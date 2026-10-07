/**
 * Shared contracts between the assistant UI (`/assistant`) and the
 * fail-proof orchestrator behind `/api/assistant`:
 *   Step 1  image analysis — Gemini (`gemini-3.8-flash`, PRIMARY) → MobileNetV2
 *           PlantVillage on Hugging Face (FALLBACK),
 *   Step 2  Hugging Face LLM chain (primary text model),
 *   Step 3  Google Gemini (`gemini-3.8-flash`, format-only text fallback),
 *   Step 4  built-in TypeScript direct formatters (never fails).
 *
 * The inter-stage payload exchanged by the image and text stages is
 * `AnalysisData` from `@/lib/assistant/analysis`.
 *
 * Kept dependency-free and importable from both server and client code.
 */

import type { AnalysisSource, TextSource } from "@/lib/assistant/analysis";

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
 * Outcome of the (removed) leaf Detection & Cropping pre-step. The stage is
 * gone from the pipeline, so the field now always reports `skipped` on image
 * responses — it is kept on the wire so clients and stored history keep
 * parsing, and so the stage can be restored without a format change.
 */
export interface AssistantPreprocessing {
  /**
   * cropped      — a leaf was detected and only the cropped region reached
   *                the classifier;
   * no-leaf      — the detector found no usable leaf box (or the crop would
   *                have kept the whole frame) — the original image was used;
   * unavailable  — the detection endpoint could not be reached (network,
   *                loading, unexpected payload) — the original image was used;
   * skipped      — the stage did not run: leaf cropping is removed from the
   *                pipeline, Hugging Face is soft-blocked, or no token was
   *                configured.
   */
  status: "cropped" | "no-leaf" | "unavailable" | "skipped";
  /** Detector model id, when a detection call was attempted. */
  detector: string | null;
  /** Crop window on the ORIGINAL image, [left, top, width, height]. */
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
  /**
   * Manual model choice from the chat's model selector — a catalog id
   * (`"phyto-3.8"` | `"phyto-3.5"` | `"phyto-2.5"`), the friendly name
   * (`"phyto 3.5"`) or the raw Gemini id. See
   * `@/lib/assistant/model-choice`; unknown values are ignored and the request
   * runs with the default chain.
   */
  model?: string;
}

/** One raw candidate from the vision classifier. */
export interface DiagnosisCandidate {
  label: string;
  score: number;
}

/**
 * Which vision engine produced a {@link AssistantDiagnosis}.
 *   • `gemini-vision`     — Gemini (`gemini-3.8-flash`) image analysis, the
 *     PRIMARY image model of the orchestrator;
 *   • `plantvillage-hf`   — Hugging Face MobileNetV2 PlantVillage classifier,
 *     the FALLBACK image model, reached only when Gemini's analysis failed.
 * Optional: most diagnoses carry no engine tag, and every consumer treats the
 * field as informational only.
 */
export type AssistantVisionEngine = "gemini-vision" | "plantvillage-hf";

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
  /** Image analysis succeeded + a text model narrated it. */
  | "hybrid"
  /**
   * Text-model reasoning only (no image analysis) — the Hugging Face chain
   * when it answers, otherwise the Gemini (`gemini-3.8-flash`) fallback.
   */
  | "llm"
  /**
   * Built-in direct formatter — emitted whenever BOTH text models were
   * unavailable (zero-failure strategy: always 200, never a 500). Carries a
   * diagnosis card when the image stage succeeded, otherwise a friendly
   * basic-mode Arabic reply (greeting-aware for text-only queries).
   */
  | "direct";

export interface AssistantResponseBody {
  /** Markdown answer in Arabic (or French when requested). */
  reply: string;
  diagnosis?: AssistantDiagnosis | null;
  source: AssistantSource;
  /** Leaf-cropping outcome — always `skipped` now (the stage is removed). */
  preprocessing?: AssistantPreprocessing | null;
  /**
   * Which image model produced `diagnosis` — `"gemini"` (primary) or
   * `"mobilenet"` (fallback). `null` for text-only requests and for the
   * Step 4 final fallback where no image model could answer. Carried for
   * debugging and analytics; the user only ever sees `reply`.
   */
  analysisSource?: AnalysisSource | null;
  /**
   * Which text model narrated the analysis — `"huggingface"` (primary) or
   * `"gemini_fallback"` (Step 3). `null` when no text model ran, i.e. the
   * built-in direct formatter answered or Step 4 replied on its own.
   */
  textSource?: TextSource | null;
  /** Non-fatal pipeline notes (e.g. "image analysis fell back to MobileNetV2"). */
  warnings?: string[];
}
