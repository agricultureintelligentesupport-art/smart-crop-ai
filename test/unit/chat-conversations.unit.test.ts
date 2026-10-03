/**
 * Multi-conversation history for the PhytoScan assistant sidebar.
 *
 * Builds on top of the single-conversation rules already pinned by
 * `chat-history.unit.test.ts` (sanitizing, caps, scope resolution): this
 * suite covers what is new — the conversation LIST (titles/metadata only,
 * grouped by recency), the per-conversation document, the legacy single-doc
 * import, and CRUD (save/rename/delete/delete-all/active-id) over an injected
 * I/O so no browser, Firestore or React is involved.
 *
 *   npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";

import { chatHistoryScope, IMAGE_PLACEHOLDER, type ChatHistoryRead } from "../../src/lib/assistant/history";
import {
  CONVERSATIONS_INDEX_VERSION,
  CONVERSATION_DOC_VERSION,
  MAX_CONVERSATIONS,
  TITLE_MAX_CHARS,
  capConversationMetas,
  deleteAllConversations,
  deleteConversation,
  deriveConversationTitle,
  groupConversationsByRecency,
  importLegacyConversation,
  loadConversation,
  loadConversationIndex,
  makeConversationId,
  markRestored,
  parseConversationDoc,
  parseConversationIndex,
  renameConversation,
  saveConversation,
  serializeConversation,
  serializeConversationIndex,
  setActiveConversationId,
  sortConversationsByRecency,
  truncateTitle,
  type ConversationMeta,
  type ConversationsIO,
} from "../../src/lib/assistant/conversations";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function userTurn(text: string, extra: Record<string, unknown> = {}) {
  return { id: `u-${text.slice(0, 6)}`, author: "user" as const, text, ...extra };
}
function assistantTurn(text: string, extra: Record<string, unknown> = {}) {
  return { id: `a-${text.slice(0, 6)}`, author: "assistant" as const, text, ...extra };
}

function meta(id: string, title: string, daysAgo: number, now = new Date("2026-01-15T12:00:00.000Z")): ConversationMeta {
  const updatedAt = new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  return { id, title, updatedAt };
}

/** A conversations I/O stand-in: in-memory local + remote, with call tracing and optional failure injection. */
function fakeIO(options: { remote?: "ok" | "fail"; local?: "ok" | "fail" } = {}): ConversationsIO & {
  calls: string[];
  local: Record<string, string>;
  remote: Record<string, string>;
} {
  const calls: string[] = [];
  const local: Record<string, string> = {};
  const remote: Record<string, string> = {};
  const remoteMode = options.remote ?? "ok";
  const localMode = options.local ?? "ok";

  const localRead = (key: string): ChatHistoryRead => {
    if (localMode === "fail") return { ok: false, raw: null };
    return { ok: true, raw: key in local ? local[key] : null };
  };

  return {
    calls,
    local,
    remote,
    readIndexLocal(key) {
      calls.push(`readIndexLocal:${key}`);
      return localRead(key);
    },
    writeIndexLocal(key, raw) {
      calls.push(`writeIndexLocal:${key}`);
      local[key] = raw;
    },
    removeIndexLocal(key) {
      calls.push(`removeIndexLocal:${key}`);
      delete local[key];
    },
    readConversationLocal(key, id) {
      calls.push(`readConversationLocal:${key}:${id}`);
      return localRead(`${key}:${id}`);
    },
    writeConversationLocal(key, id, raw) {
      calls.push(`writeConversationLocal:${key}:${id}`);
      local[`${key}:${id}`] = raw;
    },
    removeConversationLocal(key, id) {
      calls.push(`removeConversationLocal:${key}:${id}`);
      delete local[`${key}:${id}`];
    },
    async readIndexRemote(uid) {
      calls.push(`readIndexRemote:${uid}`);
      if (remoteMode === "fail") throw new Error("unavailable");
      return { ok: true, raw: uid in remote ? remote[uid] : null };
    },
    async writeIndexRemote(uid, raw) {
      calls.push(`writeIndexRemote:${uid}`);
      if (remoteMode === "fail") throw new Error("permission-denied");
      remote[uid] = raw;
    },
    async removeIndexRemote(uid) {
      calls.push(`removeIndexRemote:${uid}`);
      if (remoteMode === "fail") throw new Error("permission-denied");
      delete remote[uid];
    },
    async readConversationRemote(uid, id) {
      calls.push(`readConversationRemote:${uid}:${id}`);
      if (remoteMode === "fail") throw new Error("unavailable");
      const key = `${uid}:${id}`;
      return { ok: true, raw: key in remote ? remote[key] : null };
    },
    async writeConversationRemote(uid, id, raw) {
      calls.push(`writeConversationRemote:${uid}:${id}`);
      if (remoteMode === "fail") throw new Error("permission-denied");
      remote[`${uid}:${id}`] = raw;
    },
    async removeConversationRemote(uid, id) {
      calls.push(`removeConversationRemote:${uid}:${id}`);
      if (remoteMode === "fail") throw new Error("permission-denied");
      delete remote[`${uid}:${id}`];
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Title derivation                                                   */
/* ------------------------------------------------------------------ */

test("the title is the first USER turn, trimmed to 40 chars", () => {
  const long = "س".repeat(60);
  const title = deriveConversationTitle([assistantTurn("تجاهل هذا"), userTurn(long)]);
  assert.equal(title.length, TITLE_MAX_CHARS + 1); // 40 chars + the ellipsis character
  assert.ok(title.endsWith("…"));
  assert.equal(deriveConversationTitle([userTurn("سؤال قصير")]), "سؤال قصير");
});

test("an image-only first turn titles the conversation «صورة»", () => {
  assert.equal(
    deriveConversationTitle([{ id: "i", author: "user", text: "", imageUrl: "data:image/png;base64,AAAA" }]),
    IMAGE_PLACEHOLDER,
  );
});

test("no user turn at all falls back to the default title, never throws", () => {
  assert.equal(deriveConversationTitle([assistantTurn("رد بلا سؤال")]), "محادثة جديدة");
  assert.equal(deriveConversationTitle([]), "محادثة جديدة");
  assert.equal(deriveConversationTitle("garbage" as unknown), "محادثة جديدة");
});

test("truncateTitle collapses whitespace and only adds an ellipsis past the limit", () => {
  assert.equal(truncateTitle("  a   b\nc  "), "a b c");
  assert.equal(truncateTitle("a".repeat(TITLE_MAX_CHARS)), "a".repeat(TITLE_MAX_CHARS));
  assert.ok(truncateTitle("a".repeat(TITLE_MAX_CHARS + 1)).endsWith("…"));
  assert.equal(truncateTitle(42 as unknown), "");
});

/* ------------------------------------------------------------------ */
/*  Grouping by recency                                                 */
/* ------------------------------------------------------------------ */

test("conversations group into اليوم / أمس / آخر 7 أيام / أقدم, newest first", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const list = [
    meta("old-2", "قديمة جداً", 40, now),
    meta("today-older", "اليوم الأقدم", 0.5, now),
    meta("week-1", "منذ 3 أيام", 3, now),
    meta("today-newest", "اليوم الأحدث", 0.1, now),
    meta("yesterday-1", "أمس", 1, now),
  ];
  const groups = groupConversationsByRecency(list, now);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["today", "yesterday", "week", "older"],
  );
  assert.deepEqual(groups[0].items.map((i) => i.id), ["today-newest", "today-older"]);
  assert.deepEqual(groups[1].items.map((i) => i.id), ["yesterday-1"]);
  assert.deepEqual(groups[2].items.map((i) => i.id), ["week-1"]);
  assert.deepEqual(groups[3].items.map((i) => i.id), ["old-2"]);
});

test("empty buckets are omitted entirely", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const groups = groupConversationsByRecency([meta("a", "x", 0, now)], now);
  assert.deepEqual(groups.map((g) => g.key), ["today"]);
});

test("sortConversationsByRecency is newest-first and tolerates a garbage timestamp", () => {
  const sorted = sortConversationsByRecency([
    { id: "b", title: "b", updatedAt: "not-a-date" },
    { id: "a", title: "a", updatedAt: "2026-01-02T00:00:00.000Z" },
  ]);
  assert.deepEqual(sorted.map((i) => i.id), ["a", "b"]);
});

/* ------------------------------------------------------------------ */
/*  Caps                                                                */
/* ------------------------------------------------------------------ */

test("at most MAX_CONVERSATIONS survive — the OLDEST are dropped, never the newest", () => {
  assert.equal(MAX_CONVERSATIONS, 30);
  const now = new Date("2026-01-15T12:00:00.000Z");
  const list = Array.from({ length: MAX_CONVERSATIONS + 7 }, (_, i) => meta(`c${i}`, `t${i}`, i, now));
  const { kept, dropped } = capConversationMetas(list);
  assert.equal(kept.length, MAX_CONVERSATIONS);
  assert.equal(dropped.length, 7);
  // The newest (smallest daysAgo) are always kept.
  assert.ok(kept.every((m) => Number(m.id.slice(1)) < MAX_CONVERSATIONS));
  assert.ok(dropped.every((m) => Number(m.id.slice(1)) >= MAX_CONVERSATIONS));
});

/* ------------------------------------------------------------------ */
/*  Encoding / decoding                                                 */
/* ------------------------------------------------------------------ */

test("a conversation document round-trips (title, updatedAt, messages)", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");
  const raw = serializeConversation("سؤال عن الطماطم", [userTurn("كيف أسقي؟"), assistantTurn("صباحاً.")], now);
  assert.ok(raw);
  const parsed = parseConversationDoc(raw);
  assert.equal(parsed?.title, "سؤال عن الطماطم");
  assert.equal(parsed?.updatedAt, now.toISOString());
  assert.deepEqual(parsed?.messages.map((m) => m.text), ["كيف أسقي؟", "صباحاً."]);
});

test("an empty or only-failed conversation serializes to null — nothing is saved", () => {
  assert.equal(serializeConversation("x", [], new Date()), null);
  assert.equal(serializeConversation("x", [assistantTurn("خطأ", { error: true })], new Date()), null);
});

test("a missing title hint derives one from the messages themselves", () => {
  const raw = serializeConversation(undefined, [userTurn("ما هو أفضل سماد؟")], new Date());
  assert.equal(parseConversationDoc(raw)?.title, "ما هو أفضل سماد؟");
});

test("parseConversationDoc rejects corrupt or wrong-version payloads instead of throwing", () => {
  assert.equal(parseConversationDoc(null), null);
  assert.equal(parseConversationDoc("{ not json"), null);
  assert.equal(parseConversationDoc(JSON.stringify({ version: CONVERSATION_DOC_VERSION - 1, title: "x", updatedAt: "x", data: "{}" })), null);
});

test("the index round-trips, caps at MAX_CONVERSATIONS and drops a dangling activeId", () => {
  const list = [meta("a", "A", 0), meta("b", "B", 1)];
  const raw = serializeConversationIndex("a", list);
  const parsed = parseConversationIndex(raw);
  assert.equal(parsed?.version, CONVERSATIONS_INDEX_VERSION);
  assert.equal(parsed?.activeId, "a");
  assert.equal(parsed?.conversations.length, 2);

  // An activeId that is not in the list is dropped, never kept dangling.
  const raw2 = serializeConversationIndex("ghost", list);
  assert.equal(parseConversationIndex(raw2)?.activeId, null);
});

test("parseConversationIndex drops malformed entries but keeps the valid ones", () => {
  const raw = JSON.stringify({
    version: CONVERSATIONS_INDEX_VERSION,
    activeId: null,
    conversations: [{ id: "ok", title: "x", updatedAt: "2026-01-01T00:00:00.000Z" }, { id: 7 }, "nope", null],
  });
  assert.deepEqual(parseConversationIndex(raw)?.conversations.map((c) => c.id), ["ok"]);
});

test("parseConversationIndex returns null for a legacy (v1) or garbage payload — triggers migration upstream", () => {
  assert.equal(parseConversationIndex(JSON.stringify({ version: 1, updatedAt: "x", messages: [] })), null);
  assert.equal(parseConversationIndex("{ nope"), null);
  assert.equal(parseConversationIndex(null), null);
});

/* ------------------------------------------------------------------ */
/*  Legacy import                                                       */
/* ------------------------------------------------------------------ */

test("importLegacyConversation turns an old single transcript into the first conversation", () => {
  const now = new Date("2026-03-01T00:00:00.000Z");
  const imported = importLegacyConversation([userTurn("مرحبا"), assistantTurn("أهلاً")], now);
  assert.ok(imported);
  assert.equal(imported?.title, "مرحبا");
  assert.equal(imported?.updatedAt, now.toISOString());
  assert.equal(imported?.messages.length, 2);
  assert.ok(imported?.id.startsWith("conv-"));
});

test("importLegacyConversation is null for empty/garbage input — nothing to migrate", () => {
  assert.equal(importLegacyConversation([], new Date()), null);
  assert.equal(importLegacyConversation("not-an-array", new Date()), null);
  assert.equal(importLegacyConversation([assistantTurn("خطأ", { error: true })], new Date()), null);
});

/* ------------------------------------------------------------------ */
/*  Orchestration — loading                                             */
/* ------------------------------------------------------------------ */

test("loadConversationIndex migrates a legacy payload found at the index's own spot, exactly once", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-1", firestoreReady: true }, null);
  // Seed the OLD single-conversation shape at the exact slot the index reads.
  io.remote["member-1"] = JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", messages: [userTurn("سؤال قديم")] });

  const now = new Date("2026-01-02T00:00:00.000Z");
  const first = await loadConversationIndex(io, scope, now);
  assert.equal(first.ok, true);
  assert.equal(first.migrated, true);
  assert.equal(first.conversations.length, 1);
  assert.equal(first.conversations[0].title, "سؤال قديم");
  assert.equal(first.activeId, first.conversations[0].id);
  // The conversation itself was written to its own document.
  const loadedConv = await loadConversation(io, scope, first.conversations[0].id);
  assert.deepEqual(loadedConv.conversation?.messages.map((m) => m.text), ["سؤال قديم"]);

  // Reading again sees the NEW shape — no second migration.
  const second = await loadConversationIndex(io, scope, now);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.conversations, first.conversations);
});

test("loadConversationIndex on a brand-new identity returns an empty list without writing anything", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "new-member", firestoreReady: true }, null);
  const loaded = await loadConversationIndex(io, scope);
  assert.deepEqual(loaded, { ok: true, activeId: null, conversations: [], migrated: false });
  assert.deepEqual(io.remote, {}, "a brand-new identity writes nothing until the first real save");
});

test("a guest's legacy localStorage transcript is imported too, never touching Firestore", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: null, firestoreReady: true }, "local_guest_1");
  io.local["local_guest_1"] = JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", messages: [userTurn("ضيف")] });

  const loaded = await loadConversationIndex(io, scope, new Date("2026-01-02T00:00:00.000Z"));
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.conversations[0].title, "ضيف");
  assert.ok(io.calls.every((call) => !call.includes("Remote")), `no Firestore call: ${io.calls.join(",")}`);
});

/* ------------------------------------------------------------------ */
/*  Orchestration — CRUD                                                */
/* ------------------------------------------------------------------ */

test("saveConversation creates a document and lists it, newest first", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-2", firestoreReady: true }, null);
  const id = makeConversationId();
  const saved = await saveConversation(io, scope, id, undefined, [userTurn("ما هو المرض؟")], { activeId: null, conversations: [] });
  assert.ok(saved);
  assert.equal(saved?.meta.title, "ما هو المرض؟");
  assert.equal(saved?.activeId, id);
  assert.equal(saved?.conversations.length, 1);

  const index = await loadConversationIndex(io, scope);
  assert.equal(index.conversations.length, 1);
  assert.equal(index.conversations[0].id, id);
});

test("saveConversation never creates an empty conversation", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-3", firestoreReady: true }, null);
  const saved = await saveConversation(io, scope, makeConversationId(), undefined, [], { activeId: null, conversations: [] });
  assert.equal(saved, null);
  assert.deepEqual(io.remote, {});
});

test("saving a 31st conversation drops the oldest one, both from the index and its own document", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-4", firestoreReady: true }, null);
  let index: { activeId: string | null; conversations: ConversationMeta[] } = { activeId: null, conversations: [] };
  const ids: string[] = [];
  for (let i = 0; i < MAX_CONVERSATIONS; i += 1) {
    const id = makeConversationId(Date.now() + i);
    ids.push(id);
    const saved = await saveConversation(io, scope, id, undefined, [userTurn(`سؤال ${i}`)], index, new Date(2026, 0, 1 + i));
    index = { activeId: saved!.activeId, conversations: saved!.conversations };
  }
  assert.equal(index.conversations.length, MAX_CONVERSATIONS);

  const newestId = makeConversationId(Date.now() + 999);
  const saved = await saveConversation(io, scope, newestId, undefined, [userTurn("سؤال جديد")], index, new Date(2026, 1, 1));
  assert.equal(saved?.conversations.length, MAX_CONVERSATIONS);
  assert.ok(saved?.conversations.some((c) => c.id === newestId));
  assert.ok(!saved?.conversations.some((c) => c.id === ids[0]), "the oldest conversation was dropped");
  const droppedRead = await loadConversation(io, scope, ids[0]);
  assert.equal(droppedRead.conversation, null, "the dropped conversation's own document is gone too");
});

test("renameConversation updates the title everywhere but never bumps updatedAt", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-5", firestoreReady: true }, null);
  const id = makeConversationId();
  const saved = await saveConversation(io, scope, id, undefined, [userTurn("عنوان أصلي")], { activeId: null, conversations: [] }, new Date("2026-01-01T00:00:00.000Z"));
  const renamed = await renameConversation(io, scope, id, "اسم جديد للمحادثة", { activeId: saved!.activeId, conversations: saved!.conversations });
  assert.equal(renamed?.find((c) => c.id === id)?.title, "اسم جديد للمحادثة");
  assert.equal(renamed?.find((c) => c.id === id)?.updatedAt, saved!.meta.updatedAt);

  const doc = await loadConversation(io, scope, id);
  assert.equal(doc.conversation?.title, "اسم جديد للمحادثة");
  assert.equal(doc.conversation?.updatedAt, saved!.meta.updatedAt);
});

test("renameConversation is a no-op for an unknown id or an empty title", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-6", firestoreReady: true }, null);
  assert.equal(await renameConversation(io, scope, "ghost", "x", { activeId: null, conversations: [] }), null);
  const id = makeConversationId();
  await saveConversation(io, scope, id, undefined, [userTurn("أصلي")], { activeId: null, conversations: [] });
  assert.equal(await renameConversation(io, scope, id, "   ", { activeId: id, conversations: [{ id, title: "أصلي", updatedAt: "x" }] }), null);
});

test("deleteConversation removes it and clears activeId only if it WAS the active one", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-7", firestoreReady: true }, null);
  const a = await saveConversation(io, scope, makeConversationId(1), undefined, [userTurn("أ")], { activeId: null, conversations: [] });
  const b = await saveConversation(io, scope, makeConversationId(2), undefined, [userTurn("ب")], { activeId: a!.activeId, conversations: a!.conversations });

  const afterDeleteOther = await deleteConversation(io, scope, a!.meta.id, { activeId: b!.activeId, conversations: b!.conversations });
  assert.equal(afterDeleteOther.activeId, b!.activeId, "deleting a non-active conversation keeps the active one");
  assert.equal(afterDeleteOther.conversations.length, 1);

  const afterDeleteActive = await deleteConversation(io, scope, b!.activeId, afterDeleteOther);
  assert.equal(afterDeleteActive.activeId, null);
  assert.equal(afterDeleteActive.conversations.length, 0);
  assert.equal((await loadConversation(io, scope, b!.activeId)).conversation, null);
});

test("deleteAllConversations wipes every document and the index", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-8", firestoreReady: true }, null);
  const a = await saveConversation(io, scope, makeConversationId(1), undefined, [userTurn("أ")], { activeId: null, conversations: [] });
  const b = await saveConversation(io, scope, makeConversationId(2), undefined, [userTurn("ب")], { activeId: a!.activeId, conversations: a!.conversations });

  await deleteAllConversations(io, scope, { conversations: b!.conversations });
  const index = await loadConversationIndex(io, scope);
  assert.deepEqual(index.conversations, []);
  assert.equal((await loadConversation(io, scope, a!.meta.id)).conversation, null);
  assert.equal((await loadConversation(io, scope, b!.meta.id)).conversation, null);
});

test("setActiveConversationId persists the open conversation across a reload, and ignores an unknown id", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "member-9", firestoreReady: true }, null);
  const a = await saveConversation(io, scope, makeConversationId(1), undefined, [userTurn("أ")], { activeId: null, conversations: [] });
  const b = await saveConversation(io, scope, makeConversationId(2), undefined, [userTurn("ب")], { activeId: a!.activeId, conversations: a!.conversations });

  await setActiveConversationId(io, scope, a!.meta.id, { conversations: b!.conversations });
  assert.equal((await loadConversationIndex(io, scope)).activeId, a!.meta.id);

  await setActiveConversationId(io, scope, "ghost-id", { conversations: b!.conversations });
  assert.equal((await loadConversationIndex(io, scope)).activeId, a!.meta.id, "an unknown id never overwrites the active conversation");
});

/* ------------------------------------------------------------------ */
/*  Guest fallback / uid-from-session reuse                             */
/* ------------------------------------------------------------------ */

test("a guest conversation only ever calls the local methods — scope comes from the same verified-session rule as history.ts", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: null, firestoreReady: true }, "local_guest_2");
  const saved = await saveConversation(io, scope, makeConversationId(), undefined, [userTurn("سؤال ضيف")], { activeId: null, conversations: [] });
  assert.ok(saved);
  assert.ok(io.calls.every((call) => !call.includes("Remote")), `no Firestore call for a guest: ${io.calls.join(",")}`);
  assert.deepEqual(io.remote, {});
});

test("a verified member's conversation uses the uid from the resolved scope, never a caller-supplied value", async () => {
  const io = fakeIO();
  const scope = chatHistoryScope({ uid: "firebase-uid-xyz", firestoreReady: true }, "ignored-local-key");
  assert.deepEqual(scope, { kind: "remote", uid: "firebase-uid-xyz" });
  await saveConversation(io, scope, makeConversationId(), undefined, [userTurn("سؤال")], { activeId: null, conversations: [] });
  assert.ok(io.calls.some((call) => call.includes("firebase-uid-xyz")));
  assert.deepEqual(io.local, {}, "no localStorage write for a member");
});

/* ------------------------------------------------------------------ */
/*  Storage-failure / auth-failure resilience                           */
/* ------------------------------------------------------------------ */

test("an unreachable remote store (auth rejected / offline) never throws and never claims success", async () => {
  const failing = fakeIO({ remote: "fail" });
  const scope = chatHistoryScope({ uid: "member-10", firestoreReady: true }, null);

  const loaded = await loadConversationIndex(failing, scope);
  assert.deepEqual(loaded, { ok: false, activeId: null, conversations: [], migrated: false });

  const saved = await saveConversation(failing, scope, makeConversationId(), undefined, [userTurn("x")], { activeId: null, conversations: [] });
  // The write is attempted and swallowed; the function still reports what WOULD be the new state
  // (mirroring history.ts's save-is-fire-and-forget contract) but nothing durable changed.
  assert.ok(saved); // the in-memory projection is still returned …
  assert.deepEqual(failing.remote, {}, "… but nothing was actually persisted");

  await deleteConversation(failing, scope, "whatever", { activeId: null, conversations: [] }); // must not throw
  await deleteAllConversations(failing, scope, { conversations: [] }); // must not throw
});

test("a blocked local store never throws", async () => {
  const blocked = fakeIO({ local: "fail" });
  const scope = chatHistoryScope({ uid: null, firestoreReady: true }, "guest");
  const loaded = await loadConversationIndex(blocked, scope);
  assert.deepEqual(loaded, { ok: false, activeId: null, conversations: [], migrated: false });
  await saveConversation(blocked, scope, makeConversationId(), undefined, [userTurn("x")], { activeId: null, conversations: [] }); // must not throw
});

/* ------------------------------------------------------------------ */
/*  Restored-flag tagging (used by the view to skip animations)         */
/* ------------------------------------------------------------------ */

test("markRestored tags every item and only that — a live/new item is never tagged by the view", () => {
  const tagged = markRestored([{ id: "1" }, { id: "2" }]);
  assert.deepEqual(tagged, [
    { id: "1", isRestored: true },
    { id: "2", isRestored: true },
  ]);
  assert.deepEqual(markRestored([]), []);
});
