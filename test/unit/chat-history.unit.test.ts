/**
 * Chat-history persistence for the PhytoScan assistant.
 *
 * The conversation must survive leaving and coming back — without ever letting
 * a photo, a base64 blob, a failed bubble or an oversized payload reach storage,
 * without a guest ever touching Firestore, and without a persistence failure
 * ever breaking the chat. This suite pins exactly those promises on the pure
 * core, and the orchestration over an injected I/O (localStorage + Firestore
 * fakes) so no browser, network or React is involved.
 *
 *   npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_HISTORY_COLLECTION,
  CHAT_HISTORY_VERSION,
  GUEST_LOCAL_KEY,
  IMAGE_PLACEHOLDER,
  LOCAL_HISTORY_PREFIX,
  MAX_MESSAGES,
  MAX_PAYLOAD_BYTES,
  MAX_TEXT_CHARS,
  chatHistoryScope,
  clearPersistedChatHistory,
  createLocalIO,
  loadPersistedChatHistory,
  parseChatHistory,
  sanitizeChatHistory,
  savePersistedChatHistory,
  serializeChatHistory,
  utf8Bytes,
  type ChatHistoryIO,
  type ChatHistoryRead,
  type StorageLike,
} from "../../src/lib/assistant/history";
import { clearChatHistory, loadChatHistory, saveChatHistory } from "../../src/lib/assistant/historyStore";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const DATA_URL = `data:image/jpeg;base64,${"A".repeat(4096)}`;

function userTurn(text: string, extra: Record<string, unknown> = {}) {
  return { id: `u-${text.slice(0, 6)}`, author: "user" as const, text, ...extra };
}

function assistantTurn(text: string, extra: Record<string, unknown> = {}) {
  return { id: `a-${text.slice(0, 6)}`, author: "assistant" as const, text, ...extra };
}

const DIAGNOSIS = {
  label: "Tomato___Late_blight",
  labelAr: "الطماطم — اللفحة المتأخرة",
  cropAr: "الطماطم",
  diseaseAr: "اللفحة المتأخرة",
  healthy: false,
  confidence: 0.87,
  model: "gemini-3.8-flash",
  candidates: [
    { label: "Tomato___Late_blight", score: 0.87 },
    { label: "Tomato___Early_blight", score: 0.08 },
  ],
};

const PREPROCESSING = {
  status: "cropped" as const,
  detector: "leaf-detector",
  box: [10, 20, 200, 180] as [number, number, number, number],
  durationMs: 1200,
};

/** A storage stand-in with the three methods the module uses. */
function fakeStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

interface FakeIO extends ChatHistoryIO {
  calls: string[];
  local: Record<string, string>;
  remote: Record<string, string>;
}

function fakeIO(options: { localOk?: boolean; remote?: "ok" | "fail" | "missing" } = {}): FakeIO {
  const calls: string[] = [];
  const local: Record<string, string> = {};
  const remote: Record<string, string> = {};
  const remoteMode = options.remote ?? "ok";
  return {
    calls,
    local,
    remote,
    readLocal(key) {
      calls.push(`readLocal:${key}`);
      if (options.localOk === false) return { ok: false, raw: null };
      return { ok: true, raw: local[key] ?? null };
    },
    writeLocal(key, raw) {
      calls.push(`writeLocal:${key}`);
      local[key] = raw;
    },
    removeLocal(key) {
      calls.push(`removeLocal:${key}`);
      delete local[key];
    },
    async readRemote(uid) {
      calls.push(`readRemote:${uid}`);
      if (remoteMode === "fail") throw new Error("unavailable");
      if (remoteMode === "missing") return { ok: true, raw: null } as ChatHistoryRead;
      return { ok: true, raw: remote[uid] ?? null };
    },
    async writeRemote(uid, raw) {
      calls.push(`writeRemote:${uid}`);
      if (remoteMode === "fail") throw new Error("permission-denied");
      remote[uid] = raw;
    },
    async removeRemote(uid) {
      calls.push(`removeRemote:${uid}`);
      if (remoteMode === "fail") throw new Error("permission-denied");
      delete remote[uid];
    },
  };
}

/* ------------------------------------------------------------------ */
/*  What may be stored                                                 */
/* ------------------------------------------------------------------ */

test("only completed turns are kept — failed/retry bubbles are never stored", () => {
  const stored = sanitizeChatHistory([
    userTurn("مرحبا"),
    assistantTurn("وقع خطأ أثناء الاتصال بالمساعد.", { error: true }),
    assistantTurn("اسقِ في الصباح.", { source: "llm" }),
  ]);
  assert.deepEqual(
    stored.map((m) => m.text),
    ["مرحبا", "اسقِ في الصباح."],
  );
  assert.ok(stored.every((m) => !("error" in m)));
});

test("empty shells and unknown authors are dropped, known fields survive", () => {
  const stored = sanitizeChatHistory([
    { id: "x", author: "user", text: "   " },
    { id: "y", author: "system", text: "ignored" },
    userTurn("تشخيص؟", { source: "hybrid", analysisSource: "gemini", preprocessing: PREPROCESSING, diagnosis: DIAGNOSIS }),
  ]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, "hybrid");
  assert.equal(stored[0].analysisSource, "gemini");
  assert.equal(stored[0].preprocessing?.status, "cropped");
  assert.equal(stored[0].diagnosis?.label, "Tomato___Late_blight");
  // Unknown/legacy fields never leak into the stored shape.
  assert.deepEqual(Object.keys(stored[0]).sort(), [
    "analysisSource",
    "author",
    "diagnosis",
    "id",
    "preprocessing",
    "source",
    "text",
  ]);
});

test("a malformed diagnosis is dropped, the message itself survives", () => {
  const broken = { ...DIAGNOSIS, candidates: [{ label: 7, score: "high" }] };
  const stored = sanitizeChatHistory([assistantTurn("نتيجة", { diagnosis: broken })]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].diagnosis, undefined);

  const missingCandidates = { ...DIAGNOSIS, candidates: undefined };
  assert.equal(sanitizeChatHistory([assistantTurn("نتيجة", { diagnosis: missingCandidates })])[0].diagnosis, undefined);
});

test("text is trimmed and capped well below any limit", () => {
  const stored = sanitizeChatHistory([userTurn(`  ${"س".repeat(MAX_TEXT_CHARS + 500)}  `)]);
  assert.equal(stored[0].text.length, MAX_TEXT_CHARS);
  assert.ok(stored[0].text.endsWith("…"));
  assert.equal(sanitizeChatHistory([userTurn("  سؤال  ")])[0].text, "سؤال");
});

test("photos are replaced by the «صورة» placeholder — never stored as data or base64", () => {
  const stored = sanitizeChatHistory([
    { id: "img-1", author: "user", text: "", imageUrl: DATA_URL },
    { id: "img-2", author: "user", text: "ما هذا؟", imageUrl: DATA_URL },
  ]);
  assert.equal(stored[0].image, IMAGE_PLACEHOLDER);
  assert.equal(stored[0].text, "");
  assert.equal(stored[1].image, IMAGE_PLACEHOLDER);
  assert.equal(stored[1].text, "ما هذا؟");

  const raw = serializeChatHistory([
    { id: "img-1", author: "user", text: "", imageUrl: DATA_URL },
  ]) as string;
  assert.ok(!raw.includes("base64"), "no base64 marker in the stored payload");
  assert.ok(!raw.includes("data:image"), "no data URL in the stored payload");
  assert.ok(!raw.includes("AAAA"), "no payload bytes in the stored payload");
  assert.ok(raw.includes(IMAGE_PLACEHOLDER), "the placeholder is what gets stored");
  // Round-trip keeps exactly the placeholder.
  assert.equal(parseChatHistory(raw)[0].image, IMAGE_PLACEHOLDER);
});

test("at most the last 100 turns are kept", () => {
  const many = Array.from({ length: MAX_MESSAGES + 25 }, (_, index) => userTurn(`سؤال ${index}`, { id: `m-${index}` }));
  const stored = sanitizeChatHistory(many);
  assert.equal(stored.length, MAX_MESSAGES);
  assert.equal(stored[0].id, "m-25");
  assert.equal(stored[stored.length - 1].id, `m-${MAX_MESSAGES + 24}`);
});

test("the stored payload stays far below Firestore's 1 MiB document limit", () => {
  const huge = Array.from({ length: MAX_MESSAGES }, (_, index) =>
    assistantTurn("ا".repeat(MAX_TEXT_CHARS), { id: `h-${index}`, diagnosis: DIAGNOSIS }),
  );
  const raw = serializeChatHistory(huge) as string;
  assert.ok(raw, "something must be stored");
  assert.ok(
    utf8Bytes(raw) <= MAX_PAYLOAD_BYTES,
    `payload is ${utf8Bytes(raw)} bytes, cap is ${MAX_PAYLOAD_BYTES}`,
  );
  // The ceiling bites by dropping the OLDEST turns, never the newest ones.
  const kept = parseChatHistory(raw);
  assert.ok(kept.length >= 1);
  assert.equal(kept[kept.length - 1].id, `h-${MAX_MESSAGES - 1}`);
});

test("a single oversized message loses its extras, not the whole turn", () => {
  const giantDiagnosis = { ...DIAGNOSIS, treatment: Array.from({ length: 400 }, () => "ع".repeat(120)) };
  const stored = sanitizeChatHistory([assistantTurn("نتيجة", { diagnosis: giantDiagnosis, preprocessing: PREPROCESSING })]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].diagnosis, undefined, "oversized diagnosis dropped");
  assert.equal(stored[0].preprocessing, undefined, "extras dropped together");
  assert.equal(stored[0].text, "نتيجة");
});

/* ------------------------------------------------------------------ */
/*  Encoding / decoding                                                */
/* ------------------------------------------------------------------ */

test("a stored payload round-trips losslessly", () => {
  const live = [
    userTurn("كيف أسقي الطماطم؟", { imageUrl: DATA_URL }),
    assistantTurn("اسقِ في الصباح الباكر.", {
      diagnosis: DIAGNOSIS,
      source: "hybrid",
      analysisSource: "gemini",
      preprocessing: PREPROCESSING,
    }),
  ];
  const raw = serializeChatHistory(live) as string;
  const payload = JSON.parse(raw) as { version: number; updatedAt: string; messages: unknown[] };
  assert.equal(payload.version, CHAT_HISTORY_VERSION);
  assert.ok(typeof payload.updatedAt === "string" && payload.updatedAt.includes("T"));
  assert.deepEqual(parseChatHistory(raw), sanitizeChatHistory(live));
});

test("corrupt, foreign or empty payloads read as no history (never throw)", () => {
  assert.deepEqual(parseChatHistory(null), []);
  assert.deepEqual(parseChatHistory(undefined), []);
  assert.deepEqual(parseChatHistory(""), []);
  assert.deepEqual(parseChatHistory("{ not json"), []);
  assert.deepEqual(parseChatHistory("[]"), []);
  assert.deepEqual(parseChatHistory(JSON.stringify({ version: 99, messages: [userTurn("x")] })), []);
  assert.deepEqual(parseChatHistory(JSON.stringify({ version: CHAT_HISTORY_VERSION, messages: "nope" })), []);
  assert.deepEqual(serializeChatHistory([]), null);
  assert.deepEqual(serializeChatHistory([assistantTurn("", { error: true })]), null);
});

test("the localStorage namespace is per identity and versioned", () => {
  const storage = fakeStorage();
  const io = createLocalIO(storage);
  io.writeLocal("local_abc", "{}");
  assert.deepEqual(Object.keys(storage.data), [`${LOCAL_HISTORY_PREFIX}local_abc`]);
  assert.deepEqual(io.readLocal("local_abc"), { ok: true, raw: "{}" });
  assert.deepEqual(io.readLocal("someone-else"), { ok: true, raw: null });
  io.removeLocal("local_abc");
  assert.deepEqual(storage.data, {});
});

test("a blocked or missing storage never throws and reports a failed read", () => {
  const io = createLocalIO({
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  });
  assert.deepEqual(io.readLocal("guest"), { ok: false, raw: null });
  io.writeLocal("guest", "{}"); // must not throw
  io.removeLocal("guest"); // must not throw
  assert.deepEqual(createLocalIO(null).readLocal("guest"), { ok: false, raw: null });
});

/* ------------------------------------------------------------------ */
/*  Scope: who is allowed to touch Firestore                           */
/* ------------------------------------------------------------------ */

test("only a verified Firebase session with a live Firestore gets the remote scope", () => {
  assert.deepEqual(chatHistoryScope({ uid: "firebase-uid", firestoreReady: true }, "local_abc"), {
    kind: "remote",
    uid: "firebase-uid",
  });
  // A different local key can never redirect the remote path.
  assert.deepEqual(chatHistoryScope({ uid: "firebase-uid", firestoreReady: true }, "guest"), {
    kind: "remote",
    uid: "firebase-uid",
  });
  // Firestore unavailable → local, even with a session.
  assert.deepEqual(chatHistoryScope({ uid: "firebase-uid", firestoreReady: false }, "local_abc"), {
    kind: "local",
    key: "local_abc",
  });
  // Guests and on-device demo accounts carry no Firebase session at all.
  assert.deepEqual(chatHistoryScope({ uid: null, firestoreReady: true }, "local_abc"), {
    kind: "local",
    key: "local_abc",
  });
  assert.deepEqual(chatHistoryScope({ uid: "   ", firestoreReady: true }, null), {
    kind: "local",
    key: GUEST_LOCAL_KEY,
  });
  assert.deepEqual(chatHistoryScope({ uid: null, firestoreReady: false }, ""), {
    kind: "local",
    key: GUEST_LOCAL_KEY,
  });
});

/* ------------------------------------------------------------------ */
/*  Orchestration over injected I/O                                    */
/* ------------------------------------------------------------------ */

test("a guest conversation round-trips through localStorage and never touches Firestore", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: null, firestoreReady: true }, "local_guest_1");

  await savePersistedChatHistory(io, scope, [userTurn("مرحبا"), assistantTurn("أهلاً")]);
  assert.deepEqual(io.calls, ["writeLocal:local_guest_1"]);
  assert.ok(io.local["local_guest_1"].includes("مرحبا"));

  const loaded = await loadPersistedChatHistory(io, scope);
  assert.equal(loaded.ok, true);
  assert.deepEqual(
    loaded.messages.map((m) => m.text),
    ["مرحبا", "أهلاً"],
  );
  assert.ok(io.calls.every((call) => !call.includes("Remote")), `no Firestore call: ${io.calls.join(",")}`);

  await clearPersistedChatHistory(io, scope);
  assert.deepEqual(io.local, {});
  assert.deepEqual(io.remote, {});
});

test("a verified member writes Firestore only — the device store is not used", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "firebase-uid", firestoreReady: true }, "local_abc");

  await savePersistedChatHistory(io, scope, [userTurn("سؤال"), assistantTurn("جواب")]);
  assert.deepEqual(io.calls, ["writeRemote:firebase-uid"]);
  assert.deepEqual(io.local, {}, "no localStorage write for a member");
  assert.equal(JSON.parse(io.remote["firebase-uid"]).version, CHAT_HISTORY_VERSION);

  const loaded = await loadPersistedChatHistory(io, scope);
  assert.deepEqual(
    loaded.messages.map((m) => m.text),
    ["سؤال", "جواب"],
  );
  assert.equal(loaded.ok, true);
});

test("a failed or timing-out store never throws and never reports success", async () => {
  const failing = fakeIO({ remote: "fail" });
  const scope = chatHistoryScope({ uid: "firebase-uid", firestoreReady: true }, null);
  await savePersistedChatHistory(failing, scope, [userTurn("سؤال")]); // must not reject
  const loaded = await loadPersistedChatHistory(failing, scope);
  assert.deepEqual(loaded, { ok: false, messages: [] });

  const blocked = fakeIO({ localOk: false });
  const guestScope = chatHistoryScope({ uid: null, firestoreReady: true }, "guest");
  await savePersistedChatHistory(blocked, guestScope, []); // must not reject
  await clearPersistedChatHistory(blocked, guestScope); // must not reject
});

test("garbage input is treated as an empty history instead of being stored", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "firebase-uid", firestoreReady: true }, null);
  await savePersistedChatHistory(io, scope, "not-an-array");
  assert.deepEqual(io.calls, ["removeRemote:firebase-uid"], "an empty history clears instead of writing");
  await savePersistedChatHistory(io, scope, []);
  assert.deepEqual(io.remote, {});
});

test("the Firestore collection is the documented, brand-new one", () => {
  assert.equal(CHAT_HISTORY_COLLECTION, "assistantChats");
});

/* ------------------------------------------------------------------ */
/*  The store used by the view: SSR-safe and silent                    */
/* ------------------------------------------------------------------ */

test("without a browser the store is a silent no-op (SSR, private mode)", async () => {
  const loaded = await loadChatHistory(null);
  assert.deepEqual(loaded, { ok: false, messages: [] });
  await saveChatHistory(null, [userTurn("لا يُحفظ بدون متصفح")]); // must not throw
  await clearChatHistory(null); // must not throw
});

test("the persistence modules never call the assistant API", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/lib/assistant");
  for (const file of ["history.ts", "historyStore.ts"]) {
    const source = fs.readFileSync(path.join(src, file), "utf8");
    assert.ok(!source.includes("/api/assistant"), `${file} must not talk to the assistant route`);
    assert.ok(!source.includes("fetch("), `${file} must not perform requests`);
  }
});
