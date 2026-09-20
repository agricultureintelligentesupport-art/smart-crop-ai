/**
 * Shared contracts between the assistant UI (`/assistant`) and the hybrid
 * pipeline behind `/api/assistant` (Hugging Face PlantVillage vision +
 * Hugging Face LLM reasoning, with a smaller-model fallback).
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

export interface AssistantRequestBody {
  message?: string;
  image?: AssistantImagePayload;
  context?: AssistantContext;
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
  /** Top candidates (max 3), highest first. */
  candidates: DiagnosisCandidate[];
}

export type AssistantSource =
  /** Vision diagnosis + HF LLM reasoning. */
  | "hybrid"
  /** HF LLM only (no image attached). */
  | "llm"
  /**
   * Built-in direct formatter — emitted whenever the Step 2 LLM chain was
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
  /** Non-fatal pipeline notes (e.g. "vision step skipped"). */
  warnings?: string[];
}
