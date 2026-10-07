/**
 * Demo-mock contract (`@/lib/assistant/demo-mock` + the `/api/assistant`
 * wiring).
 *
 * Three things must stay true:
 *   1. the scripted answers are served exactly as written — headings, the
 *      `**نسبة الثقة:** \`…\`` chip and the numbered badges the UI colours —
 *      in script order (first photo Leaf Scorch, second Dieback);
 *   2. the timings are the demo's: ~600 ms for a text turn, a full ~5 s for a
 *      photo turn (the beat that shows both vision phases), and neither is
 *      paid by a turn the script does not recognise;
 *   3. the mock is ON BY DEFAULT — a deployment with no configuration at all
 *      (the Vercel recording environment, which has no `.env.local`) must
 *      answer `مرحبا` with the script, never with the old basic-mode reply —
 *      while an explicit `DEMO_MOCK=0` restores the real pipeline.
 *
 * Note on cost: photo turns really wait 5 s here — that is the contract being
 * tested, so this file is deliberately the slowest in the suite.
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

/** Mirrors the route's split timings: fast text answers, a slow vision beat. */
const SIMULATED_TEXT_DELAY_MS = 600;
const SIMULATED_IMAGE_DELAY_MS = 5000;

/** Every environment variable this suite touches. */
const TOUCHED_ENV = /^(DEMO_MOCK|PHYTOSCAN_DEMO_MOCK|GEMINI_API_KEY|HUGGINGFACE_API_KEY|HF_TOKEN)/;
const originalEnv: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (TOUCHED_ENV.test(name)) originalEnv[name] = value;
}

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

const IMAGE_B64 = "aW1hZ2U=";

/* ------------------------------------------------------------------ */
/*  The switch                                                         */
/* ------------------------------------------------------------------ */

test("the mock is ON by default — only an explicit DEMO_MOCK=0 disables it", () => {
  scrubEnv();
  // Nothing configured at all: the deployed-recording case.
  assert.equal(isDemoMockEnabled({}), true);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "" }), true);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: " 1 " }), true);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "TRUE" }), true);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "on" }), true);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "maybe" }), true);
  // The documented kill switch (alias included).
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "0" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "false" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "off" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "no" }), false);
  assert.equal(isDemoMockEnabled({ DEMO_MOCK: "disabled" }), false);
  assert.equal(isDemoMockEnabled({ PHYTOSCAN_DEMO_MOCK: "0" }), false);
});

/* ------------------------------------------------------------------ */
/*  Script order + markdown fidelity                                   */
/* ------------------------------------------------------------------ */

test("script: greeting / identity / explain / French, byte-for-byte", async () => {
  const greeting = (await getDemoMockResponse([user("مرحبا")])) ?? "";
  assert.ok(greeting.startsWith("مرحباً بك! 👋"));
  for (const paragraph of [
    "أنا هنا لمساعدتك في إدارة محاصيلك وصحة نباتاتك في الميدان الزراعي.",
    "إذا كان لديك أي سؤال حول صحة النبات، التسميد، السقي، أو ظهور أعراض مرضية، فأخبرني بالتفصيل.",
    "أو يمكنك إرسال صورة مباشرة للحالة لتشخيصها فوراً.",
  ]) {
    assert.ok(greeting.includes(paragraph), `missing paragraph: ${paragraph.slice(0, 30)}`);
  }

  // The variants a presenter may type all land on the same answer (the matcher
  // folds tashkeel and the alef/hamza forms).
  for (const variant of ["اهلا", "أهلاً", "أهلاً وسهلاً", "سلام", "السلام عليكم", "السلام عليكم ورحمة الله"]) {
    const reply = await getDemoMockResponse([user(variant)]);
    assert.ok(reply?.includes("مرحباً بك! 👋"), `greeting missed for "${variant}"`);
  }

  const identity = (await getDemoMockResponse([user("عرف بنفسك")])) ?? "";
  assert.ok(identity.startsWith("أنا **PhytoScan AI** — مستشارك الزراعي الذكي المطور خصيصاً"));
  assert.ok(identity.includes("• **مهامي الأساسية:**"));
  assert.ok(identity.includes("• تشخيص أمراض النباتات والآفات فوراً من خلال تحليل الصور."));
  assert.ok(identity.includes("• تقديم استشارات في الري، التسميد، وحماية المحاصيل"));
  assert.ok((await getDemoMockResponse([user("شكون انت؟")]))?.includes("**PhytoScan AI**"));

  const explain = (await getDemoMockResponse([user("لم أفهم، اشرحلي")])) ?? "";
  assert.ok(explain.startsWith("أفهمك، يُقصد باحتراق الحواف"));
  assert.ok(explain.includes("**الخطوات العملية التوضيحية:**"));
  assert.ok(explain.includes("• **السقي:** اسقِ النبات في الصباح الباكر فقط"));
  assert.ok(explain.includes("• **التقليم:** قم بقص الحواف الجافة والميتة بمقلم معقم"));
  assert.ok(explain.includes("• **الرش:** استعمل المحلول المذكور لحماية الأوراق المتبقية"));
  assert.ok((await getDemoMockResponse([user("ما هي التفاصيل؟")]))?.includes("يُقصد باحتراق الحواف"));

  const french = await getDemoMockResponse([user("اشرحلي بالفرنسية")]);
  // The explain branch precedes the French branch, in script order.
  assert.ok(french?.includes("يُقصد باحتراق الحواف"));
  const frenchOnly = (await getDemoMockResponse([user("Français s'il vous plaît")])) ?? "";
  // Scripted byte-for-byte: the answer opens with the period (RTL markdown)
  // and keeps the two `**: …**` headings the renderer bolds.
  assert.ok(frenchOnly.startsWith(".Oui, bien sûr"));
  assert.ok(frenchOnly.includes("**: Pour traiter**"));
  assert.ok(frenchOnly.includes("• Appliquez du **copper oxychloride 50 %**"));
  assert.ok(frenchOnly.includes("• Taillez les parties sèches et désinfectez les outils."));
  assert.ok(frenchOnly.includes("**: Prévention**"));
  assert.ok(frenchOnly.includes("• Évitez les blessures mécaniques et contrôlez l'arrosage."));
});

test("photos: 1st = Leaf Scorch 88 %, 2nd = Dieback 85 %, badges and chips intact", async () => {
  const first = (await getDemoMockResponse([user("شخّص هذه الورقة", IMAGE_B64)])) ?? "";
  assert.ok(first.startsWith("[ 🔍 لم يُعثر على ورقة واحدة — شُخِّصت الصورة كاملة. ]"));
  // `### ` heading, `**bold**` and the inline-code chip the UI colours.
  assert.ok(first.includes("### **احتراق حواف الأوراق والجفاف الأنسجي (Leaf Scorch / Tip Burn)**"));
  assert.ok(first.includes("**نسبة الثقة:** `88% · ثقة مرتفعة`"));
  // Agro-depth: physiology, dose, timing, alternatives and the field note.
  assert.ok(first.includes("(Chlorosis)"));
  assert.ok(first.includes("(Salinity Stress)"));
  assert.ok(first.includes("**خطة علاج ووقاية:**"));
  assert.ok(first.includes("`1` **اسم المنتج العلاجي:** أكسي كلورور النحاس 50% + سماد ورقي غني بالبوتاسيوم"));
  assert.ok(first.includes("• **الجرعة الموصى بها:** 200 غرام من أكسي كلورور النحاس + 150 مل من السماد الورقي"));
  assert.ok(first.includes("• **طريقة التطبيق:** رش ورقي متجانس يغطي كامل المجموع الخضري في الصباح الباكر"));
  assert.ok(first.includes("• **البدائل المتاحة محلياً:** استخدام مركب **مانكوزيب 80%** (Mancozeb)"));
  assert.ok(first.includes("• **ملاحظات ميدانية:** يجب تعديل حموضة مياه الرش (pH) لتكون بين 6.0 و6.5"));
  assert.ok(first.includes("`1` **البروتوكول الوقائي:**"));
  assert.ok(first.includes("• ضبط جدول السقي بنظام التقطير (Goutte-à-goutte) في الصباح الباكر"));

  // Second photo: the first scripted answer rides along as history — the UI
  // never resends the base64 payloads, so the marker in the assistant turn is
  // what makes this the SECOND diagnosis.
  const second = (await getDemoMockResponse([
    user("شخّص هذه الورقة", IMAGE_B64),
    { role: "assistant", content: first },
    user("وهذه الصورة الثانية؟", "c2Vjb25k"),
  ])) ?? "";
  assert.ok(second.includes("### **تيبس الأغصان والموت الخلفي الفطري (Dieback / Botryosphaeria Canker)**"));
  assert.ok(second.includes("**نسبة الثقة:** `85% · ثقة مرتفعة`"));
  assert.ok(second.includes("(Retrograde Drying)"));
  assert.ok(second.includes("(Xylem Vessels)"));
  assert.ok(second.includes("*Botryosphaeriaceae*"));
  assert.ok(second.includes("`1` **اسم المنتج العلاجي:** مبيد فطر وعائي مركّب: **مانكوزيب 80%** (Mancozeb) + **تيفانات الميثيل 70%** (Thiophanate-Methyl)"));
  assert.ok(second.includes("• **الجرعة الموصى بها:** 150 غرام من المانكوزيب + 100 غرام من تيفانات الميثيل"));
  assert.ok(second.includes("• **طريقة التطبيق:** أولاً، إجراء تقليم صحي صارم بقص الأجزاء الميتة مع زيادة 3 إلى 5 سم"));
  assert.ok(second.includes("• **البدائل المتاحة محلياً:** استخدام **كلوروثالونيل 50%** أو **هيكساكونازول 5%**"));
  assert.ok(second.includes("• **ملاحظات ميدانية:** يجب تطهير أدوات التقليم (المقلم/المنشار)"));
  assert.ok(second.includes("`1` **البروتوكول الوقائي:**"));
  assert.ok(second.includes("• جمع كافة الأغصان المقصوصة والمصابة وحرقها فوراً خارج الضيعة"));

  // A legacy `imageUrl` turn counts as a photo too.
  assert.ok(
    (
      await getDemoMockResponse([
        { role: "user", content: "", imageUrl: "data:image/jpeg;base64,x" },
      ])
    )?.includes("Leaf Scorch"),
  );
});

/* ------------------------------------------------------------------ */
/*  Matching misses + timings                                          */
/* ------------------------------------------------------------------ */

test("an unrecognised TEXT turn returns null so the real pipeline takes over", async () => {
  assert.equal(await getDemoMockResponse([]), null);
  assert.equal(await getDemoMockResponse([{ role: "assistant", content: "…" }]), null);
  assert.equal(await getDemoMockResponse([user("كيف أسقي الطماطم؟")]), null);
  // A greeting INSIDE a long sentence is not a scripted turn.
  assert.equal(
    await getDemoMockResponse([user("أريد أن أعرف كل شيء عن دورة حياة القمح من البداية إلى الحصاد")]),
    null,
  );
});

test("a text turn waits ~600 ms, a photo turn a full ~5 s (the vision beat)", async () => {
  const textStart = Date.now();
  await getDemoMockResponse([user("مرحبا")]);
  const textElapsed = Date.now() - textStart;
  assert.ok(
    textElapsed >= SIMULATED_TEXT_DELAY_MS - 5 && textElapsed < SIMULATED_IMAGE_DELAY_MS / 2,
    `text turn should wait ~600 ms, waited ${textElapsed} ms`,
  );

  const photoStart = Date.now();
  const photoReply = await getDemoMockResponse([user("شخّص هذه الورقة", IMAGE_B64)]);
  const photoElapsed = Date.now() - photoStart;
  assert.ok(photoReply?.includes("Leaf Scorch"));
  // The UI walks its thinking label at 2.6 s (detection → vision analysis), so
  // the 5 s beat is what shows both phases on camera.
  assert.ok(
    photoElapsed >= SIMULATED_IMAGE_DELAY_MS - 20,
    `photo turn should wait ~5000 ms, waited ${photoElapsed} ms`,
  );
});

test("a miss is never held behind the mock's timing", async () => {
  const start = Date.now();
  assert.equal(await getDemoMockResponse([user("كيف أسقي الطماطم؟")]), null);
  assert.equal(await getDemoMockResponse([user("ما هو أفضل سماد للزيتون؟")]), null);
  assert.ok(Date.now() - start < SIMULATED_TEXT_DELAY_MS, "no simulated delay on a miss");
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

const IMAGE = { data: IMAGE_B64, mimeType: "image/jpeg" };

test("route: on a server with NO configuration a greeting is answered by the script", async () => {
  // The reported regression: a deployment without DEMO_MOCK (Vercel has no
  // `.env.local`) used to walk the real pipeline and return the old
  // "محصولي الذكي … الوضع الأساسي" reply instead of the PhytoScan script.
  scrubEnv();
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });

  for (const greeting of ["مرحبا", "اهلا", "أهلاً", "سلام"]) {
    const response = await POST(request({ message: greeting }));
    assert.equal(response.status, 200, `expected 200 for "${greeting}"`);
    const payload = await response.json();
    assert.equal(payload.reply.includes("مرحباً بك! 👋"), true, `script missed for "${greeting}"`);
    // Neither the old basic-mode greeting nor its "unavailable" wording.
    assert.equal(payload.reply.includes("محصولي الذكي"), false);
    assert.equal(payload.reply.includes("الوضع الأساسي"), false);
    assert.equal(payload.source, "llm");
  }
});

test("route: DEMO_MOCK=0 restores the real pipeline for scripted turns", async () => {
  scrubEnv();
  process.env.DEMO_MOCK = "0";
  // No provider key configured: the documented MISSING_KEYS signal — proof the
  // mock did not answer.
  const response = await POST(request({ message: "مرحبا" }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "MISSING_KEYS");
});

test("route: with the mock on, a text turn is 200 llm with no keys at all", async () => {
  scrubEnv();
  // No test may reach a provider: any upstream call fails loudly.
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });

  const response = await POST(request({ message: "عرف بنفسك" }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "llm");
  assert.equal(payload.diagnosis, null);
  assert.match(payload.reply, /\*\*PhytoScan AI\*\*/);
  assert.match(payload.warnings.join(" "), /Demo mock/);
});

test("route: with the mock on, a photo is 200 hybrid (no provider, no quota)", async () => {
  scrubEnv();
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });

  const started = Date.now();
  const response = await POST(request({ message: "شخّص هذه الورقة", image: IMAGE }));
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis, null);
  assert.match(payload.reply, /احتراق حواف الأوراق والجفاف الأنسجي \(Leaf Scorch \/ Tip Burn\)/);
  // The 5 s vision beat survives the route (build + JSON round-trip included).
  assert.ok(elapsed >= SIMULATED_IMAGE_DELAY_MS, `photo reply came back in ${elapsed} ms`);
});

test("route: with the mock on, an unknown text turn still reaches the real pipeline", async () => {
  scrubEnv();
  const response = await POST(request({ message: "كيف أسقي الطماطم؟" }));
  // Still the unconfigured-server signal — the mock never swallowed it.
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "MISSING_KEYS");
});

test("route: validation still runs before the mock", async () => {
  scrubEnv();
  const empty = await POST(request({ message: "مرحبا", image: { data: "x", mimeType: "text/plain" } }));
  assert.equal(empty.status, 400);

  const nothing = await POST(request({ message: "   " }));
  assert.equal(nothing.status, 400);
});
