/**
 * `/api/assistant` — the fail-proof plant-diagnosis orchestrator. The route
 * NEVER returns HTTP 500.
 *
 * CURRENT PROVIDER SETUP — Gemini-only (Hugging Face soft-blocked)
 *   `ENABLE_HUGGINGFACE = false` (`@/lib/assistant/providers`) bypasses every
 *   Hugging Face stage BEFORE a token is read or a request is built. Gemini is
 *   therefore BOTH the image model and the primary text model. Nothing was
 *   deleted: flipping the flag (or setting `ENABLE_HUGGINGFACE=1`) restores the
 *   Hugging Face image fallback and the Hugging Face primary text model
 *   exactly as described under "WHEN HUGGING FACE IS ENABLED" below.
 *
 *   An attached photo triggers the full orchestration; a text-only question
 *   skips the image stage and goes straight to the text stage.
 *
 *   STEP 1 — IMAGE ANALYSIS (photo requests)
 *     PRIMARY  · Google Gemini (`gemini-3.8-flash`, overridable with
 *               `GEMINI_MODEL` → `gemini-3.5-flash` → `gemini-3.5-flash-lite`
 *               → `gemini-2.5-flash` → `gemini-flash-latest` on a retired id).
 *               A multimodal model that inspects the photo and is constrained
 *               by `responseMimeType: "application/json"` + `responseSchema` to
 *               answer with an `AnalysisData` object
 *               (`@/lib/assistant/analysis`). It receives the ORIGINAL frame.
 *     FALLBACK · MobileNetV2 PlantVillage — ONLY while
 *               `ENABLE_HUGGINGFACE=true`; with the flag off a failed Gemini
 *               analysis goes straight to STEP 4.
 *     BOTH DOWN · STEP 4 — no text model is ever called with empty data: the
 *               user gets a pre-written, polite "retry with a clearer photo"
 *               message.
 *
 *     Gemini is considered to have FAILED on: (a) an API/network error or
 *     timeout; (b) Gemini refusing or returning no usable text; (c) a response
 *     that is not valid JSON or is missing a required field. A LOW `confidence`
 *     is deliberately NOT a failure: the orchestrator has no confidence
 *     threshold, and an unsure but well-formed verdict is passed straight
 *     through to the text stage.
 *
 *   STEP 2 — TEXT GENERATION (Hugging Face — BYPASSED while the flag is off)
 *     See "WHEN HUGGING FACE IS ENABLED".
 *
 *   STEP 3 — TEXT GENERATION (Google Gemini — the PRIMARY text model)
 *     With Hugging Face soft-blocked this runs for EVERY request that has (or
 *     needs) text. The mandated Gemini chain (`gemini-3.8-flash` →
 *     `gemini-3.5-flash` → `gemini-3.5-flash-lite` → `gemini-2.5-flash` →
 *     `gemini-flash-latest`) is walked MODEL-first, KEY-second: for the current
 *     model every configured key is tried in this request's rotation order —
 *     a RANDOM draw without replacement over the pool
 *     (`GEMINI_API_KEY` + `GEMINI_API_KEY_N` + the legacy `GEMINI_API_KEYS`),
 *     so no key is repeated inside one cycle and no single project's quota is
 *     always spent first. A 429 / RESOURCE_EXHAUSTED parks that (key, model)
 *     pair for 10 minutes; a 400 `API_KEY_INVALID` or 403 parks the key itself
 *     for 60 minutes; a 503 or network error retries the same key once, then
 *     moves on. When every key is exhausted for a model, the next model is
 *     tried. NO image is attached here: Gemini formats ANALYSIS_DATA, it never
 *     re-analyses the photo.
 *
 *   MANUAL MODEL SELECTOR — the request body may carry a `model` field with the
 *   user's pick from the chat's picker (`phyto 3.8` → `gemini-3.8-flash`,
 *   `phyto 3.5` → `gemini-3.5-flash`, `phyto 2.5` → `gemini-2.5-flash`; see
 *   `@/lib/assistant/model-choice`). A recognised choice is pinned as the HEAD
 *   of the Gemini chain for BOTH the image analysis and the text stage, and
 *   `GEMINI_API_KEY_4` is moved to the front of the key draw so the explicit
 *   choice spends the freshest quota first. The 8 s per-attempt window and the
 *   single 60 s deadline are unchanged. An unknown/absent value is ignored, and
 *   a selected model that cannot answer (retired id, key without access) falls
 *   through the normal chain and REPORTS the substitution in `warnings[]` —
 *   never a silent different answer.
 *
 *   BUILT-IN FORMATTER (Gemini unavailable)
 *     Never fails: a concise Arabic diagnosis card built from the analysis, or
 *     a greeting-aware basic-mode reply for a text-only question.
 *
 *   LEAF CROPPING — REMOVED
 *     The former Step 0 "Detection & Cropping" pre-step (DETR-ResNet-50 +
 *     sharp) is gone from the pipeline: no detector round-trip, no crop, no
 *     re-encode. Every stage sees the original frame, and `preprocessing`
 *     still rides along on image responses reporting `status: "skipped"`.
 *
 *   WHEN HUGGING FACE IS ENABLED (`ENABLE_HUGGINGFACE=true`)
 *     · STEP 1 FALLBACK — MobileNetV2 PlantVillage
 *       (`linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`,
 *       overridable with `HF_VISION_MODEL`) on the free Hugging Face router.
 *       Reached ONLY after the Gemini analysis failed; its raw
 *       `{ label, score }` is mapped into the SAME `AnalysisData` shape.
 *     · STEP 2 PRIMARY TEXT — the open Qwen chain through the official
 *       Inference Providers router
 *       (`https://router.huggingface.co/v1/chat/completions`, Bearer
 *       `process.env.HUGGINGFACE_API_KEY` — ONE variable name, trimmed, no
 *       alias and no hardcoded fallback), led by
 *       `Qwen/Qwen3-4B-Instruct-2507`. Its ONLY job is to narrate
 *       ANALYSIS_DATA into a clear, user-facing explanation.
 *       HTTP 401/402/429/5xx are PROVIDER failures: the status and a SHORT
 *       (redacted) message are logged, then the next model/provider in the
 *       chain is tried — and Gemini gets its turn once the chain gives out. A
 *       402 (credits exhausted) additionally parks the WHOLE Hugging Face chain
 *       in memory for 10 minutes, because no model id can fix an empty account.
 *
 *   Contract between the stages: `AnalysisData` is the single payload the text
 *   stage ever sees, so it cannot tell — and is never told — which image model
 *   produced it. `analysisSource` ("gemini" | "mobilenet") and `textSource`
 *   ("huggingface" | "gemini_fallback") ride along on every response purely for
 *   logging and analytics; the user only ever sees the final `reply`.
 *   `textSource: "gemini_fallback"` is kept for wire compatibility: with
 *   Hugging Face soft-blocked it is the PRIMARY text path.
 *
 * Credentials — the Gemini pool is every environment variable matching
 * `/^GEMINI_API_KEY(_\d+)?$/` (plus the legacy `GEMINI_API_KEYS` comma pool):
 * trimmed, comma-pools flattened, deduplicated, then SHUFFLED per request
 * (`shuffleGeminiKeyPool()` in `@/lib/assistant/providers`). The Hugging Face
 * secret is read from ONE variable, `HUGGINGFACE_API_KEY`, trimmed, with no
 * alias and no hardcoded fallback — and it is only read while
 * `ENABLE_HUGGINGFACE` is on. Both are read from `process.env` on the server
 * only, never shipped to the browser, and every message that can reach a log
 * line or a response body goes through `redactSecrets()` first.
 *
 * Timeouts — EVERY upstream attempt is bounded by an 8 s per-attempt window and
 * the WHOLE request by one 60 s `AbortController` deadline
 * (`@/lib/assistant/providers`). When the global deadline fires the route stops
 * calling upstreams and answers HTTP 503 (`code: "DEADLINE_EXCEEDED"`) with the
 * Arabic "service is busy" message instead of leaving the user with a hanging
 * request. Deployments should keep a little head-room above 60 s in the
 * platform limit (`maxDuration = 65` where the plan allows it) so the 503 is
 * always the response the user sees.
 *
 * Status contract: 200 for every AI outcome (including all upstream
 * failures); 400/413 only for invalid client input; 503 + code MISSING_KEYS
 * when NO usable provider key is configured at all (with Hugging Face blocked,
 * that means no Gemini key); 503 + code DEADLINE_EXCEEDED when the 60 s budget
 * runs out. No HTTP 500 ever.
 *
 * Health — `GET /api/health/gemini` and `GET /api/health/hf` (both protected
 * by `?key=<HEALTH_SECRET>`) probe the same credential pool and model chain
 * this route uses, so "is the deployment configured correctly?" is answerable
 * without reading logs.
 *
 * Error reporting: each stage logs to the server console —
 * `[Step 1: Gemini Analysis Success]` / `[Step 1: MobileNetV2 Fallback
 * Success]` mark a successful image analysis, `[Step 1: Gemini Analysis
 * Failed → MobileNetV2]` / `[Step 1: MobileNetV2 Unavailable]` mark the
 * degradation, `[Step 2: HF LLM Success]` / `[Step 3: Gemini Formatter
 * Success]` mark which text model answered, and `[Step 4: Final Fallback]`
 * plus the final `[Orchestrator] analysisSource=… textSource=…` line make the
 * whole route's behaviour greppable in one place. Non-fatal degradations are
 * surfaced to the client in `warnings[]`.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  GEMINI_MODEL_DEFAULT,
  GeminiModelHealthMonitor,
  formatGeminiHealthReport,
  resolveGeminiModels as resolveGeminiChain,
  type GeminiModel,
} from "@/lib/assistant/gemini-models";
import {
  ANALYSIS_RESPONSE_SCHEMA,
  SEVERITY_AR,
  analysisToDiagnosis,
  buildAnalysisInstruction,
  classificationToAnalysis,
  parseAnalysisJson,
  type AnalysisData,
  type AnalysisResult,
  type TextSource,
} from "@/lib/assistant/analysis";
import {
  DeadlineExceededError,
  ENABLE_HUGGINGFACE,
  GEMINI_LEGACY_POOL_NAME,
  GEMINI_PRIORITY_KEY_NAME,
  HF_CREDITS_SKIP_MS,
  MIN_STAGE_BUDGET_MS,
  PER_ATTEMPT_TIMEOUT_MS,
  RequestDeadline,
  fetchWithAttemptTimeout,
  geminiKeyState,
  hfCreditCircuit,
  isAbortOrTimeoutError,
  isHuggingFaceEnabled,
  isPriorityGeminiKeyMissing,
  prioritizeGeminiKeyPool,
  resolveGeminiKeyPool,
  shuffleGeminiKeyPool,
  resolveHuggingFaceToken,
  shortMessage,
  type GeminiKeyEntry,
} from "@/lib/assistant/providers";
import {
  PHYTO_MODEL_CHOICES,
  phytoModelLabel,
  resolveRequestedModel,
  type PhytoModelChoice,
} from "@/lib/assistant/model-choice";
import { confidenceBucket, diseaseFamilyForArabic, parsePlantLabel } from "@/lib/assistant/plantvillage";
import type {
  AssistantContext,
  AssistantDiagnosis,
  AssistantImagePayload,
  AssistantHistoryTurn,
  AssistantPreprocessing,
  AssistantRequestBody,
  AssistantResponseBody,
  DiagnosisCandidate,
} from "@/lib/assistant/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Vision + LLM round-trips; give slow cold starts room on hosted platforms. */
/**
 * Platform ceiling for this function. The route's OWN ceiling is the 60 s
 * {@link GLOBAL_DEADLINE_MS} `AbortController`, which answers HTTP 503 instead
 * of letting the invocation be killed — keep this value at or above that
 * deadline (65 s where the hosting plan allows it) so the 503 always wins the
 * race and the user never sees a bare platform timeout.
 */
export const maxDuration = 60;

/* ------------------------------------------------------------------ */
/*  Tunables                                                           */
/* ------------------------------------------------------------------ */

/**
 * Step 1 — the PlantVillage classifier on the HF Inference API.
 *
 * Clean, single-model pipeline (400-error elimination): the PRIMARY
 * classifier is the known-good MobileNetV2 PlantVillage model
 * `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`, served on
 * Hugging Face's free serverless tier. The obsolete field-trained cascade
 * ids (`dima806/plant_disease_image_detection`, `fxmeng/plantdoc-vit`), the
 * 400-prone tertiary (`wambugu71/crop_leaf_diseases_vit`) and the legacy
 * `Abuzaid01/…` / `nateraw/…` experiments are REMOVED — one id that
 * actually answers, one round-trip.
 *
 * Environment override: `HF_VISION_MODEL` (single Hub id) replaces the
 * default when set (e.g. to pin a self-hosted or retrained checkpoint).
 */
export const HF_VISION_MODELS = [
  "linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification",
] as const;

const HF_ENDPOINT = (model: string) =>
  `https://router.huggingface.co/hf-inference/models/${model}`;

/* ---- Google Gemini — shared by Step 1 (analysis) and Step 3 (text)  */

/**
 * The ordered Gemini chain — used for BOTH the Step 1 image analysis and the
 * text stage — is resolved per request from the shared
 * `@/lib/assistant/gemini-models` module, so the route, the
 * `tools/check-gemini-models.mjs` CLI and the health check below can never
 * drift apart. That drift is the failure mode that let `gemini-3.6` (a model
 * id Google never shipped) sit in production until every request 404'd and
 * every photo silently degraded to MobileNetV2.
 *
 * `pin` is the model the USER chose in the chat's model selector (already
 * mapped from the friendly name by `resolveRequestedModel`): it becomes the
 * HEAD of the chain, so the request goes straight to that model. The built-in
 * fallbacks stay behind it — a selected model that is retired, refused for this
 * key, or absent from the key's catalog must still answer the user instead of
 * failing, and the substitution is reported in `warnings[]`. Without a
 * selection the `GEMINI_MODEL` pin (or the `gemini-3.8-flash` default) leads.
 * Ids the health check proved unavailable are dropped, so a retired id costs no
 * round-trip.
 */
function resolveGeminiModels(pin?: string): GeminiModel[] {
  const chain = resolveGeminiChain(process.env.GEMINI_MODEL, geminiModelHealth.unavailableModels);
  if (!pin || chain[0]?.id === pin) return chain;
  // MOVE the pick to the head instead of substituting it for the head: the
  // built-in fallbacks (the default `gemini-3.8-flash` included — it is not in
  // `GEMINI_FALLBACK_MODELS`) stay behind it, so choosing the cheapest model
  // never costs the request its safety net.
  const head: GeminiModel = chain.find((model) => model.id === pin) ?? {
    id: pin,
    thinking: GEMINI_MODEL_DEFAULT.thinking,
  };
  return [head, ...chain.filter((model) => model.id !== pin)];
}


/**
 * Output cap for a Gemini call. Slightly above {@link MAX_REPLY_TOKENS} because
 * Gemini counts any internal reasoning tokens against `maxOutputTokens`;
 * the per-generation thinking payload (`thinkingLevel: "low"` on 3.x,
 * `thinkingBudget: 0` on 2.5, none on 1.5/2.0) keeps the model in fast,
 * answer-first mode so the request budget is spent on the reply.
 */
const GEMINI_MAX_OUTPUT_TOKENS = 1024;

/**
 * Resolve THIS REQUEST's Gemini rotation order at request time (never at
 * module load, so a key added in Vercel is picked up without a redeploy).
 *
 * The configured inventory is owned by `resolveGeminiKeyPool()`
 * (`GEMINI_API_KEY_4`, then `GEMINI_API_KEY` and the numbered variants in
 * numeric order, then the legacy pool) and is then SHUFFLED by
 * `shuffleGeminiKeyPool()`: a random permutation without replacement, so
 *
 *   • every configured key is in the draw,
 *   • no key is tried twice inside one request cycle, and
 *   • consecutive requests do not always start on the same credential — the
 *     daily quota of one Google project is no longer burned first.
 *
 * Only variable NAMES travel onward: the pool returned here is the only thing
 * the transport needs, and every log/warning/health response identifies a
 * credential by its `name`, never by its value.
 */
function resolveGeminiApiKeys(prioritizePriorityKey = false): GeminiKeyEntry[] {
  const drawn = shuffleGeminiKeyPool(resolveGeminiKeyPool());
  // A manually selected model is the case the priority key exists for: it gets
  // the most predictable quota head-room, so the chosen model is the one that
  // actually answers. Everything else keeps the random rotation.
  return prioritizePriorityKey ? prioritizeGeminiKeyPool(drawn) : drawn;
}

/**
 * Announce, once per process, the configuration facts an operator must be able
 * to grep for: the configured pool (NAMES only, in the stable inventory order —
 * the live request order is a random draw), the preferred key's NAME when it is
 * absent, the legacy pool's NAME when it still feeds the rotation, and whether
 * the Hugging Face stages are enabled. Never a value.
 */
let geminiKeyConfigLogged = false;
function logGeminiKeyConfiguration(pool: readonly GeminiKeyEntry[], hfEnabled: boolean): void {
  if (geminiKeyConfigLogged) return;
  geminiKeyConfigLogged = true;

  console.log(
    `[Model Selector] offering ${PHYTO_MODEL_CHOICES.map((choice) => `${choice.label} → ${choice.model}`).join(" | ")} ` +
      "(a request's `model` field pins the chain head; unknown values are ignored).",
  );

  console.log(
    `[Hugging Face] ENABLE_HUGGINGFACE=${hfEnabled} — ` +
      (hfEnabled
        ? "Step 1 fallback vision + Step 2 text model are enabled."
        : "all Hugging Face stages are bypassed; Gemini is the only provider (image + text)."),
  );

  if (isPriorityGeminiKeyMissing()) {
    console.warn(
      `[Gemini Keys] ${GEMINI_PRIORITY_KEY_NAME} is missing — continuing with the remaining keys ` +
        `(configured pool: ${pool.map((entry) => entry.name).join(" → ") || "none"}).`,
    );
  } else {
    console.log(
      `[Gemini Keys] configured pool: ${pool.map((entry) => entry.name).join(" → ")} ` +
        "(drawn in a RANDOM order per request; no key repeats inside one cycle).",
    );
  }
  if (pool.some((entry) => entry.name.startsWith(GEMINI_LEGACY_POOL_NAME))) {
    console.warn(
      `[Gemini Keys] ${GEMINI_LEGACY_POOL_NAME} is a LEGACY comma-separated pool — its keys are appended after the numbered variables. ` +
        "Prefer GEMINI_API_KEY_4 / GEMINI_API_KEY_N.",
    );
  }
}

/* ---- Hugging Face — Step 1 (fallback vision) + Step 2 (text) ------ */

/**
 * Lightweight open-source LLM ids tried by Step 2 (the PRIMARY text model), in
 * order, through the Hugging Face Inference Providers router
 * ({@link HF_ROUTER_CHAT_URL}).
 *
 * Every id below is an open, NON-gated repository (no license click-through,
 * so no 403 on a fresh token) with at least one `status: "live"`
 * conversational provider in its Hub `inferenceProviderMapping` at the time
 * of writing — the router resolves the provider and fails over between
 * providers on its own:
 *   • `Qwen/Qwen3-4B-Instruct-2507` — 4B answer-first (non-thinking) model,
 *     strong Arabic, two live providers (nscale + featherless-ai);
 *   • `Qwen/Qwen2.5-7B-Instruct`     — 7B multilingual quality fallback;
 *   • `Qwen/Qwen2.5-1.5B-Instruct`   — 1.5B last resort: cheapest and
 *     fastest, still fluent enough for a short practical Arabic reply.
 *
 * The previous chain (`meta-llama/Llama-3.2-3B-Instruct`,
 * `Qwen/Qwen2.5-7B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.3`) was
 * addressed per provider at `/hf-inference/models/<id>/v1/chat/completions`.
 * That provider stopped serving chat LLMs in July 2025 (it is CPU-only:
 * classification, embeddings, BERT/GPT-2-class models), so every id 400ed
 * with "Model not supported by provider hf-inference" regardless of the
 * token; `Llama-3.2-3B` is also a gated repo (403 without accepting Meta's
 * terms) and `Mistral-7B-v0.3`'s only provider mapping is in `error` state.
 * Not-found / not-supported / gated responses still walk the chain as
 * model-availability errors, and the built-in direct formatter
 * ({@link buildDirectDiagnosisCard}) guarantees a useful reply even when the
 * whole chain is down.
 */
const HF_LLM_MODELS = [
  "Qwen/Qwen3-4B-Instruct-2507",
  "Qwen/Qwen2.5-7B-Instruct",
  "Qwen/Qwen2.5-1.5B-Instruct",
] as const;

/**
 * Official OpenAI-compatible chat-completions endpoint of the Hugging Face
 * Inference Providers router. One URL for every model: the id travels in the
 * JSON body's `model` field and the router picks a live provider for it
 * (`provider: "auto"` semantics, automatic failover). Authenticated with a
 * `Bearer` Hugging Face user access token that carries the "Inference
 * Providers" permission; the account's monthly free credits apply.
 */
const HF_ROUTER_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";

/** Hard cap on the reply — the system prompt demands brevity. */
const MAX_REPLY_TOKENS = 700;

/** ~6 MB of raw base64 ≈ 4.5 MB image — plenty for a leaf photo. */
const MAX_IMAGE_B64_CHARS = 6 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 4000;

/**
 * Resolve the ordered vision model list for this request. The default is the
 * single known-good MobileNetV2 PlantVillage id; `HF_VISION_MODEL` (one Hub
 * id, whitespace-trimmed) replaces it when set.
 */
function resolveVisionModels(): string[] {
  const raw = process.env.HF_VISION_MODEL?.trim();
  if (raw) return [raw];
  return [...HF_VISION_MODELS];
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Every upstream round-trip in this file goes through
 * {@link fetchWithAttemptTimeout}: an 8 s per-attempt window AND the request's
 * shared 60 s deadline. Both are explicit `AbortController` timers (not
 * `AbortSignal.timeout`), so the abort reason is inspectable, the platform
 * cannot leave a zombie round-trip behind, and the two windows compose.
 */
function timedFetch(
  url: string,
  init: RequestInit,
  deadline: RequestDeadline,
): Promise<Response> {
  return fetchWithAttemptTimeout(url, init, deadline, PER_ATTEMPT_TIMEOUT_MS);
}

function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * The 60 s budget ran out mid-request: stop and answer 503 with the Arabic
 * "service is busy" message. Called from every stage boundary so a deadline
 * abort can never be reported as an upstream failure, and so no stage starts
 * with less budget than {@link MIN_STAGE_BUDGET_MS} left.
 */
function serviceBusyResponse(): NextResponse {
  const message = "الخدمة مشغولة حالياً، حاول بعد قليل";
  console.warn(
    "[Assistant] global 60 s deadline exceeded — answering 503 DEADLINE_EXCEEDED (no upstream left running)",
  );
  return NextResponse.json(
    { error: message, code: "DEADLINE_EXCEEDED", reply: message },
    { status: 503 },
  );
}

/**
 * True when the failure is the GLOBAL deadline (as opposed to an 8 s
 * per-attempt timeout). Only the former means "stop and answer 503": a single
 * slow attempt must still fall through to the next provider.
 */
function isDeadlineFailure(error: unknown): boolean {
  return error instanceof DeadlineExceededError;
}

/**
 * Every `warnings[]` entry is echoed to the client, so each one is redacted and
 * length-capped before it leaves the server. Secrets never ride along on a
 * diagnostic message, and a 4 KB error envelope never bloats a response.
 */
function pushWarning(warnings: string[], message: string, max = 400): void {
  warnings.push(shortMessage(message, max));
}

/**
 * The Hugging Face user access token that would authenticate the (dormant)
 * Step 1 fallback vision model and the Step 2 text model is resolved by
 * `resolveHuggingFaceToken()` from `@/lib/assistant/providers`: EXACTLY
 * `process.env.HUGGINGFACE_API_KEY`, whitespace/newlines trimmed, with no alias
 * and no hardcoded fallback. It is only consulted while `ENABLE_HUGGINGFACE` is
 * on — and even then a missing/blank value lets the handler skip the vision
 * step and the primary
 * LLM synchronously — no request, no exception, no waiting.
 */

/* ------------------------------------------------------------------ */
/*  Step 1 — Hugging Face PlantVillage vision diagnosis (STRICT)       */
/* ------------------------------------------------------------------ */

interface HfClassification {
  label: string;
  score: number;
}

interface HfLoadingPayload {
  error?: string;
  estimated_time?: number;
}

function isHfClassificationArray(value: unknown): value is HfClassification[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as HfClassification).label === "string" &&
        typeof (item as HfClassification).score === "number",
    )
  );
}

/**
 * The raw MobileNetV2 verdict, before it is mapped into the orchestrator's
 * {@link AnalysisData} shape. Kept as a separate step so the label → data
 * mapping lives in exactly one place (`analysisFromMobileNet`).
 */
interface MobileNetClassification {
  /** Top-1 raw PlantVillage label, e.g. `Tomato___Late_blight`. */
  rawLabel: string;
  /** Top-1 score in [0, 1]. */
  score: number;
  /** Model id that answered. */
  model: string;
  /** Top candidates (max 3), highest first. */
  candidates: DiagnosisCandidate[];
}

/**
 * Step 1 FALLBACK image model — MobileNetV2 PlantVillage classification via
 * Hugging Face, reached ONLY when the Gemini image analysis failed. The
 * classifier is
 * `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification` — a clean
 * single-model pipeline, the obsolete field-trained ids and the 400-prone
 * cascade fallbacks are gone. `HF_VISION_MODEL` may pin a replacement id.
 * - Sends the raw image bytes of the ORIGINAL frame to the model.
 * - Parses the returned array to extract the primary predicted class + confidence.
 * - Handles 503/530 model-loading responses with a clear message.
 * - Per-model timeout: {@link PER_ATTEMPT_TIMEOUT_MS} (8 s) inside the
 *   `X-Wait-For-Model: true` handshake, bounded again by the request's 60 s
 *   deadline; a cold start that cannot answer in that window fails the stage
 *   and routes the request to STEP 4.
 * - Throws an Error prefixed with "HF Error:" on any failure so the caller can
 *   degrade to the STEP 4 final fallback.
 */
async function classifyPlantImageStrict(
  imageBase64: string,
  mimeType: string,
  apiKey: string,
  deadline: RequestDeadline,
): Promise<MobileNetClassification> {
  const body = Buffer.from(imageBase64, "base64");

  let lastErrorDetail: string | null = null;
  let loadingEstimate: number | null = null;

  const models = resolveVisionModels();

  for (const model of models) {
    const timeoutMs = PER_ATTEMPT_TIMEOUT_MS;
    try {
      const res = await timedFetch(
        HF_ENDPOINT(model),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": mimeType || "application/octet-stream",
            // Ask the HF router to wait for the model instead of instantly 503ing.
            "X-Wait-For-Model": "true",
          },
          body,
        },
        deadline,
      );

      // --- Model loading (503 / 530) -------------------------------------------------
      if (res.status === 503 || res.status === 530) {
        let estimated: number | null = null;
        let errText: string | null = null;
        try {
          const payload = (await res.json()) as HfLoadingPayload;
          if (typeof payload?.estimated_time === "number") estimated = payload.estimated_time;
          if (typeof payload?.error === "string") errText = payload.error;
        } catch {
          // ignore json parse failure, fall back to status text
        }
        if (estimated !== null) loadingEstimate = estimated;
        const detail = errText
          ? `${errText}${estimated !== null ? ` — estimated_time: ${estimated}s` : ""}`
          : `Model ${model} is loading (HTTP ${res.status})${estimated !== null ? ` — retry after ~${Math.ceil(estimated)}s` : ""}`;
        lastErrorDetail = detail;
        console.warn(`[Step 1: HF Loading] ${model} → ${detail}`);
        // Try next model (env override chain) before giving up — it may be warm.
        continue;
      }

      if (!res.ok) {
        let bodyText = "";
        try {
          bodyText = await res.text();
        } catch {
          bodyText = res.statusText;
        }
        // Try to surface JSON error message if present
        let detail = `HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 400)}` : ""}`;
        try {
          const j = JSON.parse(bodyText) as { error?: string };
          if (j?.error) detail = `HTTP ${res.status} — ${j.error}`;
        } catch {
          // keep raw detail
        }
        lastErrorDetail = `${model}: ${detail}`;
        console.warn(`[Step 1: HF Warning] ${model} → ${detail}`);
        continue;
      }

      const json: unknown = await res.json();

      // HF should return an array of { label, score }. Validate and parse.
      if (!isHfClassificationArray(json)) {
        const detail = `unexpected payload shape from ${model}: ${JSON.stringify(json).slice(0, 500)}`;
        lastErrorDetail = detail;
        console.warn(`[Step 1: HF Warning] ${detail}`);
        continue;
      }

      // Properly parse returned array: sort descending and extract primary class + confidence.
      const ranked = [...json].sort((a, b) => b.score - a.score);
      const top = ranked[0];
      const pct = Math.round(top.score * 100);
      const candidates: DiagnosisCandidate[] = ranked
        .slice(0, 3)
        .map(({ label, score }) => ({ label, score }));

      console.log(
        `[Step 1: HF Success] label=${top.label} confidence=${pct}% model=${model} timeout=${timeoutMs}ms candidates=${candidates.length}`,
      );
      return { rawLabel: top.label, score: top.score, model, candidates };
    } catch (error) {
      if (isDeadlineFailure(error)) throw error;
      const detail =
        error instanceof Error
          ? shortMessage(`${error.name}: ${error.message}`)
          : shortMessage(String(error));
      if (isAbortOrTimeoutError(error)) {
        console.warn(`[Step 1: HF Timeout] ${model} timed out after ${timeoutMs}ms`);
      } else {
        console.warn(`[Step 1: HF Warning] ${model} → ${detail}`);
      }
      lastErrorDetail = `${model}: ${detail}`;
    }
  }

  // All models exhausted — surface a clear HF Error.
  if (loadingEstimate !== null || (lastErrorDetail && /loading/i.test(lastErrorDetail))) {
    const msg = lastErrorDetail ?? `Model is loading, please retry after ~${Math.ceil(loadingEstimate ?? 20)}s`;
    throw new Error(
      `HF Error: Model is loading — ${msg}. The PlantVillage model is warming up on Hugging Face; please retry after ${loadingEstimate ? Math.ceil(loadingEstimate) : 20}s.`,
    );
  }
  throw new Error(
    `HF Error: ${lastErrorDetail ?? "Unable to classify image with PlantVillage model (all HF endpoints failed)"}`,
  );
}

/* ------------------------------------------------------------------ */
/*  Step 1 — IMAGE ANALYSIS: Gemini (PRIMARY) → MobileNetV2 (FALLBACK)   */
/* ------------------------------------------------------------------ */

/**
 * STEP 1 of the orchestrator, PRIMARY image model: Google Gemini.
 *
 * Gemini is a multimodal model, so it inspects the photo directly and is
 * asked for a strict JSON object ({@link ANALYSIS_RESPONSE_SCHEMA}) that
 * `responseMimeType: "application/json"` + `responseSchema` pin down — no
 * prose to parse, no label vocabulary to map.
 *
 * It receives the ORIGINAL frame: Gemini reasons over the whole scene (leaf,
 * stem, soil, neighbouring plants) the way a human agronomist would, and a
 * tight crop would make its own `affected_parts` / `notes` fields much weaker.
 * (The former leaf-cropping pre-step that produced such a crop is removed, so
 * every model — MobileNetV2 included — now sees the untouched frame.) This is
 * also why
 * kept for the MobileNetV2 fallback instead.
 *
 * The stage FAILS — and only then hands over to MobileNetV2 — on:
 *   a) an API/network error or timeout (surfaced as `GeminiError` by
 *      {@link runGeminiWithKeyPool});
 *   b) Gemini refusing or returning no usable text (safety block, empty
 *      candidate list);
 *   c) a response that is not valid JSON, is not an object, or is missing any
 *      required field (surfaced as `AnalysisParseError` by
 *      {@link parseAnalysisJson}).
 *
 * A LOW `confidence` is explicitly NOT a failure. The orchestrator has no
 * confidence threshold: an unsure-but-well-formed verdict is legitimate data
 * and is passed through to the text stage unchanged, which simply hedges its
 * wording.
 */
/**
 * True when a failure is specifically Gemini rejecting the structured-output
 * parameters we sent (`responseSchema` / `response_format`) rather than the
 * model id or the key. Gemini has been migrating that surface (the newer
 * Interactions API uses `response_format`), so a freshly-rotated model id can
 * legitimately refuse a `generationConfig` field the previous one accepted.
 */
function isStructuredOutputRejection(error: unknown): boolean {
  if (!(error instanceof GeminiError) || error.status !== 400) return false;
  return /response[_]?schema|response[_]?format|generationConfig/i.test(
    error.message,
  );
}

async function analyzeImageWithGemini(
  image: AssistantImagePayload,
  geminiApiKeys: readonly GeminiKeyEntry[],
  lang: "ar" | "fr",
  deadline: RequestDeadline,
  /** The user's model-selector choice, pinned as the chain head. */
  pin?: string,
  /** Client-visible notes (e.g. the selected model could not be honoured). */
  warnings: string[] = [],
): Promise<AnalysisResult> {
  const userContent =
    lang === "fr"
      ? "Analyse la photo de la plante jointe et renvoie uniquement l'objet JSON demandé."
      : "حلّل صورة النبتة المرفقة وأعد كائن JSON المطلوب.";

  const runAnalysis = async (
    extraConfig: Record<string, unknown>,
  ): Promise<GeminiResult> =>
    runGeminiWithKeyPool(
      {
        systemInstruction: buildAnalysisInstruction(lang),
        userContent,
        image,
        extraConfig,
      },
      geminiApiKeys,
      deadline,
      pin,
    );

  let result: GeminiResult;
  try {
    result = await runAnalysis({
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
    });
  } catch (error) {
    if (!isStructuredOutputRejection(error)) throw error;
    // The model would not take the schema constraint. Retry once with only
    // the JSON MIME hint: `parseAnalysisJson` still validates the result, and
    // a schema-less reply that does not conform fails the stage exactly like
    // any other malformed payload.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Step 1: Gemini Analysis] responseSchema rejected by the model — retrying with responseMimeType only: ${detail}`,
    );
    result = await runAnalysis({ responseMimeType: "application/json" });
  }

  // (c) — the payload must be a complete AnalysisData object.
  const data = parseAnalysisJson(result.text);

  // The chain walked past the user's pick (retired id, or the key's catalog
  // does not offer it): say so, exactly like the text stage does.
  if (pin && result.model !== pin) {
    const substitution =
      `Selected model ${phytoModelLabel(pin)} (${pin}) was unavailable — analysed with ` +
      `${phytoModelLabel(result.model)} (${result.model}).`;
    pushWarning(warnings, substitution);
    console.warn(`[Step 1: Selected Model Fallback] ${substitution}`);
  }

  console.log(
    `[Step 1: Gemini Analysis Success] model=${result.model} ` +
      `plant=${data.plant_type ?? "unknown"} detected=${data.disease_detected} ` +
      `disease=${data.disease_name ?? "none"} confidence=${Math.round(data.confidence * 100)}%`,
  );
  return {
    data,
    source: "gemini",
    diagnosis: analysisToDiagnosis(data, "gemini", { model: result.model, lang }),
  };
}

/**
 * STEP 1 of the orchestrator, FALLBACK image model: MobileNetV2.
 *
 * Reached ONLY when {@link analyzeImageWithGemini} failed. Its raw
 * `{ label, score }` output is mapped into the identical
 * {@link AnalysisData} shape so the text stage cannot tell the two image
 * models apart, and the runner-up classifications are preserved for the
 * diagnosis card only.
 */
function analysisFromMobileNet(
  rawLabel: string,
  score: number,
  model: string,
  candidates: DiagnosisCandidate[],
  lang: "ar" | "fr",
): AnalysisResult {
  const data = classificationToAnalysis(rawLabel, score);
  return {
    data,
    source: "mobilenet",
    diagnosis: analysisToDiagnosis(data, "mobilenet", {
      model,
      lang,
      rawLabel,
      candidates,
    }),
  };
}

/**
 * STEP 1 — the whole image stage.
 *
 * Runs the strict priority order of the spec: Gemini first, MobileNetV2
 * second and ONLY if Gemini failed, and `null` when neither could analyse the
 * photo (which routes the request to STEP 4 — no text model is ever called
 * with empty data).
 *
 * Never throws: every failure is converted into a warning plus a `null`
 * result, so a vision outage can never fail the HTTP request.
 *
 * `geminiImage` is the untouched original frame, and the MobileNetV2 fallback
 * receives those same bytes now that cropping is removed.
 */
async function runImageAnalysisStage(options: {
  geminiImage: AssistantImagePayload;
  geminiApiKeys: readonly GeminiKeyEntry[];
  huggingfaceKey: string | null;
  /** `ENABLE_HUGGINGFACE` — false skips the MobileNetV2 fallback entirely. */
  hfEnabled: boolean;
  lang: "ar" | "fr";
  warnings: string[];
  deadline: RequestDeadline;
  /** The user's model-selector choice, pinned as the chain head. */
  pin?: string;
}): Promise<AnalysisResult | null> {
  const { geminiImage, geminiApiKeys, huggingfaceKey, hfEnabled, lang, warnings, deadline, pin } =
    options;

  // ---- PRIMARY: Gemini -------------------------------------------------
  if (geminiApiKeys.length > 0) {
    try {
      return await analyzeImageWithGemini(geminiImage, geminiApiKeys, lang, deadline, pin, warnings);
    } catch (error) {
      // The global deadline is the request's hard stop, not a vision failure:
      // do not silently degrade a timing-out request into MobileNetV2.
      if (isDeadlineFailure(error)) throw error;
      const detail = shortMessage(error instanceof Error ? error.message : String(error));
      console.warn(`[Step 1: Gemini Analysis Failed → MobileNetV2] ${detail}`);
      pushWarning(warnings, `Step 1 Gemini image analysis failed — ${detail}`);
    }
  } else {
    const detail = "No GEMINI_API_KEY is configured — the primary image model is unavailable.";
    console.warn(`[Step 1: Gemini Skipped] ${detail} → MobileNetV2 fallback`);
    pushWarning(warnings, `Step 1 Gemini image analysis unavailable — ${detail}`);
  }

  // ---- FALLBACK: MobileNetV2 (only reachable after the primary failed) --
  // Soft-block: with Hugging Face disabled the fallback does not run at all —
  // no token check, no request, and NO client warning (this is configuration,
  // not a degradation).
  if (!hfEnabled) {
    console.warn(
      `[Step 1: MobileNetV2 Skipped] ENABLE_HUGGINGFACE=${ENABLE_HUGGINGFACE} — the Hugging Face fallback image model is disabled by configuration.`,
    );
    return null;
  }

  if (!huggingfaceKey) {
    const detail =
      "HUGGINGFACE_API_KEY is not configured — the fallback image model is unavailable.";
    console.warn(`[Step 1: MobileNetV2 Skipped] ${detail}`);
    pushWarning(warnings, `Step 1 MobileNetV2 unavailable — ${detail}`);
    return null;
  }

  try {
    // The MobileNetV2 classifier always receives the ORIGINAL frame now: the
    // leaf-cropping pre-step is removed from the pipeline.
    const classification = await classifyPlantImageStrict(
      geminiImage.data,
      geminiImage.mimeType,
      huggingfaceKey,
      deadline,
    );
    const result = analysisFromMobileNet(
      classification.rawLabel,
      classification.score,
      classification.model,
      classification.candidates,
      lang,
    );
    console.log(
      `[Step 1: MobileNetV2 Fallback Success] label=${classification.rawLabel} ` +
        `confidence=${Math.round(classification.score * 100)}% model=${classification.model}`,
    );
    return result;
  } catch (error) {
    if (isDeadlineFailure(error)) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    const detail = shortMessage(msg.startsWith("HF Error:") ? msg.slice("HF Error:".length).trim() : msg);
    console.warn(`[Step 1: MobileNetV2 Unavailable] ${detail} → STEP 4 (final fallback)`);
    pushWarning(warnings, `Step 1 MobileNetV2 unavailable — ${detail}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  STEP 4 — FINAL FALLBACK (both image models failed)                  */
/* ------------------------------------------------------------------ */

/**
 * STEP 4: neither Gemini nor MobileNetV2 could read the photo.
 *
 * The spec is explicit that no text model may be called with empty analysis
 * data, so this is a static, pre-written Arabic reply — never an LLM call. It
 * explains what happened and asks for a retake, with concrete guidance
 * (daylight, a close-up on the affected leaf, no blur) plus the offer to
 * describe the symptoms in words instead.
 */
function buildImageAnalysisUnavailableReply(): string {
  return [
    "⚠️ **تعذّر تحليل صورة النبتة** — لم نتمكن من قراءة الصورة هذه المرة.",
    "",
    "لم نتمكن من فحص الصورة حتى عبر محرّك التحليل الاحتياطي، لذلك لن أعطيك تشخيصاً غير مؤكّد. أعد المحاولة بصورة:",
    "- **مُضاءة جيداً** بإضاءة نهارية طبيعية، بعيداً عن الظل.",
    "- **قريبة** على الورقة المصابة، مع التركيز على البقع أو الاصفرار.",
    "- **واضحة غير ضبابية**، ومن دون ظلال قوية أو خلفية مزدحمة.",
    "",
    "أو صِف لي الأعراض نصياً: نوع المحصول، شكل البقع، مكانها على النبتة، وحالتها بعد الري — وسأجيبك مباشرة.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Shared prompting — one system prompt + user turn for BOTH text      */
/*  models (Step 2 Hugging Face and Step 3 Gemini receive identical      */
/*  input)                                                             */
/* ------------------------------------------------------------------ */

/**
 * Shared system prompt for BOTH LLM stages (Gemini + Hugging Face): the
 * serious professional agricultural expert («خبير زراعي محترف وجدي») —
 * direct, precise and practical Arabic answers with only a very subtle
 * touch of politeness: no affectionate greetings, no long-winded essays,
 * no repeated pleasantries or rehashed advice on ongoing conversations,
 * strictly within the agriculture / date-palm / Algerian farming domain.
 */
const SYSTEM_PROMPT = `أنت مساعد زراعي خبير داخل تطبيق "محصولي الذكي" (Smart Crop AI): خبير زراعي محترف وجدي، دقيق وموثوق. تقدم مشورة علمية صحيحة بأسلوب مهني متوازن وطبيعي، مع لمسة لباقة خفيفة فقط — دون ترحيبات عاطفية، دون خطب طويلة، ودون دفء زائد.

الهوية الموحدة:
- أنت كيان خبير زراعي واحد موحّد دائماً؛ تحدث بصوت واحد ولا تقدّم نفسك كمجموعة خبراء أو تنسب التشخيص إلى نموذج رؤية أو مساعد أو نظام منفصل. أدوات التحليل داخلية وليست أطرافاً في المحادثة.
- بطاقة التشخيص المرئية معروضة بالفعل في الواجهة؛ لا تكرر بياناتها التقنية في نص المحادثة. يُمنع ذكر نسب الثقة الخام (مثل «بثقة 25%»)، أو درجات المرشحين، أو تسميات نموذج الرؤية الخام مثل Tomato___Early_blight، حتى عند شرح نتيجة الفحص. استخدم أسماء الأمراض بلغة طبيعية وقدّم تعليقاً زراعياً مباشراً ونصائح عملية مبنية على التشخيص.
- عبّر عن عدم اليقين بالكلمات عند الحاجة (مثل «النتيجة أولية وتحتاج صورة أوضح»)، لا بالأرقام أو نسب الثقة.

النبرة والدقة:
- أجب مباشرة على سؤال الفلاح دون مقدمات أو إطالة؛ ادخل في صلب الموضوع من السطر الأول.
- هدفك الأول هو الدقة وبناء الثقة: معلومات علمية دقيقة بصياغة واضحة وفي متناول الفلاح الميداني.
- أجب دائماً باللغة العربية الفصحى المبسطة، إلا إذا طُلبت الفرنسية صراحةً في سياق المستخدم.
- اجعل شكل الجواب تابعاً لطبيعة السؤال وحجم المحتوى، ولا تفرض بنية واحدة من عنوان ونقاط على كل إجابة.
- استخدم النقاط فقط عندما يكون المحتوى قائمة متوازية فعلاً، مثل الخطوات المتسلسلة أو الخيارات أو المواد مع جرعاتها.
- إذا كان الجواب تفسيراً سببياً أو تحليلاً أو نصيحة واحدة مترابطة، فاكتبه في فقرة قصيرة متصلة بدلاً من تحويله إلى نقاط.
- إذا كان السؤال بسيطاً، مثل سؤال بنعم أو لا مع تعليل موجز، فأجب بجملة أو جملتين دون تنسيق أو عناوين إضافية.
- عند المقارنة، لا تستخدم العنوان نفسه لقسمين مختلفين؛ امنح كل قسم عنواناً دقيقاً ومميزاً، مثل «الإيجابيات» مقابل «التحديات» أو «السلبيات».
- حافظ على الجواب عملياً ومختصراً؛ وفي الإجابات الطويلة أو المعقدة، اعتبر ~١٥٠ كلمة حداً أعلى مرناً لا هدفاً ينبغي بلوغه، فالإجابة الأقصر هي الصحيحة والمفضلة عندما يكون السؤال بسيطاً.

التدرج من العام إلى الخاص (Progressive Detailing):
- في بداية المحادثة، عندما يكون سجل الرسائل قصيراً: قدّم سياقاً عاماً تأسيسياً يؤطّر المشكلة — المفاهيم الأساسية والأسباب الأولية المحتملة — أو اطرح أسئلة توضيحية مهنية واسعة لتأطير الوضع (نوع المحصول، عمر الأعراض، الولاية والمناخ، آخر معالجة).
- مع تقدّم المحادثة: تعمّق تدريجياً نحو تفاصيل تقنية محددة ودقيقة مستنداً إلى إجابات المستخدم في سجل المحادثة — تشخيص تفريقي، جرعات محسوبة، مواعيد تدخل، وأسماء المواد ومكوناتها الفعالة.
- لا تقفز من السؤال الأول مباشرة إلى توصيات علاجية دقيقة قبل تأطير المشكلة: ابدأ واسعاً ثم ضيّق النطاق مع كل ردّ جديد من المستخدم.

الذاكرة الذكية وعدم التكرار:
- ابنِ كل ردّ على رسائل المحادثة السابقة: لا تكرر التحية أو الترحيب أو ذكر مدينة المستخدم وولايته في كل رسالة.
- إذا كانت رسالة المستخدم مجرد تحية (مثل «مرحبا»)، فرد بجملة مهنية قصيرة واحدة ثم انتظر سؤاله.
- إذا كانت المحادثة جارية، ادخل مباشرة في الجواب دون أي مجاملات افتتاحية أو تقديم مكرر لنفسك.
- لا تكرر معلومات أو حقائق أو تشخيصات أو نصائح قدمتها في الرسائل السابقة؛ اكتفِ بالإضافة أو التعميق.
- انتقل بسلاسة من العرض العام إلى التدخل المحدد، مستنداً دائماً إلى تاريخ المحادثة وأجوبة المستخدم السابقة.

التشخيص والعلاج:
- مهمتك الأساسية مع صورة نبات هي صياغة نتيجة الفحص المرفقة: اعرض التشخيص بصوت واحد واذكر المرض باسمه العربي الطبيعي، ثم أضف ما ينبغي للفلاح فعله للعلاج والوقاية، دون إعادة سرد بطاقة التشخيص المعروضة في الواجهة أو بياناتها التقنية.
- لا تُقدِّم مرضاً أو عرضاً أو نقصاً أو سبباً أو مرشّحاً لم يرد في نتيجة الفحص المرفقة، ولا تُبدّلها بتشخيص آخر من اجتهادك الخاص. اقتصر على ما ورد أعلاه.
- إن كانت درجة الثقة في الفحص منخفضة، وضّح بالكلمات أن النتيجة أولية واطلب صورة أوضح في سطر واحد. درجة الثقة سبب لطلب صورة أفضل، لا لاقتراح تشخيص مختلف؛ ولا تنقل نسبة الثقة نفسها إلى نصّك.
- إن لم ترصد نتيجة الفحص أي إصابة، فذلك جواب مشروع: طمئن المستخدم بلغة مهنية قصيرة واذكر إجراءات الوقاية العملية، دون اختراع مرض.
- اذكر مواد وممارسات متوفرة فعلاً في السوق الجزائرية (مبيدات نحاسية، مانكوزيب، كبريت ميكروني، تناوب زراعي…) مع جرعات إرشادية مختصرة وفترة الأمان قبل الجني.
- في قسم خطة العلاج تحديداً (ودون تغيير حجم أو أسلوب بقية الأقسام)، كن أكثر تفصيلاً وعملية في ثلاث نقاط:
  1) اسم المنتج: سمِّ المادة الفعالة بدقة (مثل «مانكوزيب 80%»، «أوكسي كلورور النحاس 50%»، «أزوكسيستروبين»، «ديفينوكونازول») بدل الاكتفاء بفئة عامة كـ«مبيد فطري»، واذكر عند الاقتضاء اسماً تجارياً شائعاً كمثال (مثل «ديثان M-45» للمانكوزيب، أو «سكور» للديفينوكونازول) مع التنبيه إلى أن الأسماء التجارية تختلف حسب المورد.
  2) البدائل: لكل مادة فعالة موصى بها، اذكر بديلاً واحداً على الأقل بمادة فعالة مختلفة تعالج المرض نفسه، تحسباً لعدم توفر الأولى محلياً (مثلاً: إن لم يتوفر المانكوزيب فاستخدم الكلوروثالونيل أو مركّباً نحاسياً).
  3) طريقة التطبيق: حدّد الجرعة بالغرام أو المليلتر لكل لتر ماء، وطريقة التطبيق (رش ورقي، سقي للتربة، معاملة بذور…)، والتوقيت (وقت اليوم المناسب مثل الصباح الباكر أو المساء، الفاصل بين الرشات بالأيام، عدد مرات التكرار، وفترة الأمان قبل الجني إن كانت ذات صلة)، مع ملاحظات مختصرة عن الخلط والسلامة (عدم الخلط مع مواد غير متوافقة، التناوب بين المواد الفعالة لتجنب المقاومة، ارتداء معدات الوقاية).
- خصّص التوصيات حسب ولاية المستخدم ومناخها ومحصوله ودوره إن وردت في السياق المرفق.

احترام رغبة المستخدم:
- إذا صرّح المستخدم برفض الموضوع الحالي أو طلب تغييره، تقبّل ذلك فوراً في نفس الرد، ولا تكرر نفس المقدمة أو تفرض سياق الملف الشخصي (الولاية/المحصول) مرة أخرى.
- سياق الملف الشخصي معلومة خلفية اختيارية، وليست قاعدة تُفرض في كل رد.

حدود المجال (بمرونة):
- اختصاصك الأساسي: الفلاحة، صحة النخيل والتمور، السقي، العناية بالتربة، والسياق الفلاحي الجزائري المحلي.
- إن خرج السؤال عن الفلاحة لكنه مفيد عموماً، أجب عنه بإيجاز وبشكل نافع، ثم أشر بلطف إلى اختصاصك الزراعي عند الحاجة.
- لا تدّعي اليقين المطلق: في الحالات الحرجة انصح بمعاينة مهندس زراعي محلي، في سطر واحد.
`;

function describeContext(context: AssistantContext | undefined): string {
  if (!context) return "لا يوجد سياق ملف شخصي.";
  const parts: string[] = [];
  if (context.displayName) parts.push(`الاسم: ${context.displayName}`);
  if (context.wilayaName || context.wilayaCode) {
    parts.push(
      `الولاية: ${context.wilayaName ?? "غير معروفة"}${context.wilayaCode ? ` (رمز ${context.wilayaCode})` : ""}`,
    );
  }
  if (context.crop) parts.push(`المحصول المفضل: ${context.crop}`);
  if (context.role) {
    const roleAr =
      context.role === "farmer"
        ? "فلاح"
        : context.role === "agronomist"
          ? "مهندس زراعي"
          : context.role === "investor"
            ? "مستثمر فلاحي"
            : context.role;
    parts.push(`الدور: ${roleAr}`);
  }
  if (context.lang === "fr") parts.push("اللغة المطلوبة للإجابة: الفرنسية");
  return parts.length > 0 ? parts.join(" · ") : "لا يوجد سياق ملف شخصي.";
}

/**
 * Renders the Step 1 {@link AnalysisData} as the reference block the text
 * stage reasons over.
 *
 * This is the single hand-off point between the two stages: whichever image
 * model produced the data, the text model sees exactly these lines and never
 * learns which one it was (the last general rule of the orchestrator).
 * Gemini normally fills every field, so the block is rich; MobileNetV2 can
 * only supply a disease name, a plant type and a score, so the same renderer
 * emits less — again, without the text stage having to care.
 *
 * The `confidence` line is deliberately present but fenced off from the
 * display rules: the diagnosis card already shows the number, so the prose
 * must not repeat it, and a low score is a reason to ask for a better photo,
 * never to invent a different diagnosis.
 */
function describeAnalysis(analysis: AnalysisData | null): string {
  if (!analysis) return "";
  const pct = Math.round(analysis.confidence * 100);
  const bucket = confidenceBucket(analysis.confidence);
  return [
    "خلاصة فحص صورة المستخدم (بيانات داخلية للاستدلال فقط؛ لا تنقل نسبة الثقة الخام إلى نص المحادثة لأن البطاقة المرئية تعرضها أصلاً. التحليل يعمل في الخلفية كوحدة واحدة — اعرضها بوصفها تحليلك أنت بصوت واحد دون نسبتها إلى «نموذج» أو «نظام» منفصل):",
    analysis.plant_type ? `- نوع المحصول (plant type): ${analysis.plant_type}` : "",
    analysis.disease_detected
      ? `- المرض المشخّص (disease name): ${analysis.disease_name ?? "غير محدد"}`
      : "- لم تُرصد إصابة مرضية على النبتة؛ طمئن المستخدم وقدّم نصائح وقائية.",
    analysis.severity
      ? `- درجة الخطورة (severity): ${SEVERITY_AR[analysis.severity]}`
      : "",
    `- درجة الثقة (confidence): ${pct}% (${bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة"})`,
    analysis.affected_parts.length > 0
      ? `- الأجزاء المصابة (affected parts): ${analysis.affected_parts.join(" · ")}`
      : "",
    analysis.symptoms_observed.length > 0
      ? `- الأعراض المرصودة (symptoms): ${analysis.symptoms_observed.join(" · ")}`
      : "",
    analysis.notes ? `- ملاحظة فنية (notes): ${analysis.notes}` : "",
    // The narration contract: report what the analysis says, add the
    // treatment/prevention recommendation the farmer needs, and do not
    // substitute a different diagnosis.
    "- حدّ العرض: التزم بما ورد أعلاه — لا تخترع مرضاً أو سبباً أو مرشّحاً لم يرد في الفحص، ولا تذكر نسبة الثقة في نصّك. الثقة المنخفضة سبب لطلب صورة أوضح لا لاقتراح تشخيص مختلف.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the single user turn shared by Step 2 (HF `messages[1]`) and Step 3
 * (Gemini `contents`): Firestore profile context (Wilaya, crop, role,
 * language, name) + the Step 1 analysis reference block when an image stage
 * ran + the user's own query.
 *
 * When an image was analysed the turn also states the model's ONLY job: turn
 * the structured analysis into a clear, friendly explanation with a
 * practical recommendation. It never carries the photo — Gemini is a pure
 * formatter in Step 3 and must not re-analyse anything — and it never names
 * the image model, which is what keeps the two stages interchangeable.
 */
function buildUserContent(
  message: string,
  context: AssistantContext | undefined,
  analysis: AnalysisData | null,
  isFirstTurn: boolean,
): string {
  const sections = [
    ...(isFirstTurn ? [`سياق المستخدم من ملفه الشخصي: ${describeContext(context)}`] : []),
    describeAnalysis(analysis),
    analysis
      ? "مهمتك الآن صياغة نتيجة الفحص أعلاه فقط: قدّم للمستخدم شرحاً واضحاً ومباشراً لهذا الفحص، بدافع تطبيقي، مع توصية عملية للعلاج والوقاية إن كان الفحص قد رصد مرضاً — بصوتك الخبير أنت، دون تكرار بيانات البطاقة المرئية ودون ذكر النموذج أو النظام الذي أنجز الفحص."
      : "",
    message
      ? `سؤال المستخدم: ${message}`
      : analysis
        ? "لم يكتب المستخدم سؤالاً — قدّم نتيجة الفحص وخطة العلاج والوقاية مباشرة بناءً على البيانات أعلاه."
        : "قدّم نفسك في جملة واحدة كمساعد زراعي خبير واطلب سؤال المستخدم دون أي حشو.",
  ].filter(Boolean);
  return sections.join("\n\n");
}

/**
 * Everything one Gemini round-trip needs, so the transport can serve both
 * Gemini roles (structured image analysis and plain narration) without
 * branching on a "mode" flag.
 */
interface GeminiPrompt {
  /** `systemInstruction` — extraction rules, or the advisor persona. */
  systemInstruction: string;
  /** The single user turn (text part). */
  userContent: string;
  /** Pixels as an `inlineData` part. ONLY the Step 1 image analysis sets it. */
  image?: AssistantImagePayload | null;
  /** Prior conversation turns (narration only). */
  history?: AssistantHistoryTurn[];
  /**
   * Extra `generationConfig` keys — the image analysis passes
   * `responseMimeType: "application/json"` + `responseSchema` here to pin a
   * machine-readable answer.
   */
  extraConfig?: Record<string, unknown>;
}

/** Any Gemini failure; the caller degrades to the next stage either way. */
class GeminiError extends Error {
  /** Upstream status when the failure came back as an HTTP response. */
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

/** Response shape (subset) of `models.generateContent`. */
interface GeminiPayload {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/** Concatenates every text part of the first candidate. */
function geminiText(payload: GeminiPayload | null): string {
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part?.text ?? "")
    .join("")
    .trim();
}

/**
 * Message fragments Google returns when the *model id* is the problem rather
 * than the request. Three distinct shapes must all walk the chain:
 *
 *   • a mistyped/retired id — `models/gemini-3.6 is not found for API version
 *     v1beta, or is not supported for generateContent`;
 *   • an id withheld from this key — `models/gemini-2.5-flash is no longer
 *     available to new users. Please update your code to use …` (Google has
 *     shipped this with both 404 and 400, so the status check alone is not
 *     enough);
 *   • an id that exists but cannot serve this method.
 *
 * Together with an HTTP 404 these are the only Gemini failures that walk the
 * model chain — invalid keys (400/403), quota (429), safety blocks, 5xx,
 * network errors and the timeout abort are surfaced immediately, because
 * another model id can't fix them.
 */
const GEMINI_MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /is not found/i,
  /not supported for generateContent/i,
  /\bunknown model\b/i,
  /\bno such model\b/i,
  // Withheld from this key rather than globally retired.
  /no longer available to (?:new )?users/i,
  /not available (?:to|for) (?:new )?users/i,
];

/** True when the failure looks like "this Gemini model id is retired/gone". */
function isGeminiModelAvailabilityError(error: unknown): boolean {
  if (!(error instanceof GeminiError)) return false;
  if (error.status === 404) return true;
  return GEMINI_MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

/**
 * Google's rate-limit / quota signatures that must park a (key, model) pair
 * rather than fail the stage — the HTTP status covers the usual case, the
 * message patterns catch quota rejections surfaced in the body (a daily-quota
 * rejection can arrive as 429 with `RESOURCE_EXHAUSTED`, and some project
 * limits answer 400 with a quota message).
 */
const GEMINI_QUOTA_ERROR_PATTERNS: readonly RegExp[] = [
  /RESOURCE_EXHAUSTED/i,
  /\bquota(?:s)?(?:\s+limit|\s+exceeded|\s+per\s+day|\s+for\s+the\s+day)?\b/i,
  /\bper[_ ]?day\b/i,
  /rate[ _-]?limit/i,
  /exceeded your current quota/i,
];

/**
 * Google's "this credential is not usable" signatures: a 400 with
 * `API_KEY_INVALID` (the key was revoked, mistyped or never enabled for the
 * Generative Language API) or a 403 (permission denied / API not enabled /
 * billing refused). Both park the KEY for 60 minutes.
 */
const GEMINI_INVALID_KEY_PATTERNS: readonly RegExp[] = [
  /API[_ ]?KEY[_ ]?INVALID/i,
  /API key not valid/i,
  /invalid API key/i,
  /API key expired/i,
  /request had invalid authentication credentials/i,
  /PERMISSION_DENIED/i,
  /API (?:has not been used|is not enabled)/i,
  /billing/i,
];

/**
 * What a Gemini failure MEANS for the rotation loop — the whole reason the
 * loop can decide "same key again", "next key", "next model" or "give up"
 * without re-parsing error text in three places.
 */
type GeminiFailureKind = "quota" | "invalid_key" | "transient" | "model" | "other";

/** Classify one {@link GeminiError}; see {@link runGeminiWithKeyPool}. */
function classifyGeminiFailure(error: GeminiError): GeminiFailureKind {
  const message = error.message;

  if (isGeminiModelAvailabilityError(error)) return "model";
  if (error.status === 429) return "quota";
  if (GEMINI_QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return "quota";
  if (error.status === 403) return "invalid_key";
  if (error.status === 400 && GEMINI_INVALID_KEY_PATTERNS.some((pattern) => pattern.test(message))) {
    return "invalid_key";
  }
  if (error.status === 401) return "invalid_key";
  // 5xx and the per-attempt timeout/network wrapper (`status` undefined but a
  // "timeout after …" message) are transient: retry once, then rotate.
  if (error.status !== undefined && error.status >= 500) return "transient";
  if (error.status === undefined && /timeout|network|fetch failed|ECONN|socket/i.test(message)) {
    return "transient";
  }
  return "other";
}

/**
 * Human-readable detail for a non-2xx Gemini response, already reduced to the
 * status plus a SHORT redacted message — the same string is logged and
 * surfaced in `warnings[]`, so it must never carry the request URL (which
 * contains the key) or an unbounded error envelope.
 */
function describeGeminiHttpError(status: number, bodyText: string): string {
  const fallback = `HTTP ${status}${bodyText ? ` — ${shortMessage(bodyText)}` : ""}`;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string; status?: string } };
    const message = parsed?.error?.message;
    const state = parsed?.error?.status;
    if (message) {
      return `HTTP ${status} — ${shortMessage(message)}${state ? ` [${state}]` : ""}`;
    }
  } catch {
    // keep the raw (redacted) detail
  }
  return fallback;
}

/**
 * One `models.generateContent` round-trip against a single Gemini id.
 *
 * The same transport serves BOTH Gemini roles in the orchestrator, which is
 * why the payload is described by {@link GeminiPrompt} rather than by fixed
 * arguments:
 *   • Step 1 image analysis — `systemInstruction` is the structured-extraction
 *     instruction, `image` is the raw photo, and `extraConfig` pins
 *     `responseMimeType`/`responseSchema` so the answer is a JSON object;
 *   • Step 3 text fallback — the expert advisor prompt, NO image (Gemini is
 *     strictly a formatter there and must not re-analyse anything).
 *
 * Throws {@link GeminiError} on every failure mode (status kept for the
 * chain-walk decision); a fetch aborted by the shared signal is reported as
 * the timeout.
 */
async function generateWithGeminiModel(
  model: GeminiModel,
  prompt: GeminiPrompt,
  apiKey: string,
  deadline: RequestDeadline,
): Promise<string> {
  const { systemInstruction, userContent, image, history, extraConfig } = prompt;
  let response: Response;
  try {
    response = await timedFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [
            ...(history ?? []).map((turn) => ({
              role: turn.role === "assistant" ? "model" : "user",
              parts: [{ text: turn.content }],
            })),
            {
              role: "user",
              parts: image
                ? [
                    // The photo itself. Only the Step 1 image-analysis call
                    // ever sets this: the text stage is fed ANALYSIS_DATA and
                    // is never given pixels to re-interpret.
                    { inlineData: { mimeType: image.mimeType, data: image.data } },
                    { text: userContent },
                  ]
                : [{ text: userContent }],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            topP: 0.9,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            // Answer-first latency, per generation: Gemini 2.5 →
            // thinkingBudget 0; the stable 1.5/2.0 ids (and unknown
            // GEMINI_MODEL overrides) predate thinking and 400 on the
            // parameter, so they get NO thinkingConfig at all.
            ...(model.thinking ? { thinkingConfig: { ...model.thinking } } : {}),
            // Structured-output pins (image analysis only).
            ...(extraConfig ?? {}),
          },
        }),
      },
      deadline,
    );
  } catch (error) {
    // A global-deadline abort is terminal for the whole request (the caller
    // answers 503); an 8 s per-attempt timeout is an ordinary transient
    // failure the rotation loop retries once on the same key.
    if (isDeadlineFailure(error)) throw error;
    if (isAbortOrTimeoutError(error)) {
      throw new GeminiError(`timeout after ${PER_ATTEMPT_TIMEOUT_MS} ms (per-attempt window)`);
    }
    const detail = shortMessage(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    throw new GeminiError(detail);
  }

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = response.statusText;
    }
    // Task rule: log ONLY the status and a SHORT, redacted message. The
    // envelope is PARSED first, so Google's unbounded `details[]` payload (and,
    // defensively, anything shaped like a credential) never reaches the logs;
    // a non-JSON body is truncated by `shortMessage` instead.
    const detail = describeGeminiHttpError(response.status, bodyText || response.statusText);
    console.error(`[Gemini Error] ${detail}`);
    throw new GeminiError(detail, response.status);
  }

  const payload = (await response.json().catch(() => null)) as GeminiPayload | null;
  const text = geminiText(payload);
  if (!text) {
    const blocked = payload?.promptFeedback?.blockReason;
    const finish = payload?.candidates?.[0]?.finishReason;
    throw new GeminiError(
      blocked
        ? `no usable text — blocked by safety filters (${blocked})`
        : `no usable text in response (finishReason: ${finish ?? "unknown"})`,
    );
  }
  return text;
}

/** A completed Gemini round-trip: the model id that answered, its text and any
 *  non-fatal degradations (retired-id 404s) the chain walked past to get there. */
interface GeminiResult {
  model: string;
  text: string;
  warnings: string[];
}

/* ---- Health check — validate the chain against ListModels ---------- */

/**
 * One monitor per process: single-flight, 6-hour TTL, and the source of the
 * "these ids are dead" set that {@link resolveGeminiModels} filters the chain
 * with. Exported so tests can reset it between cases.
 */
export const geminiModelHealth = new GeminiModelHealthMonitor();

/**
 * Validate the configured Gemini chain against `GET /v1beta/models` and log a
 * one-line verdict, at most once per monitor TTL and always from the single
 * Gemini entry point — so both Gemini roles are covered by one check.
 *
 * Never throws: a ListModels outage degrades to one "could not verify" warning.
 */
async function ensureGeminiModelHealth(
  keyPool: readonly GeminiKeyEntry[],
  deadline: RequestDeadline,
): Promise<void> {
  if (keyPool.length === 0) return;

  const report = await geminiModelHealth.ensure(resolveGeminiModels(), {
    apiKey: keyPool[0].key,
    // The verdict doubles as the FIRST key's 1-hour catalog, so the request
    // path never issues a second ListModels call for it.
    catalogKey: keyPool[0].name,
    signal: deadline.signal,
    timeoutMs: Math.max(1_000, Math.min(6_000, deadline.remainingMs)),
  });
  if (!report) return;

  for (const line of formatGeminiHealthReport(report, resolveGeminiModels())) {
    // A broken chain is a deployment problem, not a request problem — it must
    // be impossible to miss in the platform logs.
    if (line.includes("❌") || line.includes("⚠")) console.error(line);
    else console.log(line);
  }
}

/**
 * Run the Gemini chain MODEL-first, KEY-second — the mandated rotation order.
 *
 * For the current model, every configured credential is tried in rotation
 * order (see {@link resolveGeminiApiKeys}), because a different key usually
 * belongs to a different Google project with its own daily quota:
 *
 *   • 429 / `RESOURCE_EXHAUSTED` / daily quota → park that (key, MODEL) pair for
 *     10 minutes and move to the next key. The same key is still eligible for
 *     the NEXT model — quotas can be per-model.
 *   • 400 `API_KEY_INVALID` / 403 → park the KEY for 60 minutes and skip it.
 *   • 503 / 5xx / network error / 8 s per-attempt timeout → retry the SAME key
 *     once, then move on to the next key.
 *   • model id missing from that key's cached `GET /v1beta/models` catalog
 *     (1 hour TTL) → skip that (key, model) pair without a round-trip.
 *   • 404 / model-not-found / "no longer available to users" → the model id
 *     itself is gone: walk to the next model for every remaining key.
 *   • anything else (safety block, empty candidate list, malformed request) →
 *     fail the stage, because neither another key nor another model can fix it.
 *
 * When every key is parked or refused for a model, the outer loop simply moves
 * to the next model in the chain. The whole walk is bounded by the request's
 * single 60 s deadline; when it fires, {@link DeadlineExceededError} propagates
 * and the route answers 503 instead of overrunning Vercel's 60 s limit.
 *
 * Only credential NAMES are ever logged or echoed — the winning pair is
 * reported as `Gemini OK: GEMINI_API_KEY_4 / gemini-3.5-flash`.
 */
async function runGeminiWithKeyPool(
  prompt: GeminiPrompt,
  keyPool: readonly GeminiKeyEntry[],
  deadline: RequestDeadline,
  /**
   * The model the user picked in the selector (a Gemini id), pinned as the head
   * of the chain. `undefined` = no manual choice.
   */
  pin?: string,
): Promise<GeminiResult> {
  // Once per process (TTL-bounded): proves the configured model ids still
  // exist BEFORE they are used, so a Google deprecation surfaces as one loud
  // log line instead of 404-ing silently on every request. The same round-trip
  // seeds the first key's catalog.
  await ensureGeminiModelHealth(keyPool, deadline);

  // Resolve the chain once per request so a `GEMINI_MODEL` change (or a fresh
  // model-selector choice) is picked up without a restart — same convention as
  // the key pool. A `pin` puts the USER'S model first.
  const models = resolveGeminiModels(pin);
  const failures: string[] = [];
  const warnings: string[] = [];

  // Per-key catalogs, cached for an hour. Resolved in parallel — each probe is
  // capped by the 8 s attempt budget and by the request deadline — and `null`
  // (unknown: unreachable, cancelled, or pre-verified) means "skip nothing".
  const catalogs = await resolveKeyCatalogs(keyPool, deadline);

  const warnedInvalid = new Set<string>();
  /** Park events from THIS request, so the final failure explains itself. */
  const quotaParked: string[] = [];
  const invalidParked: string[] = [];

  for (const [modelIndex, model] of models.entries()) {
    let modelRetired = false;
    const nextModel = models[modelIndex + 1] ?? null;

    for (const [keyIndex, entry] of keyPool.entries()) {
      if (deadline.remainingMs <= MIN_STAGE_BUDGET_MS) {
        throw new DeadlineExceededError(
          `only ${Math.max(0, deadline.remainingMs)} ms left before the 60 s deadline`,
        );
      }

      if (geminiKeyState.isInvalid(entry.name)) {
        if (!warnedInvalid.has(entry.name)) {
          warnedInvalid.add(entry.name);
          console.warn(
            `[Gemini: Key Skipped] ${entry.name} is parked as invalid (400 API_KEY_INVALID / 403) for up to 60 min — skipping.`,
          );
        }
        continue;
      }

      if (geminiKeyState.isQuotaExhausted(entry.name, model.id)) {
        continue;
      }

      const catalog = catalogs.get(entry.name) ?? null;
      if (catalog && !catalog.has(model.id)) {
        // This key's cached catalog does not offer the id (Google withholds
        // models per project). Another key may still see it, so only this
        // (key, model) pair is skipped — no round-trip, no noise per request.
        console.warn(
          `[Gemini: Model Skipped] ${model.id} is not offered to ${entry.name} (per-key catalog) — trying the next key/model.`,
        );
        continue;
      }

      const nextKeyIndex = keyIndex + 2;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const text = await generateWithGeminiModel(model, prompt, entry.key, deadline);
          // The mandated success line — key NAME and model id only.
          console.log(`Gemini OK: ${entry.name} / ${model.id}`);

          // A manual choice that could not be honoured must never be silent:
          // the user asked for one model and another answered, so the reply
          // carries the substitution — by NAME, never a credential.
          if (pin && model.id !== pin) {
            const substitution =
              `Selected model ${phytoModelLabel(pin)} (${pin}) was unavailable — answered with ` +
              `${phytoModelLabel(model.id)} (${model.id}).`;
            warnings.push(shortMessage(substitution, 400));
            console.warn(`[Gemini: Selected Model Fallback] ${substitution}`);
          }

          return { model: model.id, text, warnings };
        } catch (error) {
          if (isDeadlineFailure(error)) throw error;
          if (!(error instanceof GeminiError)) throw error;

          const kind = classifyGeminiFailure(error);
          const label = `key ${keyIndex + 1}/${keyPool.length} (${entry.name})`;
          failures.push(`${entry.name} / ${model.id}: ${error.message}`);

          const rotationNote =
            nextKeyIndex <= keyPool.length
              ? `key rotation attempt ${nextKeyIndex}/${keyPool.length}`
              : "no key left in the pool";

          if (kind === "quota") {
            geminiKeyState.markQuotaExhausted(entry.name, model.id);
            quotaParked.push(`${entry.name}@${model.id}`);
            const warning =
              `Gemini HTTP ${error.status ?? 429} quota failure on ${label} / ${model.id} — ` +
              `${shortMessage(error.message)} (key parked for 10 min, ${rotationNote}).`;
            warnings.push(shortMessage(warning, 400));
            console.warn(`[Gemini: Key Rotation] ${warning}`);
            break; // next key — another project may still have quota
          }

          if (kind === "invalid_key") {
            geminiKeyState.markInvalid(entry.name);
            invalidParked.push(entry.name);
            const warning =
              `Gemini HTTP ${error.status ?? 400} ${error.status === 403 ? "forbidden" : "API_KEY_INVALID"} on ${label} — ` +
              `${shortMessage(error.message)} (key parked for 60 min, ${rotationNote}).`;
            warnings.push(shortMessage(warning, 400));
            console.warn(`[Gemini: Key Rotation] ${warning}`);
            break; // next key
          }

          if (kind === "transient") {
            const status = error.status ?? "network";
            if (attempt === 1) {
              const warning = `Gemini HTTP ${status} transient failure on ${label} / ${model.id} — retrying the same key once.`;
              warnings.push(shortMessage(warning, 400));
              console.warn(`[Gemini: Key Retry] ${warning}`);
              continue; // retry the SAME key once
            }
            const warning =
              `Gemini HTTP ${status} transient failure on ${label} / ${model.id} — ` +
              `moving on, ${rotationNote}.`;
            warnings.push(shortMessage(warning, 400));
            console.warn(`[Gemini: Key Rotation] ${warning}`);
            break; // next key
          }

          if (kind === "model") {
            modelRetired = true;
            warnings.push(shortMessage(`Gemini unavailable — ${error.message}`, 400));
            console.warn(
              `[Gemini: Model Fallback] ${error.message} — ${nextModel ? `retrying with ${nextModel.id}` : "no model left in the chain"}`,
            );
            break; // next model
          }

          // Safety block, empty candidate list, malformed request… nothing
          // another key or model could fix.
          throw error;
        }
      }

      if (modelRetired) break; // leave the key loop, advance the model chain
    }
  }

  // The client warning must still explain WHY nothing answered, so the parked
  // credentials (names only) lead the summary, before the per-attempt details.
  const quotaKeyNames = [...new Set(quotaParked.map((id) => id.split("@")[0]))];
  const parkedState = [
    quotaKeyNames.length
      ? `quota-parked 10 min: ${quotaKeyNames
          .map((name) => `${name} (${quotaParked.filter((id) => id.startsWith(`${name}@`)).length} model(s))`)
          .join(", ")}`
      : null,
    invalidParked.length ? `invalid-parked 60 min: ${[...new Set(invalidParked)].join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  throw new GeminiError(
    `no Gemini model/key could answer (models: ${models.map((m) => m.id).join(", ")}; keys: ${keyPool
      .map((entry) => entry.name)
      .join(", ")})${parkedState ? ` — ${parkedState}` : ""} — first failure: ${failures[0] ?? "no attempt could be made"}` +
      (failures.length > 1 ? ` (+${failures.length - 1} more attempt(s))` : ""),
  );
}

/**
 * Resolve every key's cached `generateContent` catalog in parallel, once per
 * request. Each probe is bounded by the 8 s attempt window and by the request
 * deadline, cached for an hour, and NEVER fatal: `null` means "unknown, skip
 * nothing", so an unreachable ListModels can only make the pipeline more
 * permissive, never less available.
 */
async function resolveKeyCatalogs(
  keyPool: readonly GeminiKeyEntry[],
  deadline: RequestDeadline,
): Promise<Map<string, ReadonlySet<string> | null>> {
  const entries = await Promise.all(
    keyPool.map(async (entry): Promise<[string, ReadonlySet<string> | null]> => {
      const budget = deadline.remainingMs;
      if (budget <= MIN_STAGE_BUDGET_MS) return [entry.name, geminiModelHealth.cachedCatalog(entry.name)];
      const ids = await geminiModelHealth.ensureCatalog(entry.name, entry.key, {
        signal: deadline.signal,
        timeoutMs: Math.max(1_000, Math.min(PER_ATTEMPT_TIMEOUT_MS, budget)),
      });
      return [entry.name, ids];
    }),
  );
  return new Map(entries);
}

/* ------------------------------------------------------------------ */
/*  Step 2 — Hugging Face text model, the PRIMARY chain (STRICT)       */
/* ------------------------------------------------------------------ */

/** HTTP / transport failure with the response status kept for fallback logic. */
class HfLlmRequestError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "HfLlmRequestError";
    this.status = status;
  }
}

/** The model answered successfully but produced no usable text. */
class HfLlmEmptyResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HfLlmEmptyResponseError";
  }
}

/**
 * Message fragments the HF router returns when the *model id* is the problem
 * rather than the request itself: model not served by any provider (the
 * router's `400 — { code: "model_not_supported" } The requested model '…' is
 * not supported by any provider you have enabled`, or the legacy per-provider
 * `Model not supported by provider hf-inference`), retired or mistyped ids
 * (`404 — Model not found`), gated models whose license the token owner never
 * accepted (`403 — You cannot access this model… / accepting the terms`), and
 * endpoints that don't support chat completions. Together with an HTTP 404
 * these are the only failures that trigger the fallback chain — invalid or
 * under-scoped tokens (401/403 "insufficient permissions"), exhausted credits
 * (402), quota (429), 5xx, other 400s (bad request body) and network errors
 * are surfaced immediately, because another model id can't fix them and the
 * extra round-trips would just burn the request budget (`maxDuration`).
 */
const HF_LLM_MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /\bnot found\b/i,
  /does not (?:seem to )?exist/i,
  /no such model/i,
  /\bnot supported\b/i,
  /\bmodel_not_supported\b/i,
  /\bcannot access\b/i,
  /\baccess to this model\b/i,
  /\bgated\b/i,
  /\blicense\b/i,
  /\baccept(ing)? the terms\b/i,
];

/** True when the failure looks like "this model id isn't usable for this key". */
function isHfLlmModelAvailabilityError(error: unknown): boolean {
  if (error instanceof HfLlmEmptyResponseError) return true;
  if (!(error instanceof HfLlmRequestError)) return false;
  if (error.status === 404) return true;
  return HF_LLM_MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

interface HfChatCompletion {
  choices?: { message?: { content?: string | null } }[];
}

/**
 * Error envelopes the router can answer with. The OpenAI-compatible router
 * uses the OpenAI object shape (`{ error: { message, type, param, code } }`,
 * e.g. `code: "model_not_supported"`); the legacy per-provider endpoints and
 * some upstream providers still answer a bare string (`{ error: "…" }`).
 */
interface HfErrorEnvelope {
  error?: string | { message?: string; code?: string; type?: string };
}

/**
 * Human-readable detail for a non-2xx router response: the JSON error message
 * (plus the machine `code` when present, so `model_not_supported` is visible
 * in logs/warnings) or, failing that, the raw body prefix.
 */
function describeHfHttpError(status: number, bodyText: string): string {
  const fallback = `HTTP ${status}${bodyText ? ` — ${shortMessage(bodyText)}` : ""}`;
  try {
    const parsed = JSON.parse(bodyText) as HfErrorEnvelope;
    const envelope = parsed?.error;
    if (typeof envelope === "string" && envelope) {
      return `HTTP ${status} — ${shortMessage(envelope)}`;
    }
    if (envelope && typeof envelope === "object") {
      const message = typeof envelope.message === "string" ? envelope.message.trim() : "";
      const code = typeof envelope.code === "string" ? envelope.code.trim() : "";
      if (message || code) {
        return `HTTP ${status} — ${[code && `[${code}]`, shortMessage(message)].filter(Boolean).join(" ")}`;
      }
    }
  } catch {
    // keep raw detail
  }
  return fallback;
}

/**
 * A single chat-completions round-trip for one HF LLM id through the
 * Inference Providers router ({@link HF_ROUTER_CHAT_URL}) — Bearer token
 * header, OpenAI-compatible body with the model id inside it.
 * Throws {@link HfLlmRequestError} on transport/HTTP failures (status kept)
 * and {@link HfLlmEmptyResponseError} when the model returns no text.
 */
async function generateWithHfLlmModel(
  model: string,
  userContent: string,
  apiKey: string,
  history: AssistantHistoryTurn[] = [],
  deadline: RequestDeadline,
): Promise<string> {
  let res: Response;
  try {
    res = await timedFetch(
      HF_ROUTER_CHAT_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...history,
            { role: "user", content: userContent },
          ],
          temperature: 0.4,
          top_p: 0.9,
          max_tokens: MAX_REPLY_TOKENS,
          stream: false,
        }),
      },
      deadline,
    );
  } catch (error) {
    // A global-deadline abort is terminal for the whole request; an 8 s
    // per-attempt timeout is a transport failure the chain handles like any
    // other network error.
    if (isDeadlineFailure(error)) throw error;
    const detail = isAbortOrTimeoutError(error)
      ? `timeout after ${PER_ATTEMPT_TIMEOUT_MS} ms (per-attempt window)`
      : shortMessage(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    throw new HfLlmRequestError(detail);
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = res.statusText;
    }
    throw new HfLlmRequestError(describeHfHttpError(res.status, bodyText), res.status);
  }

  const json = (await res.json().catch(() => null)) as HfChatCompletion | null;
  const text = json?.choices?.[0]?.message?.content?.trim() ?? "";

  if (!text) {
    throw new HfLlmEmptyResponseError(`Empty response from ${model} (no usable choice text).`);
  }
  return text;
}

/**
 * Strict Step 2 (PRIMARY text model): concise Arabic text response formatting via
 * the Hugging Face Inference Providers router, starting at
 * {@link HF_LLM_MODELS Qwen/Qwen3-4B-Instruct-2507} and walking the remaining
 * open, non-gated ids.
 *
 * Failure policy (task A3), applied to EVERY round-trip:
 *
 *   • 401 / 402 / 429 / 5xx — log ONLY the status and a short, redacted message,
 *     then fall through to the next provider (the next model id, which the
 *     router resolves to a different inference provider). A 402 additionally
 *     trips {@link hfCreditCircuit}: no model id can fix an empty account, so
 *     the WHOLE Hugging Face chain is skipped, in memory, for 10 minutes and
 *     the request goes straight to Gemini.
 *   • 404 / `model_not_supported` / gated 403 / empty choices — the model id is
 *     unusable, so walk the chain exactly as before.
 *   • network error or the 8 s per-attempt timeout — fall through to Gemini
 *     (the next provider in the pipeline).
 *   • the global 60 s deadline — propagate, so the route answers 503.
 *
 * Any failure eventually throws an "LLM Error:" that the handler turns into the
 * Gemini fallback and then the built-in formatter, so a Step 2 outage never
 * breaks the response. Never called without a token (the handler skips the
 * stage synchronously), and the token is never logged or echoed.
 */
async function askHfLlmStrict(
  apiKey: string,
  userContent: string,
  history: AssistantHistoryTurn[] = [],
  deadline: RequestDeadline = new RequestDeadline(),
): Promise<string> {
  const failures: string[] = [];

  // Circuit breaker: a 402 seen by an earlier request in this process parks the
  // whole chain for 10 minutes instead of re-paying the same discovery cost.
  if (hfCreditCircuit.isOpen) {
    const detail = `Hugging Face skipped for another ${Math.ceil(hfCreditCircuit.remainingMs / 1000)} s (HTTP 402 — credits exhausted).`;
    console.warn(`[Step 2: HF LLM Skipped] ${detail}`);
    throw new Error(`LLM Error: ${detail}`);
  }

  for (const [index, model] of HF_LLM_MODELS.entries()) {
    if (deadline.remainingMs <= MIN_STAGE_BUDGET_MS) {
      throw new DeadlineExceededError(
        `only ${Math.max(0, deadline.remainingMs)} ms left before the 60 s deadline`,
      );
    }

    const nextModel = index < HF_LLM_MODELS.length - 1 ? HF_LLM_MODELS[index + 1] : null;

    try {
      const text = await generateWithHfLlmModel(model, userContent, apiKey, history, deadline);

      console.log(
        `[Step 2: HF LLM Success] model=${model} replyLength=${text.length}`,
      );
      return text;
    } catch (error) {
      // The 60 s deadline is terminal — never degrade it into a warning.
      if (isDeadlineFailure(error)) throw error;

      const status = error instanceof HfLlmRequestError ? error.status : undefined;
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${model}: ${detail}`);

      // 401: the token itself is rejected — a different model id cannot help.
      if (status === 401) {
        const summary = `HTTP 401 — Hugging Face token rejected (${shortMessage(detail)}); falling through to Gemini.`;
        console.error(`[Step 2: HF LLM Error] ${summary}`);
        throw new Error(`LLM Error: ${summary}`);
      }

      // 402: account-level, model-independent → trip the 10-minute circuit.
      if (status === 402) {
        hfCreditCircuit.trip();
        const summary = `HTTP 402 — Hugging Face credits exhausted (${shortMessage(detail)}); skipping Hugging Face for ${Math.round(HF_CREDITS_SKIP_MS / 60000)} min.`;
        console.error(`[Step 2: HF LLM Error] ${summary}`);
        throw new Error(`LLM Error: ${summary}`);
      }

      // 429 / 5xx: a provider-level failure — log status + short message and
      // try the NEXT provider in the chain.
      const providerLevel = status === 429 || (status !== undefined && status >= 500);
      if (providerLevel) {
        const summary = `HTTP ${status} — ${shortMessage(detail)}`;
        if (nextModel) {
          console.warn(`[Step 2: HF LLM Provider Fallback] ${model}: ${summary} — retrying with ${nextModel}`);
          continue;
        }
        console.error(`[Step 2: HF LLM Error] ${model}: ${summary} — no provider left in the chain.`);
        throw new Error(`LLM Error: ${model}: ${summary}`);
      }

      // Model-level failure (404 / not supported / gated / empty choices):
      // walk the chain; on the LAST id let the loop end so the summary below
      // reports every id that was tried.
      if (isHfLlmModelAvailabilityError(error)) {
        if (nextModel) {
          console.warn(`[Step 2: HF LLM Fallback] ${shortMessage(detail)} — retrying with ${nextModel}`);
          continue;
        }
        break;
      }

      // Network/timeout or the last model of the chain: fail the stage.
      const wrapped = new Error(`LLM Error: ${shortMessage(detail)}`);
      console.error(`[Step 2: HF LLM Error] ${wrapped.message}`);
      throw wrapped;
    }
  }

  // Every id in the chain hit a model-level failure — report all of them so the
  // operator can tell "HF dropped this model" from "this key lacks access".
  const wrapped = new Error(
    `LLM Error: no HF LLM model could answer (tried ${HF_LLM_MODELS.join(", ")}) — ${failures.join(" | ")}`,
  );
  console.error(`[Step 2: HF LLM Error] ${shortMessage(wrapped.message, 600)}`);
  throw wrapped;
}

/* ------------------------------------------------------------------ */
/*  STEP 2 output validation — (b) malformed and (c) off-analysis        */
/* ------------------------------------------------------------------ */

/**
 * Normalise a text-model reply for comparison: case-fold, strip Arabic
 * diacritics/tatweel, fold alef/ta-marbuta/alef-maksura variants, and drop
 * everything that is not a letter or digit.
 */
function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The terms a reply must be grounded in: the disease, the crop, the affected
 * parts and the observed symptoms — i.e. everything the image model actually
 * asserted. Multi-word names are kept whole, and a name made only of very
 * short/stop words is dropped so it cannot accidentally match everything.
 */
function analysisKeyTerms(analysis: AnalysisData): string[] {
  const terms = [
    analysis.disease_name,
    analysis.plant_type,
    ...analysis.affected_parts,
    ...analysis.symptoms_observed,
  ]
    .map((term) => normalizeForMatch(term ?? ""))
    .filter((term) => term.length > 0);

  return [...new Set(terms)].filter(
    (term) => term.length >= 3 && !STOP_TERMS.has(term),
  );
}

/** Terms too generic to prove a reply is about *this* analysis. */
const STOP_TERMS: ReadonlySet<string> = new Set([
  "نبتة",
  "الورقة",
  "الاوراق",
  "المريض",
  "المرض",
  "الاصابة",
  "الاصابات",
]);

/**
 * Detect the classic small-model degeneration: the same short phrase emitted
 * over and over ("نعم نعم نعم" / "asdf asdf asdf"). Returns true when some
 * 1–3 word unit fills at least three consecutive positions and covers most
 * of the reply.
 */
function looksLikeRepetitionLoop(reply: string): boolean {
  const words = normalizeForMatch(reply).split(" ").filter(Boolean);
  if (words.length < 6) return false;

  for (const size of [1, 2, 3]) {
    for (let start = 0; start + size * 3 <= words.length; start += 1) {
      const unit = words.slice(start, start + size).join(" ");
      if (!unit) continue;
      let run = 0;
      for (let i = start; i + size <= words.length; i += size) {
        if (words.slice(i, i + size).join(" ") === unit) run += 1;
        else break;
      }
      if (run >= 3 && run * size >= words.length * 0.6) return true;
    }
  }
  return false;
}

/** Raised when a text model answered but its reply is not usable. */
class TextStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextStageError";
  }
}

/**
 * Reject a Step-2 / Step-3 reply that cannot be shown to the farmer, per the
 * orchestrator's text-stage failure rules:
 *
 *   (b) empty, malformed, or nonsensical output — an empty/whitespace reply,
 *       one carrying no letters or digits at all (a lone emoji, "…", a
 *       truncated token), or a small-model repetition loop;
 *   (c) output that does not correspond to ANALYSIS_DATA — when the analysis
 *       asserted a DISEASE, the reply must actually be about it. Grounding is
 *       checked on NORMALISED text, so rephrasing "اللفحة المتأخرة" as "اللفحة
 *       المتأخرة على الطماطم" still passes while a hallucinated answer about an
 *       unrelated crop does not.
 *
 * Two deliberate design choices keep this from firing on good answers:
 *   • there is NO length threshold — a short answer to a short question is a
 *     perfectly good answer, and the fallbacks are graceful enough that a
 *     false rejection only costs a round-trip;
 *   • grounding is skipped for a HEALTHY verdict. "No disease found" is not a
 *     claim the text has to echo back, and a reassuring reply ("النبتة سليمة،
 *     اسقِ عند القاعدة") that never names the crop is exactly what we want.
 *     The check therefore only runs where hallucination actually matters: a
 *     named disease the reply is expected to talk about.
 */
function assertUsableTextReply(reply: string, analysis: AnalysisData | null): string {
  const trimmed = reply.trim();

  if (!trimmed) {
    throw new TextStageError("the text model returned an empty reply");
  }
  // No letters or digits at all — punctuation, emoji or a truncated token.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    throw new TextStageError("the text model returned no words (punctuation/emoji only)");
  }
  if (looksLikeRepetitionLoop(trimmed)) {
    throw new TextStageError("the text model returned a degenerate repetition loop");
  }

  if (analysis?.disease_detected) {
    const terms = analysisKeyTerms(analysis);
    if (terms.length > 0) {
      const normalizedReply = normalizeForMatch(trimmed);
      if (!terms.some((term) => normalizedReply.includes(term))) {
        throw new TextStageError(
          `the reply does not correspond to the image analysis (none of: ${terms.slice(0, 4).join(", ")})`,
        );
      }
    }
  }

  return trimmed;
}

/* ------------------------------------------------------------------ */
/*  Built-in direct formatter — the zero-failure safety net             */
/* ------------------------------------------------------------------ */

/** Practical treatment + prevention lines for the built-in formatter. */
interface DirectAdvice {
  treatment: string[];
  prevention: string[];
}

/**
 * Disease-family advice for the direct formatter, matched against the raw
 * PlantVillage label. Ordered most specific first; {@link DIRECT_GENERAL_ADVICE}
 * covers anything unmatched. Same brevity contract as the LLM system prompt:
 * short actionable bullets, products available in the Algerian market, safety
 * and pre-harvest interval reminders.
 */
const DIRECT_ADVICE_BY_DISEASE: readonly { match: RegExp; advice: DirectAdvice }[] = [
  {
    // Viruses (mosaic, yellow leaf curl, greening…) — no cure: remove + fight vectors.
    match: /virus|mosaic|yellow[ _]?leaf[ _]?curl|haunglongbing|greening/i,
    advice: {
      treatment: [
        "لا علاج للفيروسات: اقتلع النباتات المصابة وتخلص منها خارج الحقل فوراً.",
        "كافح الحشرات الناقلة (المنّ، الذبابة البيضاء) بمبيد حشري معتمد أو مصائد لاصقة صفراء.",
      ],
      prevention: [
        "استعمل بذوراً وشتلات سليمة ومعتمدة.",
        "أغطية شبكية مضادة للحشرات ونظافة الحقل من الأعشاب الضيفة.",
      ],
    },
  },
  {
    // Spider mites.
    match: /spider[ _]?mite|two[ _]?spotted/i,
    advice: {
      treatment: [
        "رشّ مبيد أكاروسي معتمد (أبامكتين أو سبيروميسيفن) على وجهي الورقة.",
        "أزل الأوراق شديدة الإصابة.",
      ],
      prevention: [
        "قلّل الغبار على الأوراق — الأكاروس ينتشر في الجو الجاف.",
        "فحص دوري للأسطح السفلية للأوراق.",
      ],
    },
  },
  {
    // Bacterial diseases (bacterial spot/speck…).
    match: /bacterial/i,
    advice: {
      treatment: [
        "رشّ مبيد نحاسي بالجرعة المسجلة وأوقف السقي العلوي فوراً.",
        "أزل النباتات والأوراق شديدة الإصابة وتجنب لمس السليمة بعدها.",
      ],
      prevention: [
        "بذور معقمة ومعتمدة وتناوب زراعي لموسمين مع محصول غير عائلي.",
        "لا تعمل بين النباتات وهي مبللة.",
      ],
    },
  },
  {
    // Mildews (powdery / downy).
    match: /mildew/i,
    advice: {
      treatment: [
        "عالج بمبيد فطري معتمد (كبريت ميكروني للبياض الدقيقي، أو ميتالاكسيل-م / مانكوزيب للزغبي) حسب الجرعة المسجلة وفترة الأمان قبل الجني.",
        "أزل الأجزاء شديدة الإصابة.",
      ],
      prevention: [
        "حسّن التهوية وقلّل الرطوبة حول الأوراق وتجنب التسميد الآزوتي المفرط.",
        "سقي صباحي عند القاعدة فقط.",
      ],
    },
  },
  {
    // Rusts.
    match: /rust/i,
    advice: {
      treatment: [
        "عالج بمبيد فطري (مانكوزيب أو تريبازول) وفق الجرعة المسجلة مع احترام فترة الأمان قبل الجني.",
        "أزل الأوراق شديدة الإصابة.",
      ],
      prevention: [
        "تناوب زراعي وتباعد كافٍ بين الصفوف لتهوية الأوراق.",
      ],
    },
  },
  {
    // Leaf spots (septoria, cercospora, target spot…).
    match: /septoria|leaf[ _]?spot|cercospora|target[ _]?spot|gray[ _]?leaf/i,
    advice: {
      treatment: [
        "عالج بمبيد فطري (كلوروثالونيل أو مانكوزيب) كل 7–10 أيام حسب شدة الإصابة.",
        "أزل الأوراق السفلية المصابة.",
      ],
      prevention: [
        "نظافة الحقل من بقايا المحصول السابق وتناوب زراعي.",
        "سقي عند القاعدة وتجنب بلل الأوراق.",
      ],
    },
  },
  {
    // Blights (early / late / northern…).
    match: /blight/i,
    advice: {
      treatment: [
        "أزل الأوراق المصابة فوراً وتخلص منها خارج الحقل.",
        "عالج بمبيد نحاسي أو مانكوزيب حسب الجرعة المسجلة مع احترام فترة الأمان قبل الجني.",
        "أوقف السقي العلوي؛ اسقِ عند القاعدة صباحاً.",
      ],
      prevention: [
        "تناوب زراعي مع محصول غير عائلي لموسمين.",
        "تباعد كافٍ بين النباتات للتهوية.",
      ],
    },
  },
  {
    // Rots, scabs, molds, leaf scorch.
    match: /rot|scab|mold|leaf[ _]?scorch|esca|measles/i,
    advice: {
      treatment: [
        "أزل الأجزاء المصابة وعالج بمبيد فطري نحاسي أو معتمد حسب الجرعة المسجلة.",
        "قلّل الجروح والرطوبة العالية حول الثمار والأوراق.",
      ],
      prevention: [
        "تناوب زراعي ونظافة الحقل وتصريف جيد للمياه.",
      ],
    },
  },
];

/** Used when the label matches none of the disease families above. */
const DIRECT_GENERAL_ADVICE: DirectAdvice = {
  treatment: [
    "أزل الأجزاء المصابة وتخلص منها خارج الحقل.",
    "استشر مهندساً زراعياً محلياً لاختيار المبيد المناسب والجرعة الآمنة وفترة الأمان قبل الجني.",
  ],
  prevention: [
    "تناوب زراعي ونظافة الحقل من بقايا المحصول.",
    "سقي صباحي عند القاعدة مع تهوية جيدة بين النباتات.",
  ],
};

/**
 * Family advice for a verdict, whichever image model produced it.
 *
 * The matcher keys off the raw PlantVillage label ("late blight", …), so a
 * MobileNetV2 verdict matches directly. A Gemini verdict already carries an
 * Arabic name, which is mapped back to its English family first — otherwise
 * the primary image model would silently lose all disease-specific advice and
 * fall back to the generic plan.
 */
function adviceForLabel(label: string): DirectAdvice {
  const direct = DIRECT_ADVICE_BY_DISEASE.find((entry) => entry.match.test(label));
  if (direct) return direct.advice;

  const family = diseaseFamilyForArabic(label);
  if (family) {
    const viaFamily = DIRECT_ADVICE_BY_DISEASE.find((entry) => entry.match.test(family));
    if (viaFamily) return viaFamily.advice;
  }

  return DIRECT_GENERAL_ADVICE;
}

/**
 * Zero-failure safety net: builds a clean, concise Arabic Markdown
 * diagnosis card directly from the Step 1 label + confidence, with practical
 * general advice. Used ONLY when the image analysis succeeded but both text
 * models failed or are unavailable — the request then answers 200 with
 * `{ source: "direct" }` instead of a 500.
 */
function buildDirectDiagnosisCard(diagnosis: AssistantDiagnosis): string {
  const alternates = diagnosis.candidates
    .slice(1)
    .map((c) => parsePlantLabel(c.label).labelAr)
    .join("، ");

  if (diagnosis.healthy) {
    const lines = [
      "- **يبدو أن النبتة سليمة**.",
      diagnosis.confidence < 0.45
        ? "- النتيجة أولية: أرسل صورة أوضح (ورقة كاملة، إضاءة نهارية) للتأكيد."
        : "",
      alternates ? `- احتمالات أخرى: ${alternates}` : "",
    ].filter(Boolean);
    return [
      `## 🔬 التشخيص\n${lines.join("\n")}`,
      "## 🛡️ وقاية\n- سقي صباحي منتظم عند القاعدة دون بلل الأوراق.\n- تسميد متوازن ومراقبة الأوراق الجديدة أسبوعياً.",
      "## 📅 متابعة موصى بها\n- فحص أسبوعي للأوراق السفلية والبراعم؛ عند أول بقعة أرسل صورة واضحة للتشخيص المبكر.",
    ].join("\n\n");
  }

  // Reuse the vision engine's own plan when the verdict carried one (the
  // optional enrichment fields) — the direct card then carries exactly the
  // findings the LLM stages receive, in the same voice; on the streamlined
  // MobileNetV2 pipeline these fields are unset, so the built-in
  // disease-family advice applies.
  const fallbackAdvice = adviceForLabel(diagnosis.label);
  const advice: DirectAdvice = {
    treatment:
      diagnosis.treatment && diagnosis.treatment.length > 0
        ? diagnosis.treatment
        : fallbackAdvice.treatment,
    prevention:
      diagnosis.prevention && diagnosis.prevention.length > 0
        ? diagnosis.prevention
        : fallbackAdvice.prevention,
  };
  const lowConfidence = diagnosis.confidence < 0.45;
  const lines = [
    `- الإصابة المحتملة: **${diagnosis.labelAr}**`,
    diagnosis.severity ? `- درجة الخطورة: ${diagnosis.severity}` : "",
    alternates ? `- تشخيصات بديلة محتملة: ${alternates}` : "",
    lowConfidence
      ? "- النتيجة أولية: أرسل صورة أوضح (ورقة كاملة، إضاءة نهارية) للتأكيد قبل المعالجة."
      : "",
  ].filter(Boolean);

  return [
    `## 🔬 التشخيص\n${lines.join("\n")}`,
    `## 💊 خطة العلاج\n${advice.treatment.map((line) => `- ${line}`).join("\n")}`,
    `## 🛡️ الوقاية مستقبلاً\n${advice.prevention.map((line) => `- ${line}`).join("\n")}`,
    "## 📅 متابعة موصى بها\n- راقب تطور الأعراض كل 3–5 أيام؛ إن انتشرت رغم العلاج، استشر مهندساً زراعياً محلياً.",
  ].join("\n\n");
}

/* ------------------------------------------------------------------ */
/*  Built-in formatter (text-only) — basic-mode replies (ZERO-FAILURE)   */
/* ------------------------------------------------------------------ */

/**
 * Normalize a short user message for greeting detection: lowercase, strip
 * Arabic diacritics/tatweel, fold alef/ta-marbuta/alef-maksura variants and
 * drop punctuation so "هلا"،" "السلامُ عليكم" and "أهلا!" all compare equal
 * to their plain forms.
 */
function normalizeForGreeting(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640\u0670]/g, "") // harakat, tatweel, dagger alef
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Plain (already normalized) greetings the assistant answers warmly. */
const GREETINGS: readonly string[] = [
  "هلا",
  "هلا والله",
  "يا هلا",
  "يا هلا والله",
  "مرحبا",
  "مرحبا بك",
  "مرحبا بيك",
  "اهلا",
  "اهلا وسهلا",
  "اهلا بيك",
  "السلام",
  "السلام عليكم",
  "سلام",
  "سلام عليكم",
  "صباح الخير",
  "مساء الخير",
  "هاي",
  "hi",
  "hello",
  "hey",
  "good morning",
  "good evening",
  "bonjour",
  "bonsoir",
  "salut",
];

/** Max normalized length still considered "just a greeting". */
const MAX_GREETING_CHARS = 40;

/** True when the whole (short) message is a greeting, optionally extended. */
function isGreetingMessage(message: string): boolean {
  const normalized = normalizeForGreeting(message);
  if (!normalized || normalized.length > MAX_GREETING_CHARS) return false;
  return GREETINGS.some(
    (greeting) => normalized === greeting || normalized.startsWith(`${greeting} `),
  );
}

/**
 * Friendly basic-mode text reply used when the whole text chain (Step 2
 * Hugging Face + Step 3 Gemini) is unavailable on a request without a usable
 * diagnosis. Greets back simple salutations ("هلا"، "مرحبا"، "السلام عليكم"…)
 * and asks how to help with the farm; otherwise explains the basic mode and
 * invites crop symptoms or a leaf photo (which Step 1 + the direct formatter
 * can still handle without the LLM).
 */
function buildTextFallbackReply(message: string): string {
  if (isGreetingMessage(message)) {
    const isSalam = /سلام/.test(normalizeForGreeting(message));
    return [
      isSalam ? "وعليكم السلام ورحمة الله وبركاته 👋" : "أهلاً وسهلاً بيك 👋",
      `مرحبا بيك في **محصولي الذكي** — مستشارك الزراعي. كيف نقدر نساعدك اليوم في ضيعتك؟`,
      "- اسألني عن السقي، التسميد، أو مكافحة الآفات والأمراض.",
      "- أو أرفق صورة ورقة النبتة المريضة لتشخيص فوري مع خطة علاج.",
    ].join("\n");
  }
  return [
    "المستشار الذكي يعمل حالياً في **الوضع الأساسي** — خدمة النصوص الذكية غير متاحة مؤقتاً.",
    "مع ذلك نقدر نعاونك:",
    "- صف لي أعراض محصولك: نوع النبتة، شكل البقع أو الاصفرار، الولاية، وآخر معالجة.",
    "- أو أرفق صورة واضحة لورقة مصابة — سأشخّصها وأقدّم خطة علاج مباشرة حتى في الوضع الأساسي.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Handler — the fail-proof orchestrator + built-in formatter          */
/* ------------------------------------------------------------------ */

/**
 * Fail-proof pipeline body. Every upstream stage is non-fatal:
 * - Step 1 (image analysis): Gemini first, MobileNetV2 only after it fails.
 *   When BOTH fail on a photo request → Step 4 replies with the pre-written
 *   retake message and no text model is called at all.
 * - Step 2 (Hugging Face, the PRIMARY text model) failure, timeout, a
 *   rejected reply, or a missing `HUGGINGFACE_API_KEY` → warning, fall
 *   through to Step 3.
 * - Step 3 (Gemini, format-only) failure or a missing `GEMINI_API_KEY` →
 *   warning, answer 200 from the built-in formatters: a diagnosis card when
 *   Step 1 produced an analysis, a friendly basic-mode reply otherwise.
 * - A text-only request has no image stage at all and runs Steps 2 → 3 →
 *   built-in formatter.
 * - The only non-200 responses left are client input errors (400/413), the
 *   explicit server misconfiguration signal (503 + MISSING_KEYS, emitted only
 *   when NEITHER provider key is configured) and the 60 s deadline stop
 *   (503 + DEADLINE_EXCEEDED, Arabic "service is busy" message) — never an
 *   HTTP 500.
 *
 * The handler owns the ONE {@link RequestDeadline} (60 s) and hands it to every
 * stage; a `DeadlineExceededError` from anywhere below unwinds to the 503
 * branch, and `dispose()` always runs so no timer outlives the response.
 */
async function handleAssistant(request: NextRequest): Promise<NextResponse> {
  let body: AssistantRequestBody;
  try {
    body = (await request.json()) as AssistantRequestBody;
  } catch {
    return bad("Invalid JSON body.");
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const context = body.context && typeof body.context === "object" ? body.context : undefined;
  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          (turn): turn is AssistantHistoryTurn =>
            Boolean(turn) &&
            (turn.role === "user" || turn.role === "assistant") &&
            typeof turn.content === "string" &&
            turn.content.trim().length > 0,
        )
        .slice(-10)
    : [];
  const isFirstTurn = history.length === 0;
  const image = body.image;

  if (message.length > MAX_MESSAGE_CHARS) {
    return bad("Message too long.");
  }
  if (image) {
    if (
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string" ||
      !/^image\//.test(image.mimeType)
    ) {
      return bad("Invalid image payload.");
    }
    if (image.data.length > MAX_IMAGE_B64_CHARS) {
      return bad("Image too large (max ~4 MB).", 413);
    }
  }
  if (!message && !image) {
    return bad("Provide a message and/or an image.");
  }

  // Server-only secrets — never exposed to the client bundle. Read on every
  // request (never at module load) so a rotated/added key is picked up without
  // a restart.
  //   GEMINI_API_KEY_4      → the priority key: FIRST in the draw when the
  //                           user picked a model explicitly (usually a
  //                           different Google project, hence its own quota).
  //   GEMINI_API_KEY        → next in rotation; comma-separated values pool.
  //   GEMINI_API_KEY_N      → numbered variants (`_1`, `_2`, …) in numeric
  //                           order after the base variable.
  //   GEMINI_API_KEYS       → LEGACY comma pool, appended last.
  //                           Deps 1–4 feed `resolveGeminiKeyPool()`, which
  //                           trims, dedupes and orders them; the draw is then
  //                           shuffled per request, and `GEMINI_API_KEY_4` is
  //                           moved to the head when the request carries a
  //                           manual model choice. Per model every
  //                           key is tried, a 429 parks that (key, model) pair
  //                           for 10 minutes, a 400 API_KEY_INVALID / 403
  //                           parks the key for 60 minutes, and 503/network
  //                           retries the same key once before rotating.
  //   HUGGINGFACE_API_KEY   → Step 1 FALLBACK image model (MobileNetV2) +
  //                           Step 2 text model. ONE variable name: there is
  //                           no HF_TOKEN alias and no fallback. Read ONLY
  //                           while ENABLE_HUGGINGFACE is on — with the flag
  //                           off the token is not even resolved and every
  //                           Hugging Face stage is bypassed.
  // Hugging Face is soft-blocked by default (ENABLE_HUGGINGFACE = false): the
  // pipeline is Gemini-only. Flip the constant (or set ENABLE_HUGGINGFACE=1)
  // to restore the previous Hugging Face stages — the code is untouched.
  const hfEnabled = isHuggingFaceEnabled();

  // The chat's model selector: an unknown/absent value is ignored (the request
  // runs on the default chain), a recognised one pins the chain head — the
  // request goes STRAIGHT to that model, and `GEMINI_API_KEY_4` leads the key
  // draw so the freshest quota answers the explicit choice.
  const modelChoice: PhytoModelChoice | null = resolveRequestedModel(body.model);
  // Rotation order is a random draw per request: every configured key is in
  // the draw, no key repeats inside one cycle.
  const geminiApiKeys = resolveGeminiApiKeys(modelChoice !== null);
  const huggingfaceKey = hfEnabled ? resolveHuggingFaceToken() : null;
  // The log line prints the STABLE inventory order (names only), not the draw.
  logGeminiKeyConfiguration(resolveGeminiKeyPool(), hfEnabled);
  if (modelChoice) {
    const prioritized = geminiApiKeys[0]?.name === GEMINI_PRIORITY_KEY_NAME;
    console.log(
      `[Model Selector] requested ${modelChoice.label} → ${modelChoice.model} ` +
        `(${geminiApiKeys.length} key(s) in rotation${prioritized ? `, ${GEMINI_PRIORITY_KEY_NAME} first` : ""}).`,
    );
  }

  if (geminiApiKeys.length === 0 && !huggingfaceKey) {
    // Explicit misconfiguration signal (503 Service Unavailable — the route
    // contract no longer includes any HTTP 500). The UI shows its dedicated
    // "assistant unavailable" notice for code MISSING_KEYS. With either key
    // present the route still answers: the stages below degrade gracefully.
    return NextResponse.json(
      { error: "API keys missing on server", code: "MISSING_KEYS" },
      { status: 503 },
    );
  }

  const warnings: string[] = [];
  /** Answer language, resolved once and shared by every stage. */
  const lang: "ar" | "fr" = context?.lang === "fr" ? "fr" : "ar";
  /**
   * The ONE 60 s ceiling for everything below: the image analysis, the Gemini
   * text model and (while enabled) the Hugging Face stages. Every attempt also
   * carries its own 8 s window, so no single provider can spend the budget.
   */
  const deadline = new RequestDeadline();

  try {
  // ---- LEAF CROPPING: REMOVED ---------------------------------------
  // The Step 0 "Detection & Cropping" pre-step (DETR-ResNet-50 + sharp) is
  // gone from the pipeline: no detector round-trip, no crop, no image
  // re-encode. The ORIGINAL frame is what every remaining stage sees, which
  // is what Gemini — the only image model now that Hugging Face is
  // soft-blocked — always received anyway.
  //
  // `preprocessing` keeps its exact wire shape: present on IMAGE responses
  // only, with `status: "skipped"` (the stage did not run) so the stored
  // history and the client keep parsing it unchanged.
  let preprocessing: AssistantPreprocessing | null = null;
  let analysis: AnalysisResult | null = null;

  if (image) {
      preprocessing = { status: "skipped", detector: null, box: null, durationMs: 0 };
      // ---- STEP 1: IMAGE ANALYSIS (Gemini → MobileNetV2 → give up) ----
      // MobileNetV2 (the Hugging Face fallback) only participates while
      // ENABLE_HUGGINGFACE is on; with the flag off a failed Gemini analysis
      // goes straight to Step 4.
      analysis = await runImageAnalysisStage({
        geminiImage: image,
        geminiApiKeys,
        huggingfaceKey,
        hfEnabled,
        lang,
        warnings,
        deadline,
        pin: modelChoice?.model,
      });
  }

  // The image stage consumed the budget: do not start a text model with less
  // than one attempt's worth of time left.
  if (deadline.remainingMs <= MIN_STAGE_BUDGET_MS && analysis === null) {
    return serviceBusyResponse();
  }

  // ---- STEP 4: FINAL FALLBACK (both image models failed) ------------
  // The spec is explicit: no text model is ever called with empty analysis
  // data. A photo arrived, neither Gemini nor MobileNetV2 could read it, so
  // the user gets a polite, pre-written retake request — not a guess.
  if (image && analysis === null) {
    if (deadline.expired) return serviceBusyResponse();
    const reply = buildImageAnalysisUnavailableReply();
    pushWarning(warnings, "Image analysis unavailable — replied with the final-fallback message.");
    console.log(
      `[Step 4: Final Fallback] no image model could analyse the photo — ${warnings.length} degradation(s) recorded`,
    );
    const payload: AssistantResponseBody = {
      reply,
      diagnosis: null,
      source: "direct",
      ...(preprocessing ? { preprocessing } : {}),
      analysisSource: null,
      textSource: null,
      warnings,
    };
    return NextResponse.json(payload);
  }

  // One user turn for both text stages: user query + Firestore profile
  // context (Wilaya, crop type, role) + the Step 1 ANALYSIS_DATA reference
  // block. It never carries the photo — the text stage narrates structured
  // data, it does not re-analyse pixels.
  const userContent = buildUserContent(message, context, analysis?.data ?? null, isFirstTurn);

  // ---- STEP 2: Hugging Face text model (DISABLED by default) ---------
  // Only runs while ENABLE_HUGGINGFACE is on. With the flag off (shipped
  // default) the whole stage is bypassed BEFORE any request is built: Gemini
  // is the primary text model and answers through Step 3 below. The Hugging
  // Face implementation is untouched — flip the flag to restore it.
  let reply: string | null = null;
  let textSource: TextSource | null = null;
  if (!hfEnabled) {
    console.log(
      "[Step 2: HF LLM Skipped] ENABLE_HUGGINGFACE=false — Hugging Face is soft-blocked; Gemini handles the text (Step 3).",
    );
  } else if (huggingfaceKey) {
    try {
      reply = assertUsableTextReply(
        await askHfLlmStrict(huggingfaceKey, userContent, history, deadline),
        analysis?.data ?? null,
      );
      textSource = "huggingface";
      console.log(
        `[Step 2: HF LLM Success] analysis=${analysis?.source ?? "none"} replyLength=${reply.length}`,
      );
    } catch (error) {
      // The 60 s deadline is the request's hard stop, not an HF failure.
      if (isDeadlineFailure(error)) return serviceBusyResponse();
      const msg = error instanceof Error ? error.message : String(error);
      const detail = shortMessage(msg.startsWith("LLM Error:") ? msg.slice("LLM Error:".length).trim() : msg, 700);
      console.warn(`[Step 2: HF LLM Failed → Step 3] ${detail}`);
      pushWarning(warnings, `Step 2 HF text model unavailable — ${detail}`, 700);
    }
  } else {
    // Hugging Face is enabled but has no token → skip the stage synchronously
    // (no request, no throw, no timer) and let Step 3 (Gemini) answer.
    const detail =
      "HUGGINGFACE_API_KEY is not configured — skipping the Hugging Face text model.";
    console.warn(`[Step 2: HF LLM Skipped] ${detail} → Step 3 (Gemini formatter)`);
    pushWarning(warnings, `Step 2 HF text model unavailable — ${detail}`);
  }

  // ---- STEP 3: Google Gemini (PRIMARY when Hugging Face is off) ------
  // Runs when the Hugging Face stage produced nothing — which, with
  // ENABLE_HUGGINGFACE=false, is EVERY request: Gemini is the primary text
  // model. gemini-3.8-flash or the GEMINI_MODEL override (→ 3.5-flash →
  // 3.5-flash-lite → 2.5-flash → flash-latest on a retired-id 404) via the
  // Generative Language REST API, keyed with the shuffled Gemini pool and
  // bounded by the shared request deadline.
  // Gemini is a FORMATTER here: the prompt is ANALYSIS_DATA and NO image is
  // attached, so it cannot re-analyse the photo even by accident. This also
  // covers the edge case where the analysis came from MobileNetV2 and the HF
  // text model then failed.
  if (reply === null && geminiApiKeys.length > 0) {
    try {
      const geminiResult = await runGeminiWithKeyPool(
        {
          systemInstruction: SYSTEM_PROMPT,
          userContent,
          history,
        },
        geminiApiKeys,
        deadline,
        modelChoice?.model,
      );
      reply = assertUsableTextReply(geminiResult.text, analysis?.data ?? null);
      textSource = "gemini_fallback";
      // Non-fatal degradations the chain walked past (a retired id 404ing
      // before its successor answered) are still surfaced to the client.
      warnings.push(...geminiResult.warnings);
      console.log(
        `[Step 3: Gemini Formatter Success] model=${geminiResult.model} analysis=${analysis?.source ?? "none"} replyLength=${reply.length}`,
      );
    } catch (error) {
      if (isDeadlineFailure(error)) return serviceBusyResponse();
      const detail = shortMessage(error instanceof Error ? error.message : String(error), 700);
      console.warn(`[Step 3: Gemini Failed → built-in formatter] ${detail}`);
      pushWarning(warnings, `Step 3 Gemini text fallback unavailable — ${detail}`, 700);
    }
  } else if (reply === null) {
    const detail = "No GEMINI_API_KEY is configured — skipping the text fallback.";
    console.warn(`[Step 3: Gemini Skipped] ${detail} → built-in formatter`);
    pushWarning(warnings, `Step 3 Gemini text fallback unavailable — ${detail}`);
  }

  if (reply !== null) {
    console.log(
      `[Orchestrator] analysisSource=${analysis?.source ?? "none"} textSource=${textSource}`,
    );
    const payload: AssistantResponseBody = {
      reply,
      diagnosis: analysis?.diagnosis ?? null,
      source: analysis ? "hybrid" : "llm",
      ...(preprocessing ? { preprocessing } : {}),
      analysisSource: analysis?.source ?? null,
      textSource,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return NextResponse.json(payload);
  }

  // ---- BUILT-IN FORMATTER (both text models down, ZERO-FAILURE) ------
  // Reachable only for a request that already has ANALYSIS_DATA (an image
  // request cannot get here: the Step 4 branch above returns first) or for a
  // text-only question. A request whose budget ran out is answered 503 here
  // instead of pretending a text model is merely down.
  if (deadline.expired) return serviceBusyResponse();
  let directReply: string;
  if (analysis) {
    directReply = buildDirectDiagnosisCard(analysis.diagnosis);
  } else {
    directReply = buildTextFallbackReply(message);
  }
  pushWarning(warnings, "Reply formatted locally — no upstream AI stage was available.");

  const payload: AssistantResponseBody = {
    reply: directReply,
    diagnosis: analysis?.diagnosis ?? null,
    source: "direct",
    ...(preprocessing ? { preprocessing } : {}),
    analysisSource: analysis?.source ?? null,
    textSource: null,
    warnings,
  };
  return NextResponse.json(payload);
  } catch (error) {
    // The 60 s ceiling fired inside ANY stage (either image
    // model, the HF chain or the Gemini chain): stop everything and answer 503
    // with the Arabic "service is busy" message. Any other exception keeps
    // travelling to the outer safety net.
    if (isDeadlineFailure(error)) return serviceBusyResponse();
    throw error;
  } finally {
    // Always disarm the deadline timer — on success, on 4xx and on the 503
    // path. An armed timer would keep the serverless invocation alive past the
    // response; disposing here is what guarantees the 60 s ceiling is the LAST
    // thing that can happen, never a leaked callback.
    deadline.dispose();
  }
}

/**
 * Route entrypoint wrapped in the final safety net: even an unexpected
 * internal exception (a bug, a serialization failure…) is converted into a
 * 200 basic-mode reply, so `/api/assistant` NEVER returns HTTP 500.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    return await handleAssistant(request);
  } catch (error) {
    // A deadline that escaped a stage boundary (defensive: every stage already
    // converts it) still answers the Arabic "service is busy" 503 — never a 500.
    if (isDeadlineFailure(error)) return serviceBusyResponse();
    const detail = shortMessage(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    console.error(`[Safety Net] Unexpected handler exception → basic-mode reply: ${detail}`);
    return NextResponse.json({
      reply: buildTextFallbackReply(""),
      diagnosis: null,
      source: "direct",
      warnings: [shortMessage(`Unexpected internal error — reply formatted locally: ${detail}`, 400)],
    } satisfies AssistantResponseBody);
  }
}

