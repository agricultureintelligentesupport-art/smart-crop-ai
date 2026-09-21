/**
 * `/api/assistant` — fail-proof 3-stage resilient AI chain for the
 * agricultural assistant. The route NEVER returns HTTP 500.
 *
 * Pipeline (Google Gemini first, Hugging Face fallback, built-in formatter
 * last — a vision pre-step feeds both LLM stages):
 *
 *   Step 1 (when an image is attached): Hugging Face Inference API
 *     MobileNetV2 PlantVillage disease classifier → parse returned array to
 *     extract primary predicted disease class + confidence percentage +
 *     candidate diseases.
 *     Handles 503/530 model-loading responses with a clear status message.
 *     Non-fatal: a vision outage is recorded in `warnings[]` and the request
 *     continues through Stage 1 → 2 → 3 without a diagnosis.
 *
 *   Stage 1 — Google Gemini (`gemini-3.5-flash` → `gemini-3.5-flash-lite` →
 *     `gemini-2.5-flash`) — PRIMARY LLM: REST call to
 *     https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=$GEMINI_API_KEY
 *     authenticated with the server-only `GEMINI_API_KEY` and guarded by one
 *     shared 9 s `AbortController` deadline for the whole model chain (the
 *     mandated 8–10 s window). Google retires model generations on a fast
 *     cadence — the 1.5 family shut down Sep 2025 and the 2.0 flash family
 *     Jun 2026, and both now answer 404 "is not found for API version
 *     v1beta" — so the model ids form a chain: a 404 / model-not-found
 *     walks to the next id within the remaining budget, while key/quota/5xx/
 *     safety/network/timeout failures fail the stage immediately (another
 *     model id can't fix them). Each generation receives its own
 *     `thinkingConfig` — Gemini 3.x models take `thinkingLevel: "low"` and
 *     reject a numeric `thinkingBudget`, Gemini 2.5 takes
 *     `thinkingBudget: 0` and rejects `thinkingLevel` (the wrong parameter
 *     is a 400, so the payload is model-aware).
 *     The expert system instruction ("أنت مساعد زراعي خبير…") is sent as
 *     `systemInstruction`; the user turn carries the user query, the Firestore
 *     profile context (Wilaya, crop, role…) and — whenever Step 1 produced one
 *     — the MobileNet vision diagnosis (disease label, confidence score and
 *     candidate diseases).
 *     Success → HTTP 200 `{ source: "llm" }` (promoted to `"hybrid"` when the
 *     answer ships together with a Step 1 diagnosis) carrying Gemini's
 *     generated Arabic reply.
 *
 *   Stage 2 (Gemini failed / timed out / `GEMINI_API_KEY` missing): Hugging
 *     Face Inference API LLM chat completion for concise text response
 *     formatting — active serverless-catalog, open, non-gated models only:
 *     `meta-llama/Llama-3.2-3B-Instruct` primary, then
 *     `Qwen/Qwen2.5-7B-Instruct` and `mistralai/Mistral-7B-Instruct-v0.3`.
 *     The previous generation ids (Qwen2.5-Coder-7B, zephyr-7b-beta,
 *     Xenova-Qwen1.5-0.5B) were dropped from the `hf-inference` provider
 *     catalog and 400 with "Model not supported by provider hf-inference";
 *     the gated large Llama releases (3.1/3.3 70B+) are still avoided
 *     because they 403 with a license-acceptance error on tokens that never
 *     accepted their terms. Availability failures (`404 — Model not found`,
 *     `400 — Model not supported by provider hf-inference`, gated 403s,
 *     empty choices) walk the chain and fail gracefully into Stage 3.
 *     The same system prompt, the same user query and the same Step 1 vision
 *     context are fed into the LLM behind a system prompt that enforces a
 *     concise, highly professional, direct and practical Arabic answer
 *     ("أنت مساعد زراعي خبير…") with no small talk, no filler introductions
 *     and no long summaries.
 *
 *   Stage 3 (both LLM stages down — zero-failure formatting):
 *     built-in TypeScript formatters answer 200 with `{ source: "direct" }`:
 *       • diagnosis available   → concise Arabic Markdown diagnosis card
 *                                 built from the Step 1 label + confidence;
 *       • text-only request     → friendly basic-mode Arabic reply: greets
 *                                 back simple salutations ("هلا"، "مرحبا"،
 *                                 "السلام عليكم"…) and asks how to help with
 *                                 the farm, otherwise explains the basic mode
 *                                 and invites crop symptoms or a leaf photo;
 *       • image but vision down → basic-mode reply + a "photo analysis
 *                                 unavailable, retry" note.
 *
 *   Final safety net: `POST` wraps the whole handler in a try/catch, so even
 *     an unexpected internal exception becomes a 200 basic-mode reply.
 *
 * Both server secrets (`GEMINI_API_KEY`, `HUGGINGFACE_API_KEY`) are read from
 * `process.env` on the server only — they are never shipped to the browser
 * and never echoed back in a response body.
 *
 * Status contract: 200 for every AI outcome (including all upstream
 * failures); 400/413 only for invalid client input; 503 + code MISSING_KEYS
 * when NO provider key is configured at all (the explicit
 * server-misconfiguration signal). No HTTP 500 ever.
 *
 * Error reporting: each stage logs to the server console
 * (`[Step 1: HF Success]` / `[Stage 1: Gemini Success]` /
 * `[Stage 2: HF LLM Success]` and corresponding warning logs;
 * `[Stage 1: Gemini Fallback]` / `[Stage 2: HF LLM Fallback]` mark a model
 * switch,
 * `[Step 1: HF Unavailable]` / `[Stage 1: Gemini Unavailable → Stage 2]` /
 * `[Stage 2: HF LLM Unavailable → Stage 3]` mark graceful degradation and
 * `[Safety Net]` an unexpected internal error).
 * Non-fatal degradations are surfaced to the client in `warnings[]`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { confidenceBucket, parsePlantLabel } from "@/lib/assistant/plantvillage";
import type {
  AssistantContext,
  AssistantDiagnosis,
  AssistantRequestBody,
  AssistantResponseBody,
  DiagnosisCandidate,
} from "@/lib/assistant/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Vision + LLM round-trips; give slow cold starts room on hosted platforms. */
export const maxDuration = 60;

/* ------------------------------------------------------------------ */
/*  Tunables                                                           */
/* ------------------------------------------------------------------ */

/**
 * PlantVillage classifiers on the HF Inference API, tried in order. The
 * first is a MobileNetV2 fine-tuned on the 38-class PlantVillage dataset;
 * the second is a ViT alternative kept as a warm fallback.
 */
const HF_PLANT_MODELS = [
  "linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification",
  "wambugu71/crop_leaf_diseases_vit",
] as const;

const HF_ENDPOINT = (model: string) =>
  `https://router.huggingface.co/hf-inference/models/${model}`;

/* ---- Stage 1 — Google Gemini (primary LLM) ----------------------- */

/**
 * Stage 1 model chain, in order. Google retires whole generations on a fast
 * cadence — the 1.5 family shut down Sep 2025 and the 2.0 flash family Jun
 * 2026 (both now 404 "is not found for API version v1beta"), and
 * `gemini-2.5-flash` is next in line — so a single hardcoded id is a time
 * bomb: a retired id's fast 404 walks the chain to the next id within the
 * remaining Stage-1 budget.
 *
 * `thinking` carries the per-generation `thinkingConfig`, because each
 * generation rejects the other's parameter with 400 INVALID_ARGUMENT:
 * Gemini 3.x models take a qualitative `thinkingLevel` (2.5 rejects it —
 * "Thinking level is not supported for this model"), while Gemini 2.5 takes
 * a numeric `thinkingBudget` (`0` = skip the reasoning pass, answer-first).
 */
const GEMINI_MODELS = [
  { id: "gemini-3.5-flash", thinking: { thinkingLevel: "low" } },
  { id: "gemini-3.5-flash-lite", thinking: { thinkingLevel: "low" } },
  { id: "gemini-2.5-flash", thinking: { thinkingBudget: 0 } },
] as const;

type GeminiModel = (typeof GEMINI_MODELS)[number];

/**
 * Stage 1 hard timeout for the WHOLE model chain — inside the mandated
 * 8–10 s window. Enforced with an explicit `AbortController` (not
 * `AbortSignal.timeout`) so the abort reason and the timer are both
 * inspectable/clearable per request; a fast 404 on an earlier id hands the
 * remaining budget to the next id.
 */
const GEMINI_TIMEOUT_MS = 9_000;

/**
 * Output cap for Stage 1. Slightly above {@link MAX_REPLY_TOKENS} because
 * Gemini counts any internal reasoning tokens against `maxOutputTokens`;
 * the per-model thinking config (`thinkingLevel: "low"` on Gemini 3.x,
 * `thinkingBudget: 0` on 2.5) keeps the model in fast, answer-first mode so
 * the 9 s budget is spent on the reply.
 */
const GEMINI_MAX_OUTPUT_TOKENS = 1024;

/* ---- Step 1 (vision) + Stage 2 — Hugging Face -------------------- */

/**
 * Fast open-source LLM ids tried by Stage 2, in order, via the HF Inference
 * API's OpenAI-compatible chat-completions endpoint.
 *
 * Active serverless-catalog ids only, verified against the free-tier
 * catalog: the previous generation ids (`Qwen/Qwen2.5-Coder-7B-Instruct`,
 * `HuggingFaceH4/zephyr-7b-beta`, `TiagoPires/Xenova-Qwen1.5-0.5B-Chat`)
 * were dropped from the `hf-inference` provider and answer
 * `400 — Model not supported by provider hf-inference`. The ids below serve
 * on the free `hf-inference` provider with no manual acceptance step — the
 * Llama pick is the open-weight 3B release; the gated large Llama models
 * (`meta-llama/*` 3.1/3.3 70B+) still 403 with a license-acceptance error on
 * tokens that never accepted their terms, so they stay excluded. Not-found /
 * not-supported / gated responses still walk the chain as model-availability
 * errors, and the Stage 3 direct formatter
 * ({@link buildDirectDiagnosisCard}) guarantees a useful reply even when the
 * whole chain is down.
 */
const HF_LLM_MODELS = [
  "meta-llama/Llama-3.2-3B-Instruct",
  "Qwen/Qwen2.5-7B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.3",
] as const;

const HF_CHAT_ENDPOINT = (model: string) =>
  `https://router.huggingface.co/hf-inference/models/${model}/v1/chat/completions`;

/** Hard cap on the reply — the system prompt demands brevity. */
const MAX_REPLY_TOKENS = 700;

/** ~6 MB of raw base64 ≈ 4.5 MB image — plenty for a leaf photo. */
const MAX_IMAGE_B64_CHARS = 6 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 4000;

const UPSTREAM_TIMEOUT_MS = 25_000;

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

function timedFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

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
 * Strict Step 1: classify leaf image via Hugging Face.
 * - Sends the raw image bytes to the PlantVillage model.
 * - Parses the returned array to extract the primary predicted class + confidence.
 * - Handles 503/530 model-loading responses with a clear message.
 * - Throws an Error prefixed with "HF Error:" on any failure so the caller
 *   can return `{ error: "HF Error: ..." }` with 500.
 */
async function classifyPlantImageStrict(
  imageBase64: string,
  mimeType: string,
  apiKey: string,
): Promise<AssistantDiagnosis> {
  const body = Buffer.from(imageBase64, "base64");

  let lastErrorDetail: string | null = null;
  let loadingEstimate: number | null = null;

  for (const model of HF_PLANT_MODELS) {
    try {
      const res = await timedFetch(HF_ENDPOINT(model), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": mimeType || "application/octet-stream",
          // Ask the HF router to wait for the model instead of instantly 503ing.
          "X-Wait-For-Model": "true",
        },
        body,
      });

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
        // Try next model before giving up — the fallback may be warm.
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
      const parsed = parsePlantLabel(top.label);
      const candidates: DiagnosisCandidate[] = ranked
        .slice(0, 3)
        .map(({ label, score }) => ({ label, score }));

      const diagnosis: AssistantDiagnosis = {
        label: top.label,
        labelAr: parsed.labelAr,
        cropAr: parsed.cropAr,
        diseaseAr: parsed.diseaseAr,
        healthy: parsed.healthy,
        confidence: top.score,
        model,
        candidates,
      };

      console.log(
        `[Step 1: HF Success] label=${top.label} confidence=${pct}% model=${model} candidates=${candidates.length}`,
      );
      return diagnosis;
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      // Network / timeout / abort errors
      lastErrorDetail = `${model}: ${detail}`;
      console.warn(`[Step 1: HF Warning] ${model} → ${detail}`);
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
/*  Shared prompting — one system prompt + user turn for BOTH LLMs      */
/*  (Stage 1 Gemini and Stage 2 Hugging Face receive identical input)   */
/* ------------------------------------------------------------------ */

/**
 * System prompt enforcing the required output style: concise, highly
 * professional, direct and practical Arabic — no friendly small talk, no
 * filler introductions and no long summaries.
 */
const SYSTEM_PROMPT = `أنت مساعد زراعي خبير داخل تطبيق "محصولي الذكي" (Smart Crop AI). قدّم تشخيصاً اختصارياً، عملياً، ومباشراً باللغة العربية دون مقدمات أو إطالة.

قواعد إلزامية:
- ادخل في صلب الموضوع فوراً: لا تحية، لا مجاملات، لا عبارات حشو، لا مقدمة، ولا خاتمة تلخيصية.
- أجب بالعربية الفصحى المبسطة دائماً، إلا إذا طُلبت الفرنسية صراحةً في سياق المستخدم.
- الجواب في نقاط قصيرة مرقمة ومباشرة، بحد أقصى ١٥٠ كلمة؛ لا فقرات إنشائية ولا عناوين طويلة.
- عند وجود تشخيص من نموذج الرؤية (PlantVillage): اعتمد عليه مباشرة، اذكر المرض بالعربية مع نسبة الثقة (مثال: Tomato___Early_blight 95%)، ثم قدّم العلاج والوقاية في نقاط عملية.
- إن كانت نسبة الثقة ضعيفة (<45%)، اطلب صورة أوضح في سطر واحد مع ذكر التشخيصات البديلة المحتملة.
- اذكر مواد وممارسات متوفرة فعلاً في السوق الجزائرية (مبيدات نحاسية، مانكوزيب، كبريت ميكروني، تناوب زراعي…) مع جرعات إرشادية مختصرة وفترة الأمان قبل الجني.
- خصّص التوصيات حسب ولاية المستخدم ومناخها ومحصوله ودوره إن وردت في السياق المرفق.
- إن كان السؤال خارج الفلاحة، أعد المحادثة بجملة واحدة نحو اختصاصك.
- لا تدّعي اليقين المطلق: في الحالات الحرجة انصح بمعاينة مهندس زراعي محلي، في سطر واحد.`;

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

function describeDiagnosis(diagnosis: AssistantDiagnosis | null): string {
  if (!diagnosis) return "";
  const pct = Math.round(diagnosis.confidence * 100);
  const bucket = confidenceBucket(diagnosis.confidence);
  const alternates = diagnosis.candidates
    .slice(1)
    .map((c) => `${parsePlantLabel(c.label).labelAr} (${Math.round(c.score * 100)}%)`)
    .join("، ");
  return [
    "نتيجة نموذج الرؤية (PlantVillage — MobileNetV2) على صورة المستخدم:",
    `- المرض المشخّص (disease label): ${diagnosis.labelAr} — التسمية الخام: ${diagnosis.label}`,
    `- درجة الثقة (confidence score): ${pct}% (${bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة"})`,
    alternates ? `- الأمراض المرشّحة البديلة (candidate diseases): ${alternates}` : "",
    diagnosis.healthy
      ? "- النموذج يرى أن النبتة سليمة؛ طمئن المستخدم وقدّم نصائح وقائية."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the single user turn shared by Stage 1 (Gemini `contents`) and
 * Stage 2 (HF `messages[1]`): Firestore profile context (Wilaya, crop, role,
 * language, name) + the Step 1 MobileNet vision diagnosis (disease label,
 * confidence score and candidate diseases) when one is available + the user's
 * own query. Keeping one builder guarantees the fallback LLM answers from
 * exactly the same context the primary was given.
 */
function buildUserContent(
  message: string,
  context: AssistantContext | undefined,
  diagnosis: AssistantDiagnosis | null,
): string {
  const sections = [
    `سياق المستخدم من ملفه الشخصي: ${describeContext(context)}`,
    describeDiagnosis(diagnosis),
    diagnosis
      ? `تشخيص PlantVillage (من Step 1 — مرّر مباشرة إلى نموذج اللغة): ${diagnosis.label} بثقة ${Math.round(diagnosis.confidence * 100)}% — ${diagnosis.labelAr}`
      : "",
    message
      ? `سؤال المستخدم: ${message}`
      : diagnosis
        ? "لم يكتب المستخدم سؤالاً — قدّم التشخيص وخطة العلاج والوقاية مباشرة بناءً على نتيجة PlantVillage أعلاه."
        : "قدّم نفسك في جملة واحدة كمساعد زراعي خبير واطلب سؤال المستخدم دون أي حشو.",
  ].filter(Boolean);
  return sections.join("\n\n");
}

/** Any Stage-1 failure; the caller degrades to Stage 2 (and then 3) either way. */
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
 * than the request: a retired or mistyped id answers
 * `404 — models/gemini-1.5-flash is not found for API version v1beta, or is
 * not supported for generateContent`. Together with an HTTP 404 these are the
 * only Stage-1 failures that walk the Gemini model chain — invalid keys
 * (400/403), quota (429), safety blocks, 5xx, network errors and the timeout
 * abort are surfaced immediately, because another model id can't fix them.
 */
const GEMINI_MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /is not found/i,
  /not supported for generateContent/i,
  /\bunknown model\b/i,
  /\bno such model\b/i,
];

/** True when the failure looks like "this Gemini model id is retired/gone". */
function isGeminiModelAvailabilityError(error: unknown): boolean {
  if (!(error instanceof GeminiError)) return false;
  if (error.status === 404) return true;
  return GEMINI_MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

/**
 * One `models.generateContent` round-trip against a single Gemini id:
 *   • `systemInstruction` — the expert Arabic advisor system prompt;
 *   • `contents[0].parts[0].text` — the user query + profile context + the
 *     Step 1 MobileNet vision diagnosis (label, confidence, candidates);
 *   • `generationConfig` — the sampling params plus the model's own
 *     `thinkingConfig` ({@link GeminiModel.thinking}).
 *
 * Throws {@link GeminiError} on every failure mode (status kept for the
 * chain-walk decision); a fetch aborted by the shared signal is reported as
 * the Stage-1 timeout.
 */
async function generateWithGeminiModel(
  model: GeminiModel,
  userContent: string,
  signal: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
          generationConfig: {
            temperature: 0.4,
            topP: 0.9,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            // Answer-first latency, per generation: Gemini 3.x →
            // thinkingLevel "low", Gemini 2.5 → thinkingBudget 0. Each
            // generation 400s the other's parameter, so spread the model's
            // own config instead of hardcoding one shape.
            thinkingConfig: { ...model.thinking },
          },
        }),
      },
    );
  } catch (error) {
    if (signal.aborted) {
      throw new GeminiError(
        `timeout after ${GEMINI_TIMEOUT_MS} ms (AbortController fired)`,
      );
    }
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new GeminiError(detail);
  }

  if (!response.ok) {
    let bodyText = "";
    try {
      // Preserve the body for the existing warning parser while logging
      // Google's exact, untruncated response on the server.
      const errorResponse = response.clone();
      console.error('[Gemini Error]', response.status, await response.text());
      bodyText = await errorResponse.text();
    } catch {
      bodyText = response.statusText;
    }
    let detail = `HTTP ${response.status}${bodyText ? ` — ${bodyText.slice(0, 400)}` : ""}`;
    try {
      const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
      if (parsed?.error?.message) detail = `HTTP ${response.status} — ${parsed.error.message}`;
    } catch {
      // keep the raw detail
    }
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

/** Stage-1 outcome: the model id that answered, its text and any non-fatal
 *  degradations (retired-id 404s) the chain walked past to get there. */
interface GeminiResult {
  model: string;
  text: string;
  warnings: string[];
}

/**
 * Stage 1 — Google Gemini, the PRIMARY LLM.
 *
 * POSTs to
 * `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<GEMINI_API_KEY>`
 * walking {@link GEMINI_MODELS} in order — starting at `gemini-3.5-flash`.
 *
 * The whole chain is bounded by ONE 9 s `AbortController` deadline (mandated
 * 8–10 s window) instead of per-call timeouts: a fast model-availability
 * failure (404 / model-not-found — the signature of a retired generation)
 * walks to the next id with whatever budget remains (each walk is recorded
 * in the result's `warnings` so the client still sees the degradation),
 * while any other failure — invalid/missing key (400/403), quota (429),
 * upstream 5xx, safety block, empty candidate list, network error or the
 * timeout abort — throws {@link GeminiError} immediately so the caller can
 * walk to Stage 2 (Hugging Face) and finally Stage 3 (built-in formatter).
 */
async function generateWithGemini(userContent: string): Promise<GeminiResult> {
  const controller = new AbortController();
  // Explicit AbortController + shared deadline (rather than per-call
  // AbortSignal.timeout) so the WHOLE model chain — not one call — is bounded
  // by the 9 s window, and the pending round-trip and timer are always
  // cancelled/cleared.
  const deadline = Date.now() + GEMINI_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const failures: string[] = [];
    const warnings: string[] = [];
    for (const [index, model] of GEMINI_MODELS.entries()) {
      // Only reachable after fast 404 walks that consumed the window — no
      // budget left for another round-trip.
      if (Date.now() >= deadline) break;

      try {
        const text = await generateWithGeminiModel(model, userContent, controller.signal);
        return { model: model.id, text, warnings };
      } catch (error) {
        if (!(error instanceof GeminiError)) throw error;
        failures.push(`${model.id}: ${error.message}`);

        if (!isGeminiModelAvailabilityError(error)) {
          // Anything that isn't about model availability (bad key, quota,
          // Google 5xx, timeout) fails the stage immediately — another id
          // can't fix it.
          throw error;
        }

        const next = GEMINI_MODELS[index + 1];
        if (next) {
          warnings.push(`Stage 1 Gemini unavailable — ${error.message}`.slice(0, 400));
          console.warn(`[Stage 1: Gemini Fallback] ${error.message} — retrying with ${next.id}`);
          continue;
        }
        // Availability failure on the LAST id — fall through to the summary.
      }
    }
    // Every id in the chain was retired/gone (or the budget ran out) —
    // report all of them so the operator can tell "Google retired these
    // models" from "this key lacks access".
    throw new GeminiError(
      `no Gemini model could answer (tried ${GEMINI_MODELS.map((m) => m.id).join(", ")}) — ${failures.join(" | ")}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Stage 2 — Hugging Face LLM fallback chain (STRICT)                 */
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
 * rather than the request itself: model not served by any provider
 * (`400 — Model not supported by provider hf-inference`), retired or mistyped
 * ids (`404 — Model not found`), gated models whose license the token owner
 * never accepted (`403 — You cannot access this model… / accepting the terms`),
 * and endpoints that don't support chat completions. Together with an HTTP
 * 404 these are the only failures that trigger the fallback chain — invalid
 * tokens, quota, 5xx, other 400s (bad request body) and network errors are
 * surfaced immediately, because another model id can't fix them and the extra
 * round-trips would just burn the request budget (`maxDuration`).
 */
const HF_LLM_MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /\bnot found\b/i,
  /does not (?:seem to )?exist/i,
  /no such model/i,
  /\bnot supported\b/i,
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
  choices?: { message?: { content?: string } }[];
  error?: string;
}

/**
 * A single chat-completions round-trip against one HF LLM id.
 * Throws {@link HfLlmRequestError} on transport/HTTP failures (status kept)
 * and {@link HfLlmEmptyResponseError} when the model returns no text.
 */
async function generateWithHfLlmModel(
  model: string,
  userContent: string,
  apiKey: string,
): Promise<string> {
  let res: Response;
  try {
    res = await timedFetch(HF_CHAT_ENDPOINT(model), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Ask the HF router to wait for the model instead of instantly 503ing.
        "X-Wait-For-Model": "true",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: MAX_REPLY_TOKENS,
        stream: false,
      }),
    });
  } catch (error) {
    // Network / timeout / abort errors — no HTTP status involved.
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new HfLlmRequestError(detail);
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = res.statusText;
    }
    // Surface the JSON error message when present.
    let detail = `HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 400)}` : ""}`;
    try {
      const j = JSON.parse(bodyText) as { error?: string };
      if (j?.error) detail = `HTTP ${res.status} — ${j.error}`;
    } catch {
      // keep raw detail
    }
    throw new HfLlmRequestError(detail, res.status);
  }

  const json = (await res.json().catch(() => null)) as HfChatCompletion | null;
  const text = json?.choices?.[0]?.message?.content?.trim() ?? "";

  if (!text) {
    throw new HfLlmEmptyResponseError(`Empty response from ${model} (no usable choice text).`);
  }
  return text;
}

/**
 * Strict Stage 2 (fallback): concise Arabic text response formatting via the
 * HF Inference API, starting at
 * {@link HF_LLM_MODELS meta-llama/Llama-3.2-3B-Instruct} and falling back
 * through the remaining non-gated serverless ids when the router reports a
 * model as unavailable (404 not-found / 400 not-supported-by-provider / 403
 * gated-license / empty choices). Any failure throws an "LLM Error:" — the
 * handler catches it and answers from Stage 3, so a Stage 2 outage never
 * breaks the HTTP response.
 * - Runs only after Stage 1 (Gemini) failed, timed out or its key is missing.
 * - Receives the exact same user turn as Gemini — built by
 *   {@link buildUserContent}, so it carries the PlantVillage label +
 *   confidence from Step 1 (when available), the user's text message and the
 *   Firestore profile context (Wilaya, crop).
 * - Uses the concise professional Arabic advisor system prompt.
 * - Throws an Error prefixed with "LLM Error:" once no model can answer.
 */
async function askHfLlmStrict(apiKey: string, userContent: string): Promise<string> {
  const failures: string[] = [];

  for (const [index, model] of HF_LLM_MODELS.entries()) {
    try {
      const text = await generateWithHfLlmModel(model, userContent, apiKey);

      console.log(
        `[Stage 2: HF LLM Success] model=${model} replyLength=${text.length}`,
      );
      return text;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const modelLevel = isHfLlmModelAvailabilityError(error);
      failures.push(`${model}: ${detail}`);

      const nextModel = index < HF_LLM_MODELS.length - 1 ? HF_LLM_MODELS[index + 1] : null;
      if (modelLevel && nextModel) {
        console.warn(`[Stage 2: HF LLM Fallback] ${detail} — retrying with ${nextModel}`);
        continue;
      }

      // Anything that isn't about model availability (bad key, quota, HF 5xx,
      // timeout) fails the stage immediately.
      if (!modelLevel) {
        const wrapped = new Error(`LLM Error: ${detail}`);
        console.error(`[Stage 2: HF LLM Error] ${wrapped.message}`);
        throw wrapped;
      }
      break;
    }
  }

  // Every id in the chain hit a model-level failure — report all of them so the
  // operator can tell "HF dropped this model" from "this key lacks access".
  const wrapped = new Error(
    `LLM Error: no HF LLM model could answer (tried ${HF_LLM_MODELS.join(", ")}) — ${failures.join(" | ")}`,
  );
  console.error(`[Stage 2: HF LLM Error] ${wrapped.message}`);
  throw wrapped;
}

/* ------------------------------------------------------------------ */
/*  Stage 3 — direct formatting safety net (ZERO-FAILURE)              */
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

function adviceForLabel(label: string): DirectAdvice {
  return (
    DIRECT_ADVICE_BY_DISEASE.find((entry) => entry.match.test(label))?.advice ??
    DIRECT_GENERAL_ADVICE
  );
}

/**
 * Zero-failure safety net (Stage 3): builds a clean, concise Arabic Markdown
 * diagnosis card directly from the Step 1 label + confidence, with practical
 * general advice. Used ONLY when Step 1 succeeded but the entire 3-stage LLM
 * chain failed or is unavailable — the request then answers 200 with
 * `{ source: "direct" }` instead of a 500.
 */
function buildDirectDiagnosisCard(diagnosis: AssistantDiagnosis): string {
  const pct = Math.round(diagnosis.confidence * 100);
  const bucket = confidenceBucket(diagnosis.confidence);
  const bucketAr = bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة";
  const alternates = diagnosis.candidates
    .slice(1)
    .map((c) => `${parsePlantLabel(c.label).labelAr} (${Math.round(c.score * 100)}%)`)
    .join("، ");
  const footer =
    "> ⚠️ بطاقة تشخيص تلقائية مبنية مباشرة على نموذج الرؤية — خدمة النصوص الذكية غير متاحة حالياً.";

  if (diagnosis.healthy) {
    const lines = [
      `- **النبتة سليمة** حسب نموذج الرؤية — نسبة الثقة: ${pct}% (${bucketAr}).`,
      alternates ? `- احتمالات أخرى: ${alternates}` : "",
    ].filter(Boolean);
    return [
      `## 🔬 التشخيص\n${lines.join("\n")}`,
      "## 🛡️ وقاية\n- سقي صباحي منتظم عند القاعدة دون بلل الأوراق.\n- تسميد متوازن ومراقبة الأوراق الجديدة أسبوعياً.",
      "## 📅 متابعة موصى بها\n- فحص أسبوعي للأوراق السفلية والبراعم؛ عند أول بقعة أرسل صورة واضحة للتشخيص المبكر.",
      footer,
    ].join("\n\n");
  }

  const advice = adviceForLabel(diagnosis.label);
  const lowConfidence = diagnosis.confidence < 0.45;
  const lines = [
    `- الإصابة: **${diagnosis.labelAr}** — التسمية الخام: \`${diagnosis.label}\``,
    `- نسبة الثقة: ${pct}% (${bucketAr})`,
    alternates ? `- تشخيصات بديلة محتملة: ${alternates}` : "",
    lowConfidence
      ? "- الثقة ضعيفة: أرسل صورة أوضح (ورقة كاملة، إضاءة نهارية) للتأكيد قبل المعالجة."
      : "",
  ].filter(Boolean);

  return [
    `## 🔬 التشخيص\n${lines.join("\n")}`,
    `## 💊 خطة العلاج\n${advice.treatment.map((line) => `- ${line}`).join("\n")}`,
    `## 🛡️ الوقاية مستقبلاً\n${advice.prevention.map((line) => `- ${line}`).join("\n")}`,
    "## 📅 متابعة موصى بها\n- راقب تطور الأعراض كل 3–5 أيام؛ إن انتشرت رغم العلاج، استشر مهندساً زراعياً محلياً.",
    footer,
  ].join("\n\n");
}

/* ------------------------------------------------------------------ */
/*  Stage 3 (text-only) — basic-mode replies (ZERO-FAILURE)            */
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
 * Friendly basic-mode text reply used when the whole LLM chain (Stage 1
 * Gemini + Stage 2 Hugging Face) is unavailable on a request without a usable
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
    "- أو أرفق صورة واضحة لورقة مصابة — نموذج الرؤية يشخّصها ويقدم خطة علاج مباشرة حتى في الوضع الأساسي.",
  ].join("\n");
}

/** Note appended when a photo was sent but the vision step couldn't analyse it. */
const VISION_UNAVAILABLE_NOTE = [
  "⚠️ تعذّر تحليل صورة الورقة حالياً — نموذج الرؤية غير متاح أو ما زال يقلع.",
  "- أعد المحاولة بعد دقيقة بصورة أوضح (ورقة كاملة، إضاءة نهارية).",
  "- أو صف أعراض النبتة بالنص وسأجيبك مباشرة.",
].join("\n");

/* ------------------------------------------------------------------ */
/*  Handler — fail-proof 3-stage chain + direct-formatting fallbacks   */
/* ------------------------------------------------------------------ */

/**
 * Fail-proof pipeline body. Every upstream stage is non-fatal:
 * - Step 1 (vision) failure → warning, continue through Stage 1/2 (an LLM can
 *   still answer the text part) or straight to the Stage 3 direct replies.
 * - Stage 1 (Gemini) failure, timeout, or missing `GEMINI_API_KEY` → warning,
 *   fall through to Stage 2 (the Hugging Face LLM chain).
 * - Stage 2 (Hugging Face) failure or missing `HUGGINGFACE_API_KEY` → warning,
 *   answer 200 from the Stage 3 built-in formatters: diagnosis card when
 *   Step 1 succeeded, friendly basic-mode text otherwise.
 * - The only non-200 responses left are client input errors (400/413) and
 *   the explicit server misconfiguration signal (503 + MISSING_KEYS, emitted
 *   only when NEITHER provider key is configured) — never an HTTP 500.
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
  //   GEMINI_API_KEY        → Stage 1, the primary LLM.
  //   HUGGINGFACE_API_KEY   → Step 1 PlantVillage vision + Stage 2 fallback LLM.
  const configuredGeminiKey = process.env.GEMINI_API_KEY;
  const geminiKey = configuredGeminiKey?.trim() || null;
  // Keep the fetch URL's required process.env.GEMINI_API_KEY interpolation
  // exact while still tolerating accidental whitespace in deployment secrets.
  if (geminiKey && configuredGeminiKey !== geminiKey) {
    process.env.GEMINI_API_KEY = geminiKey;
  }
  const huggingfaceKey = process.env.HUGGINGFACE_API_KEY?.trim() || null;

  if (!geminiKey && !huggingfaceKey) {
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

  // ---- Fail-proof sequential pipeline ------------------------------
  // Step 1: Hugging Face MobileNet vision classification (when image attached).
  // Non-fatal: a vision outage (or a missing HF key) degrades to the LLM /
  // direct replies instead of failing the request.
  let diagnosis: AssistantDiagnosis | null = null;
  if (image) {
    if (!huggingfaceKey) {
      const detail = "HUGGINGFACE_API_KEY is not configured — vision step skipped.";
      console.warn(`[Step 1: HF Skipped] ${detail}`);
      warnings.push(`Step 1 vision unavailable — ${detail}`.slice(0, 400));
    } else {
      try {
        diagnosis = await classifyPlantImageStrict(image.data, image.mimeType, huggingfaceKey);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const detail = msg.startsWith("HF Error:") ? msg.slice("HF Error:".length).trim() : msg;
        console.warn(`[Step 1: HF Unavailable] ${detail}`);
        warnings.push(`Step 1 vision unavailable — ${detail}`.slice(0, 400));
      }
    }
  }

  // One user turn for both LLM stages: user query + Firestore profile context
  // (Wilaya, crop type, role) + the Step 1 MobileNet vision diagnosis (disease
  // label, confidence score, candidate diseases) whenever it exists.
  const userContent = buildUserContent(message, context, diagnosis);

  // ---- Stage 1: Google Gemini (PRIMARY LLM) -------------------------
  // gemini-3.5-flash (→ 3.5-flash-lite → 2.5-flash on a retired-id 404) via
  // the Generative Language REST API, keyed with GEMINI_API_KEY and bounded
  // by a shared 9 s AbortController. Non-fatal: on any failure (or a missing
  // key) the request walks to Stage 2.
  let reply: string | null = null;
  if (geminiKey) {
    try {
      const geminiResult = await generateWithGemini(userContent);
      reply = geminiResult.text;
      // Non-fatal degradations the chain walked past (a retired primary id
      // 404ing before its successor answered) are still surfaced to the
      // client — the operator should see that the primary is gone.
      warnings.push(...geminiResult.warnings);
      console.log(
        `[Stage 1: Gemini Success] model=${geminiResult.model} diagnosis=${diagnosis?.label ?? "none"} confidence=${diagnosis ? `${Math.round(diagnosis.confidence * 100)}%` : "n/a"} replyLength=${reply.length}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Stage 1: Gemini Unavailable → Stage 2] ${detail}`);
      warnings.push(`Stage 1 Gemini unavailable — ${detail}`.slice(0, 400));
    }
  } else {
    const detail = "GEMINI_API_KEY is not configured — skipping the primary LLM.";
    console.warn(`[Stage 1: Gemini Skipped] ${detail} → Stage 2 (Hugging Face LLM chain)`);
    warnings.push(`Stage 1 Gemini unavailable — ${detail}`.slice(0, 400));
  }

  // ---- Stage 2: Hugging Face LLM fallback chain ---------------------
  // Runs only when Stage 1 produced nothing. Same system prompt and the same
  // user turn (query + profile + Step 1 vision context). Non-fatal: on total
  // LLM failure Stage 3 answers locally with 200.
  if (reply === null) {
    if (huggingfaceKey) {
      try {
        reply = await askHfLlmStrict(huggingfaceKey, userContent);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const detail = msg.startsWith("LLM Error:") ? msg.slice("LLM Error:".length).trim() : msg;
        console.warn(`[Stage 2: HF LLM Unavailable → Stage 3] ${detail}`);
        warnings.push(`Stage 2 LLM unavailable — ${detail}`.slice(0, 400));
      }
    } else {
      const detail = "HUGGINGFACE_API_KEY is not configured — skipping the fallback LLM.";
      console.warn(`[Stage 2: HF LLM Skipped] ${detail} → Stage 3 (built-in formatter)`);
      warnings.push(`Stage 2 LLM unavailable — ${detail}`.slice(0, 400));
    }
  }

  if (reply !== null) {
    const payload: AssistantResponseBody = {
      reply,
      diagnosis,
      source: diagnosis ? "hybrid" : "llm",
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return NextResponse.json(payload);
  }

  // ---- Stage 3: direct formatting, zero-failure ----------------------
  // Both LLM stages are down: answer 200 from the built-in TypeScript
  // formatters.
  let directReply: string;
  if (diagnosis) {
    // Image + successful vision → concise Arabic Markdown diagnosis card.
    directReply = buildDirectDiagnosisCard(diagnosis);
  } else if (image) {
    // Image but vision failed too → basic-mode text (when a message exists)
    // plus a clear note about the photo analysis being unavailable.
    directReply = message
      ? `${buildTextFallbackReply(message)}\n\n${VISION_UNAVAILABLE_NOTE}`
      : VISION_UNAVAILABLE_NOTE;
  } else {
    // Text-only → friendly basic-mode reply (greeting-aware).
    directReply = buildTextFallbackReply(message);
  }
  warnings.push("Reply formatted locally — no upstream AI stage was available.");

  const payload: AssistantResponseBody = {
    reply: directReply,
    diagnosis,
    source: "direct",
    warnings,
  };
  return NextResponse.json(payload);
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
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[Safety Net] Unexpected handler exception → basic-mode reply: ${detail}`);
    return NextResponse.json({
      reply: buildTextFallbackReply(""),
      diagnosis: null,
      source: "direct",
      warnings: [`Unexpected internal error — reply formatted locally: ${detail}`.slice(0, 400)],
    } satisfies AssistantResponseBody);
  }
}
