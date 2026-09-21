import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { dynamic, POST } from "../../src/app/api/assistant/route";

/** Step-2 keys used across the suite (values are deliberately padded). */
const GEMINI_KEY = "test-gemini";
const HF_KEY = "test-hf";

/**
 * Step-2 AbortController window, mirrored from the route: 18 s for the whole
 * Google Gemini model chain (a full Arabic answer needs 10–15 s on a cold
 * Flash model — the former 9 s window aborted healthy generations).
 */
const GEMINI_TIMEOUT_MS = 18_000;

/** Step-2 model chain, in order — must mirror the route's GEMINI_MODELS. */
const GEMINI_FALLBACK_ORDER = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
] as const;

/**
 * Step-1 field-trained ViT model chain, in order — must mirror the route's
 * HF_PLANT_MODELS (the old MobileNetV2 is gone):
 *   1. ViT-base fine-tuned on PlantVillage (38 crop-disease classes);
 *   2. ViT-base fine-tuned on the field "beans" leaf-disease dataset;
 *   3. ViT-tiny multi-crop last resort.
 */
const VIT_FALLBACK_ORDER = [
  "kimcomehome/plantvillage-vit-leaf-disease",
  "nateraw/vit-base-beans",
  "wambugu71/crop_leaf_diseases_vit",
] as const;

const originalKeys = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  // Hugging Face's conventional variable names — honoured by the route as
  // aliases, so they must be scrubbed too or a developer's shell token leaks
  // in.
  HF_TOKEN: process.env.HF_TOKEN,
  HGF_TOKEN: process.env.HGF_TOKEN,
};

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.HUGGINGFACE_API_KEY;
  delete process.env.HF_TOKEN;
  delete process.env.HGF_TOKEN;
  delete process.env.HF_LEAF_DETECT_MODELS;
  // No test may accidentally call a paid provider.
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

function request(withImage = false, history?: { role: "user" | "assistant"; text: string }[]) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "How should I irrigate tomatoes?",
      ...(withImage ? { image: { data: "aW1hZ2U=", mimeType: "image/jpeg" } } : {}),
      ...(history ? { history } : {}),
    }),
  });
}

function textRequest(message: string) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

/** Configure the provider keys (padded, to prove the route trims them). */
function configureKeys({ gemini = true, huggingface = true } = {}) {
  if (gemini) process.env.GEMINI_API_KEY = ` ${GEMINI_KEY} `;
  if (huggingface) process.env.HUGGINGFACE_API_KEY = ` ${HF_KEY} `;
}

/* ------------------------------------------------------------------ */
/*  Step 2 (Google Gemini) mock helpers                                 */
/* ------------------------------------------------------------------ */

const isGeminiUrl = (url: string) =>
  url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/") &&
  url.includes(":generateContent?key=");

/** The Gemini model id extracted from the generateContent URL. */
const requestedGeminiModel = (url: string) =>
  /\/models\/([^:?]+):generateContent/.exec(url)?.[1];

/** The `?key=…` query parameter the route authenticates with. */
const requestedGeminiKey = (url: string) => /[?&]key=([^&]*)/.exec(url)?.[1];

/** Mirrors a successful `models.generateContent` payload. */
const geminiReply = (text = "اسقِ في الصباح الباكر عند القاعدة.") =>
  Response.json({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  });

/** Answer with no usable text (e.g. token budget exhausted by reasoning). */
const geminiEmpty = () =>
  Response.json({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] });

/** Gemini's safety block: no candidates, only promptFeedback. */
const geminiBlocked = () =>
  Response.json({ candidates: [], promptFeedback: { blockReason: "SAFETY" } });

/** Google's REST error envelope (`{ error: { code, message, status } }`). */
const geminiHttpError = (status: number, message: string) =>
  Response.json(
    { error: { code: status, message, status: status === 429 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT" } },
    { status },
  );

/**
 * Google's 404 for a retired / mistyped model id — the exact production
 * failure signature (`models/gemini-1.5-flash is not found for API version
 * v1beta…`) that must walk the Gemini model chain.
 */
const geminiModelNotFound = (model: string) =>
  Response.json(
    {
      error: {
        code: 404,
        message: `models/${model} is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.`,
        status: "NOT_FOUND",
      },
    },
    { status: 404 },
  );

interface GeminiRequestBody {
  systemInstruction?: { parts?: { text?: string }[] };
  contents?: { role?: string; parts?: { text?: string }[] }[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string };
  };
}

const parseGeminiBody = (init: RequestInit): GeminiRequestBody =>
  JSON.parse(String(init.body ?? "{}")) as GeminiRequestBody;

const geminiSystemText = (body: GeminiRequestBody) =>
  (body.systemInstruction?.parts ?? []).map((part) => part.text ?? "").join("");

/** The Gemini user turn(s) — the LAST element is always the current turn. */
const geminiUserText = (body: GeminiRequestBody) =>
  (body.contents?.[body.contents.length - 1]?.parts ?? []).map((part) => part.text ?? "").join("");

/** The full Gemini `contents` array (history + current turn). */
const geminiContents = (body: GeminiRequestBody) => body.contents ?? [];

/* ------------------------------------------------------------------ */
/*  Step 1 (ViT vision) mock helpers                                    */
/* ------------------------------------------------------------------ */

/**
 * The Step 1 classifier endpoints (field-trained ViT chain on the
 * hf-inference router).
 */
const isClassifyUrl = (url: string) =>
  url.includes("router.huggingface.co/hf-inference/models/") && /plantvillage|vit|crop_leaf/i.test(url);

/** Mirrors a successful image-classification payload (ranked array). */
const vitReply = (
  items: { label: string; score: number }[] = [{ label: "Tomato___Early_blight", score: 0.95 }],
) => Response.json(items);

/** Mirrors HF's 503 while the ViT weights are still loading on the CPU tier. */
const vitLoading = (model: string, estimated_time = 23.4) =>
  Response.json({ error: `Model ${model} is currently loading`, estimated_time }, { status: 503 });

/* ------------------------------------------------------------------ */
/*  Shared response typing                                              */
/* ------------------------------------------------------------------ */

interface DiagnosisLike {
  label: string;
  labelAr: string;
  healthy: boolean;
  confidence: number;
  candidates: { label: string; score: number }[];
  model: string;
}

interface AssistantPayload {
  reply: string;
  diagnosis: DiagnosisLike | null;
  source: string;
  warnings?: string[];
}

/** `warnings[]` flattened for the `assert.match(…)` assertions below. */
const warningText = (payload: AssistantPayload) => (payload.warnings ?? []).join(" | ");

test("assistant route explicitly uses dynamic rendering", () => {
  assert.equal(dynamic, "force-dynamic");
});

/* ------------------------------------------------------------------ */
/*  Key handling — at least one provider key must be configured         */
/* ------------------------------------------------------------------ */

const MISSING_KEY_CASES: [string, string | undefined, string | undefined][] = [
  ["both absent", undefined, undefined],
  ["both blank", "   ", "\t"],
  ["both whitespace-only", "\t", "  \n "],
];

for (const [name, geminiKey, hfKey] of MISSING_KEY_CASES) {
  test(`missing keys: ${name} returns 503 MISSING_KEYS without calling providers`, async () => {
    if (geminiKey !== undefined) process.env.GEMINI_API_KEY = geminiKey;
    if (hfKey !== undefined) process.env.HUGGINGFACE_API_KEY = hfKey;
    const upstream = mock.method(globalThis, "fetch");
    for (const withImage of [false, true]) {
      const response = await POST(request(withImage));
      // Misconfiguration is the ONLY non-200/4xx outcome — 503, never 500.
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "API keys missing on server",
        code: "MISSING_KEYS",
      });
    }
    assert.equal(upstream.mock.callCount(), 0);
  });
}

test("keys are read per request, not when the route module loads", async () => {
  assert.equal((await POST(request())).status, 503);

  // A Gemini-only deployment is a valid configuration: Step 2 answers.
  process.env.GEMINI_API_KEY = ` ${GEMINI_KEY} `;
  const upstream = mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(isGeminiUrl(String(url)));
    return geminiReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "Water in the morning.",
    diagnosis: null,
    source: "llm",
  });
  assert.equal(upstream.mock.callCount(), 1);

  delete process.env.GEMINI_API_KEY;
  assert.equal((await POST(request())).status, 503);
  assert.equal(upstream.mock.callCount(), 1);
});

test("HGF_TOKEN (this project's short alias) is honoured for the Hugging Face token", async () => {
  // Only the alias is set — HUGGINGFACE_API_KEY and HF_TOKEN are blank.
  process.env.HUGGINGFACE_API_KEY = "   ";
  process.env.HF_TOKEN = "";
  process.env.HGF_TOKEN = " hf_alias_token ";
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (isGeminiUrl(String(url))) return geminiReply("تم.");
    // The alias authenticates the vision call too.
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer hf_alias_token");
    return vitReply();
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");
  // No 503 MISSING_KEYS: the alias counts as a configured provider key.
  assert.ok(urls.some(isClassifyUrl));
  assert.doesNotMatch(JSON.stringify(payload), /hf_alias_token/);
});

/* ------------------------------------------------------------------ */
/*  Step 1 — field-trained ViT vision diagnosis (HF Inference API)      */
/* ------------------------------------------------------------------ */

test("Step 1 classifies with the primary field-trained ViT and feeds the differential to Step 2 (hybrid)", async () => {
  configureKeys();
  const urls: string[] = [];
  let geminiUser = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (isGeminiUrl(String(url))) {
      geminiUser = geminiUserText(parseGeminiBody(init));
      return geminiReply("أزل الأوراق المصابة ثم عالج بمبيد نحاسي.");
    }
    // Step 1 — the FIELD-TRAINED ViT chain (MobileNetV2 is gone): the
    // primary id is the PlantVillage ViT-base.
    assert.ok(isClassifyUrl(String(url)), `unexpected upstream: ${url}`);
    assert.match(String(url), /kimcomehome\/plantvillage-vit-leaf-disease/);
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${HF_KEY}`);
    return vitReply([
      { label: "Tomato___Late_blight", score: 0.03 },
      { label: "Tomato___Early_blight", score: 0.95 },
      { label: "Tomato___Leaf_Mold", score: 0.02 },
    ]);
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 95);
  assert.equal(payload.diagnosis?.model, VIT_FALLBACK_ORDER[0]);
  assert.equal(payload.reply, "أزل الأوراق المصابة ثم عالج بمبيد نحاسي.");

  // Vision first, then the Gemini LLM — one call each (no HF LLM stage).
  assert.equal(urls.length, 2);
  assert.ok(isClassifyUrl(urls[0]));
  assert.ok(isGeminiUrl(urls[1]));
  // The vision verdict travels into the Gemini prompt: disease label…
  assert.match(geminiUser, /Tomato___Early_blight/);
  assert.match(geminiUser, /95%/);
  // …plus the differential diagnoses (Late blight 3%, Leaf mold 2% in Arabic).
  assert.match(geminiUser, /اللفحة المتأخرة/);
  assert.match(geminiUser, /عفن الأوراق/);
  assert.match(geminiUser, /3%/);
  assert.match(geminiUser, /How should I irrigate tomatoes\?/);
  // Secrets never travel back to the client.
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

test("Step 1 parses the returned array: sorts by score, keeps top-3 differential candidates", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiReply("تم.");
    // Unsorted array — the route must sort and pick the 95% class as top,
    // and report up to 3 candidates (differential diagnoses), highest first.
    return vitReply([
      { label: "Tomato___Late_blight", score: 0.03 },
      { label: "Tomato___Early_blight", score: 0.95 },
      { label: "Tomato___healthy", score: 0.02 },
      { label: "Tomato___Leaf_Mold", score: 0.01 },
    ]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 95);
  assert.equal(payload.source, "hybrid");
  assert.deepEqual(payload.diagnosis?.candidates, [
    { label: "Tomato___Early_blight", score: 0.95 },
    { label: "Tomato___Late_blight", score: 0.03 },
    { label: "Tomato___healthy", score: 0.02 },
  ]);
});

test("Step 1 walks the ViT chain: 503 model-loading on the primary falls back to the next model", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    if (isGeminiUrl(String(url))) return geminiReply("تم.");
    const id = /models\/(.+)$/.exec(String(url))?.[1] ?? "";
    if (id === VIT_FALLBACK_ORDER[0]) return vitLoading(id);
    // The second id in the chain answers (the beans field dataset's labels).
    assert.equal(id, VIT_FALLBACK_ORDER[1]);
    return vitReply([{ label: "bean_rust", score: 0.91 }]);
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.label, "bean_rust");
  assert.equal(payload.diagnosis?.model, VIT_FALLBACK_ORDER[1]);
  // The primary 503'd (loading), the fallback answered — two vision calls.
  assert.deepEqual(
    urls
      .filter(isClassifyUrl)
      .map((url) => /models\/(.+)$/.exec(url)?.[1]),
    [VIT_FALLBACK_ORDER[0], VIT_FALLBACK_ORDER[1]],
  );
});

test("Step 1 walks the ViT chain on 404 (checkpoint gone) and answers from the last id", async () => {
  configureKeys();
  const models: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiReply("تم.");
    if (isClassifyUrl(String(url))) {
      const id = /models\/(.+)$/.exec(String(url))?.[1] ?? "";
      models.push(id);
      // Both primary ids are gone (404 / not served) → the ViT-tiny last
      // resort answers.
      return id === VIT_FALLBACK_ORDER[2]
        ? vitReply([{ label: "Corn_(maize)___Common_rust_", score: 0.88 }])
        : Response.json({ error: `Model ${id} not found` }, { status: 404 });
    }
    throw new Error(`unexpected upstream: ${url}`);
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.label, "Corn_(maize)___Common_rust_");
  assert.equal(payload.diagnosis?.model, VIT_FALLBACK_ORDER[2]);
  assert.deepEqual(models, [...VIT_FALLBACK_ORDER]);
});

test("Step 1 healthy verdict is localised and marked healthy", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiReply("النبتة سليمة.");
    return vitReply([{ label: "Tomato___healthy", score: 0.97 }]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.healthy, true);
  assert.match(payload.diagnosis?.labelAr ?? "", /سليمة/);
});

/* ------------------------------------------------------------------ */
/*  Step 2 — Google Gemini: the SOLE LLM / final response generator     */
/* ------------------------------------------------------------------ */

test("Step 2 answers from gemini-3.5-flash with 200 { source: \"llm\" }", async () => {
  configureKeys();
  const calls: { url: string; init: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
    return geminiReply("اسقِ الطماطم صباحاً عند القاعدة كل 3 أيام.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    // Gemini's generated Arabic response, verbatim.
    reply: "اسقِ الطماطم صباحاً عند القاعدة كل 3 أيام.",
    diagnosis: null,
    source: "llm",
  });

  // A single round-trip: Gemini is the sole LLM. No vision model (no image)
  // and no other provider is touched when Step 2 answers.
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(
    url,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_KEY}`,
  );
  assert.equal(requestedGeminiModel(url), GEMINI_FALLBACK_ORDER[0]);
  assert.equal(requestedGeminiKey(url), GEMINI_KEY);
  // Bounded by an AbortController.
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal?.aborted, false);
  assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
  // The Gemini 3.x primary gets a qualitative thinking level — a numeric
  // thinkingBudget would 400 on this generation.
  assert.equal(parseGeminiBody(init).generationConfig?.thinkingConfig?.thinkingLevel, "low");
  assert.equal(parseGeminiBody(init).generationConfig?.thinkingConfig?.thinkingBudget, undefined);
});

test("Step 2 keeps the gemini-3.5-flash endpoint when the API key rotates", async () => {
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return geminiReply();
  });

  const keys = [GEMINI_KEY, "rotated-gemini-key"];
  for (const key of keys) {
    process.env.GEMINI_API_KEY = ` ${key} `;
    const response = await POST(request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, "llm");
  }

  assert.deepEqual(
    urls,
    keys.map(
      (key) =>
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`,
    ),
  );
});

test("Step 2 sends the concise Arabic system instruction, the query and the profile context", async () => {
  configureKeys();
  let body: GeminiRequestBody | undefined;
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    body = parseGeminiBody(init);
    return geminiReply();
  });

  const withContext = new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "كيف أسقي الطماطم؟",
      context: {
        wilayaCode: "07",
        wilayaName: "بسكرة",
        crop: "الطماطم",
        role: "farmer",
        displayName: "أمين",
      },
    }),
  });
  assert.equal((await POST(withContext)).status, 200);

  assert.ok(body);
  // The mandated expert-advisor instruction ("أنت مساعد زراعي خبير…").
  const system = geminiSystemText(body);
  assert.match(system, /أنت مساعد زراعي خبير/);
  assert.match(system, /دون مقدمات أو إطالة/);
  assert.match(system, /باللغة العربية/);
  assert.match(system, /عملي/);
  // The user turn: query + Firestore profile context (region, crop type…).
  const user = geminiUserText(body);
  assert.match(user, /كيف أسقي الطماطم؟/);
  assert.match(user, /بسكرة/);
  assert.match(user, /الطماطم/);
  // No history was sent → exactly one contents turn (the current user turn).
  assert.equal(body.contents?.length, 1);
  assert.equal(body.contents?.[0]?.role, "user");
  // Concise output is enforced with a hard token cap.
  assert.ok(
    typeof body.generationConfig?.maxOutputTokens === "number" &&
      body.generationConfig.maxOutputTokens <= 2048,
  );
  // Answer-first thinking, model-aware: the Gemini 3.x primary takes
  // thinkingLevel (2.5 would reject it with a 400).
  assert.equal(body.generationConfig?.thinkingConfig?.thinkingLevel, "low");
  assert.equal(body.generationConfig?.thinkingConfig?.thinkingBudget, undefined);
});

for (const [name, failure] of [
  ["HTTP 400 invalid API key", () => geminiHttpError(400, "API key not valid. Please pass a valid API key.")],
  ["HTTP 429 quota exhausted", () => geminiHttpError(429, "Resource has been exhausted (e.g. check quota).")],
  ["HTTP 500 upstream error", () => new Response(null, { status: 500 })],
  ["an empty candidate list", () => geminiEmpty()],
  ["a safety block", () => geminiBlocked()],
] as const) {
  test(`Step 2 ${name} degrades to the built-in formatter (source: direct, never 500)`, async () => {
    configureKeys();
    const calls: { url: string; init: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
      return failure();
    });

    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    // Gemini is the sole LLM — when it fails, the built-in formatter
    // answers. No other provider round-trip is made.
    assert.equal(payload.source, "direct");
    assert.match(payload.reply, /الوضع الأساسي/);
    assert.equal(calls.length, 1);
    assert.equal(requestedGeminiModel(calls[0].url), GEMINI_FALLBACK_ORDER[0]);
    assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  });
}

for (const [name, status, body, expectedDetail] of [
  [
    "structured Google error",
    429,
    JSON.stringify({
      error: {
        code: 429,
        message: "Quota exhausted.",
        status: "RESOURCE_EXHAUSTED",
        details: [{ description: "Diagnostic details. ".repeat(50) }],
      },
    }),
    "HTTP 429 — Quota exhausted.",
  ],
  ["plain-text error", 502, "Bad gateway\nUpstream unavailable.", "HTTP 502 — Bad gateway"],
  ["empty error", 500, "", "HTTP 500"],
] as const) {
  test(`Step 2 logs the exact status and full ${name} while preserving the fallback`, async () => {
    configureKeys();
    const errorLog = mock.method(console, "error", () => {});
    mock.method(globalThis, "fetch", async (url: string) => {
      if (isGeminiUrl(String(url))) return new Response(body, { status });
      throw new Error(`unexpected upstream: ${url}`);
    });

    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "direct");
    assert.ok(warningText(payload).includes(expectedDetail));
    assert.equal(errorLog.mock.callCount(), 1);
    assert.deepEqual(errorLog.mock.calls[0].arguments, ["[Gemini Error]", status, body]);
  });
}

test("Step 2 network failure degrades to the built-in formatter", async () => {
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) throw new TypeError("fetch failed");
    throw new Error(`unexpected upstream: ${url}`);
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  assert.match(warningText(payload), /fetch failed/);
  assert.equal(upstream.mock.callCount(), 1);
});

test("Step 2 timeout aborts the Gemini round-trip via AbortController after 18 s, then the formatter answers", async () => {
  configureKeys();
  const calls: { url: string; init: RequestInit }[] = [];
  let geminiAborted = false;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (isGeminiUrl(String(url))) {
      // Never answers — the route's AbortController must cancel the round-trip.
      const signal = init.signal as AbortSignal;
      assert.ok(signal instanceof AbortSignal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          geminiAborted = true;
          reject(signal.reason ?? new Error("aborted"));
        });
      });
    }
    throw new Error(`unexpected upstream: ${url}`);
  });

  // Fast-forward the 18 s Step-2 window instead of waiting for it.
  mock.timers.enable({ apis: ["setTimeout"] });
  let response: Response;
  try {
    const pending = POST(request());
    // Let the handler reach the hanging Gemini round-trip…
    await new Promise((resolve) => setImmediate(resolve));
    // …the former 9 s window must NOT fire any more: a healthy 10–15 s
    // Gemini generation has to be allowed to finish…
    mock.timers.tick(9_001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(geminiAborted, false, "Gemini was aborted before the 18 s deadline");
    assert.equal(calls.length, 1, "a second upstream round-trip started before the deadline");
    // …only the 18 s deadline aborts the round-trip.
    mock.timers.tick(GEMINI_TIMEOUT_MS - 9_001 + 1);
    response = await pending;
  } finally {
    mock.timers.reset();
  }

  assert.equal(geminiAborted, true);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  // Gemini is the sole LLM: after the abort the built-in formatter answers.
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  assert.match(warningText(payload), /timeout after 18000 ms/);
  // The abort happened inside the single Gemini round-trip.
  assert.equal(calls.length, 1);
  assert.ok(calls.every((call) => isGeminiUrl(call.url)));
});

/* ------------------------------------------------------------------ */
/*  Step 2 — Gemini model chain (retired-id 404 fallback)               */
/* ------------------------------------------------------------------ */

test("Step 2 walks the Gemini chain: a 404 'model not found' on the primary falls back to the next model", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    if (isGeminiUrl(String(url))) {
      const model = requestedGeminiModel(String(url)) ?? "";
      return model === GEMINI_FALLBACK_ORDER[0]
        ? geminiModelNotFound(model)
        : geminiReply("اسقِ في الصباح الباكر.");
    }
    // Step 2 still answers — no other provider may run.
    throw new Error(`unexpected upstream: ${url}`);
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "اسقِ في الصباح الباكر.");
  // The retired primary 404s → the next chain id answers.
  assert.deepEqual(urls.map(requestedGeminiModel), [
    GEMINI_FALLBACK_ORDER[0],
    GEMINI_FALLBACK_ORDER[1],
  ]);
  assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  assert.match(warningText(payload), /is not found for API version v1beta/);
});

test("Step 2 walks the whole Gemini chain when every model 404s, then the formatter answers", async () => {
  configureKeys();
  const geminiUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiUrls.push(String(url));
      return geminiModelNotFound(requestedGeminiModel(String(url)) ?? "unknown");
    }
    throw new Error(`unexpected upstream: ${url}`);
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  // Every retired id is walked before degrading to the formatter…
  assert.deepEqual(geminiUrls.map(requestedGeminiModel), [...GEMINI_FALLBACK_ORDER]);
  // …and the non-fatal warning names the whole tried chain.
  const warning = warningText(payload);
  assert.match(warning, /Step 2 Gemini unavailable/);
  assert.match(warning, /no Gemini model could answer/);
  for (const model of GEMINI_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

test("Step 2: a 429 quota error fails fast without walking the Gemini model chain", async () => {
  configureKeys();
  const geminiUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiUrls.push(String(url));
      return geminiHttpError(429, "Resource has been exhausted (e.g. check quota).");
    }
    throw new Error(`unexpected upstream: ${url}`);
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  // The formatter still answers — the failure is non-fatal…
  assert.equal(payload.source, "direct");
  assert.match(warningText(payload), /HTTP 429/);
  // …but a quota error is an account problem, not a model problem: exactly
  // one Gemini attempt, no chain walk.
  assert.equal(geminiUrls.length, 1);
  assert.equal(requestedGeminiModel(geminiUrls[0]), GEMINI_FALLBACK_ORDER[0]);
});

test("Step 2 sends each model generation its own thinking config (thinkingLevel for 3.x, thinkingBudget for 2.5)", async () => {
  configureKeys();
  const bodies = new Map<string, GeminiRequestBody>();
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) {
      const model = requestedGeminiModel(String(url)) ?? "";
      bodies.set(model, parseGeminiBody(init));
      // 404 every 3.x id so the walk reaches the 2.5 model; it answers.
      const last = GEMINI_FALLBACK_ORDER[GEMINI_FALLBACK_ORDER.length - 1];
      return model === last
        ? geminiReply("اسقِ في الصباح الباكر.")
        : geminiModelNotFound(model);
    }
    throw new Error(`unexpected upstream: ${url}`);
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as AssistantPayload).source, "llm");

  // Gemini 3.x: qualitative level, no numeric budget…
  for (const model of GEMINI_FALLBACK_ORDER.slice(0, -1)) {
    const gemini3 = bodies.get(model);
    assert.ok(gemini3, `no request body captured for ${model}`);
    assert.equal(gemini3.generationConfig?.thinkingConfig?.thinkingLevel, "low");
    assert.equal(gemini3.generationConfig?.thinkingConfig?.thinkingBudget, undefined);
  }
  // …Gemini 2.5: numeric zero budget, no level (each 400s the other's).
  const last = GEMINI_FALLBACK_ORDER[GEMINI_FALLBACK_ORDER.length - 1];
  const gemini25 = bodies.get(last);
  assert.ok(gemini25, `no request body captured for ${last}`);
  assert.equal(gemini25.generationConfig?.thinkingConfig?.thinkingBudget, 0);
  assert.equal(gemini25.generationConfig?.thinkingConfig?.thinkingLevel, undefined);
});

/* ------------------------------------------------------------------ */
/*  Step 2 — conversation history (smart memory)                        */
/* ------------------------------------------------------------------ */

test("Step 2 receives the client-sent conversation history as alternating Gemini turns", async () => {
  configureKeys();
  let contents: { role?: string; parts?: { text?: string }[] }[] = [];
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    contents = geminiContents(parseGeminiBody(init));
    return geminiReply();
  });

  const response = await POST(
    request(false, [
      { role: "user", text: "عندي بقع صفراء على أوراق الطماطم" },
      { role: "assistant", text: "احتمال اللفحة المبكرة — أرسل صورة." },
      { role: "user", text: "إليها الصورة" },
    ]),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, "llm");

  // history (assistant→model) + the final current user turn.
  assert.deepEqual(
    contents.map((turn) => turn.role),
    ["user", "model", "user", "user"],
  );
  assert.equal(contents[0]?.parts?.[0]?.text, "عندي بقع صفراء على أوراق الطماطم");
  assert.equal(contents[1]?.parts?.[0]?.text, "احتمال اللفحة المبكرة — أرسل صورة.");
  assert.equal(contents[2]?.parts?.[0]?.text, "إليها الصورة");
  // The current turn still carries the query.
  assert.match(contents[3]?.parts?.[0]?.text ?? "", /How should I irrigate tomatoes\?/);
});

test("Step 2 sanitizes malformed history: bad roles dropped, empty text dropped, consecutive turns merged, leading assistant dropped", async () => {
  configureKeys();
  let contents: { role?: string; parts?: { text?: string }[] }[] = [];
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    contents = geminiContents(parseGeminiBody(init));
    return geminiReply();
  });

  const response = await POST(
    request(false, [
      { role: "assistant", text: "leading assistant turn — must be dropped" },
      { role: "user", text: "أ" },
      { role: "user", text: "ب" },
      { role: "system", text: "invalid role — dropped" } as never,
      { role: "user", text: "   " },
      { role: "assistant", text: "ج" },
      "not-an-object" as never,
    ]),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, "llm");

  // Leading assistant dropped; the two consecutive user turns merged into
  // one; invalid role / blank text / non-object dropped; final current
  // user turn appended.
  assert.deepEqual(
    contents.map((turn) => turn.role),
    ["user", "model", "user"],
  );
  assert.equal(contents[0]?.parts?.[0]?.text, "أ\nب");
  assert.equal(contents[1]?.parts?.[0]?.text, "ج");
  assert.match(contents[2]?.parts?.[0]?.text ?? "", /How should I irrigate tomatoes\?/);
});

test("Step 2 caps the history at the recent 10 turns", async () => {
  configureKeys();
  let contents: { role?: string; parts?: { text?: string }[] }[] = [];
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    contents = geminiContents(parseGeminiBody(init));
    return geminiReply();
  });

  const history = Array.from({ length: 15 }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `message-${i}`,
  }));
  await POST(request(false, history));

  // The 10 most recent history turns are kept (message-5…message-14); the
  // leading one (message-5, an assistant turn) is dropped because Gemini's
  // first content must be a user turn — 9 turns + the current user turn.
  assert.equal(contents.length, 10);
  assert.equal(contents[0]?.parts?.[0]?.text, "message-6");
  assert.equal(contents[8]?.parts?.[0]?.text, "message-14");
});

/* ------------------------------------------------------------------ */
/*  Deployment shapes — Gemini-only / Hugging-Face-only                 */
/* ------------------------------------------------------------------ */

test("Gemini-only deployment: Step 2 answers and the vision steps are never called", async () => {
  configureKeys({ huggingface: false });
  const upstream = mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(isGeminiUrl(String(url)));
    return geminiReply("اسقِ صباحاً.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "اسقِ صباحاً.",
    diagnosis: null,
    source: "llm",
  });
  assert.equal(upstream.mock.callCount(), 1);
});

test("Gemini-only deployment: a Gemini failure degrades to the direct formatter and says the Gemini key path is clear", async () => {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  process.env.HUGGINGFACE_API_KEY = "   ";
  const errorLog = mock.method(console, "error", () => {});
  mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(isGeminiUrl(String(url)), `no vision call may be made without an HF key: ${url}`);
    return new Response(null, { status: 503 });
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  assert.match(warningText(payload), /Reply formatted locally/);
  assert.ok(
    errorLog.mock.calls.every(
      (call) => !/Safety Net/.test(String(call.arguments[0])),
    ),
  );
});

for (const [name, hfValue] of [
  ["unset", undefined],
  ["blank", "   "],
] as const) {
  test(`no valid HF token (${name}): Steps 0–1 are skipped synchronously — no vision request, no throw, no delay`, async () => {
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    if (hfValue !== undefined) process.env.HUGGINGFACE_API_KEY = hfValue;
    const upstream = mock.method(globalThis, "fetch", async (url: string) => {
      if (isGeminiUrl(String(url))) return geminiReply("صف أعراض الورقة نصياً.");
      throw new Error(`vision must not be attempted without a token: ${url}`);
    });

    // Freeze every timer: if the skip involved any wait (a retry back-off, a
    // timeout race…) the handler could never resolve without a tick.
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let response: Response;
    try {
      response = await POST(request(true));
    } finally {
      mock.timers.reset();
    }

    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "llm");
    // Exactly one upstream call — Gemini. Nothing went to Hugging Face.
    assert.equal(upstream.mock.callCount(), 1);
    assert.ok(upstream.mock.calls.every((call) => isGeminiUrl(String(call.arguments[0]))));
    const warning = warningText(payload);
    assert.match(warning, /Step 1 vision unavailable — HUGGINGFACE_API_KEY is not configured/);
    assert.match(warning, /HF_TOKEN \/ HGF_TOKEN unset too/);
  });
}

test("Gemini-only deployment: an image request skips the vision step and still answers from Gemini", async () => {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(isGeminiUrl(String(url)), `vision must be skipped without an HF key: ${url}`);
    return geminiReply("صف أعراض الورقة نصياً.");
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.diagnosis, null);
  assert.match(warningText(payload), /Step 1 vision unavailable/);
  assert.match(warningText(payload), /HUGGINGFACE_API_KEY is not configured/);
});

test("Hugging-Face-only deployment: Step 2 is skipped by config and the built-in formatter answers", async () => {
  process.env.HUGGINGFACE_API_KEY = HF_KEY;
  const calls: { url: string; init: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    // Only the ViT classifier may be called — no chat-completions router.
    assert.ok(isClassifyUrl(String(url)), `unexpected upstream: ${url}`);
    return vitReply([{ label: "Tomato___healthy", score: 0.95 }]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  // Diagnosis computed locally… but Gemini is the sole LLM and its key is
  // missing, so the direct diagnosis card answers instead.
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis?.healthy, true);
  assert.match(payload.reply, /## 🔬 التشخيص/);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), `Bearer ${HF_KEY}`);
  assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  assert.match(warningText(payload), /GEMINI_API_KEY is not configured/);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

test("Hugging-Face-only deployment: a text request answers basic-mode (no LLM at all)", async () => {
  process.env.HUGGINGFACE_API_KEY = HF_KEY;
  const upstream = mock.method(globalThis, "fetch");
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  assert.match(warningText(payload), /GEMINI_API_KEY is not configured/);
  assert.equal(upstream.mock.callCount(), 0);
});

/* ------------------------------------------------------------------ */
/*  Zero-failure strategy — safety-net direct formatting                */
/* ------------------------------------------------------------------ */

test("zero-failure: Step 2 down after a successful Step 1 returns 200 with source=direct and the diagnosis card", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
    if (isClassifyUrl(String(url))) {
      return vitReply([
        { label: "Tomato___Late_blight", score: 0.03 },
        { label: "Tomato___Early_blight", score: 0.95 },
        { label: "Tomato___healthy", score: 0.02 },
      ]);
    }
    throw new Error(`unexpected upstream: ${url}`);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  // Clean concise Arabic Markdown card built from the Step 1 label + confidence.
  assert.match(payload.reply, /## 🔬 التشخيص/);
  assert.match(payload.reply, /Tomato___Early_blight/);
  assert.match(payload.reply, /95%/);
  assert.match(payload.reply, /الطماطم/);
  assert.match(payload.reply, /## 💊 خطة العلاج/);
  assert.match(payload.reply, /## 🛡️ الوقاية مستقبلاً/);
  // Failures are reported as non-fatal warnings, not a 500.
  assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

test("zero-failure: healthy diagnosis gets a direct reassurance card with prevention tips", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "overloaded");
    if (isClassifyUrl(String(url))) return vitReply([{ label: "Tomato___healthy", score: 0.97 }]);
    throw new Error(`unexpected upstream: ${url}`);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis?.healthy, true);
  assert.match(payload.reply, /سليمة/);
  assert.match(payload.reply, /97%/);
  assert.match(payload.reply, /## 🛡️ وقاية/);
  assert.doesNotMatch(payload.reply, /## 💊 خطة العلاج/);
});

test("zero-failure: low-confidence diagnosis asks for a clearer photo in the direct card", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return new Response(null, { status: 503 });
    if (isClassifyUrl(String(url))) return vitReply([{ label: "Tomato___Late_blight", score: 0.3 }]);
    throw new Error(`unexpected upstream: ${url}`);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /صورة أوضح/);
});

for (const failure of ["http", "network", "empty"] as const) {
  test(`zero-failure: text-only ${failure} upstream failure answers 200 basic-mode (not MISSING_KEYS, not 500)`, async () => {
    configureKeys();
    mock.method(globalThis, "fetch", async (url: string) => {
      if (!isGeminiUrl(String(url))) throw new Error(`unexpected upstream: ${url}`);
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "empty") return geminiEmpty();
      return new Response(null, { status: 503 });
    });
    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "direct");
    assert.equal(payload.diagnosis, null);
    // Non-greeting question → polite basic-mode explanation, not a config error.
    assert.match(payload.reply, /الوضع الأساسي/);
    assert.notEqual(payload.reply, "API keys missing on server");
    assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  });
}

/* ------------------------------------------------------------------ */
/*  Zero-failure strategy — text-only basic-mode replies                */
/* ------------------------------------------------------------------ */

for (const greeting of ["هلا", "مرحبا", "السلام عليكم", "أهلا وسهلا", "السلامُ عليكم ورحمةُ الله"] as const) {
  test(`zero-failure: text-only Gemini outage greets back a simple greeting (${greeting}) with 200 direct`, async () => {
    configureKeys();
    mock.method(globalThis, "fetch", async (url: string) =>
      isGeminiUrl(String(url)) ? geminiHttpError(503, "overloaded") : new Response(null, { status: 503 }),
    );
    const response = await POST(textRequest(greeting));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "direct");
    assert.equal(payload.diagnosis, null);
    // Greets the user back warmly…
    assert.match(payload.reply, /وعليكم السلام|أهلاً وسهلاً/);
    // …and asks how it can help with the farm/crops.
    assert.match(payload.reply, /نساعدك/);
    assert.match(payload.reply, /ضيعتك|محصولك/);
    assert.match(warningText(payload), /Step 2 Gemini unavailable/);
  });
}

test("zero-failure: text-only Gemini outage answers a farm question with the polite basic-mode fallback", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) =>
    isGeminiUrl(String(url)) ? new Response(null, { status: 503 }) : new Response(null, { status: 503 }),
  );
  const response = await POST(textRequest("كيف أسقي الطماطم في بسكرة؟"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  // Explains the basic mode and invites symptoms or a leaf photo.
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.match(payload.reply, /أعراض/);
  assert.match(payload.reply, /صورة/);
  // The fallback must not look like a greeting reply.
  assert.doesNotMatch(payload.reply, /وعليكم السلام/);
});

test("zero-failure: a long message is never mistaken for a greeting", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) =>
    isGeminiUrl(String(url)) ? new Response(null, { status: 503 }) : new Response(null, { status: 503 }),
  );
  const response = await POST(
    textRequest("السلام عليكم، عندي بقع صفراء على أوراق الطماطم منذ أسبوع وبدأت تنتشر للبيت البلاستيكي المجاور فماذا أفعل"),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
});

test("final safety net: an unexpected internal exception still answers 200 direct (never 500)", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async () => geminiReply("اسقِ في الصباح."));
  // Simulate a bug deep inside the success path: the first response
  // serialization explodes; the route's outer try/catch must absorb it.
  let jsonCalls = 0;
  const original = NextResponse.json.bind(NextResponse);
  mock.method(NextResponse, "json", ((...args: Parameters<typeof NextResponse.json>) => {
    jsonCalls += 1;
    if (jsonCalls === 1) throw new Error("simulated serialization bug");
    return original(...args);
  }) as typeof NextResponse.json);
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(warningText(payload), /simulated serialization bug/);
  assert.equal(jsonCalls, 2);
});

/* ------------------------------------------------------------------ */
/*  Zero-failure strategy — graceful vision degradation                 */
/* ------------------------------------------------------------------ */

test("zero-failure: HF vision failure degrades to Step 2 with a Step 1 warning (never 500)", async () => {
  configureKeys();
  let geminiCalls = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiCalls += 1;
      return geminiReply("Water in the morning.");
    }
    // Step 1 fails on every ViT model → Step 2 must still answer the text.
    return new Response(null, { status: 503 });
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.diagnosis, null);
  assert.match(warningText(payload), /Step 1 vision unavailable/);
  assert.ok(geminiCalls >= 1);
});

test("zero-failure: HF 503 model-loading on every ViT plus Gemini down answers 200 asking to retry the photo", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
    if (isClassifyUrl(String(url))) {
      const id = /models\/(.+)$/.exec(String(url))?.[1] ?? "unknown";
      return vitLoading(id);
    }
    throw new Error(`unexpected upstream: ${url}`);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  // Both classification and Gemini failed completely → basic-mode reply +
  // the photo-retry note (the case the UI's amber warning is for).
  assert.match(payload.reply, /تعذّر تحليل صورة الورقة/);
  assert.match(payload.reply, /أعد المحاولة/);
  const warning = warningText(payload);
  assert.match(warning, /Step 1 vision unavailable/);
  assert.match(warning, /loading/i);
  assert.match(warning, /Step 2 Gemini unavailable/);
});

/* ------------------------------------------------------------------ */
/*  Step 0 — leaf Detection & Cropping before the classifier           */
/* ------------------------------------------------------------------ */

import sharp from "sharp";

/** A real decodable JPEG (solid "leaf green" 64×48 frame) for Step 0. */
const LEAF_JPEG = await sharp({
  create: { width: 64, height: 48, channels: 3, background: { r: 34, g: 120, b: 45 } },
})
  .jpeg()
  .toBuffer();
const LEAF_JPEG_B64 = LEAF_JPEG.toString("base64");

function imageRequest(data: string, mimeType = "image/jpeg") {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "شخّص هذه الورقة", image: { data, mimeType } }),
  });
}

/** Step 0 detector endpoints (DETR family on the hf-inference router). */
const isDetectUrl = (url: string) =>
  url.includes("router.huggingface.co/hf-inference/models/") && /detr/i.test(url);

/** Raw bytes body of an upstream call, base64-encoded for comparisons. */
const bodyB64 = (init: RequestInit) => Buffer.from(init.body as Uint8Array).toString("base64");

/** The Step 0 mock answer: one high-confidence leaf box at (10,8)-(50,40). */
const leafDetection = () =>
  Response.json([{ label: "LABEL_1", score: 0.87, box: { xmin: 10, ymin: 8, xmax: 50, ymax: 40 } }]);

interface PreprocessingLike {
  status: string;
  detector: string | null;
  box: [number, number, number, number] | null;
  durationMs: number;
}

test("Step 0 detects the leaf and Step 1 receives ONLY the cropped pixels", async () => {
  configureKeys();
  const urls: string[] = [];
  let classifyBody = "";
  let classifyContentType: string | null = null;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (isGeminiUrl(String(url))) return geminiReply("الاقتصاص حسّن الدقة.");
    if (isDetectUrl(String(url))) {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${HF_KEY}`);
      return leafDetection();
    }
    assert.ok(isClassifyUrl(String(url)), `unexpected upstream: ${url}`);
    classifyBody = bodyB64(init);
    classifyContentType = new Headers(init.headers).get("Content-Type");
    return vitReply();
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };

  // Pipeline order: detect → classify (ViT) → Gemini.
  assert.equal(urls.length, 3);
  assert.ok(isDetectUrl(urls[0]));
  assert.match(urls[0], /detr-finetuned-plantdoc/);
  assert.ok(isClassifyUrl(urls[1]));
  assert.ok(isGeminiUrl(urls[2]));

  // The classifier saw the re-encoded CROP, never the original frame.
  assert.notEqual(classifyBody, LEAF_JPEG_B64);
  assert.equal(classifyContentType, "image/jpeg");

  // Crop window: 40×32 box + 12% padding (5,4) → (5,4) 50×40 on the 64×48 frame.
  assert.equal(payload.preprocessing?.status, "cropped");
  assert.equal(payload.preprocessing?.detector, "suryanshgoel/detr-finetuned-plantdoc");
  assert.deepEqual(payload.preprocessing?.box, [5, 4, 50, 40]);
  assert.equal(typeof payload.preprocessing?.durationMs, "number");

  assert.equal(payload.source, "hybrid");
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

test("Step 0 with no usable detection keeps the full frame for Step 1", async () => {
  configureKeys();
  let classifyBody = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) return geminiReply("الصورة كاملة.");
    if (isDetectUrl(String(url))) return Response.json([]);
    assert.ok(isClassifyUrl(String(url)));
    classifyBody = bodyB64(init);
    return vitReply([{ label: "Tomato___healthy", score: 0.9 }]);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
  // The untouched original reached the classifier.
  assert.equal(classifyBody, LEAF_JPEG_B64);
  assert.equal(payload.preprocessing?.status, "no-leaf");
  assert.equal(payload.preprocessing?.box, null);
  // A no-leaf outcome is a normal result, not a pipeline warning.
  assert.doesNotMatch(warningText(payload), /Step 0/);
  assert.equal(payload.source, "hybrid");
});

test("Step 0 outage (detector loading) degrades to the full frame with a warning", async () => {
  configureKeys();
  let classifyBody = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) return geminiReply("المصابيح باردة.");
    if (isDetectUrl(String(url))) return Response.json({ error: "Model is loading" }, { status: 503 });
    assert.ok(isClassifyUrl(String(url)));
    classifyBody = bodyB64(init);
    return vitReply();
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
  assert.equal(payload.preprocessing?.status, "unavailable");
  assert.equal(classifyBody, LEAF_JPEG_B64);
  assert.match(warningText(payload), /Step 0 leaf detection unavailable/);
  assert.equal(payload.source, "hybrid");
});

test("Step 0 walks the detector chain when the primary id answers a non-detection payload", async () => {
  configureKeys();
  const detectUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiReply("تم.");
    if (isDetectUrl(String(url))) {
      detectUrls.push(String(url));
      // First id 404s (checkpoint gone) — the chain must walk to the COCO
      // fallback, whose plant-only labels still produce a crop here.
      if (detectUrls.length === 1) return Response.json({ error: "Model not found" }, { status: 404 });
      return Response.json([
        { label: "potted plant", score: 0.8, box: { xmin: 5, ymin: 5, xmax: 45, ymax: 35 } },
        { label: "person", score: 0.99, box: { xmin: 0, ymin: 0, xmax: 64, ymax: 48 } },
      ]);
    }
    assert.ok(isClassifyUrl(String(url)));
    return vitReply([{ label: "Tomato___healthy", score: 0.9 }]);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
  assert.deepEqual(detectUrls.map((url) => /models\/(.+)$/.exec(url)?.[1]), [
    "suryanshgoel/detr-finetuned-plantdoc",
    "facebook/detr-resnet-50",
  ]);
  // The COCO fallback accepted ONLY the plant box — the "person" box (which
  // would crop to the full frame) was filtered out by label.
  assert.equal(payload.preprocessing?.status, "cropped");
  assert.equal(payload.preprocessing?.detector, "facebook/detr-resnet-50");
});

test("HF_LEAF_DETECT_MODELS overrides the Step 0 detector chain", async () => {
  configureKeys();
  process.env.HF_LEAF_DETECT_MODELS = "custom/leaf-detector";
  const detectUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiReply("تم.");
    if (/router\.huggingface\.co\/hf-inference\/models\//.test(String(url)) && !isClassifyUrl(String(url))) {
      detectUrls.push(String(url));
      return Response.json([{ label: "LABEL_0", score: 0.9, box: { xmin: 10, ymin: 8, xmax: 50, ymax: 40 } }]);
    }
    assert.ok(isClassifyUrl(String(url)));
    return vitReply([{ label: "Tomato___healthy", score: 0.9 }]);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
  assert.match(detectUrls[0], /models\/custom\/leaf-detector$/);
  assert.equal(payload.preprocessing?.status, "cropped");
  assert.equal(payload.preprocessing?.detector, "custom/leaf-detector");
});

test("Step 0 without an HF key is skipped silently and Step 1 keeps its own skip warning", async () => {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(isGeminiUrl(String(url)));
    return geminiReply("بدون مفتاح.");
  });
  const response = await POST(imageRequest("aW1hZ2U="));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
  assert.equal(payload.preprocessing?.status, "skipped");
  assert.match(warningText(payload), /Step 1 vision unavailable/);
  assert.doesNotMatch(warningText(payload), /Step 0/);
});
