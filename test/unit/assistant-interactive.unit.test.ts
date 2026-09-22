/**
 * Interactive diagnosis workflow — end-to-end route contract.
 *
 * Covers the three moving parts that make MobileNetV2 the strict diagnostic
 * authority:
 *   1. FIRST PASS — a Top-1 below 60% stops the pipeline and returns the
 *      clarification questionnaire (`requiresClarification` + `questions`),
 *      with NO LLM call at all;
 *   2. SECOND PASS — the full MobileNetV2 vector is masked against the
 *      farmer's crop (wrong-crop classes dropped, survivors recalculated) and
 *      the masked Top-1 becomes the diagnosis;
 *   3. STRICT FORMATTING — Gemini receives that locked diagnosis plus the
 *      formatter-only system instruction and may never change it.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { POST } from "../../src/app/api/assistant/route";

const GEMINI_KEY = "test-gemini";
const HF_KEY = "test-hf";

const MOBILENET_MODEL = "linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification";

const SCRUBBED_ENV_PATTERN =
  /^(GEMINI_API_KEY|HUGGINGFACE_API_KEY|HF_TOKEN|HF_LEAF_DETECT_MODELS|HF_VISION_MODEL)/;

const originalKeys: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (SCRUBBED_ENV_PATTERN.test(name)) originalKeys[name] = value;
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (SCRUBBED_ENV_PATTERN.test(name)) delete process.env[name];
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(originalKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configureKeys() {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  process.env.HUGGINGFACE_API_KEY = HF_KEY;
}

/** A real decodable 64×48 frame so the Step 0 detector round-trip runs. */
const LEAF_JPEG = await sharp({
  create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 118, b: 42 } },
})
  .jpeg()
  .toBuffer();
const LEAF_JPEG_B64 = LEAF_JPEG.toString("base64");

function imageRequest(data: string) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "شخّص هذه الورقة",
      image: { data, mimeType: "image/jpeg" },
    }),
  });
}

/** Second pass: the photo again, plus the farmer's answer (and the echo). */
function clarificationRequest(
  crop: string,
  options: { data?: string; predictions?: { label: string; score: number }[] } = {},
) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "شخّص هذه الورقة",
      image: { data: options.data ?? LEAF_JPEG_B64, mimeType: "image/jpeg" },
      userAnswers: { crop },
      ...(options.predictions ? { predictions: options.predictions } : {}),
    }),
  });
}

const isGeminiUrl = (url: string) =>
  url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/") &&
  url.includes(":generateContent?key=");
const isDetectUrl = (url: string) =>
  url.includes("router.huggingface.co/hf-inference/models/") && /detr/i.test(url);
const isClassifyUrl = (url: string) =>
  url.includes("router.huggingface.co/hf-inference/models/") &&
  /mobilenet|vit/i.test(url);
const isChatUrl = (url: string) => url.includes("/v1/chat/completions");

const geminiReply = (text = "تقرير زراعي مهني.") =>
  Response.json({ candidates: [{ content: { role: "model", parts: [{ text }] } }] });

interface GeminiRequestBody {
  systemInstruction?: { parts?: { text?: string }[] };
  contents?: { parts?: { text?: string; inlineData?: { data?: string; mimeType?: string } }[] }[];
}

const parseGeminiBody = (init: RequestInit) =>
  JSON.parse(String(init.body ?? "{}")) as GeminiRequestBody;
const geminiSystemText = (body: GeminiRequestBody) =>
  (body.systemInstruction?.parts ?? []).map((part) => part.text ?? "").join("");
const geminiUserText = (body: GeminiRequestBody) =>
  (body.contents?.[0]?.parts ?? []).map((part) => part.text ?? "").join("");
const geminiImagePart = (body: GeminiRequestBody) =>
  (body.contents?.[0]?.parts ?? []).find((part) => part.inlineData !== undefined)?.inlineData;

/** The validation vector: tomato 15% losing to potato 45%. */
const TOMATO_BEHIND_POTATO = [
  { label: "Potato___Late_blight", score: 0.45 },
  { label: "Tomato___Early_blight", score: 0.15 },
  { label: "Grape___Black_rot", score: 0.1 },
];

interface PayloadLike {
  reply: string;
  source: string;
  requiresClarification?: boolean;
  questions?: { id: string; question: string; options: string[] }[];
  diagnosis: {
    label: string;
    labelAr: string;
    cropAr: string | null;
    confidence: number;
    healthy: boolean;
    candidates: { label: string; score: number }[];
    symptoms?: string[];
    filtered?: boolean;
  } | null;
  filtered?: {
    applied: boolean;
    answer: string | null;
    cropKey: string | null;
    crop: string | null;
    matchedClasses: number;
    droppedClasses: number;
    totalClasses: number;
    topLabelBefore: string | null;
    topScoreBefore: number;
    topLabelAfter: string | null;
    topScoreAfter: number;
    changedTop: boolean;
  } | null;
  warnings?: string[];
}

const warningText = (payload: PayloadLike) => (payload.warnings ?? []).join(" | ");

/* ------------------------------------------------------------------ */
/*  1. First pass — ask before diagnosing                              */
/* ------------------------------------------------------------------ */

test("first pass: Top-1 < 60% returns the crop questionnaire and calls no LLM", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    if (isDetectUrl(String(url))) return Response.json([]);
    if (isClassifyUrl(String(url))) return Response.json(TOMATO_BEHIND_POTATO);
    throw new Error(`unexpected upstream on the first pass: ${url}`);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as PayloadLike;

  assert.equal(payload.requiresClarification, true);
  assert.equal(payload.source, "clarification");
  assert.deepEqual(payload.questions, [
    {
      id: "crop",
      question: "ما هو نوع هذا النبات؟",
      options: ["طماطم", "بطاطس", "عنب", "تفاح", "خوخ", "غير ذلك"],
    },
  ]);
  // The shaky verdict is neither shown nor handed to an LLM.
  assert.equal(payload.diagnosis, null);
  assert.match(payload.reply, /غير واثق/);
  assert.match(payload.reply, /45%/);
  assert.equal(urls.filter((url) => isGeminiUrl(url) || isChatUrl(url)).length, 0);
  assert.equal(urls.length, 2); // detect + classify only
  assert.ok(urls[1].includes(MOBILENET_MODEL));
});

test("first pass: a confident Top-1 (≥ 60%) diagnoses straight away, no questionnaire", async () => {
  configureKeys();
  let system = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isDetectUrl(String(url))) return Response.json([]);
    if (isClassifyUrl(String(url))) {
      return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
    }
    assert.ok(isGeminiUrl(String(url)));
    system = geminiSystemText(parseGeminiBody(init));
    return geminiReply("اللفحة المبكرة — عالج بمبيد نحاسي.");
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  const payload = (await response.json()) as PayloadLike;
  assert.equal(payload.requiresClarification, undefined);
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  // The first pass keeps the plain expert prompt — no formatter lock.
  assert.doesNotMatch(system, /You are a formatter/);
  assert.doesNotMatch(system, /MUST NOT change this diagnosis/);
});

/* ------------------------------------------------------------------ */
/*  2. Second pass — masking + recalculation                           */
/* ------------------------------------------------------------------ */

test("second pass: the echoed vector is masked, recalculated and LOCKED into the formatter prompt", async () => {
  configureKeys();
  const urls: string[] = [];
  let system = "";
  let user = "";
  let inlineImage: { data?: string; mimeType?: string } | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    assert.ok(isGeminiUrl(String(url)), `the echoed vector must skip re-classification: ${url}`);
    const body = parseGeminiBody(init);
    system = geminiSystemText(body);
    user = geminiUserText(body);
    inlineImage = geminiImagePart(body);
    return geminiReply("**اللفحة المبكرة في الطماطم**: أزل الأوراق المصابة…");
  });

  const response = await POST(
    clarificationRequest("طماطم", { predictions: TOMATO_BEHIND_POTATO }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as PayloadLike;

  // Exactly one upstream call: the formatter LLM. MobileNetV2 already ran.
  assert.equal(urls.length, 1);

  // The masked verdict is the diagnosis — MobileNetV2's authority, boosted.
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(payload.diagnosis?.confidence, 1);
  assert.equal(payload.diagnosis?.filtered, true);
  assert.equal(payload.diagnosis?.cropAr, "الطماطم");
  assert.ok((payload.diagnosis?.symptoms ?? []).length > 0);
  // …and the wrong-crop classes are gone from the candidates.
  assert.deepEqual(
    payload.diagnosis?.candidates.map((c) => c.label),
    ["Tomato___Early_blight"],
  );

  // The transparency report records the flip: 45% potato → 100% tomato.
  assert.equal(payload.filtered?.applied, true);
  assert.equal(payload.filtered?.crop, "طماطم");
  assert.equal(payload.filtered?.cropKey, "tomato");
  assert.equal(payload.filtered?.totalClasses, 3);
  assert.equal(payload.filtered?.matchedClasses, 1);
  assert.equal(payload.filtered?.droppedClasses, 2);
  assert.equal(payload.filtered?.topLabelBefore, "Potato___Late_blight");
  assert.equal(payload.filtered?.topScoreBefore, 0.45);
  assert.equal(payload.filtered?.topLabelAfter, "Tomato___Early_blight");
  assert.equal(payload.filtered?.topScoreAfter, 1);
  assert.equal(payload.filtered?.changedTop, true);

  // STRICT formatter instruction: the four mandated anchors + the lockdown.
  assert.match(system, /أنت مساعد زراعي خبير/);
  assert.match(system, /دون مقدمات أو إطالة/);
  assert.match(system, /باللغة العربية/);
  assert.match(system, /عملي/);
  assert.match(system, /You are a formatter/);
  assert.match(system, /MUST NOT change this diagnosis/);
  assert.match(system, /Tomato___Early_blight/);

  // The user turn carries the FILTERED Top-1 and the recalculated score…
  assert.match(user, /Tomato___Early_blight/);
  assert.match(user, /100%/);
  assert.match(user, /الأعراض المميزة لهذا المرض/);
  // …and never the class that lost the mask.
  assert.doesNotMatch(user, /Potato/);
  assert.doesNotMatch(user, /Grape/);

  // The photo still travels with the locked turn as visual context.
  assert.equal(inlineImage?.data, LEAF_JPEG_B64);
  assert.equal(inlineImage?.mimeType, "image/jpeg");
});

test("second pass without an echoed vector re-classifies the image, then masks", async () => {
  configureKeys();
  const urls: string[] = [];
  let user = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (isDetectUrl(String(url))) return Response.json([]);
    if (isClassifyUrl(String(url))) return Response.json(TOMATO_BEHIND_POTATO);
    assert.ok(isGeminiUrl(String(url)));
    user = geminiUserText(parseGeminiBody(init));
    return geminiReply("تقرير اللفحة المبكرة.");
  });

  const response = await POST(clarificationRequest("طماطم"));
  const payload = (await response.json()) as PayloadLike;

  assert.equal(urls.length, 3);
  assert.ok(isDetectUrl(urls[0]));
  assert.ok(isClassifyUrl(urls[1]));
  assert.ok(isGeminiUrl(urls[2]));
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(payload.diagnosis?.confidence, 1);
  assert.match(user, /Tomato___Early_blight/);
});

test("second pass: several classes of the crop share the recalculated probability", async () => {
  configureKeys();
  let user = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isDetectUrl(String(url))) return Response.json([]);
    if (isClassifyUrl(String(url))) {
      return Response.json([
        { label: "Potato___Late_blight", score: 0.45 },
        { label: "Tomato___Early_blight", score: 0.15 },
        { label: "Tomato___Late_blight", score: 0.05 },
      ]);
    }
    assert.ok(isGeminiUrl(String(url)));
    user = geminiUserText(parseGeminiBody(init));
    return geminiReply("تقرير.");
  });

  const response = await POST(clarificationRequest("طماطم"));
  const payload = (await response.json()) as PayloadLike;

  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 75);
  assert.equal(payload.filtered?.matchedClasses, 2);
  assert.equal(payload.filtered?.droppedClasses, 1);
  assert.match(user, /75%/);
  assert.match(user, /اللفحة المتأخرة/);
});

test("second pass: an invalid echoed vector is ignored and the image re-classified", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    if (isDetectUrl(String(url))) return Response.json([]);
    if (isClassifyUrl(String(url))) return Response.json(TOMATO_BEHIND_POTATO);
    assert.ok(isGeminiUrl(String(url)));
    return geminiReply("تقرير.");
  });

  const response = await POST(
    clarificationRequest("طماطم", {
      // Not a MobileNetV2 class → the caller does not get to inject a verdict.
      predictions: [{ label: "Banana___Something_made_up", score: 0.99 }],
    }),
  );
  const payload = (await response.json()) as PayloadLike;

  assert.equal(urls.length, 3);
  assert.ok(isClassifyUrl(urls[1]));
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
});

/* ------------------------------------------------------------------ */
/*  3. Filtering edge cases                                            */
/* ------------------------------------------------------------------ */

test("'غير ذلك' keeps MobileNetV2's own ranking and skips the formatter lock", async () => {
  configureKeys();
  let system = "";
  let user = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isDetectUrl(String(url))) return Response.json([]);
    if (isClassifyUrl(String(url))) return Response.json(TOMATO_BEHIND_POTATO);
    assert.ok(isGeminiUrl(String(url)));
    const body = parseGeminiBody(init);
    system = geminiSystemText(body);
    user = geminiUserText(body);
    return geminiReply("تقرير.");
  });

  const response = await POST(clarificationRequest("غير ذلك"));
  const payload = (await response.json()) as PayloadLike;

  assert.equal(payload.diagnosis?.label, "Potato___Late_blight");
  assert.equal(payload.diagnosis?.confidence, 0.45);
  assert.equal(payload.diagnosis?.filtered, false);
  assert.equal(payload.filtered?.applied, false);
  // Opting out of the mask is a legitimate answer — no degradation warning.
  assert.doesNotMatch(warningText(payload), /تعذّرت التصفية/);
  assert.doesNotMatch(system, /You are a formatter/);
  assert.match(user, /Potato___Late_blight/);
});

test("a crop MobileNetV2 never predicted keeps the raw Top-1 and reports the miss", async () => {
  configureKeys();
  let user = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isDetectUrl(String(url))) return Response.json([]);
    if (isClassifyUrl(String(url))) return Response.json(TOMATO_BEHIND_POTATO);
    assert.ok(isGeminiUrl(String(url)));
    user = geminiUserText(parseGeminiBody(init));
    return geminiReply("تقرير.");
  });

  // No apple class in the vector → masking cannot apply.
  const response = await POST(clarificationRequest("تفاح"));
  const payload = (await response.json()) as PayloadLike;

  assert.equal(payload.diagnosis?.label, "Potato___Late_blight");
  assert.equal(payload.filtered?.applied, false);
  assert.equal(payload.filtered?.matchedClasses, 0);
  assert.match(warningText(payload), /تعذّرت التصفية/);
  assert.match(user, /Potato___Late_blight/);
});

/* ------------------------------------------------------------------ */
/*  4. Zero-failure: the masked verdict survives a full LLM outage     */
/* ------------------------------------------------------------------ */

test("both LLM stages down: the direct card reports the MASKED verdict", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isDetectUrl(String(url))) return Response.json([]);
    if (isClassifyUrl(String(url))) return Response.json(TOMATO_BEHIND_POTATO);
    if (isGeminiUrl(String(url))) {
      return Response.json({ error: { code: 503, message: "overloaded" } }, { status: 503 });
    }
    assert.ok(isChatUrl(String(url)));
    return new Response(null, { status: 503 });
  });

  const response = await POST(clarificationRequest("طماطم"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as PayloadLike;

  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.match(payload.reply, /Tomato___Early_blight/);
  assert.match(payload.reply, /100%/);
  assert.equal(payload.filtered?.changedTop, true);
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
});
