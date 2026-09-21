import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { dynamic, POST } from "../../src/app/api/assistant/route";

/** Stage-1 keys used across the suite (values are deliberately padded). */
const GEMINI_KEY = "test-gemini";
const HF_KEY = "test-hf";

/**
 * Stage-1 AbortController window, mirrored from the route: 18 s for the
 * whole Google Gemini model chain (a full Arabic answer needs 10–15 s on a
 * cold Flash model — the former 9 s window aborted healthy generations).
 */
const GEMINI_TIMEOUT_MS = 18_000;

/** Stage-1 model chain, in order — must mirror the route's GEMINI_MODELS. */
const GEMINI_FALLBACK_ORDER = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
] as const;

const originalKeys = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_API_KEY_2: process.env.GEMINI_API_KEY_2,
  GEMINI_API_KEY_3: process.env.GEMINI_API_KEY_3,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  // Hugging Face's conventional variable name — honoured by the route as an
  // alias, so it must be scrubbed too or a developer's shell token leaks in.
  HF_TOKEN: process.env.HF_TOKEN,
};

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY_2;
  delete process.env.GEMINI_API_KEY_3;
  delete process.env.HUGGINGFACE_API_KEY;
  delete process.env.HF_TOKEN;
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

function request(withImage = false) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "How should I irrigate tomatoes?",
      ...(withImage ? { image: { data: "aW1hZ2U=", mimeType: "image/jpeg" } } : {}),
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
/*  Stage 1 (Google Gemini) mock helpers                                */
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
    candidates: [
      { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
    ],
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

const geminiUserText = (body: GeminiRequestBody) =>
  (body.contents?.[0]?.parts ?? []).map((part) => part.text ?? "").join("");

/* ------------------------------------------------------------------ */
/*  Stage 2 (HF LLM chat-completions) mock helpers                      */
/* ------------------------------------------------------------------ */

/**
 * Stage 2 model chain, in order — must mirror the route's HF_LLM_MODELS:
 * open, non-gated, lightweight Qwen ids served by the Inference Providers
 * router (the gated Llama-3.2-3B / dead Mistral-7B ids are gone).
 */
const LLM_FALLBACK_ORDER = [
  "Qwen/Qwen3-4B-Instruct-2507",
  "Qwen/Qwen2.5-7B-Instruct",
  "Qwen/Qwen2.5-1.5B-Instruct",
] as const;

/**
 * The official OpenAI-compatible Inference Providers router endpoint — ONE
 * URL for every model (the id travels in the JSON body). The former
 * per-provider `/hf-inference/models/<id>/v1/chat/completions` URLs answer
 * `400 — Model not supported by provider hf-inference` for every LLM.
 */
const HF_ROUTER_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";

const chatReply = (content = "اسقِ في الصباح الباكر.") =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

/** Mirrors the HF router response for a retired / mistyped model id. */
const llmModelNotFound = (model: string) =>
  Response.json({ error: `Model ${model} not found.` }, { status: 404 });

/**
 * Mirrors the legacy per-provider rejection for an id the `hf-inference`
 * provider doesn't serve: `400 — Model not supported by provider
 * hf-inference` (bare-string error envelope). Must behave like a
 * model-availability error (fall through to the next id).
 */
const llmProviderUnsupported = () =>
  Response.json(
    { error: "Model not supported by provider hf-inference" },
    { status: 400 },
  );

/**
 * Mirrors the live Inference Providers router rejection for a model no
 * provider serves — the OpenAI-style OBJECT error envelope with a machine
 * code: `400 — { error: { message, type, param, code: "model_not_supported" } }`.
 * Must walk the chain exactly like the legacy string envelope.
 */
const llmRouterModelNotSupported = (model: string) =>
  Response.json(
    {
      error: {
        message: `The requested model '${model}' is not supported by any provider you have enabled.`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_supported",
      },
    },
    { status: 400 },
  );

/**
 * Mirrors HF's 403 for gated families (meta-llama/*, google/gemma-*) whose
 * license the token owner never accepted on huggingface.co. Must walk the
 * model chain like any other availability error.
 */
const llmGated = () =>
  Response.json(
    {
      error:
        "You cannot access this model unless the model owner gives you access. You can do so by accepting the terms.",
    },
    { status: 403 },
  );

const isChatUrl = (url: string) => url.includes("/v1/chat/completions");

interface ChatRequestBody {
  model?: string;
  messages?: { role: string; content: string }[];
  max_tokens?: number;
}

const parseChatBody = (init: RequestInit): ChatRequestBody =>
  JSON.parse(String(init.body ?? "{}")) as ChatRequestBody;

/**
 * The model id a Stage 2 round-trip asked the router for. The unified router
 * URL carries no model, so it is read from the JSON body — which is also
 * where the router itself reads it.
 */
const requestedChatModel = (init: RequestInit) => parseChatBody(init).model;

/** Route must call Step 1 (vision) before Stage 1 (Gemini). */
const isVisionUrl = (url: string) =>
  url.includes("router.huggingface.co/hf-inference/models/") && !isChatUrl(url);

/* ------------------------------------------------------------------ */
/*  Shared response typing                                             */
/* ------------------------------------------------------------------ */

interface DiagnosisLike {
  label: string;
  labelAr: string;
  healthy: boolean;
  confidence: number;
  candidates: { label: string; score: number }[];
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

  // A Gemini-only deployment is a valid configuration: Stage 1 answers.
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

/* ------------------------------------------------------------------ */
/*  Stage 1 — Google Gemini primary LLM                                */
/* ------------------------------------------------------------------ */

test("Stage 1 answers from gemini-3.5-flash with 200 { source: \"llm\" }", async () => {
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

  // A single round-trip: the primary LLM. Neither the fallback HF chain nor
  // the vision model is touched when Stage 1 answers.
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(
    url,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_KEY}`,
  );
  assert.equal(requestedGeminiModel(url), GEMINI_FALLBACK_ORDER[0]);
  assert.equal(requestedGeminiKey(url), GEMINI_KEY);
  // Bounded by an AbortController (mandated 8–10 s window).
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal?.aborted, false);
  assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
  // The Gemini 3.x primary gets a qualitative thinking level — a numeric
  // thinkingBudget would 400 on this generation.
  assert.equal(parseGeminiBody(init).generationConfig?.thinkingConfig?.thinkingLevel, "low");
  assert.equal(parseGeminiBody(init).generationConfig?.thinkingConfig?.thinkingBudget, undefined);
});

test("Stage 1 keeps the gemini-3.5-flash endpoint when the API key rotates", async () => {
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

test("Stage 1 rotates comma-separated and dynamically numbered Gemini keys after HTTP 429", async () => {
  process.env.GEMINI_API_KEY = " key-one , , key-two ";
  process.env.GEMINI_API_KEY_2 = " key-three ";
  process.env.GEMINI_API_KEY_3 = " key-four ";
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(String(url));
    if (requestedGeminiKey(String(url)) === "key-one") {
      return geminiHttpError(429, "Quota exceeded.");
    }
    return geminiReply("اسقِ بعد تدويم المحصول.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "اسقِ بعد تدويم المحصول.");
  assert.deepEqual(calls.map(requestedGeminiKey), ["key-one", "key-two"]);
  assert.match(warningText(payload), /HTTP 429/);
  assert.match(warningText(payload), /key rotation attempt 2\/4/);
  assert.doesNotMatch(JSON.stringify(payload), /key-one|key-two|key-three|key-four/);
});

test("Stage 1 waits through every dynamically numbered Gemini key before using the HF fallback", async () => {
  process.env.GEMINI_API_KEY = "key-one,key-two";
  process.env.GEMINI_API_KEY_2 = "key-three";
  process.env.GEMINI_API_KEY_3 = "key-four";
  process.env.HUGGINGFACE_API_KEY = HF_KEY;
  const geminiKeys: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiKeys.push(requestedGeminiKey(String(url)) ?? "");
      return geminiHttpError(429, "Rate limit reached.");
    }
    assert.ok(isChatUrl(String(url)));
    return chatReply("إجابة من الاحتياطي.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "إجابة من الاحتياطي.");
  assert.deepEqual(geminiKeys, ["key-one", "key-two", "key-three", "key-four"]);
  assert.match(warningText(payload), /all Gemini API keys failed/);
  assert.match(warningText(payload), /HTTP 429/);
});

test("Stage 1 sends the concise Arabic system instruction, the query and the profile context", async () => {
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
  // The user turn: query + Firestore profile context.
  const user = geminiUserText(body);
  assert.match(user, /كيف أسقي الطماطم؟/);
  assert.match(user, /بسكرة/);
  assert.match(user, /الطماطم/);
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

test("Stage 1 receives the Step 1 MobileNet diagnosis (label, confidence, candidates) and answers hybrid", async () => {
  configureKeys();
  const urls: string[] = [];
  let geminiUser = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (isGeminiUrl(String(url))) {
      geminiUser = geminiUserText(parseGeminiBody(init));
      return geminiReply("أزل الأوراق المصابة ثم عالج بمبيد نحاسي.");
    }
    // Step 1 — Vision Model Cascade: PRIMARY field-trained (dima806/plant_disease_image_detection
    // or fxmeng/plantdoc-vit) or SECONDARY baseline (mobilenet) on Hugging Face.
    // The cascade tries the primary first (4 s timeout) then the baseline — Step 1b is KEPT INTACT.
    assert.ok(isVisionUrl(String(url)));
    assert.ok(isClassifyUrl(String(url)), `vision url should be a classifier endpoint: ${url}`);
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${HF_KEY}`);
    return Response.json([
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
  assert.equal(payload.reply, "أزل الأوراق المصابة ثم عالج بمبيد نحاسي.");

  // Vision first, then the primary LLM — vision may be 1 call (primary succeeds) and
  // the cascade ensures we check the first vision url is a classifier (primary or baseline).
  assert.ok(urls.length >= 2, `expected at least vision + Gemini, got ${urls.length}`);
  assert.ok(isVisionUrl(urls[0]));
  assert.ok(isClassifyUrl(urls[0]));
  assert.ok(urls.some((u) => isGeminiUrl(u)));
  // The vision verdict travels into the Gemini prompt: disease label…
  assert.match(geminiUser, /Tomato___Early_blight/);
  assert.match(geminiUser, /95%/);
  // …plus the candidate diseases ("Late blight" 3%, "Leaf mold" 2% in Arabic).
  assert.match(geminiUser, /اللفحة المتأخرة/);
  assert.match(geminiUser, /عفن الأوراق/);
  assert.match(geminiUser, /3%/);
  assert.match(geminiUser, /How should I irrigate tomatoes\?/);
  // Secrets never travel back to the client.
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

for (const [name, failure] of [
  ["HTTP 400 invalid API key", () => geminiHttpError(400, "API key not valid. Please pass a valid API key.")],
  ["HTTP 429 quota exhausted", () => geminiHttpError(429, "Resource has been exhausted (e.g. check quota).")],
  ["HTTP 500 upstream error", () => new Response(null, { status: 500 })],
  ["an empty candidate list", () => geminiEmpty()],
  ["a safety block", () => geminiBlocked()],
] as const) {
  test(`Stage 1 ${name} falls through to the Hugging Face LLM chain (source: llm)`, async () => {
    configureKeys();
    const calls: { url: string; init: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (isGeminiUrl(String(url))) return failure();
      assert.ok(isChatUrl(String(url)));
      return chatReply("اسقِ في الصباح الباكر.");
    });

    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "llm");
    assert.equal(payload.reply, "اسقِ في الصباح الباكر.");
    // Gemini was attempted first, then the HF chain's primary id.
    assert.equal(requestedGeminiModel(calls[0].url), GEMINI_FALLBACK_ORDER[0]);
    assert.equal(calls[1].url, HF_ROUTER_CHAT_URL);
    assert.equal(requestedChatModel(calls[1].init), LLM_FALLBACK_ORDER[0]);
    assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
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
  test(`Stage 1 logs the exact status and full ${name} while preserving fallback`, async () => {
    configureKeys();
    const errorLog = mock.method(console, "error", () => {});
    mock.method(globalThis, "fetch", async (url: string) => {
      if (isGeminiUrl(String(url))) return new Response(body, { status });
      return chatReply();
    });

    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "llm");
    assert.ok(warningText(payload).includes(expectedDetail));
    assert.equal(errorLog.mock.callCount(), 1);
    assert.deepEqual(errorLog.mock.calls[0].arguments, ["[Gemini Error]", status, body]);
  });
}

test("Stage 1 network failure falls through to the Hugging Face LLM chain", async () => {
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) throw new TypeError("fetch failed");
    return chatReply("اسقِ في الصباح الباكر.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.match(warningText(payload), /fetch failed/);
  // 1 Gemini attempt + 1 HF chain attempt.
  assert.equal(upstream.mock.callCount(), 2);
});

test("Stage 1 timeout aborts the Gemini round-trip via AbortController after 18 s and falls through", async () => {
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
    return chatReply("اسقِ في الصباح الباكر.");
  });

  // Fast-forward the 18 s Stage-1 window instead of waiting for it.
  mock.timers.enable({ apis: ["setTimeout"] });
  let response: Response;
  try {
    const pending = POST(request());
    // Let the handler reach the hanging Gemini round-trip…
    await new Promise((resolve) => setImmediate(resolve));
    // …the former 9 s window must NOT fire any more: a healthy 10–15 s Gemini
    // generation has to be allowed to finish…
    mock.timers.tick(9_001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(geminiAborted, false, "Gemini was aborted before the 18 s deadline");
    assert.equal(calls.length, 1, "the fallback chain started before the 18 s deadline");
    // …only the 18 s deadline aborts the round-trip.
    mock.timers.tick(GEMINI_TIMEOUT_MS - 9_001 + 1);
    response = await pending;
  } finally {
    mock.timers.reset();
  }

  assert.equal(geminiAborted, true);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "اسقِ في الصباح الباكر.");
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.match(warningText(payload), /timeout after 18000 ms/);
  // The fallback chain ran after the abort.
  assert.equal(calls[1].url, HF_ROUTER_CHAT_URL);
  assert.equal(requestedChatModel(calls[1].init), LLM_FALLBACK_ORDER[0]);
});

/* ------------------------------------------------------------------ */
/*  Stage 1 — Gemini model chain (retired-id 404 fallback)             */
/* ------------------------------------------------------------------ */

test("Stage 1 walks the Gemini chain: a 404 'model not found' on the primary falls back to the next model", async () => {
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
    // Stage 1 still answers — neither the HF chain nor Stage 3 may run.
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
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.match(warningText(payload), /is not found for API version v1beta/);
  assert.doesNotMatch(warningText(payload), /Stage 2 LLM unavailable/);
});

test("Stage 1 walks the whole Gemini chain when every model 404s, then the HF chain answers", async () => {
  configureKeys();
  const geminiUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiUrls.push(String(url));
      return geminiModelNotFound(requestedGeminiModel(String(url)) ?? "unknown");
    }
    assert.ok(isChatUrl(String(url)));
    return chatReply("Water in the morning.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "Water in the morning.");
  // Every retired id is walked before degrading to Stage 2…
  assert.deepEqual(geminiUrls.map(requestedGeminiModel), [...GEMINI_FALLBACK_ORDER]);
  // …and the non-fatal warning names the whole tried chain.
  const warning = warningText(payload);
  assert.match(warning, /Stage 1 Gemini unavailable/);
  assert.match(warning, /no Gemini model could answer/);
  for (const model of GEMINI_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

for (const status of [503, 500] as const) {
  test(`Stage 1 rotates to the next Gemini key after HTTP ${status}`, async () => {
    process.env.GEMINI_API_KEY = "first-key,second-key";
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      calls.push(String(url));
      if (requestedGeminiKey(String(url)) === "first-key") {
        return new Response(null, { status });
      }
      return geminiReply("إجابة بعد تدوير المفتاح.");
    });

    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "llm");
    assert.equal(payload.reply, "إجابة بعد تدوير المفتاح.");
    assert.deepEqual(calls.map(requestedGeminiKey), ["first-key", "second-key"]);
    assert.match(warningText(payload), new RegExp(`HTTP ${status}`));
    assert.match(warningText(payload), /key rotation attempt 2\/2/);
  });
}

test("Stage 1: a 429 quota error fails fast without walking the Gemini model chain", async () => {
  configureKeys();
  const geminiUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiUrls.push(String(url));
      return geminiHttpError(429, "Resource has been exhausted (e.g. check quota).");
    }
    assert.ok(isChatUrl(String(url)));
    return chatReply("اسقِ في الصباح الباكر.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  // The HF chain still answers — the failure is non-fatal…
  assert.equal(payload.source, "llm");
  assert.match(warningText(payload), /HTTP 429/);
  // …but a quota error is an account problem, not a model problem: exactly
  // one Gemini attempt, no chain walk.
  assert.equal(geminiUrls.length, 1);
  assert.equal(requestedGeminiModel(geminiUrls[0]), GEMINI_FALLBACK_ORDER[0]);
});

test("Stage 1 sends each model generation its own thinking config (thinkingLevel for 3.x, thinkingBudget for 2.5)", async () => {
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
/*  Deployment shapes — Gemini-only / Hugging-Face-only                 */
/* ------------------------------------------------------------------ */

test("Gemini-only deployment: Stage 1 answers and the HF fallback is never called", async () => {
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

test("Gemini-only deployment: a Gemini failure degrades to Stage 3 and says the HF key is missing", async () => {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
    return new Response(null, { status: 503 });
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.match(warningText(payload), /Stage 2 LLM unavailable/);
  assert.match(warningText(payload), /HUGGINGFACE_API_KEY is not configured/);
  assert.match(warningText(payload), /Reply formatted locally/);
});

for (const [name, hfValue] of [
  ["unset", undefined],
  ["blank", "   "],
] as const) {
  test(`no valid HF token (${name}): Stage 2 is skipped synchronously — no router request, no throw, no delay`, async () => {
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    if (hfValue !== undefined) process.env.HUGGINGFACE_API_KEY = hfValue;
    const upstream = mock.method(globalThis, "fetch", async (url: string) => {
      if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
      throw new Error(`Stage 2 must not be attempted without a token: ${url}`);
    });
    const errorLog = mock.method(console, "error", () => {});

    // Freeze every timer: if the skip involved any wait (a retry back-off, a
    // timeout race…) the handler could never resolve without a tick.
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let response: Response;
    try {
      response = await POST(request());
    } finally {
      mock.timers.reset();
    }

    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "direct");
    assert.match(payload.reply, /الوضع الأساسي/);
    // Exactly one upstream call — Gemini. Nothing went to Hugging Face.
    assert.equal(upstream.mock.callCount(), 1);
    assert.ok(upstream.mock.calls.every((call) => isGeminiUrl(String(call.arguments[0]))));
    // The skip is a graceful degradation, not an error: no `[Stage 2: HF LLM
    // Error]` line, and no safety-net exception.
    assert.ok(
      errorLog.mock.calls.every(
        (call) => !/Stage 2|Safety Net/.test(String(call.arguments[0])),
      ),
    );
    const warning = warningText(payload);
    assert.match(warning, /Stage 2 LLM unavailable — HUGGINGFACE_API_KEY is not configured/);
    assert.match(warning, /HF_TOKEN unset too/);
    assert.match(warning, /Reply formatted locally/);
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

test("Hugging-Face-only deployment: Stage 1 is skipped by config and the HF chain answers", async () => {
  process.env.HUGGINGFACE_API_KEY = HF_KEY;
  const calls: { url: string; init: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "Water in the morning.");
  assert.ok(calls.every((call) => isChatUrl(call.url)));
  assert.equal(calls[0].url, HF_ROUTER_CHAT_URL);
  assert.equal(requestedChatModel(calls[0].init), LLM_FALLBACK_ORDER[0]);
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.match(warningText(payload), /GEMINI_API_KEY is not configured/);
});

test("HF_TOKEN (Hugging Face's own variable name) is honoured as an alias of HUGGINGFACE_API_KEY", async () => {
  // Only the alias is set — HUGGINGFACE_API_KEY is blank, not merely unset.
  process.env.HUGGINGFACE_API_KEY = "   ";
  process.env.HF_TOKEN = " hf_alias_token ";
  const calls: { url: string; init: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return chatReply("Water in the morning.");
  });
  // The alias counts as a configured provider key: no 503 MISSING_KEYS…
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "Water in the morning.");
  // …and Stage 2 authenticates the router call with the trimmed alias value.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HF_ROUTER_CHAT_URL);
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer hf_alias_token");
  assert.doesNotMatch(JSON.stringify(payload), /hf_alias_token/);
});

test("Hugging-Face-only deployment: an image request keeps the vision diagnosis (source hybrid)", async () => {
  process.env.HUGGINGFACE_API_KEY = HF_KEY;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${HF_KEY}`);
    if (isChatUrl(String(url))) return chatReply("النبتة سليمة. قلّم الأوراق السفلية.");
    return Response.json([{ label: "Tomato___healthy", score: 0.95 }]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.healthy, true);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

/* ------------------------------------------------------------------ */
/*  Stage 2 — Hugging Face fallback chain (model selection)             */
/* ------------------------------------------------------------------ */

/** Gemini always fails here, so every assertion targets the HF chain. */
function mockGeminiDownThen(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  return mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
    return fetchImpl(String(url), init);
  });
}

test("Stage 2 calls the official Inference Providers router with a Bearer token and the model id in the body", async () => {
  configureKeys();
  const calls: { url: string; init: RequestInit }[] = [];
  mockGeminiDownThen(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as AssistantPayload).reply, "Water in the morning.");

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  // ONE unified URL — never the retired per-provider `hf-inference` chat
  // URLs, which 400 for every LLM.
  assert.equal(url, HF_ROUTER_CHAT_URL);
  assert.doesNotMatch(url, /hf-inference/);
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${HF_KEY}`);
  assert.equal(headers.get("Content-Type"), "application/json");
  // The serverless cold-start hint is an hf-inference-only header.
  assert.equal(headers.get("X-Wait-For-Model"), null);
  // OpenAI-compatible body: the model id is selected here, not in the URL.
  const body = parseChatBody(init);
  assert.equal(body.model, LLM_FALLBACK_ORDER[0]);
  assert.equal(body.messages?.[0]?.role, "system");
  assert.equal(body.messages?.[1]?.role, "user");
  assert.ok(typeof body.max_tokens === "number" && body.max_tokens <= 1000);
});

test("Stage 2 walks the HF chain: 404 model-not-found on the primary id falls back to the next", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockGeminiDownThen(async (_url: string, init: RequestInit) => {
    models.push(requestedChatModel(init));
    if (models.length === 1) return llmModelNotFound(LLM_FALLBACK_ORDER[0]);
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "Water in the morning.");
  assert.deepEqual(models, [LLM_FALLBACK_ORDER[0], LLM_FALLBACK_ORDER[1]]);
});

test("Stage 2 walks the HF chain: legacy 400 model-not-supported (string envelope) falls back to the next id", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockGeminiDownThen(async (_url: string, init: RequestInit) => {
    models.push(requestedChatModel(init));
    if (models.length === 1) return llmProviderUnsupported();
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as AssistantPayload).reply, "Water in the morning.");
  assert.deepEqual(models, [LLM_FALLBACK_ORDER[0], LLM_FALLBACK_ORDER[1]]);
});

test("Stage 2 walks the HF chain: the router's 400 { error: { code: model_not_supported } } object envelope falls back to the next id", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockGeminiDownThen(async (_url: string, init: RequestInit) => {
    const model = requestedChatModel(init);
    models.push(model);
    if (models.length === 1) return llmRouterModelNotSupported(String(model));
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "Water in the morning.");
  assert.deepEqual(models, [LLM_FALLBACK_ORDER[0], LLM_FALLBACK_ORDER[1]]);
  // The walk is a non-fatal warning inside the route (console), not a
  // client-visible one — the client only sees the Stage 1 degradation.
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.doesNotMatch(warningText(payload), /Stage 2 LLM unavailable/);
});

test("Stage 2: every model unsupported by the router degrades to 200 basic-mode listing the whole chain and the error code", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockGeminiDownThen(async (_url: string, init: RequestInit) => {
    const model = requestedChatModel(init);
    models.push(model);
    return llmRouterModelNotSupported(String(model));
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.deepEqual(models, [...LLM_FALLBACK_ORDER]);
  const warning = warningText(payload);
  // The object envelope is unwrapped: machine code + human message, not
  // "[object Object]" or the raw JSON blob.
  assert.match(warning, /HTTP 400 — \[model_not_supported\] The requested model/);
  assert.match(warning, /not supported by any provider/);
  assert.doesNotMatch(warning, /\[object Object\]/);
  for (const model of LLM_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

test("Stage 2: every model unsupported by the provider (legacy string envelope) degrades to 200 basic-mode listing the whole chain", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockGeminiDownThen(async (_url: string, init: RequestInit) => {
    models.push(requestedChatModel(init));
    return llmProviderUnsupported();
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.deepEqual(models, [...LLM_FALLBACK_ORDER]);
  const warning = warningText(payload);
  assert.match(warning, /Model not supported by provider hf-inference/);
  for (const model of LLM_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

test("Stage 2: an unrelated 400 (bad request) fails fast without walking the model chain", async () => {
  configureKeys();
  const upstream = mockGeminiDownThen(async () =>
    Response.json({ error: "Invalid payload: messages field is required." }, { status: 400 }),
  );
  const response = await POST(request());
  // Fail-proof: even a fail-fast upstream error answers 200 in basic mode.
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(warningText(payload), /HTTP 400/);
  // A malformed-request 400 is not a model problem — one chat attempt only.
  assert.equal(
    upstream.mock.calls.filter((call) => isChatUrl(String(call.arguments[0]))).length,
    1,
  );
});

test("Stage 2: all models not found degrades to 200 basic-mode listing every id tried", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockGeminiDownThen(async (_url: string, init: RequestInit) => {
    const model = requestedChatModel(init);
    models.push(model);
    return llmModelNotFound(String(model));
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis, null);
  assert.deepEqual(models, [...LLM_FALLBACK_ORDER]);
  const warning = warningText(payload);
  for (const model of LLM_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

test("Stage 2: a model that returns no text falls through to the next id", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockGeminiDownThen(async (_url: string, init: RequestInit) => {
    models.push(requestedChatModel(init));
    return models.length < LLM_FALLBACK_ORDER.length
      ? Response.json({ choices: [] })
      : chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.reply, "Water in the morning.");
  assert.equal(payload.diagnosis, null);
  assert.equal(payload.source, "llm");
  assert.deepEqual(models, [...LLM_FALLBACK_ORDER]);
});

for (const [name, status, body] of [
  [
    "401 invalid token",
    401,
    { error: "Invalid credentials in Authorization header" },
  ],
  [
    "403 token without the Inference Providers permission",
    403,
    {
      error: {
        message:
          "This authentication method does not have sufficient permissions to call Inference Providers on behalf of user farmer",
        type: "permission_error",
      },
    },
  ],
  [
    "402 monthly credits exhausted",
    402,
    {
      error: {
        message:
          "You have exceeded your monthly included credits for Inference Providers. Subscribe to PRO to get 20x more monthly included credits.",
        type: "insufficient_quota",
      },
    },
  ],
] as const) {
  test(`Stage 2: a ${name} is an account problem — fails fast to Stage 3 without walking the chain`, async () => {
    configureKeys();
    const upstream = mockGeminiDownThen(async () => Response.json(body, { status }));
    const response = await POST(request());
    // Fail-proof: still a 200 basic-mode reply, never a 500.
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "direct");
    assert.match(warningText(payload), new RegExp(`HTTP ${status}`));
    // Another model id can't fix a credential/billing failure: one attempt.
    assert.equal(
      upstream.mock.calls.filter((call) => isChatUrl(String(call.arguments[0]))).length,
      1,
    );
    // The token never travels back to the client.
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(HF_KEY));
  });
}

test("Stage 2: a transient 503 on the primary id does not walk the chain", async () => {
  configureKeys();
  const upstream = mockGeminiDownThen(async () => new Response(null, { status: 503 }));
  const response = await POST(request());
  // Fail-proof: transient 503s degrade to the basic-mode reply, not an HTTP 500.
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(warningText(payload), /HTTP 503/);
  // One chat attempt only: a 503 is not a model problem, so don't burn the
  // request budget re-trying the same failure on every id.
  assert.equal(
    upstream.mock.calls.filter((call) => isChatUrl(String(call.arguments[0]))).length,
    1,
  );
});

test("Stage 2 sends the same system prompt, query and Step 1 context the primary LLM received", async () => {
  configureKeys();
  let chatBody: ChatRequestBody | undefined;
  let geminiUser = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) {
      geminiUser = geminiUserText(parseGeminiBody(init));
      return geminiHttpError(503, "overloaded");
    }
    if (isChatUrl(String(url))) {
      chatBody = parseChatBody(init);
      return chatReply();
    }
    return Response.json([
      { label: "Tomato___Late_blight", score: 0.03 },
      { label: "Tomato___Early_blight", score: 0.95 },
      { label: "Tomato___healthy", score: 0.02 },
    ]);
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");

  assert.ok(chatBody);
  assert.equal(chatBody.model, LLM_FALLBACK_ORDER[0]);
  const messages = chatBody.messages ?? [];
  assert.ok(messages.length >= 2);
  const [system, user] = messages;
  assert.equal(system.role, "system");
  // The mandated system instruction: expert agricultural assistant, concise,
  // direct, practical Arabic, no introductions and no padding.
  assert.match(system.content, /أنت مساعد زراعي خبير/);
  assert.match(system.content, /دون مقدمات أو إطالة/);
  assert.match(system.content, /باللغة العربية/);
  assert.match(system.content, /عملي/);
  assert.equal(user.role, "user");
  // Same user turn as Stage 1: query + Step 1 label/confidence + candidates.
  assert.equal(user.content, geminiUser);
  assert.match(user.content, /Tomato___Early_blight/);
  assert.match(user.content, /95%/);
  assert.match(user.content, /How should I irrigate tomatoes\?/);
  // Concise output must be enforced with a hard token cap too.
  assert.ok(typeof chatBody.max_tokens === "number" && chatBody.max_tokens <= 1000);
});

/* ------------------------------------------------------------------ */
/*  Zero-failure strategy — Stage 3 direct formatting                   */
/* ------------------------------------------------------------------ */

test("zero-failure: both LLM stages down after a successful Step 1 returns 200 with source=direct", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    return Response.json([
      { label: "Tomato___Late_blight", score: 0.03 },
      { label: "Tomato___Early_blight", score: 0.95 },
      { label: "Tomato___healthy", score: 0.02 },
    ]);
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
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.match(warningText(payload), /Stage 2 LLM unavailable/);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

test("zero-failure: gated-model 403s walk the whole HF chain, then answer with direct formatting", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "overloaded");
    if (isChatUrl(String(url))) {
      models.push(requestedChatModel(init));
      return llmGated();
    }
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.deepEqual(models, [...LLM_FALLBACK_ORDER]);
});

test("zero-failure: healthy diagnosis gets a direct reassurance card with prevention tips", async () => {
  configureKeys();
  mockGeminiDownThen(async (url: string) =>
    isChatUrl(url)
      ? llmProviderUnsupported()
      : Response.json([{ label: "Tomato___healthy", score: 0.97 }]),
  );
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
  mockGeminiDownThen(async (url: string) =>
    isChatUrl(url)
      ? new Response(null, { status: 503 })
      : Response.json([{ label: "Tomato___Late_blight", score: 0.3 }]),
  );
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
      if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "empty") return Response.json({ choices: [] });
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
    assert.match(warningText(payload), /Stage 2 LLM unavailable/);
  });
}

/* ------------------------------------------------------------------ */
/*  Zero-failure strategy — text-only basic-mode replies                */
/* ------------------------------------------------------------------ */

for (const greeting of ["هلا", "مرحبا", "السلام عليكم", "أهلا وسهلا", "السلامُ عليكم ورحمةُ الله"] as const) {
  test(`zero-failure: text-only LLM outage greets back a simple greeting (${greeting}) with 200 direct`, async () => {
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
    assert.match(warningText(payload), /Stage 2 LLM unavailable/);
  });
}

test("zero-failure: text-only LLM outage answers a farm question with the polite basic-mode fallback", async () => {
  configureKeys();
  mockGeminiDownThen(async () => llmGated());
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
  mockGeminiDownThen(async () => new Response(null, { status: 503 }));
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

test("zero-failure: HF vision failure degrades to Stage 1 with a Step 1 warning (never 500)", async () => {
  configureKeys();
  let geminiCalls = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiCalls += 1;
      return geminiReply("Water in the morning.");
    }
    // Step 1 fails on every vision model → Stage 1 must still answer the text.
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

test("zero-failure: HF 503 model-loading plus every LLM down answers 200 asking to retry the photo", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    return Response.json(
      {
        error:
          "Model linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification is currently loading",
        estimated_time: 23.4,
      },
      { status: 503 },
    );
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  // The reply tells the user the photo couldn't be analysed and to retry.
  assert.match(payload.reply, /تعذّر تحليل صورة الورقة/);
  assert.match(payload.reply, /أعد المحاولة/);
  const warning = warningText(payload);
  assert.match(warning, /Step 1 vision unavailable/);
  assert.match(warning, /loading/i);
  assert.match(warning, /Stage 2 LLM unavailable/);
});

test("strict pipeline: HF parses the returned array to extract the primary class and confidence", async () => {
  configureKeys();
  let llmRequestBody = "";
  let llmUrl = "";
  let llmModel: string | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "overloaded");
    if (isChatUrl(String(url))) {
      llmUrl = String(url);
      llmModel = requestedChatModel(init);
      llmRequestBody = String(init.body ?? "");
      return chatReply();
    }
    // Unsorted array — route must sort and pick Tomato___Early_blight 95% as top
    return Response.json([
      { label: "Tomato___Late_blight", score: 0.03 },
      { label: "Tomato___Early_blight", score: 0.95 },
      { label: "Tomato___healthy", score: 0.02 },
    ]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 95);
  assert.equal(payload.source, "hybrid");
  // Stage 2 runs on the primary HF LLM via the router's chat-completions endpoint…
  assert.equal(llmUrl, HF_ROUTER_CHAT_URL);
  assert.equal(llmModel, LLM_FALLBACK_ORDER[0]);
  // …and the Step 1 verdict (label + confidence) is passed straight into the prompt.
  assert.match(llmRequestBody, /Tomato___Early_blight/);
  assert.match(llmRequestBody, /95%/);
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
/** Step 1 classifier endpoints (Vision Model Cascade: primary field-trained ViT + fallback MobileNetV2 / ViT). */
const isClassifyUrl = (url: string) =>
  url.includes("router.huggingface.co/hf-inference/models/") &&
  /mobilenet|vit|dima806|plantdoc|plant_disease/i.test(url);

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
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };

  // Pipeline order: detect → classify → LLM.
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
    return Response.json([{ label: "Tomato___healthy", score: 0.9 }]);
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
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
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
    return Response.json([{ label: "Tomato___healthy", score: 0.9 }]);
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
    return Response.json([{ label: "Tomato___healthy", score: 0.9 }]);
  });

  try {
    const response = await POST(imageRequest(LEAF_JPEG_B64));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
    assert.match(detectUrls[0], /models\/custom\/leaf-detector$/);
    assert.equal(payload.preprocessing?.status, "cropped");
    assert.equal(payload.preprocessing?.detector, "custom/leaf-detector");
  } finally {
    delete process.env.HF_LEAF_DETECT_MODELS;
  }
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
