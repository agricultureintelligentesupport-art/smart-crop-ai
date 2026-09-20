/**
 * `/api/assistant` — strict 2-step sequential AI pipeline for the agricultural assistant.
 *
 * Strict pipeline (100% Hugging Face — no Google Gemini dependency):
 *   Step 1 (mandatory when image is attached): Hugging Face Inference API
 *     PlantVillage disease classifier → parse returned array to extract
 *     primary predicted disease class + confidence percentage.
 *     Handles 503/530 model-loading responses with a clear status message.
 *
 *   Step 2 (always): Hugging Face Inference API LLM chat completion for
 *     concise text response formatting — `Qwen/Qwen2.5-72B-Instruct` primary,
 *     with automatic fallback to `meta-llama/Llama-3.1-8B-Instruct` when the
 *     router reports the primary model id itself as unavailable
 *     (e.g. `404 — Model not found`).
 *     The PlantVillage label + confidence from Step 1, alongside the user's
 *     text message and Firestore profile context (Wilaya, crop type), are fed
 *     into the LLM behind a system prompt that enforces a concise, highly
 *     professional, direct and practical Arabic answer ("أنت مساعد زراعي
 *     خبير…") with no small talk, no filler introductions and no long
 *     summaries.
 *
 * The single `HUGGINGFACE_API_KEY` is read from `process.env` on the server
 * only — it is never shipped to the browser. Missing configuration returns a
 * server error.
 *
 * Error reporting: each stage logs to the server console
 * (`[Step 1: HF Success]` / `[Step 2: HF LLM Success]` and corresponding
 * error logs; `[Step 2: HF LLM Fallback]` marks a model switch). If either
 * stage errors, the handler returns a descriptive JSON error
 * `{ error: "HF Error: ..." }` (vision stage) or `{ error: "LLM Error: ..." }`
 * (text stage) with HTTP 500 so the caller can identify exactly which step
 * failed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { confidenceBucket, parsePlantLabel } from "@/lib/assistant/plantvillage";
import type {
  AssistantContext,
  AssistantDiagnosis,
  AssistantRequestBody,
  AssistantResponseBody,
  AssistantSource,
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

/**
 * Fast open-source LLM ids tried by Step 2, in order, via the HF Inference
 * API's OpenAI-compatible chat-completions endpoint.
 *
 * `Qwen/Qwen2.5-72B-Instruct` is the primary: strong multilingual (Arabic
 * included) instruct model served warm on the HF router.
 * `meta-llama/Llama-3.1-8B-Instruct` is kept as a small, fast fallback for
 * router windows where the 72B model is unavailable or cold.
 */
const HF_LLM_MODELS = [
  "Qwen/Qwen2.5-72B-Instruct",
  "meta-llama/Llama-3.1-8B-Instruct",
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
/*  Step 2 — Hugging Face LLM concise text formatting (STRICT)         */
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
    "نتيجة نموذج الرؤية (PlantVillage) على صورة المستخدم:",
    `- التصنيف الأعلى: ${diagnosis.labelAr} — التسمية الخام: ${diagnosis.label}`,
    `- نسبة الثقة: ${pct}% (${bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة"})`,
    alternates ? `- تشخيصات بديلة محتملة: ${alternates}` : "",
    diagnosis.healthy
      ? "- النموذج يرى أن النبتة سليمة؛ طمئن المستخدم وقدّم نصائح وقائية."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

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
 * rather than the request itself: model not served by any provider, retired or
 * mistyped ids, endpoints that don't support chat completions. Together with
 * an HTTP 404 these are the only failures that trigger the fallback chain —
 * auth, quota, 5xx and network errors are surfaced immediately, because
 * another model id can't fix them and the extra round-trips would just burn
 * the request budget (`maxDuration`).
 */
const HF_LLM_MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /\bnot found\b/i,
  /does not (?:seem to )?exist/i,
  /no such model/i,
  /is not supported/i,
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
 * Strict Step 2: concise Arabic text response formatting via the HF Inference
 * API, starting at {@link HF_LLM_MODELS Qwen/Qwen2.5-72B-Instruct} and falling
 * back to the smaller Llama id when the router reports the primary model as
 * unavailable (404 / model-not-found).
 * - Passes the PlantVillage label + confidence from Step 1 directly into the
 *   LLM, alongside the user's text message and Firestore profile (Wilaya, crop).
 * - Uses the concise professional Arabic advisor system prompt.
 * - Throws an Error prefixed with "LLM Error:" once no model can answer.
 */
async function askHfLlmStrict(
  apiKey: string,
  message: string,
  context: AssistantContext | undefined,
  diagnosis: AssistantDiagnosis | null,
): Promise<string> {
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
  const userContent = sections.join("\n\n");

  const failures: string[] = [];

  for (const [index, model] of HF_LLM_MODELS.entries()) {
    try {
      const text = await generateWithHfLlmModel(model, userContent, apiKey);

      console.log(
        `[Step 2: HF LLM Success] model=${model} diagnosis=${diagnosis?.label ?? "none"} confidence=${diagnosis ? Math.round(diagnosis.confidence * 100) + "%" : "n/a"} replyLength=${text.length}`,
      );
      return text;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const modelLevel = isHfLlmModelAvailabilityError(error);
      failures.push(`${model}: ${detail}`);

      const nextModel = index < HF_LLM_MODELS.length - 1 ? HF_LLM_MODELS[index + 1] : null;
      if (modelLevel && nextModel) {
        console.warn(`[Step 2: HF LLM Fallback] ${detail} — retrying with ${nextModel}`);
        continue;
      }

      // Anything that isn't about model availability (bad key, quota, HF 5xx,
      // timeout) fails the stage immediately.
      if (!modelLevel) {
        const wrapped = new Error(`LLM Error: ${detail}`);
        console.error(`[Step 2: HF LLM Error] ${wrapped.message}`);
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
  console.error(`[Step 2: HF LLM Error] ${wrapped.message}`);
  throw wrapped;
}

/* ------------------------------------------------------------------ */
/*  Handler — strict 2-step sequential pipeline                        */
/* ------------------------------------------------------------------ */

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  // Server-only secret — never exposed to the client bundle. One key powers
  // both stages: HF PlantVillage vision (Step 1) and the HF LLM (Step 2).
  const huggingfaceKey = process.env.HUGGINGFACE_API_KEY?.trim() || null;

  if (!huggingfaceKey) {
    return NextResponse.json(
      { error: "API keys missing on server", code: "MISSING_KEYS" },
      { status: 500 },
    );
  }

  // ---- Strict sequential pipeline ---------------------------------
  // Step 1: Mandatory Hugging Face Vision Classification (when image attached)
  let diagnosis: AssistantDiagnosis | null = null;
  if (image) {
    try {
      diagnosis = await classifyPlantImageStrict(image.data, image.mimeType, huggingfaceKey);
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : String(error);
      const hfMessage = msg.startsWith("HF Error:") ? msg : `HF Error: ${msg}`;
      console.error(`[Step 1: HF Error] ${hfMessage}`);
      return NextResponse.json({ error: hfMessage }, { status: 500 });
    }
  }

  // Step 2: Hugging Face LLM concise reasoning & advisory
  // Pass the output label + confidence from Step 1 directly into the LLM,
  // alongside the user's text message and Firestore profile (Wilaya, crop type).
  let reply: string;
  try {
    reply = await askHfLlmStrict(huggingfaceKey, message, context, diagnosis);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const llmMessage = msg.startsWith("LLM Error:") ? msg : `LLM Error: ${msg}`;
    console.error(`[Step 2: HF LLM Error] ${llmMessage}`);
    return NextResponse.json({ error: llmMessage }, { status: 500 });
  }

  const source: AssistantSource = diagnosis ? "hybrid" : "llm";
  const payload: AssistantResponseBody = {
    reply,
    diagnosis,
    source,
  };
  return NextResponse.json(payload);
}
