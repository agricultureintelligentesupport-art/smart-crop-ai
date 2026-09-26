/**
 * Shared contracts between the assistant UI (`/assistant`) and the fail-proof
 * 3-stage chain behind `/api/assistant`:
 *   Step 1  Hugging Face MobileNet PlantVillage vision diagnosis,
 *   Stage 1 Hugging Face LLM chain (primary LLM),
 *   Stage 2 Google Gemini (`gemini-3.6`, fallback LLM),
 *   Stage 3 built-in TypeScript direct formatters (never fails).
 *
 * Kept dependency-free and importable from both server and client code.
 */

export interface AssistantContext {
  /** Two-digit wilaya code from the stored profile, e.g. "07". */
  wilayaCode?: string | null;
  /** Human-readable wilaya name (Arabic) resolved on the client. */
  wilayaName?: string | null;
  /** Preferred crop label (Arabic) resolved on the client. */
  crop?: string | null;
  /** Farm/plot size in hectares, collected during the onboarding farm step. */
  landSizeHa?: number | null;
  /** Profile role: farmer | agronomist | investor. */
  role?: string | null;
  /** UI language, drives the answer language (ar default). */
  lang?: "ar" | "fr";
  /** Display name for a personal touch in answers. */
  displayName?: string | null;
}

export interface AssistantImagePayload {
  /** Raw base64 (no data-URL prefix). */
  data: string;
  /** e.g. "image/jpeg". */
  mimeType: string;
}

/**
 * Outcome of Step 0 — the leaf Detection & Cropping preprocessing stage that
 * runs before the PlantVillage classifier. Surfaced in the response body for
 * full transparency (the UI shows whether the photo was auto-cropped).
 */
export interface AssistantPreprocessing {
  /**
   * cropped       — a leaf was detected and only the cropped region reached
   *                 the classifier;
   * smart-fallback— the detector answered but no box cleared the score
   *                 threshold, so the automated Smart Fallback Crop (HSV
   *                 green-dominant box, else a centre-focused 80 % crop)
   *                 trimmed desks/hands/walls before the classifier;
   * no-leaf       — no detector box AND even the fallback crop was
   *                 impossible (degenerate frame) — the original image was
   *                 used (legacy status, normally unreachable);
   * unavailable   — the detection endpoint could not be reached (network,
   *                 loading, unexpected payload) — the original image was used;
   * skipped       — no Hugging Face token is configured, so detection cannot
   *                 run (mirrors the Step 1 skip).
   */
  status: "cropped" | "smart-fallback" | "no-leaf" | "unavailable" | "skipped";
  /** Detector model id, when a detection call was attempted. */
  detector: string | null;
  /**
   * Crop window on the ORIGINAL image as a normalised
   * `[xMin, yMin, xMax, yMax]` tuple — every coordinate in `[0, 1]`
   * (corners, not size), `null` when no crop was applied.
   */
  box: [number, number, number, number] | null;
  /** Wall-clock cost of the whole stage (detection + crop), in ms. */
  durationMs: number;
}

export interface AssistantHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantRequestBody {
  message?: string;
  image?: AssistantImagePayload;
  context?: AssistantContext;
  history?: AssistantHistoryTurn[];
}

/** One raw candidate from the vision classifier. */
export interface DiagnosisCandidate {
  label: string;
  score: number;
}

/**
 * Which vision engine produced a {@link AssistantDiagnosis}.
 *   • `plantvillage-hf` — Hugging Face MobileNetV2 PlantVillage classifier.
 * The streamlined pipeline has exactly ONE vision engine: the former
 * CodeCraft gateway was removed from the chain (WAF 403 stalls + an extra
 * network round-trip). Optional: most diagnoses carry no engine tag, and
 * every consumer treats the field as informational only.
 */
export type AssistantVisionEngine = "plantvillage-hf";

/** Structured result of the PlantVillage vision step. */
export interface AssistantDiagnosis {
  /** Raw model label, e.g. "Tomato___Late_blight". */
  label: string;
  /** Localised label, e.g. "الطماطم — اللفحة المتأخرة". */
  labelAr: string;
  cropAr: string | null;
  diseaseAr: string | null;
  healthy: boolean;
  /** Top-1 confidence in [0, 1]. */
  confidence: number;
  /** Model id used for classification. */
  model: string;
  /** Top candidates (max 3), highest first. */
  candidates: DiagnosisCandidate[];

  /* ------------------------------------------------------------------ */
  /*  Optional enrichment — additive, never required by any consumer.    */
  /*  The MobileNetV2 PlantVillage classifier sets none of these; they   */
  /*  remain for richer classifiers pinned via `HF_VISION_MODEL` and for */
  /*  older stored responses (severity + immediate treatment plan).      */
  /* ------------------------------------------------------------------ */

  /** Vision engine that produced this diagnosis. */
  engine?: AssistantVisionEngine;
  /** Severity wording in the user's language ("متوسطة", "moyenne"…). */
  severity?: string | null;
  /** Share of the plant/leaf already affected, in [0, 100]. */
  severityPercent?: number | null;
  /** Symptoms the engine observed on the photo. */
  symptoms?: string[] | null;
  /** Immediate treatment steps, in priority order. */
  treatment?: string[] | null;
  /** Prevention measures for the next seasons. */
  prevention?: string[] | null;
  /** Short free-form agronomic remark. */
  notes?: string | null;
}

export type AssistantSource =
  /** Step 1 vision diagnosis + Stage 1/2 LLM reasoning. */
  | "hybrid"
  /**
   * LLM reasoning only (no vision diagnosis attached) — the Hugging Face
   * chain when it answers, otherwise the Gemini (`gemini-3.6`) fallback.
   */
  | "llm"
  /**
   * Built-in direct formatter — emitted whenever BOTH LLM stages were
   * unavailable (zero-failure strategy: always 200, never a 500). Carries a
   * diagnosis card when Step 1 succeeded, otherwise a friendly basic-mode
   * Arabic reply (greeting-aware for text-only queries).
   */
  | "direct";

export interface AssistantResponseBody {
  /** Markdown answer in Arabic (or French when requested). */
  reply: string;
  diagnosis?: AssistantDiagnosis | null;
  source: AssistantSource;
  /** Step 0 detection & cropping outcome (image requests only). */
  preprocessing?: AssistantPreprocessing | null;
  /** Non-fatal pipeline notes (e.g. "vision step skipped"). */
  warnings?: string[];
}
