/**
 * `/api/assistant` — hybrid AI pipeline for the agricultural assistant.
 *
 * Step 1 (vision): when the request carries a leaf photo, it is classified
 *   with a PlantVillage disease model on the Hugging Face Inference API
 *   (`HUGGINGFACE_API_KEY`), producing a disease label + confidence.
 *
 * Step 2 (reasoning): the label, confidence, the user's question and the
 *   Firestore-mirrored profile context (wilaya, preferred crop, role) are fed
 *   into Google Gemini 1.5 Flash (`GEMINI_API_KEY`) behind a system prompt
 *   that frames it as an expert Algerian agricultural advisor answering in
 *   natural Arabic / Algerian Darija.
 *
 * Both keys are read from `process.env` on the server only — they are never
 * shipped to the browser. Every upstream failure degrades gracefully: vision
 * without Gemini yields a templated Arabic plan, no keys at all yields a
 * deterministic offline answer, and the response always tells the UI which
 * path produced it (`source`).
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
/*  Step 1 — Hugging Face PlantVillage vision diagnosis                */
/* ------------------------------------------------------------------ */

interface HfClassification {
  label: string;
  score: number;
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

async function classifyPlantImage(
  imageBase64: string,
  mimeType: string,
  apiKey: string,
  warnings: string[],
): Promise<AssistantDiagnosis | null> {
  const body = Buffer.from(imageBase64, "base64");

  for (const model of HF_PLANT_MODELS) {
    try {
      const res = await timedFetch(HF_ENDPOINT(model), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": mimeType || "application/octet-stream",
          // Wait for the model to spin up instead of failing with a 503.
          "X-Wait-For-Model": "true",
        },
        body,
      });

      if (!res.ok) {
        warnings.push(`vision(${model}): HTTP ${res.status}`);
        continue;
      }

      const json: unknown = await res.json();
      if (!isHfClassificationArray(json)) {
        warnings.push(`vision(${model}): unexpected payload shape`);
        continue;
      }

      const ranked = [...json].sort((a, b) => b.score - a.score);
      const top = ranked[0];
      const parsed = parsePlantLabel(top.label);
      const candidates: DiagnosisCandidate[] = ranked
        .slice(0, 3)
        .map(({ label, score }) => ({ label, score }));

      return {
        label: top.label,
        labelAr: parsed.labelAr,
        cropAr: parsed.cropAr,
        diseaseAr: parsed.diseaseAr,
        healthy: parsed.healthy,
        confidence: top.score,
        model,
        candidates,
      };
    } catch (error) {
      warnings.push(
        `vision(${model}): ${error instanceof Error ? error.name : "request failed"}`,
      );
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Step 2 — Gemini 1.5 Flash localized reasoning                      */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `أنت "مستشار زراعي جزائري خبير" داخل تطبيق "محصولي الذكي" (Smart Crop AI).
مهمتك مساعدة الفلاحين والمهندسين الزراعيين في الجزائر بنصائح عملية دقيقة.

قواعد إلزامية:
- أجب بالعربية الفصحى المبسطة مع لمسات من الدارجة الجزائرية عندما تكون طبيعية (مثل: "السقي"، "الفلاّح"، "البرّاد الصباحي")، إلا إذا طُلبت الفرنسية صراحةً.
- خصّص الجواب حسب سياق المستخدم المرفق: الولاية ومناخها، المحصول المفضل، ودوره (فلاح / مهندس زراعي / مستثمر).
- عند وجود تشخيص من نموذج الرؤية (PlantVillage): اعتمد عليه، اذكر اسم المرض بالعربية مع نسبة الثقة، وإذا كانت الثقة ضعيفة (<45%) نبّه المستخدم بلطف واطلب صورة أوضح مع اقتراح التشخيصات المحتملة.
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

async function askGemini(
  apiKey: string,
  message: string,
  context: AssistantContext | undefined,
  diagnosis: AssistantDiagnosis | null,
  image: { data: string; mimeType: string } | null,
  warnings: string[],
): Promise<string | null> {
  const userParts: GeminiPart[] = [];

  const sections = [
    `سياق المستخدم من ملفه الشخصي: ${describeContext(context)}`,
    describeDiagnosis(diagnosis),
    message
      ? `سؤال المستخدم: ${message}`
      : diagnosis
        ? "لم يكتب المستخدم سؤالاً — قدّم التشخيص وخطة العلاج والوقاية مباشرة."
        : "حيّ المستخدم وقدّم نفسك بإيجاز كمستشار زراعي.",
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
      warnings.push(`gemini: HTTP ${res.status}`);
      return null;
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

    return text && text.length > 0 ? text : null;
  } catch (error) {
    warnings.push(`gemini: ${error instanceof Error ? error.name : "request failed"}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Offline / degraded fallbacks (keys missing or upstream down)       */
/* ------------------------------------------------------------------ */

function templatedDiagnosisReply(
  diagnosis: AssistantDiagnosis,
  context: AssistantContext | undefined,
): string {
  const pct = Math.round(diagnosis.confidence * 100);
  const where = context?.wilayaName ? ` في ولاية ${context.wilayaName}` : "";
  if (diagnosis.healthy) {
    return [
      `## 🔬 التشخيص`,
      `النبتة تبدو **سليمة** حسب نموذج الرؤية (ثقة ${pct}%). واصل على نفس العناية${where}. 🌿`,
      ``,
      `## 🛡️ الوقاية مستقبلاً`,
      `- افحص الأوراق أسبوعياً من الوجهين.`,
      `- اسقِ في الصباح الباكر وتجنّب تبليل الأوراق.`,
      `- حافظ على تهوية جيدة بين النباتات.`,
    ].join("\n");
  }
  return [
    `## 🔬 التشخيص`,
    `النتيجة الأعلى: **${diagnosis.labelAr}** بنسبة ثقة **${pct}%**.`,
    ``,
    `## 💊 خطة العلاج (عامة)`,
    `- اعزل النباتات المصابة وأزل الأوراق المتضررة واحرقها بعيداً عن الحقل.`,
    `- استشر مهندساً زراعياً محلياً لاختيار المبيد المناسب والجرعة الدقيقة.`,
    `- تجنّب السقي بالرش فوق الأوراق حتى تنحصر الإصابة.`,
    ``,
    `## 🛡️ الوقاية مستقبلاً`,
    `- ناوب المحاصيل ولا تزرع نفس العائلة في نفس القطعة موسمين متتاليين.`,
    `- عقّم الأدوات وقلّل الرطوبة على المجموع الخضري.`,
    ``,
    `> ملاحظة: خدمة النصائح الذكية غير متاحة حالياً، هذه إرشادات عامة اعتماداً على تشخيص الصورة فقط.`,
  ].join("\n");
}

function offlineReply(context: AssistantContext | undefined, hadImage: boolean): string {
  const who = context?.displayName ? ` يا ${context.displayName}` : "";
  return [
    `أهلاً${who} 🌱 أنا مساعدك الزراعي في "محصولي الذكي".`,
    ``,
    hadImage
      ? `وصلتني الصورة، لكن خدمة التشخيص الذكي غير مفعّلة حالياً على هذا الخادم (مفاتيح API غير مضبوطة).`
      : `خدمة الذكاء الاصطناعي غير مفعّلة حالياً على هذا الخادم (مفاتيح API غير مضبوطة).`,
    ``,
    `لتفعيلها أضف في ملف \`.env.local\`:`,
    `- \`GEMINI_API_KEY\` — من Google AI Studio.`,
    `- \`HUGGINGFACE_API_KEY\` — من إعدادات حساب Hugging Face.`,
    ``,
    `في الأثناء يمكنك استعمال لوحة التحكم لمتابعة السقي والطقس حسب ولايتك. 💧`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Handler                                                            */
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

  const warnings: string[] = [];

  // ---- Step 1: vision diagnosis (only when a photo was sent) ----
  let diagnosis: AssistantDiagnosis | null = null;
  if (image) {
    if (huggingfaceKey) {
      diagnosis = await classifyPlantImage(image.data, image.mimeType, huggingfaceKey, warnings);
    } else {
      warnings.push("vision: HUGGINGFACE_API_KEY not configured — step skipped");
    }
  }

  // ---- Step 2: localized reasoning with Gemini 1.5 Flash ----
  let reply: string | null = null;
  let source: AssistantSource = "offline";

  if (geminiKey) {
    reply = await askGemini(
      geminiKey,
      message,
      context,
      diagnosis,
      image ? { data: image.data, mimeType: image.mimeType } : null,
      warnings,
    );
    if (reply) source = diagnosis ? "hybrid" : "gemini";
  } else {
    warnings.push("reasoning: GEMINI_API_KEY not configured");
  }

  // ---- Degraded paths ----
  if (!reply && diagnosis) {
    reply = templatedDiagnosisReply(diagnosis, context);
    source = "vision-only";
  }
  if (!reply) {
    reply = offlineReply(context, Boolean(image));
    source = "offline";
  }

  const payload: AssistantResponseBody = {
    reply,
    diagnosis,
    source,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
  return NextResponse.json(payload);
}
