/**
 * Shared contracts between the assistant UI (`/assistant`) and the fail-proof
 * chain behind `/api/assistant`:
 *   Step 0  leaf detection & cropping,
 *   Step 1  Hugging Face MobileNetV2 PlantVillage vision diagnosis (the FULL
 *           logit vector, and the strict diagnostic authority),
 *   Step 1.5 interactive diagnosis — below 60% Top-1 the route returns
 *           `requiresClarification` + `questions` (source `"clarification"`)
 *           and the wizard's answer masks + recalculates the vector,
 *   Stage 1 Google Gemini (primary LLM — a locked formatter after a mask),
 *   Stage 2 Hugging Face LLM chain (fallback),
 *   Stage 3 built-in TypeScript direct formatters (never fails).
 *
 * Kept dependency-free and importable from both server and client code; the
 * taxonomy types are re-exported from `@/lib/vision/taxonomyFilter` so the UI
 * imports one module.
 */

import type {
  ClarificationQuestion,
  DiagnosisFilterReport,
  DiagnosisUserAnswers,
  RawPrediction,
} from "@/lib/vision/taxonomyFilter";

export type { ClarificationQuestion, DiagnosisFilterReport, DiagnosisUserAnswers, RawPrediction };

export interface AssistantContext {
  /** Two-digit wilaya code from the stored profile, e.g. "07". */
  wilayaCode?: string | null;
  /** Human-readable wilaya name (Arabic) resolved on the client. */
  wilayaName?: string | null;
  /** Preferred crop label (Arabic) resolved on the client. */
  crop?: string | null;
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
   * cropped      — a leaf was detected and only the cropped region reached
   *                the classifier;
   * no-leaf      — the detector found no usable leaf box (or the crop would
   *                have kept the whole frame) — the original image was used;
   * unavailable  — the detection endpoint could not be reached (network,
   *                loading, unexpected payload) — the original image was used;
   * skipped      — no Hugging Face token is configured, so detection cannot
   *                run (mirrors the Step 1 skip).
   */
  status: "cropped" | "no-leaf" | "unavailable" | "skipped";
  /** Detector model id, when a detection call was attempted. */
  detector: string | null;
  /** Crop window on the ORIGINAL image, [left, top, width, height]. */
  box: [number, number, number, number] | null;
  /** Wall-clock cost of the whole stage (detection + crop), in ms. */
  durationMs: number;
}

export interface AssistantRequestBody {
  message?: string;
  image?: AssistantImagePayload;
  context?: AssistantContext;
  /**
   * Second pass only — the farmer's answers to the interactive questionnaire.
   * Present ⇒ MobileNetV2's full vector is masked against them and the Top-1
   * of the masked vector becomes the diagnostic authority (no re-asking).
   */
  userAnswers?: DiagnosisUserAnswers;
  /**
   * Second pass only (optional) — the raw MobileNetV2 vector echoed back from
   * the first pass, so the same photo is not classified twice. Accepted only
   * when every row resolves to a known PlantVillage class and carries a finite
   * score; anything else is ignored and the image is re-classified.
   */
  predictions?: RawPrediction[];
}

/** One raw candidate from the vision classifier. */
export interface DiagnosisCandidate {
  label: string;
  score: number;
}

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
  /** Top candidates (max 3), highest first — AFTER taxonomy masking. */
  candidates: DiagnosisCandidate[];
  /**
   * Short Arabic symptoms of this exact class, from `DISEASE_TAXONOMY`.
   * Handed to the formatter LLM so its report describes what is really
   * visible on this disease instead of inventing generic symptoms.
   */
  symptoms?: string[];
  /** True when the interactive wizard + taxonomy masking produced this verdict. */
  filtered?: boolean;
}

export type AssistantSource =
  /** Step 1 vision diagnosis + Stage 1/2 LLM reasoning. */
  | "hybrid"
  /**
   * LLM reasoning only (no vision diagnosis attached) — Gemini
   * (`gemini-1.5-flash`) when it answers, otherwise the Hugging Face fallback
   * chain.
   */
  | "llm"
  /**
   * First pass of the interactive diagnosis flow: MobileNetV2's Top-1 was
   * below the clarification threshold, so the route stopped and asked the
   * farmer for the crop instead of forwarding a shaky verdict to the LLM.
   */
  | "clarification"
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
  /**
   * Interactive diagnosis (first pass, image + Top-1 confidence < 60%):
   * the route asks BEFORE diagnosing instead of guessing. The frontend renders
   * `questions`, then re-sends the original image plus `userAnswers`.
   */
  requiresClarification?: boolean;
  /** The questionnaire to render when `requiresClarification` is true. */
  questions?: ClarificationQuestion[];
  /** Masking/recalculation report of the second pass (transparency). */
  filtered?: DiagnosisFilterReport | null;
  /**
   * MobileNetV2's raw logit vector (sorted, highest first) — sent ONLY with
   * the clarification request so the frontend can echo it back on the second
   * pass and the same photo is not classified twice.
   */
  predictions?: RawPrediction[];
}
