import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { dynamic, geminiModelHealth, POST } from "../../src/app/api/assistant/route";

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
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
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
  /^(DEMO_MOCK|PHYTOSCAN_DEMO_MOCK|GEMINI_API_KEY|GEMINI_MODEL|HUGGINGFACE_API_KEY|HF_TOKEN|HF_LEAF_DETECT_MODELS|HF_VISION_MODEL|CODECRAFT_API_KEY|CODECRAFT_BASE_URL|CODECRAFT_VISION_MODEL|CODECRAFT_MODEL)/;
// NOTE: the DEMO_MOCK family is scrubbed AND pinned to "0" below: the demo
// mock is ON by default (that is what a recording deployment needs), while
// this suite exists to exercise the REAL orchestrator on every turn.
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
  // The scripted demo mock (ON by default) is explicitly disabled here so
  // every assertion below observes the real orchestrator.
  process.env.DEMO_MOCK = "0";
  // The health verdict is cached per process for 6 h. Each test starts from a
  // known-clean verdict so an earlier test's dead-id set cannot leak forward;
  // the health-check tests below `reset()` to force a real ListModels call.
  geminiModelHealth.reset();
  geminiModelHealth.markVerified();
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

/**
 * The health check's `GET /v1beta/models` catalog call — issued once per
 * process (TTL-bounded) before the first Gemini round-trip, so a retired
 * model id is reported before it is used.
 */
const isListModelsUrl = (url: string) =>
  url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?") &&
  url.includes("pageSize=");

/** Mirrors a ListModels payload; `ids` are exposed as generateContent-capable. */
const listModelsReply = (ids: string[]) =>
  Response.json({
    models: ids.map((id) => ({
      name: `models/${id}`,
      supportedGenerationMethods: ["generateContent", "countTokens"],
    })),
  });

/**
 * Capture what the route writes to the console so a health verdict can be
 * asserted on. `mock.restoreAll()` in `afterEach` puts the real methods back.
 */
function captureConsole() {
  const lines: string[] = [];
  for (const level of ["log", "error", "warn"] as const) {
    mock.method(console, level, (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  }
  return {
    all: () => lines,
    find: (needle: string) => lines.find((line) => line.includes(needle)),
  };
}

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

/* ------------------------------------------------------------------ */
/*  Step 1 image analysis — Gemini JSON + MobileNetV2 classification    */
/* ------------------------------------------------------------------ */

/** A complete, well-formed `AnalysisData` object (Gemini's happy path). */
const ANALYSIS_FIXTURE = {
  plant_type: "الطماطم",
  disease_detected: true,
  disease_name: "اللفحة المتأخرة",
  confidence: 0.82,
  affected_parts: ["الأوراق السفلية"],
  severity: "medium",
  symptoms_observed: ["بقع بنية داكنة", "ذبول الحواف"],
  notes: "الإصابة متقدمة على الأوراق السفلية.",
} as const;

/** Merge overrides into the healthy `AnalysisData` fixture. */
const analysisFixture = (overrides: Record<string, unknown> = {}) => ({
  ...ANALYSIS_FIXTURE,
  ...overrides,
});

/**
 * A `models.generateContent` answer carrying a JSON `AnalysisData` object —
 * what Gemini returns for the Step 1 image analysis under
 * `responseMimeType: "application/json"`.
 */
const geminiAnalysis = (data: unknown = ANALYSIS_FIXTURE) =>
  Response.json({
    candidates: [
      {
        content: { role: "model", parts: [{ text: JSON.stringify(data) }] },
        finishReason: "STOP",
      },
    ],
  });

/** A Gemini answer whose text is NOT a usable `AnalysisData` object. */
const geminiAnalysisRaw = (text: string) =>
  Response.json({
    candidates: [
      { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
    ],
  });

/** MobileNetV2's raw PlantVillage classification payload. */
const mobilenetReply = (
  label = "Tomato___Late_blight",
  score = 0.91,
  extra: { label: string; score: number }[] = [],
) =>
  Response.json([{ label, score }, ...extra]);

/** Mirrors a text reply that is grounded in `ANALYSIS_FIXTURE`. */
const GROUNDED_REPLY =
  "اللفحة المتأخرة ظهرت بوضوح على أوراق الطماطم السفلية. أنصح برشّ مبيد نحاسي وإزالة الأوراق المصابة مع السقي عند القاعدة.";


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
    responseMimeType?: string;
    responseSchema?: { required?: string[]; type?: string };
    thinkingConfig?: { thinkingBudget?: number; thinkingLevel?: string };
  };
}

const parseGeminiBody = (init: RequestInit): GeminiRequestBody =>
  JSON.parse(String(init.body ?? "{}")) as GeminiRequestBody;

const geminiSystemText = (body: GeminiRequestBody) =>
  (body.systemInstruction?.parts ?? []).map((part) => part.text ?? "").join("");

/** The text of the LAST user turn (history turns precede it). */
const geminiUserText = (body: GeminiRequestBody) => {
  const turn = body.contents?.[body.contents.length - 1];
  return (turn?.parts ?? []).map((part) => part.text ?? "").join("");
};

/**
 * The inlineData image part. ONLY the Step 1 image-analysis call may attach
 * one — the Step 3 text fallback is a formatter and must receive no pixels.
 */
const geminiImagePart = (body: GeminiRequestBody): GeminiImagePart | undefined => {
  for (const turn of body.contents ?? []) {
    const found = (turn.parts ?? []).find((part) => part.inlineData !== undefined)?.inlineData;
    if (found) return found;
  }
  return undefined;
};

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
  severity?: string | null;
  candidates: { label: string; score: number }[];
}

interface AssistantPayload {
  reply: string;
  diagnosis: DiagnosisLike | null;
  source: string;
  analysisSource?: string | null;
  textSource?: string | null;
  preprocessing?: { status: string; box: [number, number, number, number] | null } | null;
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
    // `beforeEach` pre-verifies the chain, so the strict single-URL mock below
    // still holds: only the generation round-trip reaches fetch.
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
/*  The ListModels health check, exercised through the real route       */
/* ------------------------------------------------------------------ */

test("a model id the health check proves dead is dropped before the first generateContent", async () => {
  configureKeys();
  geminiModelHealth.reset();
  const asked: string[] = [];
  const [retiredPrimary, liveFallback] = GEMINI_FALLBACK_ORDER;
  let listCalls = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    const target = String(url);
    // The production incident, reproduced: the primary is gone from the
    // catalog, the long-lived fallback is still there.
    if (isListModelsUrl(target)) {
      listCalls += 1;
      return listModelsReply(GEMINI_FALLBACK_ORDER.slice(1));
    }
    asked.push(requestedGeminiModel(target) as string);
    if (isChatUrl(target)) return chatReply(GROUNDED_REPLY);
    return geminiAnalysis();
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");

  // The dead primary was never attempted: the check prevented a known-404.
  assert.equal(asked.includes(retiredPrimary as string), false, `asked: ${asked.join(", ")}`);
  assert.equal(asked[0], liveFallback as string, "the first live id is tried first");
  assert.equal(listCalls, 1);

  // A second request reuses the verdict (6 h TTL) — no second ListModels call.
  await POST(request(true));
  assert.equal(listCalls, 1, "the verdict is cached, not re-queried per request");
});

test("a full catalog outage is reported but never fails the request", async () => {
  configureKeys();
  geminiModelHealth.reset();
  const captured = captureConsole();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isListModelsUrl(String(url))) throw new Error("ListModels unreachable");
    if (isChatUrl(String(url))) return chatReply(GROUNDED_REPLY);
    return geminiAnalysis();
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200, "an unrunnable health check must never 500 a request");
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");

  // Reported loudly, because "could not verify" is a real deployment signal.
  const report = captured.all().filter((line) => line.includes("Gemini Health")).join("\n");
  assert.ok(report, "the verdict must be logged even when it cannot verify");
  assert.match(report, /could not verify the model chain \(ListModels unreachable\)/);
  assert.match(report, /check:models/, "it must say how to diagnose the failure");
});

test("a fully dead chain is logged as a total outage, not silently degraded", async () => {
  configureKeys();
  geminiModelHealth.reset();
  const captured = captureConsole();
  // Every configured id is retired — the exact shape of the 2026-09 incident,
  // where all eight keys 404'd and every photo fell through to MobileNetV2.
  mock.method(globalThis, "fetch", async (url: string) => {
    const target = String(url);
    if (isListModelsUrl(target)) return listModelsReply(["gemini-1.0-pro"]);
    if (isChatUrl(target)) return chatReply(GROUNDED_REPLY);
    if (isDetectUrl(target)) return Response.json([]);
    if (isGeminiUrl(target)) return new Response("not found", { status: 404 });
    return mobilenetReply("Tomato___Late_blight", 0.9);
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200, "a dead chain degrades, it does not 500");
  const payload = (await response.json()) as AssistantPayload;
  // With the chain dead the route cannot use Gemini at all — and this is the
  // degradation that used to happen SILENTLY on every photo. The log below is
  // the whole point of the health check.
  assert.equal(payload.analysisSource, "mobilenet");

  // The report spans several lines; the total-outage verdict is the last one.
  const report = captured.all().filter((line) => line.includes("Gemini Health")).join("\n");
  assert.match(report, /3 of 3 configured model ids are NOT available/);
  assert.match(report, /NO configured id is live/);
  assert.match(
    report,
    /degrade to MobileNetV2/,
    "it must spell out the consequence that was previously silent",
  );
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
  // Primary first (503), then the Gemini fallback with gemini-3.8-flash.
  assert.equal(urls.length, 2);
  assert.equal(urls[0], HF_ROUTER_CHAT_URL);
  assert.equal(
    urls[1],
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_KEY}`,
  );
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
});

/* ------------------------------------------------------------------ */
/*  Stage 2 — Google Gemini fallback LLM                                */
/* ------------------------------------------------------------------ */

test("Stage 2 answers from gemini-3.8-flash with 200 { source: \"llm\" }", async () => {
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
  assert.match(warningText(payload), /Step 2 HF text model unavailable — HUGGINGFACE_API_KEY is not configured/);

  // A single round-trip: the fallback LLM. Neither the HF primary chain nor
  // the vision model is touched when Stage 2 answers.
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(
    url,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_KEY}`,
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

test("Stage 2 keeps the gemini-3.8-flash endpoint when the API key rotates", async () => {
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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`,
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
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
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

/* ------------------------------------------------------------------ */
/*  STEP 1 — IMAGE ANALYSIS: Gemini PRIMARY → MobileNetV2 FALLBACK      */
/* ------------------------------------------------------------------ */

/**
 * The full happy path: Gemini analyses the photo and the Hugging Face text
 * model narrates it. MobileNetV2 must never be reached — the fallback is
 * strictly conditional.
 */
test("Step 1: Gemini analyses the image FIRST and MobileNetV2 is never called", async () => {
  configureKeys();
  const urls: string[] = [];
  let analysisBody: GeminiRequestBody | undefined;
  let chatUser = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    urls.push(target);
    if (isChatUrl(target)) {
      chatUser = (parseChatBody(init).messages ?? []).at(-1)?.content ?? "";
      return chatReply(GROUNDED_REPLY);
    }
    if (isGeminiUrl(target)) {
      analysisBody = parseGeminiBody(init);
      return geminiAnalysis();
    }
    // Step 0 detector finds nothing usable → the full frame continues.
    if (isDetectUrl(target)) return Response.json([]);
    throw new Error(`unexpected upstream request: ${target}`);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;

  // Gemini ran the image analysis and the HF text model narrated it.
  assert.equal(payload.analysisSource, "gemini");
  assert.equal(payload.textSource, "huggingface");
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis?.labelAr, "اللفحة المتأخرة");
  assert.equal(payload.diagnosis?.healthy, false);
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 82);
  assert.equal(payload.reply, GROUNDED_REPLY);

  // Gemini is the FIRST image model: it is called before any HF vision URL,
  // and the MobileNetV2 classifier endpoint is never touched at all.
  const geminiIndex = urls.findIndex(isGeminiUrl);
  assert.ok(geminiIndex >= 0, "Gemini must run the image analysis");
  assert.equal(
    urls.findIndex(isClassifyUrl),
    -1,
    `MobileNetV2 must not run when Gemini succeeded: ${urls.join(", ")}`,
  );

  // The analysis is pinned to structured JSON output.
  assert.equal(analysisBody?.generationConfig?.responseMimeType, "application/json");
  assert.ok(analysisBody?.generationConfig?.responseSchema);
  assert.deepEqual(analysisBody?.generationConfig?.responseSchema?.required, [
    "plant_type",
    "disease_detected",
    "disease_name",
    "confidence",
    "affected_parts",
    "severity",
    "symptoms_observed",
    "notes",
  ]);
  // Gemini gets the RAW photo — the crop is for the narrow classifier only.
  assert.equal(geminiImagePart(analysisBody!)?.data, LEAF_JPEG_B64);

  // The text stage is handed ANALYSIS_DATA, not pixels.
  assert.match(chatUser, /اللفحة المتأخرة/);
  assert.match(chatUser, /الأوراق السفلية/);
  assert.doesNotMatch(chatUser, /Tomato___/);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

/**
 * The single trigger for the MobileNetV2 fallback: the Gemini image analysis
 * FAILED. Its raw `{ label, score }` is mapped into the same schema, so the
 * diagnosis card and the text stage see an identical shape.
 */
test("Step 1 fallback: a failed Gemini analysis hands over to MobileNetV2", async () => {
  configureKeys();
  const urls: string[] = [];
  let chatUser = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    urls.push(target);
    if (isChatUrl(target)) {
      chatUser = (parseChatBody(init).messages ?? []).at(-1)?.content ?? "";
      return chatReply(GROUNDED_REPLY);
    }
    // Gemini refuses / cannot process the image.
    if (isGeminiUrl(target)) return geminiBlocked();
    if (isDetectUrl(target)) return Response.json([]);
    return mobilenetReply("Tomato___Late_blight", 0.93, [
      { label: "Tomato___Early_blight", score: 0.04 },
    ]);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;

  // The fallback ran, and the provenance flipped.
  assert.equal(payload.analysisSource, "mobilenet");
  assert.equal(payload.diagnosis?.label, "Tomato___Late_blight");
  assert.equal(payload.diagnosis?.labelAr, "الطماطم — اللفحة المتأخرة");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 93);
  // Runner-up classifications survive for the card.
  assert.equal(payload.diagnosis?.candidates.length, 2);
  // The text stage is source-agnostic: it sees the same schema either way.
  assert.match(chatUser, /اللفحة المتأخرة/);
  assert.doesNotMatch(chatUser, /Tomato___/);
  assert.match(warningText(payload), /Step 1 Gemini image analysis failed/);
  // Order: detect → Gemini (primary, failed) → MobileNetV2 (fallback) → chat.
  assert.ok(urls.findIndex(isGeminiUrl) < urls.findIndex(isClassifyUrl));
});

/** Every Gemini failure mode that MUST hand over to MobileNetV2. */
for (const [name, failure] of [
  ["a network error", () => { throw new TypeError("fetch failed"); }],
  ["an HTTP 500", () => new Response(null, { status: 500 })],
  ["an invalid API key", () => geminiHttpError(400, "API key not valid.")],
  ["a safety block / refusal", () => geminiBlocked()],
  ["an empty candidate list", () => geminiEmpty()],
  ["free text instead of JSON", () => geminiAnalysisRaw("الورقة مصابة باللفحة المتأخرة.")],
  ["a truncated JSON object", () => geminiAnalysisRaw('{"plant_type":"الطماطم","disease_det')],
  ["a JSON object missing required fields", () => geminiAnalysisRaw('{"plant_type":"الطماطم","confidence":0.9}')],
  ["a JSON array instead of an object", () => geminiAnalysisRaw('[{"plant_type":"الطماطم"}]')],
] as const) {
  test(`Step 1 fallback: ${name} falls back to MobileNetV2`, async () => {
    configureKeys();
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      const target = String(url);
      urls.push(target);
      if (isChatUrl(target)) return chatReply(GROUNDED_REPLY);
      if (isGeminiUrl(target)) return failure();
      if (isDetectUrl(target)) return Response.json([]);
      return mobilenetReply("Tomato___Late_blight", 0.9);
    });

    const response = await POST(imageRequest(LEAF_JPEG_B64));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(payload.analysisSource, "mobilenet", "MobileNetV2 must take over");
    assert.ok(urls.findIndex(isGeminiUrl) >= 0, "Gemini must be tried first");
    assert.ok(urls.findIndex(isClassifyUrl) >= 0, "MobileNetV2 must run as the fallback");
  });
}

/**
 * The orchestrator has NO confidence threshold: a low-confidence Gemini
 * verdict is legitimate data. It must be used as-is, and must NOT trigger the
 * MobileNetV2 fallback.
 */
test("Step 1: a LOW-confidence Gemini analysis is NOT a failure — no MobileNetV2 fallback", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    const target = String(url);
    urls.push(target);
    if (isChatUrl(target)) return chatReply(GROUNDED_REPLY);
    if (isGeminiUrl(target)) {
      return geminiAnalysis(analysisFixture({ confidence: 0.11 }));
    }
    if (isDetectUrl(target)) return Response.json([]);
    throw new Error(`unexpected upstream request: ${target}`);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;

  // The low score is passed straight through…
  assert.equal(payload.analysisSource, "gemini");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 11);
  // …and MobileNetV2 was never consulted.
  assert.equal(
    urls.findIndex(isClassifyUrl),
    -1,
    "a low confidence must NOT trigger the MobileNetV2 fallback",
  );
  assert.doesNotMatch(warningText(payload), /MobileNetV2/);
});

/** An out-of-range or unparseable confidence is clamped, never a failure. */
test("Step 1: an out-of-range confidence is clamped and still passes through", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    const target = String(url);
    urls.push(target);
    if (isChatUrl(target)) return chatReply(GROUNDED_REPLY);
    if (isGeminiUrl(target)) return geminiAnalysis(analysisFixture({ confidence: 1.4 }));
    if (isDetectUrl(target)) return Response.json([]);
    throw new Error(`unexpected upstream request: ${target}`);
  });

  const payload = (await (await POST(imageRequest(LEAF_JPEG_B64))).json()) as AssistantPayload;
  assert.equal(payload.analysisSource, "gemini");
  assert.equal(payload.diagnosis?.confidence, 1);
  assert.equal(urls.findIndex(isClassifyUrl), -1);
});

/** A healthy verdict is a real, non-failure outcome. */
test("Step 1: a healthy Gemini verdict passes through without a disease name", async () => {
  configureKeys();
  let chatUser = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    if (isChatUrl(target)) {
      chatUser = (parseChatBody(init).messages ?? []).at(-1)?.content ?? "";
      return chatReply("الورقة خضراء سليمة ولا يبدو عليها أي مرض. اسقِ عند القاعدة وراقبها أسبوعياً.");
    }
    if (isGeminiUrl(target)) {
      return geminiAnalysis(
        analysisFixture({
          disease_detected: false,
          disease_name: "",
          confidence: 0.6,
          severity: "none",
        }),
      );
    }
    if (isDetectUrl(target)) return Response.json([]);
    throw new Error(`unexpected upstream request: ${target}`);
  });

  const payload = (await (await POST(imageRequest(LEAF_JPEG_B64))).json()) as AssistantPayload;
  assert.equal(payload.analysisSource, "gemini");
  assert.equal(payload.diagnosis?.healthy, true);
  assert.equal(payload.diagnosis?.severity, null);
  // A name can never leak through a "no disease" verdict.
  assert.doesNotMatch(chatUser, /اللفحة المتأخرة/);
  assert.match(chatUser, /لم تُرصد إصابة مرضية/);
});

/* ------------------------------------------------------------------ */
/*  STEP 4 — FINAL FALLBACK (both image models failed)                 */
/* ------------------------------------------------------------------ */

test("Step 4: both image models fail → a polite retry message and NO text model is called", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    const target = String(url);
    urls.push(target);
    if (isGeminiUrl(target)) return new Response(null, { status: 503 });
    if (isChatUrl(target)) throw new Error("Step 4 must not call any text model");
    if (isDetectUrl(target)) return Response.json([]);
    return new Response(null, { status: 503 });
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;

  // No analysis, no text model, no fabricated diagnosis.
  assert.equal(payload.diagnosis, null);
  assert.equal(payload.analysisSource, null);
  assert.equal(payload.textSource, null);
  assert.equal(payload.source, "direct");
  assert.equal(
    urls.filter(isChatUrl).length,
    0,
    "the Step 4 rule forbids calling a text model with empty analysis data",
  );
  // A clear, polite message asking for a better photo.
  assert.match(payload.reply, /تعذّر تحليل صورة النبتة/);
  assert.match(payload.reply, /مُضاءة جيداً/);
  assert.match(payload.reply, /قريبة/);
  assert.match(warningText(payload), /Image analysis unavailable/);
});

test("Step 4: the final fallback also fires when the MobileNetV2 fallback is unconfigured", async () => {
  // Gemini is configured but its analysis fails, and no Hugging Face token
  // exists (a blank HF_TOKEN alias counts as unconfigured) — so neither
  // image model can answer and the request lands on STEP 4.
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  process.env.HF_TOKEN = " ";
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    const target = String(url);
    urls.push(target);
    if (isGeminiUrl(target)) return new Response(null, { status: 503 });
    throw new Error(`unexpected upstream request: ${target}`);
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.analysisSource, null);
  assert.equal(payload.textSource, null);
  assert.match(payload.reply, /تعذّر تحليل صورة النبتة/);
  // Only the Gemini analysis attempt was made — the classifier was skipped
  // by configuration and no text model ran.
  assert.equal(urls.filter((url) => isClassifyUrl(url)).length, 0);
  assert.equal(urls.filter((url) => isChatUrl(url)).length, 0);
  assert.match(warningText(payload), /MobileNetV2 unavailable/);
});

/* ------------------------------------------------------------------ */
/*  STEP 2 → STEP 3 — text generation and its format-only fallback      */
/* ------------------------------------------------------------------ */

test("Step 2 → Step 3: when the HF text model fails, Gemini formats the same ANALYSIS_DATA with no image", async () => {
  configureKeys();
  const urls: string[] = [];
  let formatterBody: GeminiRequestBody | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    urls.push(target);
    if (isChatUrl(target)) return new Response(null, { status: 503 });
    if (isGeminiUrl(target)) {
      const body = parseGeminiBody(init);
      // The image analysis and the text fallback are distinguishable by
      // their generationConfig: only the analysis pins a JSON schema.
      if (body.generationConfig?.responseMimeType === "application/json") {
        return geminiAnalysis();
      }
      formatterBody = body;
      return geminiReply(GROUNDED_REPLY);
    }
    if (isDetectUrl(target)) return Response.json([]);
    throw new Error(`unexpected upstream request: ${target}`);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;

  assert.equal(payload.analysisSource, "gemini");
  assert.equal(payload.textSource, "gemini_fallback");
  assert.equal(payload.reply, GROUNDED_REPLY);

  // Gemini acted ONLY as a formatter: no pixels, no JSON schema, and the
  // same advisor system prompt the HF stage would have received.
  assert.equal(geminiImagePart(formatterBody!), undefined, "the text stage must get no image");
  assert.equal(formatterBody?.generationConfig?.responseMimeType, undefined);
  assert.match(geminiSystemText(formatterBody!), /أنت مساعد زراعي خبير/);
  const user = geminiUserText(formatterBody!);
  assert.match(user, /اللفحة المتأخرة/);
  assert.match(user, /الأوراق السفلية/);
});

/**
 * The edge case called out in the spec: the analysis came from MobileNetV2
 * and the HF text model then failed. Gemini must format the MobileNetV2 data
 * and must NOT re-run its own image analysis.
 */
test("Step 3 edge case: MobileNetV2 analysis + HF text failure → Gemini formats the MobileNetV2 data", async () => {
  configureKeys();
  let geminiCalls = 0;
  let formatterBody: GeminiRequestBody | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    if (isChatUrl(target)) return new Response(null, { status: 503 });
    if (isGeminiUrl(target)) {
      const body = parseGeminiBody(init);
      if (body.generationConfig?.responseMimeType === "application/json") {
        geminiCalls += 1;
        return geminiHttpError(400, "API key not valid.");
      }
      formatterBody = body;
      return geminiReply(GROUNDED_REPLY);
    }
    if (isDetectUrl(target)) return Response.json([]);
    return mobilenetReply("Tomato___Late_blight", 0.9);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;

  assert.equal(payload.analysisSource, "mobilenet");
  assert.equal(payload.textSource, "gemini_fallback");
  // Exactly one Gemini image-analysis attempt: no second analysis happened.
  assert.equal(geminiCalls, 1);
  // The formatter received the MobileNetV2-derived data and NO image.
  assert.equal(geminiImagePart(formatterBody!), undefined);
  assert.match(geminiUserText(formatterBody!), /اللفحة المتأخرة/);
});

/** Text-stage failure (c): a reply that ignores ANALYSIS_DATA is rejected. */
for (const [name, reply] of [
  [
    "an off-topic answer",
    "الزراعة الجيدة تحتاج تربة خصبة وماءً منتظماً خلال موسم النمو، مع متابعة دورية للحقل بأكمله.",
  ],
  ["an empty reply", "   "],
  ["a punctuation-only reply", "..."],
] as const) {
  test(`Step 2 → Step 3: a rejected HF reply (${name}) hands over to Gemini`, async () => {
    configureKeys();
    let formatterCalled = false;
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      const target = String(url);
      if (isChatUrl(target)) return chatReply(reply);
      if (isGeminiUrl(target)) {
        const body = parseGeminiBody(init);
        if (body.generationConfig?.responseMimeType === "application/json") {
          return geminiAnalysis();
        }
        formatterCalled = true;
        return geminiReply(GROUNDED_REPLY);
      }
      if (isDetectUrl(target)) return Response.json([]);
      throw new Error(`unexpected upstream request: ${target}`);
    });

    const response = await POST(imageRequest(LEAF_JPEG_B64));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    assert.equal(formatterCalled, true, "the Gemini formatter must take over");
    assert.equal(payload.textSource, "gemini_fallback");
    assert.equal(payload.reply, GROUNDED_REPLY);
  });
}

/** Both text models rejecting → the built-in direct card, still 200. */
test("zero-failure: both text models reject their replies after a successful image analysis", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = String(url);
    if (isChatUrl(target)) return chatReply("لا أفيدك في هذا."); // off-analysis
    if (isGeminiUrl(target)) {
      const body = parseGeminiBody(init);
      if (body.generationConfig?.responseMimeType === "application/json") {
        return geminiAnalysis();
      }
      return geminiReply("لا أفيدك في هذا.");
    }
    if (isDetectUrl(target)) return Response.json([]);
    throw new Error(`unexpected upstream request: ${target}`);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.equal(payload.analysisSource, "gemini");
  assert.equal(payload.textSource, null);
  assert.equal(payload.diagnosis?.labelAr, "اللفحة المتأخرة");
  assert.match(payload.reply, /## 🔬 التشخيص/);
  assert.match(payload.reply, /## 💊 خطة العلاج/);
  assert.doesNotMatch(payload.reply, /82%/);
  assert.match(warningText(payload), /Reply formatted locally/);
});

/** The Gemini key pool is exercised by the image analysis, not only by the text fallback. */
test("Gemini key pool: the image analysis rotates keys on a quota failure", async () => {
  process.env.GEMINI_API_KEYS = " key-a , key-b ";
  process.env.HUGGINGFACE_API_KEY = HF_KEY;
  const attempted: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    const target = String(url);
    if (isChatUrl(target)) return chatReply(GROUNDED_REPLY);
    if (isGeminiUrl(target)) {
      const key = requestedGeminiKey(target) ?? "";
      attempted.push(key);
      if (key === "key-a") {
        return geminiHttpError(429, "Quota exceeded (RESOURCE_EXHAUSTED).");
      }
      return geminiAnalysis();
    }
    if (isDetectUrl(target)) return Response.json([]);
    throw new Error(`unexpected upstream request: ${target}`);
  });

  const payload = (await (await POST(imageRequest(LEAF_JPEG_B64))).json()) as AssistantPayload;
  assert.deepEqual(attempted, ["key-a", "key-b"]);
  assert.equal(payload.analysisSource, "gemini");
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
    assert.match(warningText(payload), /Step 2 HF text model unavailable/);
    assert.match(warningText(payload), /Step 3 Gemini text fallback unavailable/);
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
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
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
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
  assert.match(warningText(payload), /Step 3 Gemini text fallback unavailable/);
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
  assert.match(warningText(payload), /Gemini unavailable/);
  assert.match(warningText(payload), /is not found for API version v1beta/);
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
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
  assert.match(warning, /Step 3 Gemini text fallback unavailable/);
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

  // Every id in the current chain is a Gemini 3.x generation, which reasons
  // by default and takes `thinkingLevel: "low"` (the legacy numeric
  // `thinkingBudget` is rejected on this generation).
  for (const model of GEMINI_FALLBACK_ORDER) {
    const body = bodies.get(model);
    assert.ok(body, `no request body captured for ${model}`);
    assert.deepEqual(
      body.generationConfig?.thinkingConfig,
      { thinkingLevel: "low" },
      `${model} must be sent thinkingLevel: "low"`,
    );
  }
});

/** A `GEMINI_MODEL` override predates nothing: it gets NO thinkingConfig. */
test("a pinned GEMINI_MODEL override receives no thinkingConfig", async () => {
  configureKeys();
  process.env.GEMINI_MODEL = "gemini-3.7-flash";
  let body: GeminiRequestBody | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    body = parseGeminiBody(init);
    return geminiReply();
  });
  assert.equal((await POST(request())).status, 200);
  assert.equal(body?.generationConfig?.thinkingConfig, undefined);
});

/* ------------------------------------------------------------------ */
/*  Stage 2 — GEMINI_MODEL override                                     */
/* ------------------------------------------------------------------ */

test("GEMINI_MODEL overrides the Stage-2 model id (trimmed, single round-trip)", async () => {
  configureKeys();
  // Pin a different stable id; the padding proves the value is trimmed.
  process.env.GEMINI_MODEL = " gemini-3.7-flash ";
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
  // gemini-3.8-flash id is skipped and the override is not duplicated as its
  // own fallback.
  assert.deepEqual(urls.map(requestedGeminiModel), ["gemini-3.7-flash"]);
});

test("a GEMINI_MODEL override that 404s walks to the built-in fallback ids", async () => {
  configureKeys();
  process.env.GEMINI_MODEL = "gemini-9.9-flash";
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    urls.push(String(url));
    if (isGeminiUrl(String(url))) {
      const model = requestedGeminiModel(String(url)) ?? "";
      return model === "gemini-9.9-flash"
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
  // The override REPLACES the default primary, so the first fallback walked
  // is the first built-in one.
  assert.deepEqual(urls.map(requestedGeminiModel), [
    "gemini-9.9-flash",
    GEMINI_FALLBACK_ORDER[1],
  ]);
  assert.match(warningText(payload), /Gemini unavailable/);
});

test("a blank GEMINI_MODEL falls back to the gemini-3.8-flash default", async () => {
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
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
  assert.match(warningText(payload), /Step 3 Gemini text fallback unavailable/);
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
    // The skip is a graceful degradation, not an error: no `[Step 2: HF LLM
    // Error]` line, and no safety-net exception.
    assert.ok(
      errorLog.mock.calls.every(
        (call) => !/Step 2: HF LLM Error|Safety Net/.test(String(call.arguments[0])),
      ),
    );
    const warning = warningText(payload);
    assert.match(warning, /Step 2 HF text model unavailable — HUGGINGFACE_API_KEY is not configured/);
    assert.match(warning, /HF_TOKEN unset too/);
    assert.match(warning, /Reply formatted locally/);
  });
}

test("Gemini-only deployment: an image request is analysed AND narrated by Gemini alone", async () => {
  // No Hugging Face token: Step 1 is the only text model and is skipped, so
  // Gemini does both jobs — the image analysis (Step 1) and the formatting
  // (Step 3). MobileNetV2 never runs, because it is a fallback and Gemini
  // (the primary) succeeded.
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  const geminiBodies: GeminiRequestBody[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.ok(isGeminiUrl(String(url)), `no HF provider is configured: ${url}`);
    const body = parseGeminiBody(init);
    geminiBodies.push(body);
    // Exactly one call carries the photo + the JSON schema: the analysis.
    return body.generationConfig?.responseMimeType === "application/json"
      ? geminiAnalysis()
      : geminiReply(GROUNDED_REPLY);
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.analysisSource, "gemini");
  assert.equal(payload.textSource, "gemini_fallback");
  assert.equal(payload.reply, GROUNDED_REPLY);
  assert.equal(geminiBodies.length, 2, "one analysis call + one formatting call");
  // The analysis saw the photo; the formatter did not.
  assert.equal(geminiImagePart(geminiBodies[0])?.data, "aW1hZ2U=");
  assert.equal(geminiImagePart(geminiBodies[1]), undefined);
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
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

test("both text stages receive the same system prompt and the same ANALYSIS_DATA user turn", async () => {
  configureKeys();
  let chatBody: ChatRequestBody | undefined;
  let geminiUser = "";
  let geminiSystem = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isChatUrl(String(url))) {
      chatBody = parseChatBody(init);
      // An account-level failure: the primary stage fails fast (no model
      // walk) and the Gemini fallback takes over with the same turn.
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }
    if (isGeminiUrl(String(url))) {
      const body = parseGeminiBody(init);
      // Skip the Step 1 image analysis so we can assert on the FORMATTER
      // call specifically: it is the one without the JSON response schema.
      if (body.generationConfig?.responseMimeType === "application/json") {
        return geminiAnalysis();
      }
      geminiUser = geminiUserText(body);
      geminiSystem = geminiSystemText(body);
      return geminiReply(GROUNDED_REPLY);
    }
    throw new Error(`unexpected upstream: ${url}`);
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
  assert.match(system.content, /بطاقة التشخيص المرئية معروضة بالفعل/);
  assert.match(system.content, /يُمنع ذكر نسب الثقة الخام/);
  assert.equal(user.role, "user");
  // The Gemini fallback received EXACTLY the same user turn as the primary
  // HF stage: query + the ANALYSIS_DATA reference block.
  assert.ok(geminiUser, "the Gemini fallback must have been consulted");
  assert.equal(user.content, geminiUser);
  assert.match(user.content, /بيانات داخلية للاستدلال فقط/);
  assert.match(user.content, /اللفحة المتأخرة/);
  assert.match(user.content, /الأوراق السفلية/);
  assert.match(user.content, /How should I irrigate tomatoes\?/);
  // The inter-stage payload is source-agnostic: no machine label leaks.
  assert.doesNotMatch(user.content, /Tomato___/);
  assert.doesNotMatch(user.content, /mobilenet|PlantVillage|gemini/i);
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
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
  assert.match(warningText(payload), /Step 3 Gemini text fallback unavailable/);
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
    assert.match(warningText(payload), /Step 2 HF text model unavailable/);
    assert.match(warningText(payload), /Step 3 Gemini text fallback unavailable/);
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
    assert.match(warningText(payload), /Step 2 HF text model unavailable/);
    assert.match(warningText(payload), /Step 3 Gemini text fallback unavailable/);
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

test("Step 4: an image-stage outage answers 200 with the retry message and no 500", async () => {
  configureKeys();
  let chatCalls = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) {
      chatCalls += 1;
      throw new Error("Step 4 must not call any text model");
    }
    // Both image models are down.
    return new Response(null, { status: 503 });
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis, null);
  assert.equal(payload.analysisSource, null);
  assert.equal(chatCalls, 0);
  assert.match(payload.reply, /تعذّر تحليل صورة النبتة/);
  assert.match(warningText(payload), /Step 1 Gemini image analysis failed/);
  assert.match(warningText(payload), /Step 1 MobileNetV2 unavailable/);
});

test("zero-failure: HF 503 model-loading plus a Gemini outage answers 200 asking to retry the photo", async () => {
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
  assert.match(payload.reply, /تعذّر تحليل صورة النبتة/);
  assert.match(payload.reply, /أعد المحاولة/);
  const warning = warningText(payload);
  assert.match(warning, /Step 1 Gemini image analysis failed/);
  assert.match(warning, /Step 1 MobileNetV2 unavailable/);
  assert.match(warning, /loading/i);
  // Neither text model was consulted, so neither is reported as unavailable.
  assert.doesNotMatch(warning, /Step 2 HF text model unavailable/);
  assert.doesNotMatch(warning, /Step 3 Gemini text fallback unavailable/);
});

test("the MobileNetV2 fallback sorts the returned array and picks the top class", async () => {
  configureKeys();
  let llmRequestBody = "";
  let llmUrl = "";
  let llmModel: string | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    // Force the fallback: the primary image model refuses.
    if (isGeminiUrl(String(url))) return geminiBlocked();
    if (isChatUrl(String(url))) {
      llmUrl = String(url);
      llmModel = requestedChatModel(init);
      llmRequestBody = String(init.body ?? "");
      return chatReply(GROUNDED_REPLY);
    }
    if (isDetectUrl(String(url))) return Response.json([]);
    // Unsorted array — the route must sort and pick the 95% entry.
    return Response.json([
      { label: "Tomato___Late_blight", score: 0.03 },
      { label: "Tomato___Early_blight", score: 0.95 },
      { label: "Tomato___healthy", score: 0.02 },
    ]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.analysisSource, "mobilenet");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 95);
  assert.equal(payload.source, "hybrid");
  // The primary text model runs via the router's chat-completions endpoint…
  assert.equal(llmUrl, HF_ROUTER_CHAT_URL);
  assert.equal(llmModel, LLM_FALLBACK_ORDER[0]);
  // …and receives the mapped analysis, with NO machine label in the user turn
  // (the system prompt names one only as a negative example).
  const llmUserTurn = (JSON.parse(llmRequestBody) as ChatRequestBody).messages?.at(-1)?.content ?? "";
  assert.match(llmUserTurn, /اللفحة المبكرة/);
  assert.doesNotMatch(llmUserTurn, /Tomato___/);
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

test("Step 0 crops for the MobileNetV2 fallback, while Gemini keeps the original frame", async () => {
  configureKeys();
  const urls: string[] = [];
  let classifyBody = "";
  let classifyContentType: string | null = null;
  let geminiImage: GeminiImagePart | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (isChatUrl(String(url))) return chatReply(GROUNDED_REPLY);
    if (isGeminiUrl(String(url))) {
      const body = parseGeminiBody(init);
      // Force the fallback so the crop is actually exercised, and capture the
      // photo the PRIMARY image model was given.
      if (body.generationConfig?.responseMimeType === "application/json") {
        geminiImage = geminiImagePart(body);
        return geminiBlocked();
      }
      return geminiReply(GROUNDED_REPLY);
    }
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

  // Pipeline order: detect → Gemini (primary) → MobileNetV2 (fallback) → chat.
  assert.equal(urls.length, 4, `expected detect + Gemini + classify + HF, got ${urls.join(", ")}`);
  assert.ok(isDetectUrl(urls[0]));
  // The PRIMARY detector is the COCO facebook/detr-resnet-50 — the obsolete
  // fine-tuned PlantDoc checkpoint is gone from the default chain.
  assert.match(urls[0], /facebook\/detr-resnet-50/);
  assert.doesNotMatch(urls[0], /detr-finetuned-plantdoc/);
  assert.ok(isGeminiUrl(urls[1]), "Gemini is the PRIMARY image model");
  assert.ok(isClassifyUrl(urls[2]));
  assert.equal(urls[3], HF_ROUTER_CHAT_URL);

  // The PRIMARY image model reasons over the whole scene: it gets the
  // untouched original frame, never the crop.
  assert.equal(geminiImage?.data, LEAF_JPEG_B64);
  assert.equal(geminiImage?.mimeType, "image/jpeg");

  // The narrow FALLBACK classifier saw the re-encoded CROP instead.
  assert.notEqual(classifyBody, LEAF_JPEG_B64);
  assert.equal(classifyContentType, "image/jpeg");

  // Crop window: 40×32 box + 12% padding (5,4) → (5,4) 50×40 on the 64×48 frame.
  assert.equal(payload.preprocessing?.status, "cropped");
  assert.equal(payload.preprocessing?.detector, LEAF_DETECTOR);
  assert.deepEqual(payload.preprocessing?.box, [5, 4, 50, 40]);
  assert.equal(typeof payload.preprocessing?.durationMs, "number");

  assert.equal(payload.source, "hybrid");
  assert.equal(payload.analysisSource, "mobilenet");
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
    if (isChatUrl(String(url))) return chatReply(GROUNDED_REPLY);
    if (isGeminiUrl(String(url))) return geminiBlocked(); // force the fallback
    if (isDetectUrl(String(url))) return Response.json({ error: "Model is loading" }, { status: 503 });
    assert.ok(isClassifyUrl(String(url)));
    classifyBody = bodyB64(init);
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
  assert.equal(payload.preprocessing?.status, "unavailable");
  // The crop could not be produced, so the fallback classifier got the
  // original frame — the exact pre-Step-0 behaviour.
  assert.equal(classifyBody, LEAF_JPEG_B64);
  assert.match(warningText(payload), /Step 0 leaf detection unavailable/);
  assert.equal(payload.source, "hybrid");
});

test("Step 0 without an HF key is skipped silently and Step 1 reports its own skip", async () => {
  // Gemini-only deployment: Step 0 cannot run (no detector token) and stays
  // silent so it does not duplicate the Step 1 / Step 2 skip messages.
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  const geminiBodies: GeminiRequestBody[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.ok(isGeminiUrl(String(url)), `no HF endpoint is reachable: ${url}`);
    const body = parseGeminiBody(init);
    geminiBodies.push(body);
    return body.generationConfig?.responseMimeType === "application/json"
      ? geminiAnalysis()
      : geminiReply(GROUNDED_REPLY);
  });
  const response = await POST(imageRequest("aW1hZ2U="));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };
  assert.equal(payload.preprocessing?.status, "skipped");
  assert.equal(payload.analysisSource, "gemini");
  // The skip is a graceful degradation, not an error: no analysis-stage
  // warning for MobileNetV2, because the primary model handled the photo.
  assert.doesNotMatch(warningText(payload), /Step 0/);
  assert.doesNotMatch(warningText(payload), /MobileNetV2/);
  assert.match(warningText(payload), /Step 2 HF text model unavailable/);
  assert.equal(geminiImagePart(geminiBodies[0])?.data, "aW1hZ2U=");
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

test("orchestrated Step 1: detect → Gemini (primary) → MobileNetV2 (fallback) → HF text, no CodeCraft", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    // The CodeCraft gateway is gone from the chain: any request to it is a
    // regression.
    assert.doesNotMatch(String(url), CODECRAFT_URL_PATTERN);
    if (isChatUrl(String(url))) return chatReply(GROUNDED_REPLY);
    // The primary image model fails, so the fallback classifier runs.
    if (isGeminiUrl(String(url))) return geminiBlocked();
    if (isDetectUrl(String(url))) return leafDetection();
    assert.ok(isClassifyUrl(String(url)), `unexpected upstream: ${url}`);
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
  });

  const response = await POST(imageRequest(LEAF_JPEG_B64));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload & { preprocessing?: PreprocessingLike };

  // Exactly four round-trips: detect → Gemini → MobileNetV2 → HF text.
  assert.equal(urls.length, 4, `expected detect + Gemini + classify + HF, got ${urls.join(" | ")}`);
  assert.ok(isDetectUrl(urls[0]));
  assert.ok(isGeminiUrl(urls[1]), "Gemini is the PRIMARY image model");
  assert.ok(isClassifyUrl(urls[2]), "MobileNetV2 only runs after the primary failed");
  assert.ok(urls[2].includes(MOBILENET_MODEL), `expected the MobileNetV2 endpoint, got ${urls[2]}`);
  assert.equal(urls[3], HF_ROUTER_CHAT_URL);

  // The MobileNetV2 verdict flows through the shared AnalysisData schema.
  assert.equal(payload.analysisSource, "mobilenet");
  assert.equal(payload.diagnosis?.label, "Tomato___Early_blight");
  assert.equal(Math.round((payload.diagnosis?.confidence ?? 0) * 100), 95);
  assert.equal(payload.preprocessing?.status, "cropped");
  assert.equal(payload.source, "hybrid");
  // No CodeCraft degradation ever surfaces in the pipeline.
  assert.doesNotMatch(warningText(payload), /CodeCraft/i);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(`${GEMINI_KEY}|${HF_KEY}`));
});

test("orchestrated Step 1: legacy CODECRAFT_* env vars are ignored — no request ever reaches the removed engine", async () => {
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
    if (isChatUrl(String(url))) return chatReply(GROUNDED_REPLY);
    if (isGeminiUrl(String(url))) return geminiAnalysis();
    if (isDetectUrl(String(url))) return leafDetection();
    throw new Error(`unexpected upstream: ${url}`);
  });

  try {
    const response = await POST(imageRequest(LEAF_JPEG_B64));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as AssistantPayload;
    // Gemini, the primary image model, answered…
    assert.equal(payload.analysisSource, "gemini");
    assert.equal(payload.textSource, "huggingface");
    assert.equal(payload.source, "hybrid");
    // …and the HF primary text model answered the reply.
    assert.equal(payload.reply, GROUNDED_REPLY);
    // Exactly: detect → Gemini → HF text. No classifier, no CodeCraft.
    assert.equal(urls.length, 3, urls.join(" | "));
    assert.ok(urls.every((url) => !CODECRAFT_URL_PATTERN.test(url)));
    assert.equal(urls.filter(isClassifyUrl).length, 0);
    assert.doesNotMatch(warningText(payload), /CodeCraft/i);
  } finally {
    delete process.env.CODECRAFT_API_KEY;
    delete process.env.CODECRAFT_BASE_URL;
    delete process.env.CODECRAFT_VISION_MODEL;
  }
});

test("orchestrated Step 1: when MobileNetV2 also fails the request lands on STEP 4, not a re-analysis", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    assert.doesNotMatch(String(url), CODECRAFT_URL_PATTERN);
    if (isChatUrl(String(url))) {
      throw new Error("STEP 4 must not call any text model");
    }
    if (isGeminiUrl(String(url))) return geminiBlocked();
    // The MobileNetV2 fallback is loading too.
    return Response.json({ error: "Model is loading", estimated_time: 12 }, { status: 503 });
  });

  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as AssistantPayload;
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis, null);
  assert.equal(payload.analysisSource, null);
  assert.equal(payload.textSource, null);
  assert.match(payload.reply, /تعذّر تحليل صورة النبتة/);
  assert.doesNotMatch(warningText(payload), /CodeCraft/i);
  // One Gemini analysis attempt (refused) + one classifier attempt (loading);
  // no text model ran, and there is no third vision engine.
  assert.equal(urls.filter((url) => isClassifyUrl(url)).length, 1);
  assert.equal(urls.filter((url) => isChatUrl(url)).length, 0);
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
    assert.match(warningText(payload), /Step 2 HF text model unavailable/);
    // HF first, then Gemini — the dual-tiered fallback order is locked.
    assert.equal(urls[0], HF_ROUTER_CHAT_URL);
    assert.ok(isGeminiUrl(urls[urls.length - 1]));
    mock.restoreAll();
  }
});
