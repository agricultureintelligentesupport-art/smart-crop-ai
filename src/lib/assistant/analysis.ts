/**
 * The image-stage contract shared by BOTH vision models of the
 * `/api/assistant` diagnosis orchestrator.
 *
 * The orchestrator runs a strict priority order:
 *
 *   Step 1 · IMAGE ANALYSIS
 *     PRIMARY   Gemini (`gemini-3.6`, overridable with `GEMINI_MODEL`) — a
 *               multimodal model that inspects the photo and answers with a
 *               structured JSON object matching {@link AnalysisData}.
 *     FALLBACK  MobileNetV2 PlantVillage on the Hugging Face router — reached
 *               ONLY when the Gemini image analysis failed. Its raw
 *               `{ label, score }` classification is mapped into the SAME
 *               {@link AnalysisData} shape by {@link classificationToAnalysis}.
 *     BOTH DOWN Step 4 — a polite "retry with a clearer photo" message; no
 *               text model is ever called with empty data.
 *
 *   Step 2 · TEXT GENERATION
 *     PRIMARY   Hugging Face LLM — narrates {@link AnalysisData}.
 *     FALLBACK  Gemini — formats the SAME {@link AnalysisData}, without
 *               re-analysing the image.
 *
 * The whole point of this module is the last general rule: the text stage
 * only ever sees {@link AnalysisData} and never learns which image model
 * produced it. {@link AnalysisSource} is carried alongside purely for logging
 * and analytics.
 *
 * Server-safe and dependency-light: no browser APIs, no React.
 */

import type {
  AssistantDiagnosis,
  DiagnosisCandidate,
} from "@/lib/assistant/types";
import { parsePlantLabel } from "@/lib/assistant/plantvillage";

/** How severe the detected problem looks, on the model's own judgement. */
export type AnalysisSeverity = "low" | "medium" | "high";

/** Which image model produced {@link AnalysisData} — analytics only. */
export type AnalysisSource = "gemini" | "mobilenet";

/** Which text model narrated {@link AnalysisData} — analytics only. */
export type TextSource = "huggingface" | "gemini_fallback";

/**
 * The single structured payload exchanged between the image stage and the
 * text stage. Field names are snake_case and stable across both image models,
 * so the narration step is completely agnostic about its origin.
 *
 * `confidence` is a plain data point, never a routing signal: the
 * orchestrator has NO confidence threshold — a low score from Gemini is a
 * legitimate verdict that is passed through untouched (it only shapes how
 * hedged the narration reads).
 */
export interface AnalysisData {
  /** Crop/species as read from the photo, in the target language, or null. */
  plant_type: string | null;
  /** Whether the model believes the plant is diseased at all. */
  disease_detected: boolean;
  /** Disease name in the target language, or null when nothing was found. */
  disease_name: string | null;
  /** Model-reported confidence in [0, 1]. */
  confidence: number;
  /** Plant parts showing symptoms ("الأوراق السفلية", …). */
  affected_parts: string[];
  /** Severity judgement, or null when not applicable. */
  severity: AnalysisSeverity | null;
  /** Symptoms actually visible in the photo. */
  symptoms_observed: string[];
  /** Short agronomic remark. */
  notes: string;
}

/** A completed image-stage run: the payload plus its provenance. */
export interface AnalysisResult {
  data: AnalysisData;
  source: AnalysisSource;
  /** The UI-facing card built from `data` (see {@link analysisToDiagnosis}). */
  diagnosis: AssistantDiagnosis;
}

/* ------------------------------------------------------------------ */
/*  Empty / absent analysis                                            */
/* ------------------------------------------------------------------ */

/** An {@link AnalysisData} with every field explicitly empty. */
export function emptyAnalysis(): AnalysisData {
  return {
    plant_type: null,
    disease_detected: false,
    disease_name: null,
    confidence: 0,
    affected_parts: [],
    severity: null,
    symptoms_observed: [],
    notes: "",
  };
}

/* ------------------------------------------------------------------ */
/*  Gemini response schema + parsing                                   */
/* ------------------------------------------------------------------ */

/**
 * JSON Schema handed to Gemini as `generationConfig.responseSchema` so the
 * image-analysis step answers with a machine-readable object instead of prose.
 *
 * Gemini's schema dialect has no `null` type, so the two optional string
 * fields (`plant_type`, `disease_name`) and `severity` are declared as
 * strings and normalised back to `null` by {@link parseAnalysisJson} when the
 * model returns an empty string / the `"none"` sentinel.
 */
export const ANALYSIS_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    plant_type: {
      type: "STRING",
      description: "Crop species, in the user's language. Empty string if not identifiable.",
    },
    disease_detected: {
      type: "BOOLEAN",
      description: "True only when a disease or pest problem is actually visible.",
    },
    disease_name: {
      type: "STRING",
      description:
        "Name of the detected disease in the user's language. Empty string when disease_detected is false.",
    },
    confidence: {
      type: "NUMBER",
      description: "Confidence in the diagnosis between 0 and 1.",
    },
    affected_parts: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Plant parts showing symptoms, in the user's language.",
    },
    severity: {
      type: "STRING",
      enum: ["low", "medium", "high", "none"],
      description:
        "Severity of the problem: low, medium, high, or none when the plant is healthy.",
    },
    symptoms_observed: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Concrete symptoms visible in the photo, in the user's language.",
    },
    notes: {
      type: "STRING",
      description: "One short agronomic remark, in the user's language.",
    },
  },
  required: [
    "plant_type",
    "disease_detected",
    "disease_name",
    "confidence",
    "affected_parts",
    "severity",
    "symptoms_observed",
    "notes",
  ],
  propertyOrdering: [
    "plant_type",
    "disease_detected",
    "disease_name",
    "confidence",
    "affected_parts",
    "severity",
    "symptoms_observed",
    "notes",
  ],
} as const;

/** Every field the orchestrator requires a Gemini image analysis to carry. */
const REQUIRED_ANALYSIS_FIELDS = ANALYSIS_RESPONSE_SCHEMA.required;

/**
 * The image-analysis system instruction. Deliberately NOT the conversational
 * agricultural-advisor persona used by the text stage: this step is a pure,
 * literal visual extraction, and mixing the two invites the model to start
 * chatting (or recommending treatments) instead of filling the object.
 *
 * The reply language follows the farm app's default (Arabic), or French when
 * the caller asks for it.
 */
export function buildAnalysisInstruction(lang: "ar" | "fr"): string {
  return lang === "fr"
    ? [
        "You are a plant pathology vision engine. Inspect the attached photo and describe ONLY what is literally visible on the plant.",
        "Return a single JSON object — no prose, no markdown fence, no explanation outside the object.",
        "Rules:",
        "- Identify the crop species; if it is genuinely unreadable, return an empty string.",
        "- Set disease_detected to true ONLY when a disease or pest problem is visibly present. A healthy plant is a legitimate, common answer.",
        "- Name the disease in French. Never invent a disease that the photo does not support.",
        "- Report confidence as a number between 0 and 1 reflecting how certain YOU are. A modest number is a normal, acceptable answer — do not inflate it.",
        "- List the affected parts and the symptoms you can actually see, in French.",
        "- Use severity \"none\" when the plant is healthy, otherwise low, medium or high.",
        "- notes: one short, factual agronomic remark in French. No treatment plan here.",
        "Answer with the JSON object only.",
      ].join("\n")
    : [
        "أنت محرك رؤية لتشخيص أمراض النبات. افحص الصورة المرفقة وصف حرفياً ما هو ظاهر على النبتة فقط.",
        "أعد كائن JSON واحداً فقط — بلا شرح، وبلا أسوار markdown، وبلا كلام خارج الكائن.",
        "القواعد:",
        "- حدّد نوع المحصول؛ إن لم يمكن التعرف عليه فعلياً، أعد نصاً فارغاً.",
        "- اجعل disease_detected يساوي true فقط عند وجود مرض أو آفة ظاهرة فعلاً. النبتة السليمة جواب مشروع وشائع.",
        "- سمِّ المرض بالعربية. لا تخترع مرضاً لا تدعمه الصورة.",
        "- أعطِ confidence رقماً بين 0 و1 يعبّر عن يقينك أنت. الرقم المتواضع جواب طبيعي ومقبول — لا تضخّمه.",
        "- اذكر الأجزاء المصابة والأعراض التي تراها فعلاً، بالعربية.",
        "- استخدم severity بقيمة \"none\" إذا كانت النبتة سليمة، وإلا low أو medium أو high.",
        "- notes: ملاحظة زراعية واقعية قصيرة بالعربية. لا تضع خطة علاج هنا.",
        "أعد كائن JSON فقط.",
      ].join("\n");
}

/** Raised when a Gemini image analysis is not usable (Step 1 failure). */
export class AnalysisParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisParseError";
  }
}

/** Trim a code fence some providers still wrap JSON in. */
function stripCodeFence(raw: string): string {
  const fence = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1] : raw.trim();
}

/** `"high"` → `"high"`, `""`/`"none"`/`"unknown"` → `null`. */
function toSeverity(value: unknown): AnalysisSeverity | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return null;
}

/** Trimmed non-empty string, or null. */
function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Array of trimmed non-empty strings — never null, tolerant of a lone string. */
function toStringList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return source
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

/**
 * Coerce a model-reported confidence into [0, 1].
 *
 * Deliberately NEVER raises and NEVER fails: the orchestrator has no
 * confidence threshold, so an out-of-range or unparseable number is clamped
 * (or zeroed) and still travels to the text stage as ordinary data.
 */
function toConfidence(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

/** Boolean, tolerating the `"true"` / `"yes"` / `1` spellings some models emit. */
function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1", "نعم", "موجود"].includes(normalized)) return true;
    if (["false", "no", "0", "لا", "لا يوجد"].includes(normalized)) return false;
  }
  return false;
}

/**
 * Parse and validate the JSON object returned by the Gemini image-analysis
 * step.
 *
 * Throws {@link AnalysisParseError} — the ONE shape of Gemini failure that
 * routes the request to the MobileNetV2 fallback — when the payload is not
 * JSON, is not an object, or is missing any of the
 * {@link REQUIRED_ANALYSIS_FIELDS}. Type noise (a stringified boolean, a
 * confidence of 1.4, `"none"` instead of `null`) is normalised rather than
 * rejected, and confidence NEVER gates the result.
 */
export function parseAnalysisJson(raw: string): AnalysisData {
  const text = stripCodeFence(raw);
  if (!text) {
    throw new AnalysisParseError("empty image-analysis response");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AnalysisParseError(`image analysis is not valid JSON — ${detail}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AnalysisParseError("image analysis is not a JSON object");
  }

  const record = payload as Record<string, unknown>;
  const missing = REQUIRED_ANALYSIS_FIELDS.filter(
    (field) => !Object.prototype.hasOwnProperty.call(record, field) || record[field] === undefined,
  );
  if (missing.length > 0) {
    throw new AnalysisParseError(
      `image analysis is missing required field(s): ${missing.join(", ")}`,
    );
  }

  const diseaseDetected = toBoolean(record.disease_detected);
  return {
    plant_type: toNullableString(record.plant_type),
    disease_detected: diseaseDetected,
    // A "no disease" verdict must not smuggle a disease name through.
    disease_name: diseaseDetected ? toNullableString(record.disease_name) : null,
    confidence: toConfidence(record.confidence),
    affected_parts: toStringList(record.affected_parts),
    severity: toSeverity(record.severity),
    symptoms_observed: toStringList(record.symptoms_observed),
    notes: typeof record.notes === "string" ? record.notes.trim() : "",
  };
}

/* ------------------------------------------------------------------ */
/*  MobileNetV2 → AnalysisData (the fallback mapping)                  */
/* ------------------------------------------------------------------ */

/**
 * Convert MobileNetV2's raw PlantVillage classification into the same
 * {@link AnalysisData} shape Gemini produces, so the text stage is
 * source-agnostic.
 *
 * Mapping: `label` → `disease_name` (through the Arabic label localiser) and
 * `plant_type`, `score` → `confidence`. Everything MobileNetV2 genuinely
 * cannot express (affected parts, severity, symptoms, notes) stays empty
 * rather than invented — the narration step then leans on its own agronomy.
 */
export function classificationToAnalysis(
  label: string,
  score: number,
): AnalysisData {
  const parsed = parsePlantLabel(label);
  return {
    plant_type: parsed.cropAr,
    disease_detected: !parsed.healthy,
    disease_name: parsed.healthy ? null : parsed.labelAr,
    confidence: toConfidence(score),
    affected_parts: [],
    severity: null,
    symptoms_observed: [],
    notes: "",
  };
}

/* ------------------------------------------------------------------ */
/*  AnalysisData → AssistantDiagnosis (the UI card)                    */
/* ------------------------------------------------------------------ */

/**
 * Arabic wording for the `severity` enum, shared with the prompt builder in
 * the route so the diagnosis card and the text stage use one vocabulary.
 */
export const SEVERITY_AR: Record<AnalysisSeverity, string> = {
  low: "منخفضة",
  medium: "متوسطة",
  high: "عالية",
};

/** French wording, for the `lang: "fr"` reply mode. */
export const SEVERITY_FR: Record<AnalysisSeverity, string> = {
  low: "faible",
  medium: "moyenne",
  high: "élevée",
};

/** Severity enum → the wording the diagnosis card shows. */
function localizeSeverity(
  severity: AnalysisSeverity | null,
  lang: "ar" | "fr",
): string | null {
  if (!severity) return null;
  return (lang === "fr" ? SEVERITY_FR : SEVERITY_AR)[severity];
}

/**
 * Project {@link AnalysisData} onto the `AssistantDiagnosis` the UI's
 * `DiagnosisCard` renders. The two shapes are deliberately separate: the card
 * is a presentational contract that predates the orchestrator, while
 * `AnalysisData` is the inter-stage payload. Both image models go through this
 * one function, so the card looks identical whatever produced the data.
 */
export function analysisToDiagnosis(
  data: AnalysisData,
  source: AnalysisSource,
  options: {
    /** Model id shown on the card, e.g. `gemini-3.6`. */
    model: string;
    lang?: "ar" | "fr";
    /**
     * Raw classifier label, carried through for MobileNetV2 so the built-in
     * disease-family advice matcher and the prompt's "raw label" line keep
     * working. Omitted for Gemini, whose `disease_name` is already a natural
     * name rather than a machine label.
     */
    rawLabel?: string;
    /** Runner-up classifications (MobileNetV2 only). */
    candidates?: DiagnosisCandidate[];
  },
): AssistantDiagnosis {
  const lang = options.lang ?? "ar";
  const rawLabel = options.rawLabel ?? data.disease_name ?? "";
  const parsed = source === "mobilenet" ? parsePlantLabel(rawLabel) : null;

  const labelAr = data.disease_detected
    ? data.disease_name ?? rawLabel.replace(/_{2,}/g, " — ").replace(/_/g, " ")
    : parsed?.healthy
      ? parsed.labelAr
      : `${data.plant_type ?? "النبتة"} — تبدو سليمة ✅`;

  return {
    label: rawLabel,
    labelAr,
    cropAr: data.plant_type ?? parsed?.cropAr ?? null,
    diseaseAr: data.disease_detected ? data.disease_name : (parsed?.diseaseAr ?? null),
    healthy: !data.disease_detected,
    confidence: data.confidence,
    model: options.model,
    candidates: options.candidates ?? [],
    engine: source === "gemini" ? "gemini-vision" : "plantvillage-hf",
    severity: localizeSeverity(data.severity, lang),
    symptoms: data.symptoms_observed,
    notes: data.notes || null,
  };
}
