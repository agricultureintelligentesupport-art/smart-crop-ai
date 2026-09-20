import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { dynamic, POST } from "../../src/app/api/assistant/route";

/** Stage-1 keys used across the suite (values are deliberately padded). */
const GEMINI_KEY = "test-gemini";
const HF_KEY = "test-hf";

/**
 * Stage-1 AbortController window, mirrored from the route: the mandated
 * 8–10 s timeout for the Google Gemini round-trip.
 */
const GEMINI_TIMEOUT_MS = 9_000;

const originalKeys = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
};

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.HUGGINGFACE_API_KEY;
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

const isGeminiUrl = (url: string) => url.includes("generativelanguage.googleapis.com");

/** `gemini-1.5-flash` extracted from the generateContent URL. */
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

interface GeminiRequestBody {
  systemInstruction?: { parts?: { text?: string }[] };
  contents?: { role?: string; parts?: { text?: string }[] }[];
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingBudget?: number };
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

/** Stage 2 model chain, in order — must mirror the route's HF_LLM_MODELS. */
const LLM_FALLBACK_ORDER = [
  "Qwen/Qwen2.5-Coder-7B-Instruct",
  "HuggingFaceH4/zephyr-7b-beta",
  "TiagoPires/Xenova-Qwen1.5-0.5B-Chat",
] as const;

const chatReply = (content = "اسقِ في الصباح الباكر.") =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

/** Mirrors the HF router response for a retired / mistyped model id. */
const llmModelNotFound = (model: string) =>
  Response.json({ error: `Model ${model} not found.` }, { status: 404 });

/**
 * Mirrors the live HF serverless router rejection for an id no longer in its
 * catalog: `400 — Model not supported by provider hf-inference`. Must behave
 * like a model-availability error (fall through to the next id).
 */
const llmProviderUnsupported = () =>
  Response.json(
    { error: "Model not supported by provider hf-inference" },
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

const requestedChatModel = (url: string) =>
  /\/hf-inference\/models\/(.+?)\/v1\/chat\/completions/.exec(url)?.[1];

interface ChatRequestBody {
  model?: string;
  messages?: { role: string; content: string }[];
  max_tokens?: number;
}

const parseChatBody = (init: RequestInit): ChatRequestBody =>
  JSON.parse(String(init.body ?? "{}")) as ChatRequestBody;

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

test("Stage 1 answers from gemini-1.5-flash with 200 { source: \"llm\" }", async () => {
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
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
  );
  assert.equal(requestedGeminiModel(url), "gemini-1.5-flash");
  assert.equal(requestedGeminiKey(url), GEMINI_KEY);
  // Bounded by an AbortController (mandated 8–10 s window).
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal?.aborted, false);
  assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
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
    // Step 1 — MobileNetV2 PlantVillage classifier on Hugging Face.
    assert.ok(isVisionUrl(String(url)));
    assert.match(String(url), /mobilenet_v2_1\.0_224-plant-disease-identification/);
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

  // Vision first, then the primary LLM — one call each.
  assert.equal(urls.length, 2);
  assert.ok(isVisionUrl(urls[0]));
  assert.ok(isGeminiUrl(urls[1]));
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
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      urls.push(String(url));
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
    assert.equal(requestedGeminiModel(urls[0]), "gemini-1.5-flash");
    assert.equal(requestedChatModel(urls[1]), LLM_FALLBACK_ORDER[0]);
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

test("Stage 1 timeout aborts the Gemini round-trip via AbortController and falls through", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (isGeminiUrl(String(url))) {
      // Never answers — the route's AbortController must cancel the round-trip.
      const signal = init.signal as AbortSignal;
      assert.ok(signal instanceof AbortSignal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(signal.reason ?? new Error("aborted")),
        );
      });
    }
    return chatReply("اسقِ في الصباح الباكر.");
  });

  // Fast-forward the 9 s Stage-1 window instead of waiting for it.
  mock.timers.enable({ apis: ["setTimeout"] });
  let response: Response;
  try {
    const pending = POST(request());
    // Let the handler reach the hanging Gemini round-trip…
    await new Promise((resolve) => setImmediate(resolve));
    // …then fire the timeout.
    mock.timers.tick(GEMINI_TIMEOUT_MS + 1);
    response = await pending;
  } finally {
    mock.timers.reset();
  }

  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "اسقِ في الصباح الباكر.");
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.match(warningText(payload), /timeout after 9000 ms/);
  // The fallback chain ran after the abort.
  assert.equal(requestedChatModel(urls[1]), LLM_FALLBACK_ORDER[0]);
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
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "Water in the morning.");
  assert.ok(urls.every((url) => isChatUrl(url)));
  assert.equal(requestedChatModel(urls[0]), LLM_FALLBACK_ORDER[0]);
  assert.match(warningText(payload), /Stage 1 Gemini unavailable/);
  assert.match(warningText(payload), /GEMINI_API_KEY is not configured/);
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

test("Stage 2 walks the HF chain: 404 model-not-found on the primary id falls back to the next", async () => {
  configureKeys();
  const urls: string[] = [];
  mockGeminiDownThen(async (url: string) => {
    urls.push(url);
    if (urls.length === 1) return llmModelNotFound(LLM_FALLBACK_ORDER[0]);
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "Water in the morning.");
  assert.deepEqual(urls.map(requestedChatModel), [
    LLM_FALLBACK_ORDER[0],
    LLM_FALLBACK_ORDER[1],
  ]);
});

test("Stage 2 walks the HF chain: 400 model-not-supported falls back to the next id", async () => {
  configureKeys();
  const urls: string[] = [];
  mockGeminiDownThen(async (url: string) => {
    urls.push(url);
    if (urls.length === 1) return llmProviderUnsupported();
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as AssistantPayload).reply, "Water in the morning.");
  assert.deepEqual(urls.map(requestedChatModel), [
    LLM_FALLBACK_ORDER[0],
    LLM_FALLBACK_ORDER[1],
  ]);
});

test("Stage 2: every model unsupported by the provider degrades to 200 basic-mode listing the whole chain", async () => {
  configureKeys();
  const urls: string[] = [];
  mockGeminiDownThen(async (url: string) => {
    urls.push(url);
    return llmProviderUnsupported();
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
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
  const urls: string[] = [];
  mockGeminiDownThen(async (url: string) => {
    urls.push(url);
    return llmModelNotFound(String(requestedChatModel(url)));
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis, null);
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
  const warning = warningText(payload);
  for (const model of LLM_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

test("Stage 2: a model that returns no text falls through to the next id", async () => {
  configureKeys();
  const urls: string[] = [];
  mockGeminiDownThen(async (url: string) => {
    urls.push(url);
    return urls.length < LLM_FALLBACK_ORDER.length
      ? Response.json({ choices: [] })
      : chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.reply, "Water in the morning.");
  assert.equal(payload.diagnosis, null);
  assert.equal(payload.source, "llm");
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
});

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
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "overloaded");
    if (isChatUrl(String(url))) {
      urls.push(String(url));
      return llmGated();
    }
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
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
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "overloaded");
    if (isChatUrl(String(url))) {
      llmUrl = String(url);
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
  // Stage 2 runs on the primary HF LLM via the chat-completions endpoint…
  assert.equal(requestedChatModel(llmUrl), LLM_FALLBACK_ORDER[0]);
  // …and the Step 1 verdict (label + confidence) is passed straight into the prompt.
  assert.match(llmRequestBody, /Tomato___Early_blight/);
  assert.match(llmRequestBody, /95%/);
});
