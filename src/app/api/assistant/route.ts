/**
 * `/api/assistant` — strict 2-step sequential AI pipeline for the agricultural assistant.
 *
 * Strict pipeline:
 *   Step 1 (mandatory when image is attached): Hugging Face Inference API
 *     PlantVillage disease classifier → parse returned array to extract
 *     primary predicted disease class + confidence percentage.
 *     Handles 503/530 model-loading responses with a clear status message.
 *
 *   Step 2 (always): Google Gemini 1.5 Flash localized reasoning.
 *     The PlantVillage label + confidence from Step 1, alongside the user's
 *     text message and Firestore profile context (Wilaya, crop type), are fed
 *     into Gemini behind a system prompt that frames it as an expert Algerian
 *     agricultural advisor ("مستشار زراعي جزائري خبير") answering in natural
 *     Arabic / Algerian Darija with a treatment + irrigation plan.
 *
 * Both keys are read from `process.env` on the server only — they are never
 * shipped to the browser. Missing configuration returns a server error.
 *
 * Error reporting: each stage logs to the server console
 * (`[Step 1: HF Success]` / `[Step 2: Gemini Success]` and corresponding
 * error logs). If either API errors, the handler returns a descriptive JSON
 * error `{ error: "HF Error: ..." }` or `{ error: "Gemini Error: ..." }`
 * with HTTP 500 so the caller can identify exactly which stage failed.
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

const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
/*  Step 2 — Gemini 1.5 Flash localized reasoning (STRICT)             */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `أنت "مستشار زراعي جزائري خبير" داخل تطبيق "محصولي الذكي" (Smart Crop AI).
مهمتك مساعدة الفلاحين والمهندسين الزراعيين في الجزائر بنصائح عملية دقيقة.

قواعد إلزامية:
- أجب بالعربية الفصحى المبسطة مع لمسات من الدارجة الجزائرية عندما تكون طبيعية (مثل: "السقي"، "الفلاّح"، "البرّاد الصباحي")، إلا إذا طُلبت الفرنسية صراحةً.
- خصّص الجواب حسب سياق المستخدم المرفق: الولاية ومناخها، المحصول المفضل، ودوره (فلاح / مهندس زراعي / مستثمر).
- عند وجود تشخيص من نموذج الرؤية (PlantVillage): اعتمد عليه مباشرة، اذكر اسم المرض بالعربية مع نسبة الثقة (مثال: Tomato___Early_blight 95%)، وإذا كانت الثقة ضعيفة (<45%) نبّه المستخدم بلطف واطلب صورة أوضح مع اقتراح التشخيصات المحتملة.
- عند تشخيص مرض، قدّم دائماً خطة علاجية ووقائية محلية منظمة بهذا الشكل (Markdown):
  ## 🔬 التشخيص
  ## 💊 خطة العلاج
  ## 🛡️ الوقاية مستقبلاً
  ## 📅 متابعة موصى بها
- اذكر مواد وممارسات متوفرة فعلاً في السوق الجزائرية (مبيدات نحاسية، مانكوزيب، كبريت ميكروني، تناوب زراعي، تهوية البيوت البلاستيكية…) مع جرعات إرشادية وتحذيرات السلامة وفترة الأمان قبل الجني.
- راعِ مناخ ولاية المستخدم (ساحلي، تلّي، هضاب عليا، صحراوي) في مواعيد السقي والمعالجة.
- كن مقتضباً ومنظماً: عناوين، نقاط قصيرة، أرقام واضحة. لا تتجاوز ٤٠٠ كلمة إلا للضرورة.
- إن كان السؤال خارج الفلاحة، أعد توجيه المحادثة بلباقة نحو اختصاصك.
- لا تدّعي اليقين الطبي المطلق: انصح بمعاينة مهندس زراعي محلي في الحالات الحرجة.`;

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

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

/**
 * Strict Step 2: localized reasoning via Gemini 1.5 Flash.
 * - Passes the PlantVillage label + confidence from Step 1 directly into Gemini,
 *   alongside the user's text message and Firestore profile (Wilaya, crop type).
 * - Uses the Algerian advisor system prompt.
 * - Throws an Error prefixed with "Gemini Error:" on any failure.
 */
async function askGeminiStrict(
  apiKey: string,
  message: string,
  context: AssistantContext | undefined,
  diagnosis: AssistantDiagnosis | null,
  image: { data: string; mimeType: string } | null,
): Promise<string> {
  const userParts: GeminiPart[] = [];

  const sections = [
    `سياق المستخدم من ملفه الشخصي: ${describeContext(context)}`,
    describeDiagnosis(diagnosis),
    diagnosis
      ? `تشخيص PlantVillage (من Step 1 — مرّر مباشرة إلى Gemini): ${diagnosis.label} بثقة ${Math.round(diagnosis.confidence * 100)}% — ${diagnosis.labelAr}`
      : "",
    message
      ? `سؤال المستخدم: ${message}`
      : diagnosis
        ? "لم يكتب المستخدم سؤالاً — قدّم التشخيص وخطة العلاج والوقاية مباشرة بناءً على نتيجة PlantVillage أعلاه."
        : "حيّ المستخدم وقدّم نفسك بإيجاز كمستشار زراعي جزائري خبير.",
  ].filter(Boolean);
  userParts.push({ text: sections.join("\n\n") });

  // Attach the photo too: Gemini can double-check the vision verdict and
  // spot context the classifier ignores (pests, nutrient burn, wilt).
  if (image) {
    userParts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
  }

  try {
    const res = await timedFetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: userParts }],
        generationConfig: {
          temperature: 0.55,
          topP: 0.9,
          maxOutputTokens: 1400,
        },
        safetySettings: [
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    });

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        bodyText = res.statusText;
      }
      let detail = `HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 600)}` : ""}`;
      try {
        const j = JSON.parse(bodyText) as { error?: { message?: string } | string };
        if (typeof j?.error === "string") detail = `HTTP ${res.status} — ${j.error}`;
        else if (typeof j?.error?.message === "string") detail = `HTTP ${res.status} — ${j.error.message}`;
      } catch {
        // keep raw
      }
      throw new Error(`Gemini Error: ${detail}`);
    }

    const json: unknown = await res.json();
    const text = (
      json as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      }
    )?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!text || text.length === 0) {
      throw new Error(
        `Gemini Error: Empty response from Gemini 1.5 Flash (no candidates). Raw: ${JSON.stringify(json).slice(0, 800)}`,
      );
    }

    console.log(
      `[Step 2: Gemini Success] diagnosis=${diagnosis?.label ?? "none"} confidence=${diagnosis ? Math.round(diagnosis.confidence * 100) + "%" : "n/a"} replyLength=${text.length}`,
    );
    return text;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Gemini Error:")) {
      console.error(`[Step 2: Gemini Error] ${error.message}`);
      throw error;
    }
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const wrapped = new Error(`Gemini Error: ${detail}`);
    console.error(`[Step 2: Gemini Error] ${detail}`);
    throw wrapped;
  }
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

  // Server-only secrets — never exposed to the client bundle.
  const geminiKey = process.env.GEMINI_API_KEY?.trim() || null;
  const huggingfaceKey = process.env.HUGGINGFACE_API_KEY?.trim() || null;

  if (!geminiKey || !huggingfaceKey) {
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

  // Step 2: Gemini Localized Reasoning & Advisory
  // Pass the output label + confidence from Step 1 directly into Gemini,
  // alongside the user's text message and Firestore profile (Wilaya, crop type).
  let reply: string;
  try {
    reply = await askGeminiStrict(
      geminiKey,
      message,
      context,
      diagnosis,
      image ? { data: image.data, mimeType: image.mimeType } : null,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const geminiMessage = msg.startsWith("Gemini Error:") ? msg : `Gemini Error: ${msg}`;
    console.error(`[Step 2: Gemini Error] ${geminiMessage}`);
    return NextResponse.json({ error: geminiMessage }, { status: 500 });
  }

  const source: AssistantSource = diagnosis ? "hybrid" : "gemini";
  const payload: AssistantResponseBody = {
    reply,
    diagnosis,
    source,
  };
  return NextResponse.json(payload);
}
