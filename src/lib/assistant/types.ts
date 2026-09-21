/**
 * Shared contracts between the assistant UI (`/assistant`) and the fail-proof
 * chain behind `/api/assistant`:
 *   Step 0  Hugging Face leaf detection & smart cropping (image requests),
 *   Step 1  Field-trained Vision Transformer (ViT) plant-disease classifier
 *           on the Hugging Face Serverless Inference API (free tier),
 *   Step 2  Google Gemini — the SOLE conversational orchestrator and final
 *           response generator (diagnosis + context + conversation history
 *           in, Arabic reply out),
 *   Safety net  built-in TypeScript direct formatters (never fail).
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
   * Recent conversation turns (oldest first), EXCLUDING the current
   * exchange. Lets Step 2 (Gemini) answer with full context instead of
   * rehashing earlier advice. Server-side capped (recent 10 turns, 1500
   * chars each) and sanitised before use.
   */
  history?: AssistantHistoryEntry[];
}

/** One raw candidate from the vision classifier. */
export interface DiagnosisCandidate {
  label: string;
  score: number;
}

/**
 * One turn of the recent conversation, sent by the client so Step 2 (Gemini)
 * can build on the previous turns (smart memory / progressive detailing).
 * The route sanitises it (valid roles, non-empty text, strict alternation,
 * recent-10 cap) before it ever reaches the Gemini API.
 */
export interface AssistantHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

/** Structured result of the Step 1 field-trained ViT vision diagnosis. */
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
  /** Step 1 ViT diagnosis + Step 2 Gemini reply (the full pipeline). */
  | "hybrid"
  /**
   * Step 2 Gemini reply only (no vision diagnosis attached) — Gemini is the
   * sole LLM, so any `"llm"` reply is Gemini's.
   */
  | "llm"
  /**
   * Built-in direct formatter — emitted whenever Step 2 (Gemini) was
   * unavailable (zero-failure strategy: always 200, never a 500). Carries a
   * diagnosis card when Step 1 succeeded (the client then does NOT show its
   * amber fallback warning), otherwise a friendly basic-mode Arabic reply
   * (greeting-aware for text-only queries) — that is the
   * "both classification and Gemini failed completely" case that surfaces
   * the warning.
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
