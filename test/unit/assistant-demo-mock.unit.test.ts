/**
 * Demo-mock contract (`@/lib/assistant/demo-mock` + the `/api/assistant`
 * wiring).
 *
 * Two things must stay true:
 *   1. the scripted answers are served exactly as written, in script order,
 *      with a simulated ~600 ms round-trip, and
 *   2. the mock is INERT unless `DEMO_MOCK` is explicitly enabled — an unset
 *      flag (production, the rest of the suite) must leave the real pipeline
 *      in charge, and any turn outside the script must fall through to it
 *      even while the flag is on.
 */

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { NextRequest } from "next/server";
import {
  buildDemoMockMessages,
  getDemoMockResponse,
  isDemoMockEnabled,
} from "../../src/lib/assistant/demo-mock";
import { POST } from "../../src/app/api/assistant/route";

/** Every environment variable this suite touches. */
const TOUCHED_ENV = /^(DEMO_MOCK|PHYTOSCAN_DEMO_MOCK|GEMINI_API_KEY|HUGGINGFACE_API_KEY|HF_TOKEN)/;
const originalEnv: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (TOUCHED_ENV.test(name)) originalEnv[name] = value;
}

const SIMULATED_DELAY_MS = 600;

function scrubEnv() {
  for (const name of Object.keys(process.env)) {
    if (TOUCHED_ENV.test(name)) delete process.env[name];
  }
}

afterEach(() => {
  mock.restoreAll();
  scrubEnv();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const user = (content: string, image?: string) => ({
  role: "user",
  content,
  ...(image ? { image } : {}),
});

/* ------------------------------------------------------------------ */
/*  The opt-in switch                                                  */
/* ------------------------------------------------------------------ */

test("the mock is OFF unless DEMO_MOCK is explicitly enabled", () => {
  scrubEnv();
  assert.equal(isDemoMockEnabled({}), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "0" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "off" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "no" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "maybe" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: " 1 " }), true);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "TRUE" }), true);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "on" }), true);
  // Documented alias.
  assert.equal(isDemoMockEnabled({ PHYTOSCAN_DEMO_MOCK: "1" }), true);
});

/* ------------------------------------------------------------------ */
/*  Script order                                                       */
/* ------------------------------------------------------------------ */

test("script: greeting / identity / explain / French", async () => {
  const greeting = await getDemoMockResponse([user("مرحبا")]);
  assert.ok(greeting?.includes("مرحباً بك! 👋"));
  assert.ok(greeting?.includes("يمكنك إرسال صورة مباشرة"));
  // The typed variants a presenter may use all land on the same answer.
  for (const variant of ["أهلاً", "أهلاً وسهلاً", "سلام", "السلام عليكم", "السلام عليكم ورحمة الله"]) {
    const reply = await getDemoMockResponse([user(variant)]);
    assert.ok(reply?.includes("مرحباً بك! 👋"), `greeting missed for "${variant}"`);
  }

  const identity = await getDemoMockResponse([user("عرف بنفسك")]);
  assert.ok(identity?.includes("**PhytoScan AI**"));
  assert.ok(identity?.includes("المتعاملين الزراعيين في الجزائر"));
  assert.ok((await getDemoMockResponse([user("شكون انت؟")]))?.includes("**PhytoScan AI**"));

  const explain = await getDemoMockResponse([user("لم أفهم، اشرحلي")]);
  assert.ok(explain?.includes("يُقصد باحتراق الحواف"));
  assert.ok(explain?.includes("**الخطوات العملية التوضيحية:**"));
  assert.ok((await getDemoMockResponse([user("ما هي التفاصيل؟")]))?.includes("يُقصد باحتراق الحواف"));

  const french = await getDemoMockResponse([user("اشرحلي بالفرنسية")]);
  // The explain branch precedes the French branch, in script order.
  assert.ok(french?.includes("يُقصد باحتراق الحواف"));
  const frenchOnly = await getDemoMockResponse([user("Français s'il vous plaît")]);
  assert.ok(frenchOnly?.includes(".Oui, bien sûr"));
  assert.ok(frenchOnly?.includes("**: Pour traiter**"));
  assert.ok(frenchOnly?.includes("**: Prévention**"));
});

test("script: the first photo answers Leaf Scorch 88 %, the second Dieback 85 %", async () => {
  const first = await getDemoMockResponse([user("شخّص هذه الورقة", "aW1hZ2U=")]);
  assert.ok(first?.includes("### **احتراق حواف الأوراق (Leaf Scorch)**"));
  assert.ok(first?.includes("`88% · ثقة مرتفعة`"));
  assert.ok(first?.includes("أكسي كلورور النحاس 50%"));

  // Second photo: the first scripted answer rides along as history — the UI
  // never resends the base64 payloads.
  const second = await getDemoMockResponse([
    user("شخّص هذه الورقة", "aW1hZ2U="),
    { role: "assistant", content: first ?? "" },
    user("وهذه الصورة الثانية؟", "c2Vjb25k"),
  ]);
  assert.ok(second?.includes("### **تيبس الأغصان والموت الخلفي (Dieback)**"));
  assert.ok(second?.includes("`85% · ثقة مرتفعة`"));
  assert.ok(second?.includes("الكلوروثالونيل 50%"));

  // A legacy `imageUrl` turn counts as a photo too.
  assert.ok(
    (await getDemoMockResponse([{ role: "user", content: "", imageUrl: "data:image/jpeg;base64,x" }]))
      ?.includes("Leaf Scorch"),
  );
});

test("script: an unrecognised turn returns null (the real pipeline takes over)", async () => {
  assert.equal(await getDemoMockResponse([]), null);
  assert.equal(await getDemoMockResponse([{ role: "assistant", content: "…" }]), null);
  assert.equal(await getDemoMockResponse([user("كيف أسقي الطماطم؟")]), null);
  // A greeting INSIDE a long sentence is not a scripted turn.
  assert.equal(
    await getDemoMockResponse([user("أريد أن أعرف كل شيء عن دورة حياة القمح من البداية إلى الحصاد")]),
    null,
  );
});

test("the 600 ms simulated round-trip is paid only by a scripted turn", async () => {
  const started = Date.now();
  await getDemoMockResponse([user("مرحبا")]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= SIMULATED_DELAY_MS - 5, `greeting answered too fast: ${elapsed} ms`);

  const missStart = Date.now();
  assert.equal(await getDemoMockResponse([user("كيف أسقي الطماطم؟")]), null);
  assert.ok(Date.now() - missStart < SIMULATED_DELAY_MS, "a non-scripted turn must not be delayed");
});

test("buildDemoMockMessages appends the current turn after the history", () => {
  const messages = buildDemoMockMessages("وهذه صورة أخرى", "YWJj", [
    { role: "user", content: "شخّص" },
    { role: "assistant", content: "…" },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "شخّص" },
    { role: "assistant", content: "…" },
    { role: "user", content: "وهذه صورة أخرى", image: "YWJj" },
  ]);
});

/* ------------------------------------------------------------------ */
/*  Route wiring                                                       */
/* ------------------------------------------------------------------ */

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const IMAGE = { data: "aW1hZ2U=", mimeType: "image/jpeg" };

test("route: with the flag OFF a scripted turn still goes to the real pipeline", async () => {
  scrubEnv();
  // No provider key configured: the documented MISSING_KEYS signal — proof the
  // mock did not answer.
  const response = await POST(request({ message: "مرحبا" }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "MISSING_KEYS");

  const photo = await POST(request({ message: "شخّص هذه الورقة", image: IMAGE }));
  assert.equal(photo.status, 503);
  assert.equal((await photo.json()).code, "MISSING_KEYS");
});

test("route: with DEMO_MOCK=1 a greeting is answered 200 llm with no keys at all", async () => {
  scrubEnv();
  process.env.DEMO_MOCK = "1";
  // No test may reach a provider: any upstream call fails loudly.
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });

  const response = await POST(request({ message: "مرحبا" }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "llm");
  assert.equal(payload.diagnosis, null);
  assert.match(payload.reply, /مرحباً بك! 👋/);
  assert.match(payload.warnings.join(" "), /Demo mock/);
});

test("route: with DEMO_MOCK=1 a photo is answered 200 hybrid (no provider, no quota)", async () => {
  scrubEnv();
  process.env.DEMO_MOCK = "1";
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });

  const response = await POST(request({ message: "شخّص هذه الورقة", image: IMAGE }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis, null);
  assert.match(payload.reply, /احتراق حواف الأوراق \(Leaf Scorch\)/);
});

test("route: with DEMO_MOCK=1 an unknown turn still reaches the real pipeline", async () => {
  scrubEnv();
  process.env.DEMO_MOCK = "1";
  const response = await POST(request({ message: "كيف أسقي الطماطم؟" }));
  // Still the unconfigured-server signal — the mock never swallowed it.
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "MISSING_KEYS");
});

test("route: validation still runs before the mock", async () => {
  scrubEnv();
  process.env.DEMO_MOCK = "1";
  const empty = await POST(request({ message: "مرحبا", image: { data: "x", mimeType: "text/plain" } }));
  assert.equal(empty.status, 400);

  const nothing = await POST(request({ message: "   " }));
  assert.equal(nothing.status, 400);
});
