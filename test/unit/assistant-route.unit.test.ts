import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { dynamic, POST } from "../../src/app/api/assistant/route";

/** Provider keys used across the suite (values are deliberately padded). */
const GEMINI_KEY = "test-gemini";
const HF_KEY = "test-hf";
/**
 * The removed CodeCraft vision engine's endpoint — kept ONLY as a guard
 * pattern: no test may ever see a request to it (the engine is gone from
 * the pipeline).
 */
const CODECRAFT_URL_PATTERN = /codecraftapi\.com/i;

/**
 * Stage-2 (Gemini fallback) AbortController window, mirrored from the route:
 * 18 s for the whole Google Gemini model chain (a full Arabic answer needs
 * 10–15 s on a cold Flash model — the former 9 s window aborted healthy
 * generations).
 */
const GEMINI_TIMEOUT_MS = 18_000;

/**
 * Stage-2 (Gemini fallback) model chain, in order — must mirror the route's
 * resolveGeminiModels(): the current Flash generation first, then the older
 * ids walked when a generation is retired.
 */
const GEMINI_FALLBACK_ORDER = [
  "gemini-3.6",
  "gemini-2.5-flash",
  "gemini-2.0-flash-exp",
] as const;

/**
 * Every environment variable the route consults must be scrubbed between
 * tests and restored afterwards — including the WHOLE `GEMINI_API_KEY*`
 * family (the route parses ANY variable starting with `GEMINI_API_KEY`:
 * `GEMINI_API_KEY`, the `GEMINI_API_KEYS` pool and the numbered
 * `GEMINI_API_KEY_N` variants), the Hugging Face token (including the
 * `HF_TOKEN` alias — a developer's shell token must not leak in) and the
 * model-chain overrides.
 */
const SCRUBBED_ENV_PATTERN =
  /^(GEMINI_API_KEY|GEMINI_MODEL|HUGGINGFACE_API_KEY|HF_TOKEN|HF_LEAF_DETECT_MODELS|HF_VISION_MODEL|CODECRAFT_API_KEY|CODECRAFT_BASE_URL|CODECRAFT_VISION_MODEL|CODECRAFT_MODEL)/;
// NOTE: the CODECRAFT_* variables stay in the scrub list on purpose — a
// developer's shell may still export them from the pre-streamlining setup,
// and the guard tests below rely on them being absent unless set explicitly.

const originalKeys: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (SCRUBBED_ENV_PATTERN.test(name)) originalKeys[name] = value;
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (SCRUBBED_ENV_PATTERN.test(name)) delete process.env[name];
  }
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
/*  Stage 2 (Google Gemini — the FALLBACK LLM) mock helpers            */
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
 * failure signature (`models/gemini-1.5-flash-latest is not found for API version
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

interface GeminiImagePart {
  mimeType?: string;
  data?: string;
}

interface GeminiRequestBody {
  systemInstruction?: { parts?: { text?: string }[] };
  contents?: { role?: string; parts?: { text?: string; inlineData?: GeminiImagePart }[] }[];
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

/** The inlineData image part the hybrid pipeline attaches to the Gemini turn. */
const geminiImagePart = (body: GeminiRequestBody): GeminiImagePart | undefined =>
  (body.contents?.[0]?.parts ?? []).find((part) => part.inlineData !== undefined)?.inlineData;

/* ------------------------------------------------------------------ */
/*  Stage 1 (HF LLM chat-completions — the PRIMARY LLM) mock helpers   */
/* ------------------------------------------------------------------ */

/**
 * Step 1 — the PlantVillage classifier on Hugging Face. Clean single-model
 * pipeline: the MobileNetV2 id is the PRIMARY (and only default) classifier
 * — the obsolete field-trained cascade ids and the 400-prone fallbacks are
 * gone from the route.
 */
const MOBILENET_MODEL =
  "linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification";

/** Step 0 — primary leaf detector (COCO DETR-ResNet-50), mirrors the route. */
const LEAF_DETECTOR = "facebook/detr-resnet-50";

/**
 * Stage 1 model chain, in order — must mirror the route's HF_LLM_MODELS:
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

  // A Gemini-only deployment is a valid configuration: with no Hugging Face
  // token the primary LLM is skipped and the Gemini fallback answers.
  process.env.GEMINI_API_KEY = ` ${GEMINI_KEY} `;
  const upstream = mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
    return geminiReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.reply, "Water in the morning.");
  assert.equal(payload.diagnosis, null);
  assert.equal(payload.source, "llm");
  assert.equal(upstream.mock.callCount(), 1);

  delete process.env.GEMINI_API_KEY;
  assert.equal((await POST(request())).status, 503);
  assert.equal(upstream.mock.callCount(), 1);
});

/* ------------------------------------------------------------------ */
/*  Chain priority — Hugging Face FIRST, Gemini only as the fallback    */
/* ------------------------------------------------------------------ */

test("chain order: the Hugging Face primary LLM is called first and Gemini is never reached", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    // Stage 1 — the PRIMARY LLM: the HF Inference Providers router, keyed
    // with the Hugging Face token and the first Qwen id.
    if (isChatUrl(String(url))) {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${HF_KEY}`);
      assert.equal(requestedChatModel(init), LLM_FALLBACK_ORDER[0]);
      return chatReply("إجابة النموذج الأساسي.");
    }
    // Stage 2 — Gemini must NOT be reached while the primary answers.
    throw new Error(`Gemini must not run before the primary LLM fails: ${url}`);
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "إجابة النموذج الأساسي.");
  // Exactly ONE upstream round-trip: the primary. No Gemini call at all.
  assert.deepEqual(urls, [HF_ROUTER_CHAT_URL]);
  assert.doesNotMatch(warningText(payload), /Gemini/);
});

test("chain order: Gemini is consulted ONLY after the primary LLM failed", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    // Stage 1 — the primary Hugging Face LLM is DOWN…
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    // …Stage 2 — only now is the Gemini fallback consulted.
    return geminiReply("إجابة الاحتياط.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "إجابة الاحتياط.");
  // Primary first (503), then the Gemini fallback with gemini-3.6.
  assert.equal(urls.length, 2);
  assert.equal(urls[0], HF_ROUTER_CHAT_URL);
  assert.equal(
    urls[1],
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6:generateContent?key=${GEMINI_KEY}`,
  );
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
});

/* ------------------------------------------------------------------ */
/*  Stage 2 — Google Gemini fallback LLM                                */
/* ------------------------------------------------------------------ */

test("Stage 2 answers from gemini-3.6 with 200 { source: \"llm\" }", async () => {
  // Gemini-only deployment: with no Hugging Face token the primary LLM stage
  // is skipped, so the Gemini fallback is the stage that answers.
  configureKeys({ huggingface: false });
  const calls: { url: string; init: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
    return geminiReply("اسقِ الطماطم صباحاً عند القاعدة كل 3 أيام.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  // Gemini's generated Arabic response, verbatim.
  assert.equal(payload.reply, "اسقِ الطماطم صباحاً عند القاعدة كل 3 أيام.");
  assert.equal(payload.diagnosis, null);
  assert.equal(payload.source, "llm");
  // The only degradation is the skipped primary LLM stage.
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable — HUGGINGFACE_API_KEY is not configured/);

  // A single round-trip: the fallback LLM. Neither the HF primary chain nor
  // the vision model is touched when Stage 2 answers.
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(
    url,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6:generateContent?key=${GEMINI_KEY}`,
  );
  assert.equal(requestedGeminiModel(url), GEMINI_FALLBACK_ORDER[0]);
  assert.equal(requestedGeminiKey(url), GEMINI_KEY);
  // Bounded by an AbortController (mandated 8–10 s window).
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal?.aborted, false);
  assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
  // Gemini 3.x reasons by default: `thinkingLevel: "low"` keeps it in fast,
  // answer-first mode (the legacy numeric `thinkingBudget` is rejected on
  // this generation).
  assert.deepEqual(parseGeminiBody(init).generationConfig?.thinkingConfig, {
    thinkingLevel: "low",
  });
});

test("Stage 2 keeps the gemini-3.6 endpoint when the API key rotates", async () => {
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6:generateContent?key=${key}`,
    ),
  );
});

test("Stage 2 rotates comma-separated and dynamically numbered Gemini keys after HTTP 429", async () => {
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

test("Stage 2 waits through every dynamically numbered Gemini key before Stage 3 answers", async () => {
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
    // The PRIMARY Hugging Face LLM is down as well — only Stage 3 is left.
    assert.ok(isChatUrl(String(url)));
    return new Response(null, { status: 503 });
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.deepEqual(geminiKeys, ["key-one", "key-two", "key-three", "key-four"]);
  assert.match(warningText(payload), /all Gemini API keys failed/);
  assert.match(warningText(payload), /HTTP 429/);
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
});

test("Gemini key pool: GEMINI_API_KEYS + GEMINI_API_KEY + numbered variants merge trimmed, deduplicated and rotation-ordered", async () => {
  // Four sources with overlaps and whitespace on purpose:
  //   GEMINI_API_KEY   = " alpha , gamma "  (rank 0 — base variable first)
  //   GEMINI_API_KEY_1 = " beta "           (rank 1)
  //   GEMINI_API_KEY_2 = " delta "          (rank 2)
  //   GEMINI_API_KEYS  = " alpha, beta "    (plural pool — deduped vs the rest)
  process.env.GEMINI_API_KEY = " alpha , gamma ";
  process.env.GEMINI_API_KEY_1 = " beta ";
  process.env.GEMINI_API_KEY_2 = " delta ";
  process.env.GEMINI_API_KEYS = " alpha, beta ";
  const attempted: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    const key = requestedGeminiKey(String(url));
    attempted.push(key ?? "");
    if (key === "delta") return geminiReply("إجابة من المفتاح الأخير.");
    return geminiHttpError(429, "Resource has been exhausted (RESOURCE_EXHAUSTED).");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "إجابة من المفتاح الأخير.");
  // Exactly the deduplicated pool, in deterministic rotation order: the base
  // variable first, then _1, _2, and finally the GEMINI_API_KEYS pool (its
  // alpha/beta already tried → skipped). No empty/whitespace entries.
  assert.deepEqual(attempted, ["alpha", "gamma", "beta", "delta"]);
  // Every exhausted key left a rotation warning…
  assert.match(warningText(payload), /key rotation attempt 2\/4/);
  assert.match(warningText(payload), /key rotation attempt 3\/4/);
  assert.match(warningText(payload), /key rotation attempt 4\/4/);
  // …and the key values never leak to the client.
  assert.doesNotMatch(JSON.stringify(payload), /alpha|gamma|beta|delta/);
});

test("Fallback A: MobileNetV2 failure → Gemini inspects the raw image independently (image still attached)", async () => {
  configureKeys();
  let geminiImage: GeminiImagePart | undefined;
  let geminiUser = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) {
      const body = parseGeminiBody(init);
      geminiImage = geminiImagePart(body);
      geminiUser = geminiUserText(body);
      return geminiReply("الورقة تبدو مصابة باللفحة المبكرة.");
    }
    // Step 0 + Step 1 both 503 (models loading) — no MobileNetV2 verdict at
    // all, yet Gemini must STILL receive the raw image and diagnose it.
    return Response.json({ error: "Model is loading", estimated_time: 12 }, { status: 503 });
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  // Gemini answered from its own inspection — no diagnosis attached…
  assert.equal(payload.source, "llm");
  assert.equal(payload.diagnosis, null);
  // …but the raw image STILL travelled to Gemini as an inlineData part…
  assert.ok(geminiImage, "Fallback A must still send the raw image to Gemini");
  assert.equal(geminiImage?.mimeType, "image/jpeg");
  assert.equal(geminiImage?.data, "aW1hZ2U=");
  // …with the instruction to diagnose the image independently (no reference).
  assert.match(geminiUser, /لا تتوفر نتيجة فحص آلي مسبقة للصورة/);
  assert.match(geminiUser, /افحص الصورة المرفقة مباشرة/);
  // The vision outage is a non-fatal warning, never a 500.
  assert.match(warningText(payload), /Step 1 vision unavailable/);
});

test("Fallback B: every Gemini key exhausted → structured response built directly from MobileNetV2's findings", async () => {
  // Vision works (HF key set) but BOTH Gemini keys are quota-exhausted and
  // Stage 2 is down too — the built-in formatter must answer from the
  // MobileNetV2 diagnosis with a valid structured payload.
  process.env.GEMINI_API_KEY = "key-one,key-two";
  process.env.HUGGINGFACE_API_KEY = HF_KEY;
  const attempted: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      attempted.push(requestedGeminiKey(String(url)) ?? "");
      return geminiHttpError(429, "Quota exceeded for quota metric 'GenerateContentRequests' (RESOURCE_EXHAUSTED).");
    }
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    if (isDetectUrl(String(url))) return Response.json([]);
    // Step 1 — MobileNetV2 PlantVillage (sole default classifier).
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  // BOTH keys were rotated through and exhausted (1 s backoff between them)…
  assert.deepEqual(attempted, ["key-one", "key-two"]);
  // …and the farmer still got a full structured diagnosis (the MobileNetV2
  // card) instead of an error…
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 95);
  assert.match(payload.reply, /## 🔬 التشخيص/);
  assert.doesNotMatch(payload.reply, /Tomato___Early_blight/);
  assert.doesNotMatch(payload.reply, /95%/);
  assert.match(payload.reply, /## 💊 خطة العلاج/);
  // …with the degradations reported as warnings, never an HTTP 500.
  assert.match(warningText(payload), /all Gemini API keys failed/);
  assert.match(warningText(payload), /HTTP 429/);
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
  assert.match(warningText(payload), /Reply formatted locally/);
});

test("Stage 2 sends the concise Arabic system instruction, the query and the profile context", async () => {
  configureKeys();
  let body: GeminiRequestBody | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    // The primary Hugging Face LLM is down → the Gemini fallback answers.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
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
  // Answer-first payload, generation-aware: the Gemini 3.x fallback takes
  // `thinkingLevel: "low"` (reasoning is on by default on this generation).
  assert.deepEqual(body.generationConfig?.thinkingConfig, { thinkingLevel: "low" });
});

test("hybrid fallback path: Gemini receives the image + the MobileNetV2 reference (label, confidence, candidates) and answers hybrid", async () => {
  configureKeys();
  const urls: string[] = [];
  let geminiUser = "";
  let geminiImage: GeminiImagePart | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    // Stage 1 — the primary Hugging Face LLM is DOWN here, so the request
    // walks on to the Gemini fallback with the very same user turn.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    if (isGeminiUrl(String(url))) {
      const body = parseGeminiBody(init);
      geminiUser = geminiUserText(body);
      geminiImage = geminiImagePart(body);
      return geminiReply("أزل الأوراق المصابة ثم عالج بمبيد نحاسي.");
    }
    // Step 0 — the primary detector (facebook/detr-resnet-50) sees the raw
    // frame first; it finds no usable leaf here, so the ORIGINAL frame
    // continues down the pipeline.
    if (isDetectUrl(String(url))) {
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${HF_KEY}`);
      return Response.json([]);
    }
    // Step 1 — MobileNetV2 PlantVillage, the sole default classifier.
    assert.ok(isClassifyUrl(String(url)), `vision url should be the classifier endpoint: ${url}`);
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${HF_KEY}`);
    return Response.json([
      { label: "Tomato___Late_blight", score: 0.03 },
      { label: "Tomato___Early_blight", score: 0.95 },
      { label: "Tomato___Leaf_Mold", score: 0.02 },
    ]);
  });

  // A decodable frame so Step 0 (detect) actually runs its round-trip.
  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 95);
  assert.equal(payload.reply, "أزل الأوراق المصابة ثم عالج بمبيد نحاسي.");

  // Pipeline order: detect → classify → HF LLM (down) → Gemini.
  assert.equal(urls.length, 4, `expected detect + classify + HF + Gemini, got ${urls.length}`);
  assert.ok(isDetectUrl(urls[0]));
  assert.match(urls[0], /facebook\/detr-resnet-50/);
  // Step 1 is the MobileNetV2 PlantVillage classifier — the sole default.
  assert.ok(isClassifyUrl(urls[1]));
  assert.ok(urls[1].includes(MOBILENET_MODEL), `expected the MobileNetV2 endpoint, got ${urls[1]}`);
  assert.equal(urls[2], HF_ROUTER_CHAT_URL);
  assert.ok(isGeminiUrl(urls[3]));
  // The photo itself travels with the Gemini turn (inlineData part) —
  // no-leaf outcome above means the original frame is what Gemini inspects.
  assert.ok(geminiImage, "Gemini must receive the attached image as an inlineData part");
  assert.equal(geminiImage?.mimeType, "image/jpeg");
  assert.equal(geminiImage?.data, LEAF_JPEG_B64);
  // The MobileNetV2 reference travels in the text: disease label…
  assert.match(geminiUser, /Tomato___Early_blight/);
  assert.match(geminiUser, /95%/);
  // …plus the candidate diseases ("Late blight" 3%, "Leaf mold" 2% in Arabic).
  assert.match(geminiUser, /اللفحة المتأخرة/);
  assert.match(geminiUser, /عفن الأوراق/);
  assert.match(geminiUser, /3%/);
  // …and Gemini is instructed to inspect the image against the reference.
  assert.match(geminiUser, /افحص الصورة المرفقة/);
  assert.match(geminiUser, /شخّص هذه الورقة/);
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
  test(`Stage 2 Gemini ${name} is non-fatal — 200 basic-mode when the primary is down too`, async () => {
    configureKeys();
    const calls: { url: string; init: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      // Stage 1 — the primary Hugging Face LLM fails first…
      if (isChatUrl(String(url))) return new Response(null, { status: 503 });
      // …only then is the Gemini fallback consulted, and it fails too.
      if (isGeminiUrl(String(url))) return failure();
      throw new Error(`unexpected upstream: ${url}`);
    });

    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "direct");
    assert.equal(payload.diagnosis, null);
    // The primary LLM ran FIRST, then the Gemini fallback's primary id.
    assert.equal(calls[0].url, HF_ROUTER_CHAT_URL);
    assert.equal(requestedChatModel(calls[0].init), LLM_FALLBACK_ORDER[0]);
    assert.equal(requestedGeminiModel(calls[1].url), GEMINI_FALLBACK_ORDER[0]);
    assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
    assert.match(warningText(payload), /Stage 2 Gemini unavailable/);
    assert.match(warningText(payload), /Reply formatted locally/);
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
  test(`Stage 2 logs the exact status and full ${name} while preserving the Stage 3 fallback`, async () => {
    configureKeys();
    const errorLog = mock.method(console, "error", () => {});
    mock.method(globalThis, "fetch", async (url: string) => {
      // The primary Hugging Face LLM is down → the Gemini fallback errors.
      if (isChatUrl(String(url))) return new Response(null, { status: 503 });
      if (isGeminiUrl(String(url))) return new Response(body, { status });
      throw new Error(`unexpected upstream: ${url}`);
    });

    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.source, "direct");
    assert.ok(warningText(payload).includes(expectedDetail));
    // The primary stage's own failure is logged first, then Google's exact,
    // untruncated error envelope for the Gemini fallback attempt.
    assert.ok(
      errorLog.mock.calls.some(
        (call) =>
          call.arguments[0] === "[Gemini Error]" &&
          call.arguments[1] === status &&
          call.arguments[2] === body,
      ),
      `expected a [Gemini Error] ${status} log, got ${JSON.stringify(errorLog.mock.calls)}`,
    );
  });
}

test("Stage 1 network failure falls through to the Gemini fallback chain", async () => {
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) throw new TypeError("fetch failed");
    return geminiReply("اسقِ في الصباح الباكر.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "اسقِ في الصباح الباكر.");
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
  assert.match(warningText(payload), /fetch failed/);
  // 1 primary HF attempt + 1 Gemini fallback attempt.
  assert.equal(upstream.mock.callCount(), 2);
});

test("Stage 2 timeout aborts the Gemini round-trip via AbortController after 18 s and falls through", async () => {
  configureKeys();
  const calls: { url: string; init: RequestInit }[] = [];
  let geminiAborted = false;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    // The primary Hugging Face LLM fails fast…
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
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
    // The primary failed fast and the Gemini fallback round-trip is in
    // flight — the former 9 s window must NOT abort it.
    assert.equal(calls.length, 2, "the Gemini fallback started before the 18 s deadline");
    assert.ok(isGeminiUrl(calls[1].url));
    // …only the 18 s deadline aborts the round-trip.
    mock.timers.tick(GEMINI_TIMEOUT_MS - 9_001 + 1);
    response = await pending;
  } finally {
    mock.timers.reset();
  }

  assert.equal(geminiAborted, true);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
  assert.match(warningText(payload), /Stage 2 Gemini unavailable/);
  assert.match(warningText(payload), /timeout after 18000 ms/);
  // The Gemini fallback ran after the primary failed — and nothing else did.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, HF_ROUTER_CHAT_URL);
  assert.ok(isGeminiUrl(calls[1].url));
});

/* ------------------------------------------------------------------ */
/*  Stage 2 — Gemini fallback model chain (retired-id 404 fallback)     */
/* ------------------------------------------------------------------ */

test("Stage 2 walks the Gemini chain: a 404 'model not found' on the primary falls back to the next model", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    // The primary Hugging Face LLM is down → the Gemini fallback walks its
    // own model chain and still answers.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    if (isGeminiUrl(String(url))) {
      const model = requestedGeminiModel(String(url)) ?? "";
      return model === GEMINI_FALLBACK_ORDER[0]
        ? geminiModelNotFound(model)
        : geminiReply("اسقِ في الصباح الباكر.");
    }
    throw new Error(`unexpected upstream: ${url}`);
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "اسقِ في الصباح الباكر.");
  // The retired primary 404s → the next chain id answers.
  assert.deepEqual(
    urls.filter((url) => isGeminiUrl(url)).map(requestedGeminiModel),
    [GEMINI_FALLBACK_ORDER[0], GEMINI_FALLBACK_ORDER[1]],
  );
  assert.match(warningText(payload), /Stage 2 Gemini unavailable/);
  assert.match(warningText(payload), /is not found for API version v1beta/);
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
});

test("Stage 2 walks the whole Gemini chain when every model 404s, then Stage 3 answers", async () => {
  configureKeys();
  const geminiUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiUrls.push(String(url));
      return geminiModelNotFound(requestedGeminiModel(String(url)) ?? "unknown");
    }
    // The primary Hugging Face LLM is down as well.
    assert.ok(isChatUrl(String(url)));
    return new Response(null, { status: 503 });
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  // Every retired id is walked before degrading to Stage 3…
  assert.deepEqual(geminiUrls.map(requestedGeminiModel), [...GEMINI_FALLBACK_ORDER]);
  // …and the non-fatal warning names the whole tried chain.
  const warning = warningText(payload);
  assert.match(warning, /Stage 2 Gemini unavailable/);
  assert.match(warning, /no Gemini model could answer/);
  for (const model of GEMINI_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

for (const status of [503, 500] as const) {
  test(`Stage 2 rotates to the next Gemini key after HTTP ${status}`, async () => {
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

test("Stage 2: a 429 quota error fails fast without walking the Gemini model chain", async () => {
  configureKeys();
  const geminiUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiUrls.push(String(url));
      return geminiHttpError(429, "Resource has been exhausted (e.g. check quota).");
    }
    // The primary Hugging Face LLM is down as well.
    assert.ok(isChatUrl(String(url)));
    return new Response(null, { status: 503 });
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  // Stage 3 still answers — the failure is non-fatal…
  assert.equal(payload.source, "direct");
  assert.match(warningText(payload), /HTTP 429/);
  // …but a quota error is an account problem, not a model problem: exactly
  // one Gemini attempt, no chain walk.
  assert.equal(geminiUrls.length, 1);
  assert.equal(requestedGeminiModel(geminiUrls[0]), GEMINI_FALLBACK_ORDER[0]);
});

test("Stage 2 sends each model generation its own thinking payload (thinkingLevel for 3.x, thinkingBudget for 2.5, none for 2.0)", async () => {
  configureKeys();
  const bodies = new Map<string, GeminiRequestBody>();
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    // The primary Hugging Face LLM is down → the Gemini fallback walks its
    // whole model chain here.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    if (isGeminiUrl(String(url))) {
      const model = requestedGeminiModel(String(url)) ?? "";
      bodies.set(model, parseGeminiBody(init));
      // 404 the 3.x/2.5 ids so the walk reaches the 2.0 model; it answers.
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

  // Gemini 3.x: `thinkingLevel: "low"` — the generation reasons by default
  // and rejects the legacy numeric budget…
  const flash36 = bodies.get(GEMINI_FALLBACK_ORDER[0]);
  assert.ok(flash36, `no request body captured for ${GEMINI_FALLBACK_ORDER[0]}`);
  assert.deepEqual(flash36.generationConfig?.thinkingConfig, { thinkingLevel: "low" });
  // …Gemini 2.5: numeric zero budget (reasoning skipped, answer-first)…
  const flash25 = bodies.get("gemini-2.5-flash");
  assert.ok(flash25, "no request body captured for gemini-2.5-flash");
  assert.equal(flash25.generationConfig?.thinkingConfig?.thinkingBudget, 0);
  assert.equal(flash25.generationConfig?.thinkingConfig?.thinkingLevel, undefined);
  // …Gemini 2.0: NO thinkingConfig at all — the generation predates thinking
  // and 400s on either parameter shape.
  const flash20 = bodies.get("gemini-2.0-flash-exp");
  assert.ok(flash20, "no request body captured for gemini-2.0-flash-exp");
  assert.equal(flash20.generationConfig?.thinkingConfig, undefined);
});

/* ------------------------------------------------------------------ */
/*  Stage 2 — GEMINI_MODEL override                                     */
/* ------------------------------------------------------------------ */

test("GEMINI_MODEL overrides the Stage-2 model id (trimmed, single round-trip)", async () => {
  configureKeys();
  // Pin an older stable id; the padding proves the value is trimmed.
  process.env.GEMINI_MODEL = " gemini-2.0-flash-exp ";
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    urls.push(String(url));
    assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
    return geminiReply("اسقِ في الصباح الباكر.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  // Exactly one Gemini round-trip against the override — the default
  // gemini-3.6 id is skipped and the override is not duplicated as its
  // own fallback.
  assert.deepEqual(urls.map(requestedGeminiModel), ["gemini-2.0-flash-exp"]);
});

test("a GEMINI_MODEL override that 404s walks to the built-in fallback ids", async () => {
  configureKeys();
  process.env.GEMINI_MODEL = "gemini-2.0-flash-exp";
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    urls.push(String(url));
    if (isGeminiUrl(String(url))) {
      const model = requestedGeminiModel(String(url)) ?? "";
      return model === "gemini-2.0-flash-exp"
        ? geminiModelNotFound(model)
        : geminiReply("اسقِ في الصباح الباكر.");
    }
    throw new Error(`unexpected upstream: ${url}`);
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  // The retired override 404s → the next fallback id answers (the override
  // is deduplicated out of the fallback list, so no doubled attempt).
  assert.deepEqual(urls.map(requestedGeminiModel), [
    "gemini-2.0-flash-exp",
    "gemini-2.5-flash",
  ]);
  assert.match(warningText(payload), /Stage 2 Gemini unavailable/);
});

test("a blank GEMINI_MODEL falls back to the gemini-3.6 default", async () => {
  configureKeys();
  process.env.GEMINI_MODEL = "   ";
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    urls.push(String(url));
    assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
    return geminiReply("اسقِ في الصباح الباكر.");
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as AssistantPayload).source, "llm");
  assert.deepEqual(urls.map(requestedGeminiModel), [GEMINI_FALLBACK_ORDER[0]]);
});

/* ------------------------------------------------------------------ */
/*  Deployment shapes — Gemini-only / Hugging-Face-only                 */
/* ------------------------------------------------------------------ */

test("Gemini-only deployment: Stage 2 answers and the HF primary is never called", async () => {
  configureKeys({ huggingface: false });
  const upstream = mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
    return geminiReply("اسقِ صباحاً.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.reply, "اسقِ صباحاً.");
  assert.equal(payload.diagnosis, null);
  assert.equal(payload.source, "llm");
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
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
  assert.match(warningText(payload), /Stage 2 Gemini unavailable/);
  assert.match(warningText(payload), /HUGGINGFACE_API_KEY is not configured/);
  assert.match(warningText(payload), /GEMINI_API_KEY is not configured|HTTP 503/);
  assert.match(warningText(payload), /Reply formatted locally/);
});

for (const [name, hfValue] of [
  ["unset", undefined],
  ["blank", "   "],
] as const) {
  test(`no valid HF token (${name}): Stage 1 is skipped synchronously — no router request, no throw, no delay`, async () => {
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    if (hfValue !== undefined) process.env.HUGGINGFACE_API_KEY = hfValue;
    const upstream = mock.method(globalThis, "fetch", async (url: string) => {
      if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
      throw new Error(`Stage 1 must not be attempted without a token: ${url}`);
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
    // The skip is a graceful degradation, not an error: no `[Stage 1: HF LLM
    // Error]` line, and no safety-net exception.
    assert.ok(
      errorLog.mock.calls.every(
        (call) => !/Stage 1: HF LLM Error|Safety Net/.test(String(call.arguments[0])),
      ),
    );
    const warning = warningText(payload);
    assert.match(warning, /Stage 1 HF LLM unavailable — HUGGINGFACE_API_KEY is not configured/);
    assert.match(warning, /HF_TOKEN unset too/);
    assert.match(warning, /Reply formatted locally/);
  });
}

test("Gemini-only deployment: an image request skips the vision step and still answers from the Gemini fallback", async () => {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  let geminiImage: GeminiImagePart | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.ok(isGeminiUrl(String(url)), `vision must be skipped without an HF key: ${url}`);
    geminiImage = geminiImagePart(parseGeminiBody(init));
    return geminiReply("صف أعراض الورقة نصياً.");
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.diagnosis, null);
  // Fallback A: without an HF key MobileNetV2 never runs — the Gemini
  // fallback still receives the raw image and inspects it independently.
  assert.ok(geminiImage, "the raw image must still reach Gemini");
  assert.equal(geminiImage?.data, "aW1hZ2U=");
  assert.match(warningText(payload), /Step 1 vision unavailable/);
  assert.match(warningText(payload), /HUGGINGFACE_API_KEY is not configured/);
});

test("Hugging-Face-only deployment: the HF primary answers and Gemini is skipped by config", async () => {
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
  // The primary answered, so the Gemini fallback is never consulted — no
  // request, and no Gemini degradation is reported to the client.
  assert.doesNotMatch(warningText(payload), /Gemini/);
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
  // …and Stage 1 authenticates the router call with the trimmed alias value.
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
    if (isDetectUrl(String(url))) return Response.json([]);
    // Step 1 — MobileNetV2 PlantVillage (sole default classifier).
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
/*  Stage 1 — Hugging Face primary chain (model selection)              */
/* ------------------------------------------------------------------ */

/**
 * The primary Hugging Face LLM answers here, so the Gemini fallback is never
 * consulted. Gemini is kept down anyway: a regression that put Gemini back in
 * front of the primary would surface as a wrong answer, not a hang.
 */
function mockHfLlmPrimary(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  return mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) return geminiHttpError(503, "The model is overloaded.");
    return fetchImpl(String(url), init);
  });
}

test("Stage 1 calls the official Inference Providers router with a Bearer token and the model id in the body", async () => {
  configureKeys();
  const calls: { url: string; init: RequestInit }[] = [];
  mockHfLlmPrimary(async (url: string, init: RequestInit) => {
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

test("Stage 1 walks the HF chain: 404 model-not-found on the primary id falls back to the next", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockHfLlmPrimary(async (_url: string, init: RequestInit) => {
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

test("Stage 1 walks the HF chain: legacy 400 model-not-supported (string envelope) falls back to the next id", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockHfLlmPrimary(async (_url: string, init: RequestInit) => {
    models.push(requestedChatModel(init));
    if (models.length === 1) return llmProviderUnsupported();
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as AssistantPayload).reply, "Water in the morning.");
  assert.deepEqual(models, [LLM_FALLBACK_ORDER[0], LLM_FALLBACK_ORDER[1]]);
});

test("Stage 1 walks the HF chain: the router's 400 { error: { code: model_not_supported } } object envelope falls back to the next id", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockHfLlmPrimary(async (_url: string, init: RequestInit) => {
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
  // The primary LLM answered, so the Gemini fallback never ran: no Gemini
  // degradation is reported to the client at all.
  assert.doesNotMatch(warningText(payload), /Gemini/);
});

test("Stage 1: every model unsupported by the router degrades to 200 basic-mode listing the whole chain and the error code", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockHfLlmPrimary(async (_url: string, init: RequestInit) => {
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

test("Stage 1: every model unsupported by the provider (legacy string envelope) degrades to 200 basic-mode listing the whole chain", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockHfLlmPrimary(async (_url: string, init: RequestInit) => {
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

test("Stage 1: an unrelated 400 (bad request) fails fast without walking the model chain", async () => {
  configureKeys();
  const upstream = mockHfLlmPrimary(async () =>
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

test("Stage 1: all models not found degrades to 200 basic-mode listing every id tried", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockHfLlmPrimary(async (_url: string, init: RequestInit) => {
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

test("Stage 1: a model that returns no text falls through to the next id", async () => {
  configureKeys();
  const models: (string | undefined)[] = [];
  mockHfLlmPrimary(async (_url: string, init: RequestInit) => {
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
  test(`Stage 1: a ${name} is an account problem — fails fast to Stage 3 without walking the chain`, async () => {
    configureKeys();
    const upstream = mockHfLlmPrimary(async () => Response.json(body, { status }));
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

test("Stage 1: a transient 503 on the primary id does not walk the chain", async () => {
  configureKeys();
  const upstream = mockHfLlmPrimary(async () => new Response(null, { status: 503 }));
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

test("Stage 1 sends the same system prompt, query and Step 1 context the Gemini fallback receives", async () => {
  configureKeys();
  let chatBody: ChatRequestBody | undefined;
  let geminiUser = "";
  let geminiSystem = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isGeminiUrl(String(url))) {
      geminiUser = geminiUserText(parseGeminiBody(init));
      geminiSystem = geminiSystemText(parseGeminiBody(init));
      return geminiReply();
    }
    if (isChatUrl(String(url))) {
      chatBody = parseChatBody(init);
      // An account-level failure: the primary stage fails fast (no model
      // walk) and the Gemini fallback takes over with the same turn.
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }
    if (isDetectUrl(String(url))) return Response.json([]);
    // Step 1 — MobileNetV2 PlantVillage (sole default classifier).
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
  assert.equal(system.content, geminiSystem);
  assert.match(system.content, /كيان خبير زراعي واحد موحّد/);
  assert.match(system.content, /يُمنع ذكر نسب الثقة الخام/);
  assert.match(system.content, /درجات المرشحين/);
  assert.match(system.content, /تسميات نموذج الرؤية الخام/);
  assert.match(system.content, /بطاقة التشخيص المرئية معروضة بالفعل/);
  assert.doesNotMatch(system.content, /اذكر المرض بالعربية مع نسبة الثقة|بنِسَبهم/);
  assert.equal(user.role, "user");
  // The Gemini fallback received EXACTLY the same user turn as the primary
  // HF stage: query + Step 1 label/confidence + candidates.
  assert.ok(geminiUser, "the Gemini fallback must have been consulted");
  assert.equal(user.content, geminiUser);
  assert.match(user.content, /بيانات داخلية للاستدلال فقط/);
  assert.match(user.content, /دون نسب الثقة أو درجات المرشحين أو التسميات الخام/);
  assert.doesNotMatch(user.content, /بنِسَبهم|بنِسَبها|بثقة 95%/);
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
    if (isDetectUrl(String(url))) return Response.json([]);
    // Step 1 — MobileNetV2 PlantVillage (sole default classifier).
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
  assert.doesNotMatch(payload.reply, /Tomato___Early_blight/);
  assert.doesNotMatch(payload.reply, /95%/);
  assert.match(payload.reply, /الطماطم/);
  assert.match(payload.reply, /## 💊 خطة العلاج/);
  assert.match(payload.reply, /## 🛡️ الوقاية مستقبلاً/);
  // Failures are reported as non-fatal warnings, not a 500.
  assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
  assert.match(warningText(payload), /Stage 2 Gemini unavailable/);
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
  mockHfLlmPrimary(async (url: string) =>
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
  assert.doesNotMatch(payload.reply, /97%|Tomato___healthy/);
  assert.equal(payload.diagnosis?.confidence, 0.97);
  assert.match(payload.reply, /## 🛡️ وقاية/);
  assert.doesNotMatch(payload.reply, /## 💊 خطة العلاج/);
});

test("zero-failure: low-confidence diagnosis asks for a clearer photo in the direct card", async () => {
  configureKeys();
  mockHfLlmPrimary(async (url: string) =>
    isChatUrl(url)
      ? new Response(null, { status: 503 })
      : Response.json([
          { label: "Tomato___Late_blight", score: 0.3 },
          { label: "Tomato___Early_blight", score: 0.25 },
        ]),
  );
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /صورة أوضح/);
  assert.match(payload.reply, /اللفحة المتأخرة/);
  assert.match(payload.reply, /اللفحة المبكرة/);
  assert.doesNotMatch(payload.reply, /[%٪]|Tomato___|نموذج|خدمة النصوص/);
  assert.equal(payload.diagnosis?.confidence, 0.3);
  assert.equal(payload.diagnosis?.candidates[1]?.score, 0.25);
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
    assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
    assert.match(warningText(payload), /Stage 2 Gemini unavailable/);
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
    assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
    assert.match(warningText(payload), /Stage 2 Gemini unavailable/);
  });
}

test("zero-failure: text-only LLM outage answers a farm question with the polite basic-mode fallback", async () => {
  configureKeys();
  mockHfLlmPrimary(async () => llmGated());
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
  mockHfLlmPrimary(async () => new Response(null, { status: 503 }));
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

test("zero-failure: HF vision failure degrades to the LLM stages with a Step 1 warning (never 500)", async () => {
  configureKeys();
  let geminiCalls = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isGeminiUrl(String(url))) {
      geminiCalls += 1;
      return geminiReply("Water in the morning.");
    }
    // Step 1 fails on every vision model → an LLM stage must still answer.
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
  assert.match(warning, /Stage 1 HF LLM unavailable/);
  assert.match(warning, /Stage 2 Gemini unavailable/);
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
    if (isDetectUrl(String(url))) return Response.json([]);
    // Step 1 — MobileNetV2. Unsorted array — route must sort and pick
    // Tomato___Early_blight 95% as top.
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
  // Stage 1 (the primary HF LLM) runs via the router's chat-completions endpoint…
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
/** Step 1 classifier endpoints (MobileNetV2 PlantVillage — the sole default classifier). */
const isClassifyUrl = (url: string) =>
  url.includes("router.huggingface.co/hf-inference/models/") && /mobilenet|vit/i.test(url);

/** Raw bytes body of an upstream call, base64-encoded for comparisons. */
const bodyB64 = (init: RequestInit) => Buffer.from(init.body as Uint8Array).toString("base64");

/**
 * The Step 0 mock answer: one high-confidence leaf box at (10,8)-(50,40).
 * The label must pass the facebook/detr-resnet-50 plant filter
 * (`/plant|leaf/i`) — "potted plant" is the COCO id's plant-flavoured label.
 */
const leafDetection = () =>
  Response.json([{ label: "potted plant", score: 0.87, box: { xmin: 10, ymin: 8, xmax: 50, ymax: 40 } }]);

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
    // Stage 1 — the primary HF LLM is DOWN here, so the Gemini fallback is
    // the stage that answers (the assertions below only watch Step 0/1).
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
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

  // Pipeline order: detect → classify → HF LLM (down) → Gemini fallback.
  assert.equal(urls.length, 4);
  assert.ok(isDetectUrl(urls[0]));
  // The PRIMARY detector is the COCO facebook/detr-resnet-50 — the obsolete
  // fine-tuned PlantDoc checkpoint is gone from the default chain.
  assert.match(urls[0], /facebook\/detr-resnet-50/);
  assert.doesNotMatch(urls[0], /detr-finetuned-plantdoc/);
  assert.ok(isClassifyUrl(urls[1]));
  assert.equal(urls[2], HF_ROUTER_CHAT_URL);
  assert.ok(isGeminiUrl(urls[3]));

  // The classifier saw the re-encoded CROP, never the original frame.
  assert.notEqual(classifyBody, LEAF_JPEG_B64);
  assert.equal(classifyContentType, "image/jpeg");

  // Crop window: 40×32 box + 12% padding (5,4) → (5,4) 50×40 on the 64×48 frame.
  assert.equal(payload.preprocessing?.status, "cropped");
  assert.equal(payload.preprocessing?.detector, LEAF_DETECTOR);
  assert.deepEqual(payload.preprocessing?.box, [5, 4, 50, 40]);
  assert.equal(typeof payload.preprocessing?.durationMs, "number");

  assert.equal(payload.source, "hybrid");
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

test("Step 0 with no usable detection keeps the full frame for Step 1", async () => {
  configureKeys();
  let classifyBody = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    // The primary HF LLM is down → the Gemini fallback answers.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
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
    // The primary HF LLM is down → the Gemini fallback answers.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
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

test("Step 0 label filter: only plant/leaf boxes are accepted (a person box never crops)", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    // The primary HF LLM is down → the Gemini fallback answers.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    if (isGeminiUrl(String(url))) return geminiReply("تم.");
    if (isDetectUrl(String(url))) {
      // The higher-scoring "person" box (full frame) must be REJECTED by the
      // facebook/detr-resnet-50 plant label filter; the potted-plant box crops.
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
  // The plant box was accepted — the "person" box (which would crop to the
  // full frame) was filtered out by label.
  assert.equal(payload.preprocessing?.status, "cropped");
  assert.equal(payload.preprocessing?.detector, LEAF_DETECTOR);
});

test("Step 0 walks the HF_LEAF_DETECT_MODELS override chain when the primary id 404s", async () => {
  configureKeys();
  process.env.HF_LEAF_DETECT_MODELS = "first/leaf-detector,second/leaf-detector";
  const detectUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    // The primary HF LLM is down → the Gemini fallback answers.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    if (isGeminiUrl(String(url))) return geminiReply("تم.");
    // Custom override ids are not necessarily "detr" — any router URL that is
    // not the classifier is a detection call.
    if (
      /router\.huggingface\.co\/hf-inference\/models\//.test(String(url)) &&
      !isClassifyUrl(String(url))
    ) {
      detectUrls.push(String(url));
      // First id 404s (checkpoint gone) — the chain must walk to the second.
      if (detectUrls.length === 1) return Response.json({ error: "Model not found" }, { status: 404 });
      return Response.json([
        { label: "potted plant", score: 0.8, box: { xmin: 5, ymin: 5, xmax: 45, ymax: 35 } },
      ]);
    }
    assert.ok(isClassifyUrl(String(url)));
    return Response.json([{ label: "Tomato___healthy", score: 0.9 }]);
  });

  try {
    const response = await POST(imageRequest(LEAF_JPEG_B64));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
    assert.deepEqual(detectUrls.map((url) => /models\/(.+)$/.exec(url)?.[1]), [
      "first/leaf-detector",
      "second/leaf-detector",
    ]);
    assert.equal(payload.preprocessing?.status, "cropped");
    assert.equal(payload.preprocessing?.detector, "second/leaf-detector");
  } finally {
    delete process.env.HF_LEAF_DETECT_MODELS;
  }
});

test("HF_LEAF_DETECT_MODELS overrides the Step 0 detector chain", async () => {
  configureKeys();
  process.env.HF_LEAF_DETECT_MODELS = "custom/leaf-detector";
  const detectUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    // The primary HF LLM is down → the Gemini fallback answers.
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
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

/* ------------------------------------------------------------------ */
/*  Step 1 — streamlined vision chain: MobileNetV2 DIRECT (no CodeCraft) */
/* ------------------------------------------------------------------ */

/**
 * The streamlined pipeline locks three contracts:
 *   1. Step 1 routes EVERY photo DIRECTLY to the MobileNetV2 PlantVillage
 *      classifier — the removed CodeCraft engine is never called, whatever
 *      its (legacy) environment variables say;
 *   2. the upstream order is exactly: Step 0 detect → Step 1 MobileNetV2
 *      classify → Stage 1 HF LLM → (on failure) Stage 2 Gemini;
 *   3. the Stage 1 → Stage 2 LLM fallback chain (HF Qwen primary, Gemini
 *      fallback) is intact and unchanged.
 */

test("streamlined Step 1: the photo goes DIRECTLY to MobileNetV2 — detect → classify → HF LLM → Gemini, no CodeCraft", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    // The CodeCraft gateway is gone from the chain: any request to it is a
    // regression in the streamlined pipeline.
    assert.doesNotMatch(String(url), CODECRAFT_URL_PATTERN);
    // Stage 1 — the primary HF LLM is DOWN here, so the Gemini fallback is
    // the stage that answers (the assertions below watch Step 0/1).
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    if (isGeminiUrl(String(url))) return geminiReply("تشخيص مباشر.");
    if (isDetectUrl(String(url))) return leafDetection();
    // Step 1 — the MobileNetV2 PlantVillage classifier is the ONLY vision
    // diagnosis engine left in the pipeline.
    assert.ok(isClassifyUrl(String(url)), `unexpected upstream: ${url}`);
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };

  // Exactly four round-trips: detect → MobileNetV2 → HF LLM (down) → Gemini.
  // A fifth one (the removed CodeCraft attempt) would be a regression.
  assert.equal(urls.length, 4, `expected detect + classify + HF + Gemini, got ${urls.join(" | ")}`);
  assert.ok(isDetectUrl(urls[0]));
  assert.ok(isClassifyUrl(urls[1]), "Step 1 must go directly to the MobileNetV2 classifier");
  assert.ok(urls[1].includes(MOBILENET_MODEL), `expected the MobileNetV2 endpoint, got ${urls[1]}`);
  assert.equal(urls[2], HF_ROUTER_CHAT_URL);
  assert.ok(isGeminiUrl(urls[3]));

  // The MobileNetV2 verdict flows through untouched.
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 95);
  assert.equal(payload.preprocessing?.status, "cropped");
  assert.equal(payload.source, "hybrid");
  // No CodeCraft degradation ever surfaces in the streamlined pipeline.
  assert.doesNotMatch(warningText(payload), /CodeCraft/i);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

test("streamlined Step 1: legacy CODECRAFT_* env vars are ignored — no request ever reaches the removed engine", async () => {
  configureKeys();
  // A deployment that still carries the pre-streamlining CodeCraft config
  // must behave exactly like one without it: the variables are dead config.
  process.env.CODECRAFT_API_KEY = " real-looking-key ";
  process.env.CODECRAFT_BASE_URL = "https://codecraftapi.com/v1";
  process.env.CODECRAFT_VISION_MODEL = "gpt-4o";
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    assert.doesNotMatch(String(url), CODECRAFT_URL_PATTERN, "the removed CodeCraft engine must never be called");
    if (isChatUrl(String(url))) return chatReply("إجابة النموذج الأساسي.");
    if (isDetectUrl(String(url))) return leafDetection();
    assert.ok(isClassifyUrl(String(url)), `unexpected upstream: ${url}`);
    return Response.json([{ label: "Tomato___Late_blight", score: 0.88 }]);
  });

  try {
    const response = await POST(imageRequest(LEAF_JPEG_B64));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    // Step 1 answered directly from MobileNetV2…
    assert.equal(payload.diagnosis?.label, "Tomato___Late_blight");
    assert.equal(payload.source, "hybrid");
    // …and Stage 1 (the HF primary LLM) answered the reply — the streamlined
    // chain never needed Gemini or any other engine.
    assert.equal(payload.reply, "إجابة النموذج الأساسي.");
    // Exactly: detect → classify → HF LLM. Nothing else.
    assert.equal(urls.length, 3);
    assert.ok(urls.every((url) => !CODECRAFT_URL_PATTERN.test(url)));
    assert.doesNotMatch(warningText(payload), /CodeCraft/i);
  } finally {
    delete process.env.CODECRAFT_API_KEY;
    delete process.env.CODECRAFT_BASE_URL;
    delete process.env.CODECRAFT_VISION_MODEL;
  }
});

test("streamlined Step 1: a CodeCraft-only deployment is now an unconfigured one (503 MISSING_KEYS, no request)", async () => {
  // With the engine removed from the chain, its key alone can no longer
  // power the route: the explicit misconfiguration signal applies.
  process.env.CODECRAFT_API_KEY = " real-looking-key ";
  const upstream = mock.method(globalThis, "fetch");
  try {
    const response = await POST(request(true));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "API keys missing on server",
      code: "MISSING_KEYS",
    });
    assert.equal(upstream.mock.callCount(), 0);
  } finally {
    delete process.env.CODECRAFT_API_KEY;
  }
});

test("streamlined Step 1: MobileNetV2 failure still degrades to Gemini inspecting the raw image (Fallback A, no second vision engine)", async () => {
  configureKeys();
  const urls: string[] = [];
  let geminiImage: GeminiImagePart | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    assert.doesNotMatch(String(url), CODECRAFT_URL_PATTERN);
    if (isGeminiUrl(String(url))) {
      geminiImage = geminiImagePart(parseGeminiBody(init));
      return geminiReply("افحص الصورة بنفسي.");
    }
    // Step 0 + Step 1 both fail (models loading) — the streamlined chain has
    // NO backup vision engine; Gemini must inspect the raw image itself.
    return Response.json({ error: "Model is loading", estimated_time: 12 }, { status: 503 });
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.diagnosis, null);
  assert.ok(geminiImage, "Fallback A must still send the raw image to Gemini");
  assert.equal(geminiImage?.data, "aW1hZ2U=");
  assert.match(warningText(payload), /Step 1 vision unavailable/);
  assert.doesNotMatch(warningText(payload), /CodeCraft/i);
  // One vision attempt (classify — the payload is not decodable, so Step 0
  // skips its detect round-trip), then HF LLM (down) and Gemini. A fourth
  // call (the removed CodeCraft engine) would be a regression.
  assert.equal(urls.length, 3);
  assert.ok(isClassifyUrl(urls[0]), "Step 1 must go directly to the MobileNetV2 classifier");
});

test("LLM fallback chain intact: Stage 1 HF primary (Qwen/Qwen3-4B-Instruct-2507) answers first, Gemini untouched", async () => {
  configureKeys();
  const calls: { url: string; init: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    assert.doesNotMatch(String(url), CODECRAFT_URL_PATTERN);
    if (isChatUrl(String(url))) return chatReply("الإجابة الأساسية من Qwen.");
    throw new Error(`Gemini must not run while the primary HF LLM answers: ${url}`);
  });

  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.reply, "الإجابة الأساسية من Qwen.");
  // The PRIMARY model id is Qwen/Qwen3-4B-Instruct-2507 on the HF router…
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HF_ROUTER_CHAT_URL);
  assert.equal(requestedChatModel(calls[0].init), LLM_FALLBACK_ORDER[0]);
  assert.equal(LLM_FALLBACK_ORDER[0], "Qwen/Qwen3-4B-Instruct-2507");
  // …and the Gemini fallback never ran.
  assert.doesNotMatch(warningText(payload), /Gemini/);
});

test("LLM fallback chain intact: HF failure, timeout-shaped error or empty reply seamlessly triggers the Gemini fallback", async () => {
  for (const failure of [
    () => new Response(null, { status: 503 }), // router down
    () => Response.json({ choices: [] }), // empty reply on every model
  ] as const) {
    configureKeys();
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      urls.push(String(url));
      assert.doesNotMatch(String(url), CODECRAFT_URL_PATTERN);
      if (isChatUrl(String(url))) return failure();
      assert.ok(isGeminiUrl(String(url)), `unexpected upstream: ${url}`);
      return geminiReply("الإجابة الاحتياطية من Gemini.");
    });

    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    // Gemini answered seamlessly after the HF stage failed…
    assert.equal(payload.source, "llm");
    assert.equal(payload.reply, "الإجابة الاحتياطية من Gemini.");
    // …with the degradation reported as a non-fatal warning.
    assert.match(warningText(payload), /Stage 1 HF LLM unavailable/);
    // HF first, then Gemini — the dual-tiered fallback order is locked.
    assert.equal(urls[0], HF_ROUTER_CHAT_URL);
    assert.ok(isGeminiUrl(urls[urls.length - 1]));
    mock.restoreAll();
  }
});
