/**
 * `/api/assistant` — the fail-proof plant-diagnosis orchestrator. The route
 * NEVER returns HTTP 500.
 *
 * The pipeline runs a STRICT priority order with an explicit fallback chain.
 * An attached photo triggers the full orchestration; a text-only question
 * skips the image stage entirely and goes straight to the text stages.
 *
 *   STEP 1 — IMAGE ANALYSIS (photo requests)
 *     PRIMARY  · Google Gemini (`gemini-3.8-flash`, overridable with
 *               `GEMINI_MODEL` → `gemini-3.5-flash` → `gemini-3.5-flash-lite`
 *               on a retired
 *               id). A multimodal model that inspects the photo and is
 *               constrained by `responseMimeType: "application/json"` +
 *               `responseSchema` to answer with an `AnalysisData` object
 *               (`@/lib/assistant/analysis`). It receives the ORIGINAL
 *               frame, not the Step 0 crop, because it reasons over the whole
 *               scene.
 *     FALLBACK · MobileNetV2 PlantVillage
 *               (`linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`,
 *               overridable with `HF_VISION_MODEL`) on the free Hugging Face
 *               router, fed the Step 0 crop. Reached ONLY after the Gemini
 *               analysis failed; its raw `{ label, score }` is mapped into the
 *               SAME `AnalysisData` shape.
 *     BOTH DOWN · STEP 4 — no text model is ever called with empty data: the
 *               user gets a pre-written, polite "retry with a clearer photo"
 *               message.
 *
 *     Gemini is considered to have FAILED — and only then is MobileNetV2
 *     called — on: (a) an API/network error or timeout; (b) Gemini refusing
 *     or returning no usable text; (c) a response that is not valid JSON or
 *     is missing a required field. A LOW `confidence` is deliberately NOT a
 *     failure: the orchestrator has no confidence threshold, and an unsure
 *     but well-formed verdict is passed straight through to the text stage.
 *
 *   STEP 2 — TEXT GENERATION (PRIMARY: Hugging Face)
 *     The open Qwen chain through the official Inference Providers router
 *     (`https://router.huggingface.co/v1/chat/completions`, Bearer
 *     `HUGGINGFACE_API_KEY` / `HF_TOKEN`), led by
 *     `Qwen/Qwen3-4B-Instruct-2507`. Its ONLY job is to narrate ANALYSIS_DATA
 *     into a clear, user-facing explanation with a practical recommendation.
 *     A failure is: (a) an API/network error or timeout; (b) an empty,
 *     malformed or nonsensical reply; (c) a reply that does not correspond
 *     to ANALYSIS_DATA.
 *
 *   STEP 3 — TEXT FALLBACK (Google Gemini, FORMAT-ONLY)
 *     Runs ONLY after Step 2 failed. The same Gemini model chain and key pool
 *     (`GEMINI_API_KEY` + `GEMINI_API_KEYS` + numbered `GEMINI_API_KEY_N`,
 *     rotated on 429 / RESOURCE_EXHAUSTED / quota; one shared 18 s
 *     `AbortController` for the whole chain) turn the SAME `AnalysisData` into
 *     the same kind of explanation. NO image is attached here: Gemini must
 *     format the data, not re-analyse the photo. This branch also covers the
 *     edge case where the analysis came from MobileNetV2 and Step 2 then
 *     failed.
 *
 *   BUILT-IN FORMATTER (both text models down)
 *     Never fails: a concise Arabic diagnosis card built from the analysis,
 *     or a greeting-aware basic-mode reply for a text-only question.
 *
 *   DEMO MOCK (ON by default — `DEMO_MOCK=0` restores the pipeline)
 *     `getDemoMockResponse` (@/lib/assistant/demo-mock) answers the SCRIPTED
 *     demo prompts (greeting, self-introduction, "explain more", French,
 *     first photo, second photo) from a canned script after a simulated
 *     600 ms round-trip, and it does so BEFORE any provider key is read — so a
 *     demo/pitch recording cannot burn or hit a quota, whatever the provider
 *     state is, and cannot fall back to the old basic-mode reply just because
 *     a deployment lacks `.env.local`. Any turn outside the script returns
 *     null and the whole pipeline below runs untouched. Set `DEMO_MOCK=0`
 *     (alias `PHYTOSCAN_DEMO_MOCK=0`) in the environment to switch every
 *     scripted prompt back to the real orchestrator — the automated test suite
 *     pins exactly that.
 *
 *   STEP 0 (pre-step, photo requests only) — leaf Detection & Cropping.
 *     The free Hugging Face router also runs an open-source object detector:
 *     the COCO `facebook/detr-resnet-50` (DETR-ResNet-50) with a plant-only
 *     label filter (chain overridable via `HF_LEAF_DETECT_MODELS`). The
 *     detected box is grown into a padded, clamped crop window and sharp
 *     crops the photo, so background noise (hands, soil, pots) never reaches
 *     the narrow classifier. The crop feeds the MobileNetV2 FALLBACK only —
 *     Gemini, the primary image model, sees the untouched frame. Strictly an
 *     accuracy pre-step: every failure mode (missing HF key, undecodable
 *     image, unreachable/loading detector, a non-detection payload, or "no
 *     leaf above threshold") is non-fatal and falls back to the original.
 *     The outcome is reported in `preprocessing` on the response.
 *
 *   Contract between the stages: `AnalysisData` is the single payload the
 *   text stage ever sees, so it cannot tell — and is never told — which image
 *   model produced it. `analysisSource` ("gemini" | "mobilenet") and
 *   `textSource` ("huggingface" | "gemini_fallback") ride along on every
 *   response purely for logging and analytics; the user only ever sees the
 *   final `reply`.
 *
 * Gemini credentials — every environment variable starting with
 * `GEMINI_API_KEY` (`GEMINI_API_KEY`, the `GEMINI_API_KEYS` comma-separated
 * pool, and numbered `GEMINI_API_KEY_N` variants; combined, trimmed,
 * deduplicated, rotation-ordered) — and the Hugging Face secret
 * (`HUGGINGFACE_API_KEY`, with Hugging Face's conventional `HF_TOKEN` accepted
 * as an alias) are read from `process.env` on the server only. They are never
 * shipped to the browser and never echoed back in a response body.
 *
 * Status contract: 200 for every AI outcome (including all upstream
 * failures); 400/413 only for invalid client input; 503 + code MISSING_KEYS
 * when NO provider key is configured at all (the explicit
 * server-misconfiguration signal — never reached for a scripted turn while
 * the demo mock is enabled: it answers 200 with zero keys configured). No
 * HTTP 500 ever.
 *
 * Error reporting: each stage logs to the server console —
 * `[Step 1: Gemini Analysis Success]` / `[Step 1: MobileNetV2 Fallback
 * Success]` mark a successful image analysis, `[Step 1: Gemini Analysis
 * Failed → MobileNetV2]` / `[Step 1: MobileNetV2 Unavailable]` mark the
 * degradation, `[Step 2: HF LLM Success]` / `[Step 3: Gemini Formatter
 * Success]` mark which text model answered, and `[Step 4: Final Fallback]`
 * plus the final `[Orchestrator] analysisSource=… textSource=…` line make the
 * whole route's behaviour greppable in one place. Non-fatal degradations are
 * surfaced to the client in `warnings[]`.
 */

import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import {
  GeminiModelHealthMonitor,
  formatGeminiHealthReport,
  resolveGeminiModels as resolveGeminiChain,
  type GeminiModel,
} from "@/lib/assistant/gemini-models";
import {
  ANALYSIS_RESPONSE_SCHEMA,
  SEVERITY_AR,
  analysisToDiagnosis,
  buildAnalysisInstruction,
  classificationToAnalysis,
  parseAnalysisJson,
  type AnalysisData,
  type AnalysisResult,
  type TextSource,
} from "@/lib/assistant/analysis";
import {
  LEAF_DETECT_DEFAULTS,
  parseObjectDetections,
  selectLeafCrop,
  type CropRect,
  type LeafDetection,
} from "@/lib/assistant/leaf-detect";
import { confidenceBucket, diseaseFamilyForArabic, parsePlantLabel } from "@/lib/assistant/plantvillage";
import {
  buildDemoMockMessages,
  getDemoMockResponse,
  isDemoMockEnabled,
} from "@/lib/assistant/demo-mock";
import type {
  AssistantContext,
  AssistantDiagnosis,
  AssistantImagePayload,
  AssistantHistoryTurn,
  AssistantPreprocessing,
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
 * Step 1 — the PlantVillage classifier on the HF Inference API.
 *
 * Clean, single-model pipeline (400-error elimination): the PRIMARY
 * classifier is the known-good MobileNetV2 PlantVillage model
 * `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`, served on
 * Hugging Face's free serverless tier. The obsolete field-trained cascade
 * ids (`dima806/plant_disease_image_detection`, `fxmeng/plantdoc-vit`), the
 * 400-prone tertiary (`wambugu71/crop_leaf_diseases_vit`) and the legacy
 * `Abuzaid01/…` / `nateraw/…` experiments are REMOVED — one id that
 * actually answers, one round-trip.
 *
 * Environment override: `HF_VISION_MODEL` (single Hub id) replaces the
 * default when set (e.g. to pin a self-hosted or retrained checkpoint).
 */
export const HF_VISION_MODELS = [
  "linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification",
] as const;

const HF_ENDPOINT = (model: string) =>
  `https://router.huggingface.co/hf-inference/models/${model}`;

/* ------------------------------------------------------------------ */
/*  Step 0 — leaf detection & smart cropping (open detector + sharp)   */
/* ------------------------------------------------------------------ */

/**
 * Step 0 model chain (object-detection), tried in order, through the SAME
 * hf-inference router endpoint as the Step 1 classifier:
 *
 *   • `facebook/detr-resnet-50` — PRIMARY detector: the open-source
 *     DETR-ResNet-50 trained on COCO. Only its plant-flavoured labels
 *     ("potted plant", …) are accepted, so a plant photo still crops while
 *     a photo of the farmer's hand never passes the label filter. The
 *     obsolete fine-tuned PlantDoc checkpoint
 *     (`suryanshgoel/detr-finetuned-plantdoc`) is REMOVED — it is not
 *     reliably served on the free router anymore and its failures only
 *     cost a round-trip before the COCO id answered anyway.
 *
 * Open-source and free — the weights live on Hugging Face's infrastructure,
 * the function only parses the returned boxes, so the serverless bundle and
 * the cold start stay untouched.
 */
interface LeafDetectModel {
  id: string;
  /** Which detected labels count as leaf/plant material for this id. */
  acceptLabel: (label: string) => boolean;
}

const DEFAULT_LEAF_DETECT_MODELS: LeafDetectModel[] = [
  { id: "facebook/detr-resnet-50", acceptLabel: (label) => /plant|leaf/i.test(label) },
];

/**
 * `HF_LEAF_DETECT_MODELS="id1,id2"` overrides the chain (e.g. to pin a
 * self-hosted or newer detector). Custom ids have no known label space, so
 * their accepted labels are: clearly plant-flavoured words, or the unnamed
 * `LABEL_n` indices most fine-tuned checkpoints ship with.
 */
function resolveLeafDetectModels(): LeafDetectModel[] {
  const raw = process.env.HF_LEAF_DETECT_MODELS?.trim();
  if (!raw) return DEFAULT_LEAF_DETECT_MODELS;
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return DEFAULT_LEAF_DETECT_MODELS;
  return ids.map((id) => ({
    id,
    acceptLabel: (label: string) =>
      /plant|leaf|weed|crop/i.test(label) || /^LABEL_\d+$/i.test(label),
  }));
}

/**
 * Detection is a pre-step, not the main act: a tighter deadline than the
 * classifier so a sleepy detector can never eat the request budget.
 */
const LEAF_DETECT_TIMEOUT_MS = 9_000;

/** Re-encoded crop constraints — mirror the client's own downscale. */
const LEAF_CROP_MAX_EDGE_PX = 1024;
const LEAF_CROP_JPEG_QUALITY = 88;

/** Smallest image worth cropping (below this, the frame IS the leaf). */
const LEAF_CROP_MIN_DIMENSION_PX = 8;

interface LeafDetectOutcome {
  model: string;
  detections: LeafDetection[];
}

/**
 * Strict Step 0 detection round-trip: POST the raw image bytes to the
 * object-detection endpoint (same auth + `X-Wait-For-Model` pattern as Step
 * 1), validate the payload shape, walk the model chain on loading/404/shape
 * errors. Throws (message prefixed "HF Error:") when every id failed — the
 * caller treats that as "stage unavailable" and keeps the full frame.
 */
async function detectLeafStrict(
  source: Buffer,
  apiKey: string,
): Promise<LeafDetectOutcome> {
  let lastDetail = "no detection model was attempted";

  for (const model of resolveLeafDetectModels()) {
    try {
      const res = await fetch(HF_ENDPOINT(model.id), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "image/jpeg",
          // Ask the HF router to wait for a cold model instead of 503ing.
          "X-Wait-For-Model": "true",
        },
        body: new Uint8Array(source),
        signal: AbortSignal.timeout(LEAF_DETECT_TIMEOUT_MS),
      });

      if (res.status === 503 || res.status === 530) {
        lastDetail = `${model.id}: model loading (HTTP ${res.status})`;
        console.warn(`[Step 0: Detect Loading] ${lastDetail}`);
        continue;
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => res.statusText);
        let detail = `HTTP ${res.status}${bodyText ? ` — ${bodyText.slice(0, 200)}` : ""}`;
        try {
          const j = JSON.parse(bodyText) as { error?: string };
          if (j?.error) detail = `HTTP ${res.status} — ${j.error}`;
        } catch {
          // keep the raw detail
        }
        lastDetail = `${model.id}: ${detail}`;
        console.warn(`[Step 0: Detect Warning] ${lastDetail}`);
        continue;
      }

      const json: unknown = await res.json();
      if (!Array.isArray(json)) {
        lastDetail = `${model.id}: payload is not a detection array`;
        console.warn(`[Step 0: Detect Warning] ${lastDetail}`);
        continue;
      }
      const parsed = parseObjectDetections(json);
      if (parsed.length === 0 && json.length > 0) {
        // A 200 whose items are not detection-shaped (e.g. a classification
        // array) — this id is not serving object detection; walk the chain.
        lastDetail = `${model.id}: ${json.length} payload items, none a valid detection`;
        console.warn(`[Step 0: Detect Warning] ${lastDetail}`);
        continue;
      }

      const detections = parsed.filter((det) => model.acceptLabel(det.label));
      return { model: model.id, detections };
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      lastDetail = `${model.id}: ${detail}`;
      console.warn(`[Step 0: Detect Warning] ${lastDetail}`);
    }
  }

  throw new Error(`HF Error: leaf detection failed — ${lastDetail}`);
}

/** Crop the detected window out of the source photo and re-encode it. */
async function cropLeafImage(source: Buffer, rect: CropRect): Promise<Buffer> {
  return sharp(source)
    .extract(rect)
    .resize({
      width: LEAF_CROP_MAX_EDGE_PX,
      height: LEAF_CROP_MAX_EDGE_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: LEAF_CROP_JPEG_QUALITY })
    .toBuffer();
}

/**
 * Step 0 orchestration: detect the leaf, crop to it, and return BOTH the
 * stage report (`AssistantPreprocessing`) and the image the classifier must
 * receive — the cropped pixels on success, the untouched original in every
 * other case. Never throws: any internal failure is converted into an
 * "unavailable" report plus a non-fatal warning.
 */
async function runLeafDetectionStage(
  image: AssistantImagePayload,
  huggingfaceKey: string | null,
  warnings: string[],
): Promise<{ preprocessing: AssistantPreprocessing; image: AssistantImagePayload }> {
  const original: AssistantImagePayload = { data: image.data, mimeType: image.mimeType };

  if (!huggingfaceKey) {
    // Same configuration gap Step 1 reports; Step 0 stays silent in
    // `warnings[]` to avoid a duplicated line — the Step 1 skip already
    // warns with the exact reason.
    console.warn("[Step 0: Detect Skipped] no Hugging Face token — leaf detection skipped.");
    return {
      preprocessing: { status: "skipped", detector: null, box: null, durationMs: 0 },
      image: original,
    };
  }

  const startedAt = Date.now();
  try {
    const source = Buffer.from(image.data, "base64");
    const metadata = await sharp(source).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width < LEAF_CROP_MIN_DIMENSION_PX || height < LEAF_CROP_MIN_DIMENSION_PX) {
      throw new Error(`image is not decodable or too small to crop (${width}×${height})`);
    }

    const { model, detections } = await detectLeafStrict(source, huggingfaceKey);
    const decision = selectLeafCrop(detections, width, height, {
      minScore: LEAF_DETECT_DEFAULTS.minScore,
    });
    if (!decision) {
      console.log(
        `[Step 0: Detect NoLeaf] model=${model} above-threshold=${detections.length} — the full frame goes to Step 1`,
      );
      return {
        preprocessing: {
          status: "no-leaf",
          detector: model,
          box: null,
          durationMs: Date.now() - startedAt,
        },
        image: original,
      };
    }

    const cropped = await cropLeafImage(source, decision.rect);
    const durationMs = Date.now() - startedAt;
    console.log(
      `[Step 0: Detect Success] model=${model} box=${decision.rect.left},${decision.rect.top}+${decision.rect.width}x${decision.rect.height} coverage=${Math.round(decision.coverage * 100)}% top=${Math.round(decision.topScore * 100)}% ${durationMs}ms — ONLY the crop goes to Step 1`,
    );
    return {
      preprocessing: {
        status: "cropped",
        detector: model,
        box: [
          decision.rect.left,
          decision.rect.top,
          decision.rect.width,
          decision.rect.height,
        ],
        durationMs,
      },
      image: { data: cropped.toString("base64"), mimeType: "image/jpeg" },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[Step 0: Detect Unavailable] ${detail} — the full frame goes to Step 1`);
    warnings.push(`Step 0 leaf detection unavailable — ${detail}`.slice(0, 400));
    return {
      preprocessing: {
        status: "unavailable",
        detector: null,
        box: null,
        durationMs: Date.now() - startedAt,
      },
      image: original,
    };
  }
}

/* ---- Google Gemini — shared by Step 1 (analysis) and Step 3 (text)  */

/**
 * The ordered Gemini chain — used for BOTH the Step 1 image analysis and the
 * Step 3 text fallback — is resolved per request from the shared
 * `@/lib/assistant/gemini-models` module, so the route, the
 * `tools/check-gemini-models.mjs` CLI and the health check below can never
 * drift apart. That drift is the failure mode that let `gemini-3.6` (a model
 * id Google never shipped) sit in production until every request 404'd and
 * every photo silently degraded to MobileNetV2.
 *
 * The default is `gemini-3.8-flash`; `GEMINI_MODEL` pins a different primary
 * and ids the health check proved unavailable are dropped from the chain, so a
 * retired id costs no round-trip.
 */
function resolveGeminiModels(): GeminiModel[] {
  return resolveGeminiChain(process.env.GEMINI_MODEL, geminiModelHealth.unavailableModels);
}


/**
 * Hard timeout for the WHOLE Gemini model chain: 18 s. A full Arabic
 * ~200-word answer (system prompt + profile context + vision verdict in, up
 * to {@link GEMINI_MAX_OUTPUT_TOKENS} out) regularly takes 10–15 s on a cold
 * Flash model; the previous 9 s window aborted those healthy generations
 * mid-flight and sent the request to the weaker fallbacks for nothing. 18 s
 * still leaves the built-in formatter comfortably
 * inside {@link maxDuration}. Enforced with an explicit `AbortController`
 * (not `AbortSignal.timeout`) so the abort reason and the timer are both
 * inspectable/clearable per request; a fast 404 on an earlier id hands the
 * remaining budget to the next id.
 */
const GEMINI_TIMEOUT_MS = 18_000;

/**
 * Output cap for a Gemini call. Slightly above {@link MAX_REPLY_TOKENS} because
 * Gemini counts any internal reasoning tokens against `maxOutputTokens`;
 * the per-generation thinking payload (`thinkingLevel: "low"` on 3.x,
 * `thinkingBudget: 0` on 2.5, none on 1.5/2.0) keeps the model in fast,
 * answer-first mode so the 18 s budget is spent on the reply.
 */
const GEMINI_MAX_OUTPUT_TOKENS = 1024;

/**
 * Resolve every configured Gemini credential at request time. Every
 * environment variable whose name starts with `GEMINI_API_KEY` participates,
 * so deployments can add `GEMINI_API_KEY_3`, `GEMINI_API_KEY_4`, and so on
 * without another code change. Each value may itself be a comma-separated
 * pool. Numeric variants are sorted naturally after the base variable so
 * rotation remains deterministic (`GEMINI_API_KEY` → `_2` → `_3` …).
 * Whitespace-only entries are ignored and duplicate credentials are removed.
 */
function resolveGeminiApiKeys(): string[] {
  const prefix = "GEMINI_API_KEY";
  const configured = Object.entries(process.env)
    .filter(([name, value]) => name.startsWith(prefix) && typeof value === "string")
    .sort(([first], [second]) => {
      const order = (name: string): [number, string] => {
        if (name === prefix) return [0, name];
        const suffix = name.slice(`${prefix}_`.length);
        return [/^\d+$/.test(suffix) ? Number(suffix) : Number.POSITIVE_INFINITY, name];
      };

      const [firstRank, firstName] = order(first);
      const [secondRank, secondName] = order(second);
      return firstRank - secondRank || firstName.localeCompare(secondName);
    })
    .flatMap(([, value]) => value?.split(",") ?? []);

  return [...new Set(configured.map((key) => key.trim()).filter(Boolean))];
}

/* ---- Hugging Face — Step 1 (fallback vision) + Step 2 (text) ------ */

/**
 * Lightweight open-source LLM ids tried by Step 2 (the PRIMARY text model), in
 * order, through the Hugging Face Inference Providers router
 * ({@link HF_ROUTER_CHAT_URL}).
 *
 * Every id below is an open, NON-gated repository (no license click-through,
 * so no 403 on a fresh token) with at least one `status: "live"`
 * conversational provider in its Hub `inferenceProviderMapping` at the time
 * of writing — the router resolves the provider and fails over between
 * providers on its own:
 *   • `Qwen/Qwen3-4B-Instruct-2507` — 4B answer-first (non-thinking) model,
 *     strong Arabic, two live providers (nscale + featherless-ai);
 *   • `Qwen/Qwen2.5-7B-Instruct`     — 7B multilingual quality fallback;
 *   • `Qwen/Qwen2.5-1.5B-Instruct`   — 1.5B last resort: cheapest and
 *     fastest, still fluent enough for a short practical Arabic reply.
 *
 * The previous chain (`meta-llama/Llama-3.2-3B-Instruct`,
 * `Qwen/Qwen2.5-7B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.3`) was
 * addressed per provider at `/hf-inference/models/<id>/v1/chat/completions`.
 * That provider stopped serving chat LLMs in July 2025 (it is CPU-only:
 * classification, embeddings, BERT/GPT-2-class models), so every id 400ed
 * with "Model not supported by provider hf-inference" regardless of the
 * token; `Llama-3.2-3B` is also a gated repo (403 without accepting Meta's
 * terms) and `Mistral-7B-v0.3`'s only provider mapping is in `error` state.
 * Not-found / not-supported / gated responses still walk the chain as
 * model-availability errors, and the built-in direct formatter
 * ({@link buildDirectDiagnosisCard}) guarantees a useful reply even when the
 * whole chain is down.
 */
const HF_LLM_MODELS = [
  "Qwen/Qwen3-4B-Instruct-2507",
  "Qwen/Qwen2.5-7B-Instruct",
  "Qwen/Qwen2.5-1.5B-Instruct",
] as const;

/**
 * Official OpenAI-compatible chat-completions endpoint of the Hugging Face
 * Inference Providers router. One URL for every model: the id travels in the
 * JSON body's `model` field and the router picks a live provider for it
 * (`provider: "auto"` semantics, automatic failover). Authenticated with a
 * `Bearer` Hugging Face user access token that carries the "Inference
 * Providers" permission; the account's monthly free credits apply.
 */
const HF_ROUTER_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";

/** Hard cap on the reply — the system prompt demands brevity. */
const MAX_REPLY_TOKENS = 700;

/** ~6 MB of raw base64 ≈ 4.5 MB image — plenty for a leaf photo. */
const MAX_IMAGE_B64_CHARS = 6 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 4000;

const UPSTREAM_TIMEOUT_MS = 25_000;

/**
 * Resolve the ordered vision model list for this request. The default is the
 * single known-good MobileNetV2 PlantVillage id; `HF_VISION_MODEL` (one Hub
 * id, whitespace-trimmed) replaces it when set.
 */
function resolveVisionModels(): string[] {
  const raw = process.env.HF_VISION_MODEL?.trim();
  if (raw) return [raw];
  return [...HF_VISION_MODELS];
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

function timedFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Environment variables consulted, in order, for the Hugging Face user access
 * token that authenticates Step 0 (detector) / Step 1 (fallback vision)
 * and Step 2 (router LLM — the PRIMARY text model).
 * `HUGGINGFACE_API_KEY` is this project's documented name;
 * `HF_TOKEN` is the name Hugging Face's own SDKs/CLI read, so a deployment
 * configured the "Hugging Face way" still gets the primary LLM instead of a
 * silent skip.
 */
const HF_TOKEN_ENV_VARS = ["HUGGINGFACE_API_KEY", "HF_TOKEN"] as const;

/**
 * The first usable Hugging Face token found in the environment, whitespace
 * trimmed — or `null` when none is configured (unset or blank). Purely
 * synchronous: a missing token lets the handler skip the vision step and the
 * primary LLM instantly, with no request, no exception and no waiting.
 */
function resolveHuggingFaceToken(): string | null {
  for (const name of HF_TOKEN_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
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
 * The raw MobileNetV2 verdict, before it is mapped into the orchestrator's
 * {@link AnalysisData} shape. Kept as a separate step so the label → data
 * mapping lives in exactly one place (`analysisFromMobileNet`).
 */
interface MobileNetClassification {
  /** Top-1 raw PlantVillage label, e.g. `Tomato___Late_blight`. */
  rawLabel: string;
  /** Top-1 score in [0, 1]. */
  score: number;
  /** Model id that answered. */
  model: string;
  /** Top candidates (max 3), highest first. */
  candidates: DiagnosisCandidate[];
}

/**
 * Step 1 FALLBACK image model — MobileNetV2 PlantVillage classification via
 * Hugging Face, reached ONLY when the Gemini image analysis failed. The
 * classifier is
 * `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification` — a clean
 * single-model pipeline, the obsolete field-trained ids and the 400-prone
 * cascade fallbacks are gone. `HF_VISION_MODEL` may pin a replacement id.
 * - Sends the raw image bytes (the Step 0 crop when available) to the model.
 * - Parses the returned array to extract the primary predicted class + confidence.
 * - Handles 503/530 model-loading responses with a clear message.
 * - Per-model timeout: UPSTREAM_TIMEOUT_MS (25 s) — long enough for a cold
 *   serverless start under `X-Wait-For-Model: true`.
 * - Throws an Error prefixed with "HF Error:" on any failure so the caller can
 *   degrade to the STEP 4 final fallback.
 */
async function classifyPlantImageStrict(
  imageBase64: string,
  mimeType: string,
  apiKey: string,
): Promise<MobileNetClassification> {
  const body = Buffer.from(imageBase64, "base64");

  let lastErrorDetail: string | null = null;
  let loadingEstimate: number | null = null;

  const models = resolveVisionModels();

  for (const model of models) {
    const timeoutMs = UPSTREAM_TIMEOUT_MS;
    try {
      const res = await fetch(HF_ENDPOINT(model), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": mimeType || "application/octet-stream",
          // Ask the HF router to wait for the model instead of instantly 503ing.
          "X-Wait-For-Model": "true",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
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
        // Try next model (env override chain) before giving up — it may be warm.
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
      const candidates: DiagnosisCandidate[] = ranked
        .slice(0, 3)
        .map(({ label, score }) => ({ label, score }));

      console.log(
        `[Step 1: HF Success] label=${top.label} confidence=${pct}% model=${model} timeout=${timeoutMs}ms candidates=${candidates.length}`,
      );
      return { rawLabel: top.label, score: top.score, model, candidates };
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      if (/timeout|abort|TimeoutError|AbortError/i.test(detail) || detail.includes("timed out")) {
        console.warn(`[Step 1: HF Timeout] ${model} timed out after ${timeoutMs}ms`);
      } else {
        console.warn(`[Step 1: HF Warning] ${model} → ${detail}`);
      }
      lastErrorDetail = `${model}: ${detail}`;
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
/*  Step 1 — IMAGE ANALYSIS: Gemini (PRIMARY) → MobileNetV2 (FALLBACK)   */
/* ------------------------------------------------------------------ */

/**
 * STEP 1 of the orchestrator, PRIMARY image model: Google Gemini.
 *
 * Gemini is a multimodal model, so it inspects the photo directly and is
 * asked for a strict JSON object ({@link ANALYSIS_RESPONSE_SCHEMA}) that
 * `responseMimeType: "application/json"` + `responseSchema` pin down — no
 * prose to parse, no label vocabulary to map.
 *
 * It deliberately receives the ORIGINAL frame, not the Step 0 crop: Gemini
 * reasons over the whole scene (leaf, stem, soil, neighbouring plants) the
 * way a human agronomist would, and losing that context to a tight crop
 * would make its own `affected_parts` / `notes` fields much weaker. The crop
 * exists to stop background noise polluting a narrow classifier, so it is
 * kept for the MobileNetV2 fallback instead.
 *
 * The stage FAILS — and only then hands over to MobileNetV2 — on:
 *   a) an API/network error or timeout (surfaced as `GeminiError` by
 *      {@link runGeminiWithKeyPool});
 *   b) Gemini refusing or returning no usable text (safety block, empty
 *      candidate list);
 *   c) a response that is not valid JSON, is not an object, or is missing any
 *      required field (surfaced as `AnalysisParseError` by
 *      {@link parseAnalysisJson}).
 *
 * A LOW `confidence` is explicitly NOT a failure. The orchestrator has no
 * confidence threshold: an unsure-but-well-formed verdict is legitimate data
 * and is passed through to the text stage unchanged, which simply hedges its
 * wording.
 */
/**
 * True when a failure is specifically Gemini rejecting the structured-output
 * parameters we sent (`responseSchema` / `response_format`) rather than the
 * model id or the key. Gemini has been migrating that surface (the newer
 * Interactions API uses `response_format`), so a freshly-rotated model id can
 * legitimately refuse a `generationConfig` field the previous one accepted.
 */
function isStructuredOutputRejection(error: unknown): boolean {
  if (!(error instanceof GeminiError) || error.status !== 400) return false;
  return /response[_]?schema|response[_]?format|generationConfig/i.test(
    error.message,
  );
}

async function analyzeImageWithGemini(
  image: AssistantImagePayload,
  geminiApiKeys: readonly string[],
  lang: "ar" | "fr",
): Promise<AnalysisResult> {
  const userContent =
    lang === "fr"
      ? "Analyse la photo de la plante jointe et renvoie uniquement l'objet JSON demandé."
      : "حلّل صورة النبتة المرفقة وأعد كائن JSON المطلوب.";

  const runAnalysis = async (
    extraConfig: Record<string, unknown>,
  ): Promise<GeminiResult> =>
    runGeminiWithKeyPool(
      {
        systemInstruction: buildAnalysisInstruction(lang),
        userContent,
        image,
        extraConfig,
      },
      geminiApiKeys,
    );

  let result: GeminiResult;
  try {
    result = await runAnalysis({
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
    });
  } catch (error) {
    if (!isStructuredOutputRejection(error)) throw error;
    // The model would not take the schema constraint. Retry once with only
    // the JSON MIME hint: `parseAnalysisJson` still validates the result, and
    // a schema-less reply that does not conform fails the stage exactly like
    // any other malformed payload.
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Step 1: Gemini Analysis] responseSchema rejected by the model — retrying with responseMimeType only: ${detail}`,
    );
    result = await runAnalysis({ responseMimeType: "application/json" });
  }

  // (c) — the payload must be a complete AnalysisData object.
  const data = parseAnalysisJson(result.text);

  console.log(
    `[Step 1: Gemini Analysis Success] model=${result.model} ` +
      `plant=${data.plant_type ?? "unknown"} detected=${data.disease_detected} ` +
      `disease=${data.disease_name ?? "none"} confidence=${Math.round(data.confidence * 100)}%`,
  );
  return {
    data,
    source: "gemini",
    diagnosis: analysisToDiagnosis(data, "gemini", { model: result.model, lang }),
  };
}

/**
 * STEP 1 of the orchestrator, FALLBACK image model: MobileNetV2.
 *
 * Reached ONLY when {@link analyzeImageWithGemini} failed. Its raw
 * `{ label, score }` output is mapped into the identical
 * {@link AnalysisData} shape so the text stage cannot tell the two image
 * models apart, and the runner-up classifications are preserved for the
 * diagnosis card only.
 */
function analysisFromMobileNet(
  rawLabel: string,
  score: number,
  model: string,
  candidates: DiagnosisCandidate[],
  lang: "ar" | "fr",
): AnalysisResult {
  const data = classificationToAnalysis(rawLabel, score);
  return {
    data,
    source: "mobilenet",
    diagnosis: analysisToDiagnosis(data, "mobilenet", {
      model,
      lang,
      rawLabel,
      candidates,
    }),
  };
}

/**
 * STEP 1 — the whole image stage.
 *
 * Runs the strict priority order of the spec: Gemini first, MobileNetV2
 * second and ONLY if Gemini failed, and `null` when neither could analyse the
 * photo (which routes the request to STEP 4 — no text model is ever called
 * with empty data).
 *
 * Never throws: every failure is converted into a warning plus a `null`
 * result, so a vision outage can never fail the HTTP request.
 *
 * `geminiImage` is the untouched original frame; `mobilenetImage` is the Step 0
 * crop when detection succeeded, the full frame otherwise.
 */
async function runImageAnalysisStage(options: {
  geminiImage: AssistantImagePayload;
  mobilenetImage: AssistantImagePayload;
  geminiApiKeys: readonly string[];
  huggingfaceKey: string | null;
  lang: "ar" | "fr";
  warnings: string[];
}): Promise<AnalysisResult | null> {
  const { geminiImage, mobilenetImage, geminiApiKeys, huggingfaceKey, lang, warnings } = options;

  // ---- PRIMARY: Gemini -------------------------------------------------
  if (geminiApiKeys.length > 0) {
    try {
      return await analyzeImageWithGemini(geminiImage, geminiApiKeys, lang);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Step 1: Gemini Analysis Failed → MobileNetV2] ${detail}`);
      warnings.push(`Step 1 Gemini image analysis failed — ${detail}`.slice(0, 400));
    }
  } else {
    const detail = "No GEMINI_API_KEY is configured — the primary image model is unavailable.";
    console.warn(`[Step 1: Gemini Skipped] ${detail} → MobileNetV2 fallback`);
    warnings.push(`Step 1 Gemini image analysis unavailable — ${detail}`.slice(0, 400));
  }

  // ---- FALLBACK: MobileNetV2 (only reachable after the primary failed) --
  if (!huggingfaceKey) {
    const detail =
      "HUGGINGFACE_API_KEY is not configured (HF_TOKEN unset too) — the fallback image model is unavailable.";
    console.warn(`[Step 1: MobileNetV2 Skipped] ${detail}`);
    warnings.push(`Step 1 MobileNetV2 unavailable — ${detail}`.slice(0, 400));
    return null;
  }

  try {
    const classification = await classifyPlantImageStrict(
      mobilenetImage.data,
      mobilenetImage.mimeType,
      huggingfaceKey,
    );
    const result = analysisFromMobileNet(
      classification.rawLabel,
      classification.score,
      classification.model,
      classification.candidates,
      lang,
    );
    console.log(
      `[Step 1: MobileNetV2 Fallback Success] label=${classification.rawLabel} ` +
        `confidence=${Math.round(classification.score * 100)}% model=${classification.model}`,
    );
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const detail = msg.startsWith("HF Error:") ? msg.slice("HF Error:".length).trim() : msg;
    console.warn(`[Step 1: MobileNetV2 Unavailable] ${detail} → STEP 4 (final fallback)`);
    warnings.push(`Step 1 MobileNetV2 unavailable — ${detail}`.slice(0, 400));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  STEP 4 — FINAL FALLBACK (both image models failed)                  */
/* ------------------------------------------------------------------ */

/**
 * STEP 4: neither Gemini nor MobileNetV2 could read the photo.
 *
 * The spec is explicit that no text model may be called with empty analysis
 * data, so this is a static, pre-written Arabic reply — never an LLM call. It
 * explains what happened and asks for a retake, with concrete guidance
 * (daylight, a close-up on the affected leaf, no blur) plus the offer to
 * describe the symptoms in words instead.
 */
function buildImageAnalysisUnavailableReply(): string {
  return [
    "⚠️ **تعذّر تحليل صورة النبتة** — لم نتمكن من قراءة الصورة هذه المرة.",
    "",
    "لم نتمكن من فحص الصورة حتى عبر محرّك التحليل الاحتياطي، لذلك لن أعطيك تشخيصاً غير مؤكّد. أعد المحاولة بصورة:",
    "- **مُضاءة جيداً** بإضاءة نهارية طبيعية، بعيداً عن الظل.",
    "- **قريبة** على الورقة المصابة، مع التركيز على البقع أو الاصفرار.",
    "- **واضحة غير ضبابية**، ومن دون ظلال قوية أو خلفية مزدحمة.",
    "",
    "أو صِف لي الأعراض نصياً: نوع المحصول، شكل البقع، مكانها على النبتة، وحالتها بعد الري — وسأجيبك مباشرة.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Shared prompting — one system prompt + user turn for BOTH text      */
/*  models (Step 2 Hugging Face and Step 3 Gemini receive identical      */
/*  input)                                                             */
/* ------------------------------------------------------------------ */

/**
 * Shared system prompt for BOTH LLM stages (Gemini + Hugging Face): the
 * serious professional agricultural expert («خبير زراعي محترف وجدي») —
 * direct, precise and practical Arabic answers with only a very subtle
 * touch of politeness: no affectionate greetings, no long-winded essays,
 * no repeated pleasantries or rehashed advice on ongoing conversations,
 * strictly within the agriculture / date-palm / Algerian farming domain.
 */
const SYSTEM_PROMPT = `أنت مساعد زراعي خبير داخل تطبيق "محصولي الذكي" (Smart Crop AI): خبير زراعي محترف وجدي، دقيق وموثوق. تقدم مشورة علمية صحيحة بأسلوب مهني متوازن وطبيعي، مع لمسة لباقة خفيفة فقط — دون ترحيبات عاطفية، دون خطب طويلة، ودون دفء زائد.

الهوية الموحدة:
- أنت كيان خبير زراعي واحد موحّد دائماً؛ تحدث بصوت واحد ولا تقدّم نفسك كمجموعة خبراء أو تنسب التشخيص إلى نموذج رؤية أو مساعد أو نظام منفصل. أدوات التحليل داخلية وليست أطرافاً في المحادثة.
- بطاقة التشخيص المرئية معروضة بالفعل في الواجهة؛ لا تكرر بياناتها التقنية في نص المحادثة. يُمنع ذكر نسب الثقة الخام (مثل «بثقة 25%»)، أو درجات المرشحين، أو تسميات نموذج الرؤية الخام مثل Tomato___Early_blight، حتى عند شرح نتيجة الفحص. استخدم أسماء الأمراض بلغة طبيعية وقدّم تعليقاً زراعياً مباشراً ونصائح عملية مبنية على التشخيص.
- عبّر عن عدم اليقين بالكلمات عند الحاجة (مثل «النتيجة أولية وتحتاج صورة أوضح»)، لا بالأرقام أو نسب الثقة.

النبرة والدقة:
- أجب مباشرة على سؤال الفلاح دون مقدمات أو إطالة؛ ادخل في صلب الموضوع من السطر الأول.
- هدفك الأول هو الدقة وبناء الثقة: معلومات علمية دقيقة بصياغة واضحة وفي متناول الفلاح الميداني.
- أجب دائماً باللغة العربية الفصحى المبسطة، إلا إذا طُلبت الفرنسية صراحةً في سياق المستخدم.
- اجعل شكل الجواب تابعاً لطبيعة السؤال وحجم المحتوى، ولا تفرض بنية واحدة من عنوان ونقاط على كل إجابة.
- استخدم النقاط فقط عندما يكون المحتوى قائمة متوازية فعلاً، مثل الخطوات المتسلسلة أو الخيارات أو المواد مع جرعاتها.
- إذا كان الجواب تفسيراً سببياً أو تحليلاً أو نصيحة واحدة مترابطة، فاكتبه في فقرة قصيرة متصلة بدلاً من تحويله إلى نقاط.
- إذا كان السؤال بسيطاً، مثل سؤال بنعم أو لا مع تعليل موجز، فأجب بجملة أو جملتين دون تنسيق أو عناوين إضافية.
- عند المقارنة، لا تستخدم العنوان نفسه لقسمين مختلفين؛ امنح كل قسم عنواناً دقيقاً ومميزاً، مثل «الإيجابيات» مقابل «التحديات» أو «السلبيات».
- حافظ على الجواب عملياً ومختصراً؛ وفي الإجابات الطويلة أو المعقدة، اعتبر ~١٥٠ كلمة حداً أعلى مرناً لا هدفاً ينبغي بلوغه، فالإجابة الأقصر هي الصحيحة والمفضلة عندما يكون السؤال بسيطاً.

التدرج من العام إلى الخاص (Progressive Detailing):
- في بداية المحادثة، عندما يكون سجل الرسائل قصيراً: قدّم سياقاً عاماً تأسيسياً يؤطّر المشكلة — المفاهيم الأساسية والأسباب الأولية المحتملة — أو اطرح أسئلة توضيحية مهنية واسعة لتأطير الوضع (نوع المحصول، عمر الأعراض، الولاية والمناخ، آخر معالجة).
- مع تقدّم المحادثة: تعمّق تدريجياً نحو تفاصيل تقنية محددة ودقيقة مستنداً إلى إجابات المستخدم في سجل المحادثة — تشخيص تفريقي، جرعات محسوبة، مواعيد تدخل، وأسماء المواد ومكوناتها الفعالة.
- لا تقفز من السؤال الأول مباشرة إلى توصيات علاجية دقيقة قبل تأطير المشكلة: ابدأ واسعاً ثم ضيّق النطاق مع كل ردّ جديد من المستخدم.

الذاكرة الذكية وعدم التكرار:
- ابنِ كل ردّ على رسائل المحادثة السابقة: لا تكرر التحية أو الترحيب أو ذكر مدينة المستخدم وولايته في كل رسالة.
- إذا كانت رسالة المستخدم مجرد تحية (مثل «مرحبا»)، فرد بجملة مهنية قصيرة واحدة ثم انتظر سؤاله.
- إذا كانت المحادثة جارية، ادخل مباشرة في الجواب دون أي مجاملات افتتاحية أو تقديم مكرر لنفسك.
- لا تكرر معلومات أو حقائق أو تشخيصات أو نصائح قدمتها في الرسائل السابقة؛ اكتفِ بالإضافة أو التعميق.
- انتقل بسلاسة من العرض العام إلى التدخل المحدد، مستنداً دائماً إلى تاريخ المحادثة وأجوبة المستخدم السابقة.

التشخيص والعلاج:
- مهمتك الأساسية مع صورة نبات هي صياغة نتيجة الفحص المرفقة: اعرض التشخيص بصوت واحد واذكر المرض باسمه العربي الطبيعي، ثم أضف ما ينبغي للفلاح فعله للعلاج والوقاية، دون إعادة سرد بطاقة التشخيص المعروضة في الواجهة أو بياناتها التقنية.
- لا تُقدِّم مرضاً أو عرضاً أو نقصاً أو سبباً أو مرشّحاً لم يرد في نتيجة الفحص المرفقة، ولا تُبدّلها بتشخيص آخر من اجتهادك الخاص. اقتصر على ما ورد أعلاه.
- إن كانت درجة الثقة في الفحص منخفضة، وضّح بالكلمات أن النتيجة أولية واطلب صورة أوضح في سطر واحد. درجة الثقة سبب لطلب صورة أفضل، لا لاقتراح تشخيص مختلف؛ ولا تنقل نسبة الثقة نفسها إلى نصّك.
- إن لم ترصد نتيجة الفحص أي إصابة، فذلك جواب مشروع: طمئن المستخدم بلغة مهنية قصيرة واذكر إجراءات الوقاية العملية، دون اختراع مرض.
- اذكر مواد وممارسات متوفرة فعلاً في السوق الجزائرية (مبيدات نحاسية، مانكوزيب، كبريت ميكروني، تناوب زراعي…) مع جرعات إرشادية مختصرة وفترة الأمان قبل الجني.
- في قسم خطة العلاج تحديداً (ودون تغيير حجم أو أسلوب بقية الأقسام)، كن أكثر تفصيلاً وعملية في ثلاث نقاط:
  1) اسم المنتج: سمِّ المادة الفعالة بدقة (مثل «مانكوزيب 80%»، «أوكسي كلورور النحاس 50%»، «أزوكسيستروبين»، «ديفينوكونازول») بدل الاكتفاء بفئة عامة كـ«مبيد فطري»، واذكر عند الاقتضاء اسماً تجارياً شائعاً كمثال (مثل «ديثان M-45» للمانكوزيب، أو «سكور» للديفينوكونازول) مع التنبيه إلى أن الأسماء التجارية تختلف حسب المورد.
  2) البدائل: لكل مادة فعالة موصى بها، اذكر بديلاً واحداً على الأقل بمادة فعالة مختلفة تعالج المرض نفسه، تحسباً لعدم توفر الأولى محلياً (مثلاً: إن لم يتوفر المانكوزيب فاستخدم الكلوروثالونيل أو مركّباً نحاسياً).
  3) طريقة التطبيق: حدّد الجرعة بالغرام أو المليلتر لكل لتر ماء، وطريقة التطبيق (رش ورقي، سقي للتربة، معاملة بذور…)، والتوقيت (وقت اليوم المناسب مثل الصباح الباكر أو المساء، الفاصل بين الرشات بالأيام، عدد مرات التكرار، وفترة الأمان قبل الجني إن كانت ذات صلة)، مع ملاحظات مختصرة عن الخلط والسلامة (عدم الخلط مع مواد غير متوافقة، التناوب بين المواد الفعالة لتجنب المقاومة، ارتداء معدات الوقاية).
- خصّص التوصيات حسب ولاية المستخدم ومناخها ومحصوله ودوره إن وردت في السياق المرفق.

احترام رغبة المستخدم:
- إذا صرّح المستخدم برفض الموضوع الحالي أو طلب تغييره، تقبّل ذلك فوراً في نفس الرد، ولا تكرر نفس المقدمة أو تفرض سياق الملف الشخصي (الولاية/المحصول) مرة أخرى.
- سياق الملف الشخصي معلومة خلفية اختيارية، وليست قاعدة تُفرض في كل رد.

حدود المجال (بمرونة):
- اختصاصك الأساسي: الفلاحة، صحة النخيل والتمور، السقي، العناية بالتربة، والسياق الفلاحي الجزائري المحلي.
- إن خرج السؤال عن الفلاحة لكنه مفيد عموماً، أجب عنه بإيجاز وبشكل نافع، ثم أشر بلطف إلى اختصاصك الزراعي عند الحاجة.
- لا تدّعي اليقين المطلق: في الحالات الحرجة انصح بمعاينة مهندس زراعي محلي، في سطر واحد.
`;

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

/**
 * Renders the Step 1 {@link AnalysisData} as the reference block the text
 * stage reasons over.
 *
 * This is the single hand-off point between the two stages: whichever image
 * model produced the data, the text model sees exactly these lines and never
 * learns which one it was (the last general rule of the orchestrator).
 * Gemini normally fills every field, so the block is rich; MobileNetV2 can
 * only supply a disease name, a plant type and a score, so the same renderer
 * emits less — again, without the text stage having to care.
 *
 * The `confidence` line is deliberately present but fenced off from the
 * display rules: the diagnosis card already shows the number, so the prose
 * must not repeat it, and a low score is a reason to ask for a better photo,
 * never to invent a different diagnosis.
 */
function describeAnalysis(analysis: AnalysisData | null): string {
  if (!analysis) return "";
  const pct = Math.round(analysis.confidence * 100);
  const bucket = confidenceBucket(analysis.confidence);
  return [
    "خلاصة فحص صورة المستخدم (بيانات داخلية للاستدلال فقط؛ لا تنقل نسبة الثقة الخام إلى نص المحادثة لأن البطاقة المرئية تعرضها أصلاً. التحليل يعمل في الخلفية كوحدة واحدة — اعرضها بوصفها تحليلك أنت بصوت واحد دون نسبتها إلى «نموذج» أو «نظام» منفصل):",
    analysis.plant_type ? `- نوع المحصول (plant type): ${analysis.plant_type}` : "",
    analysis.disease_detected
      ? `- المرض المشخّص (disease name): ${analysis.disease_name ?? "غير محدد"}`
      : "- لم تُرصد إصابة مرضية على النبتة؛ طمئن المستخدم وقدّم نصائح وقائية.",
    analysis.severity
      ? `- درجة الخطورة (severity): ${SEVERITY_AR[analysis.severity]}`
      : "",
    `- درجة الثقة (confidence): ${pct}% (${bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة"})`,
    analysis.affected_parts.length > 0
      ? `- الأجزاء المصابة (affected parts): ${analysis.affected_parts.join(" · ")}`
      : "",
    analysis.symptoms_observed.length > 0
      ? `- الأعراض المرصودة (symptoms): ${analysis.symptoms_observed.join(" · ")}`
      : "",
    analysis.notes ? `- ملاحظة فنية (notes): ${analysis.notes}` : "",
    // The narration contract: report what the analysis says, add the
    // treatment/prevention recommendation the farmer needs, and do not
    // substitute a different diagnosis.
    "- حدّ العرض: التزم بما ورد أعلاه — لا تخترع مرضاً أو سبباً أو مرشّحاً لم يرد في الفحص، ولا تذكر نسبة الثقة في نصّك. الثقة المنخفضة سبب لطلب صورة أوضح لا لاقتراح تشخيص مختلف.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the single user turn shared by Step 2 (HF `messages[1]`) and Step 3
 * (Gemini `contents`): Firestore profile context (Wilaya, crop, role,
 * language, name) + the Step 1 analysis reference block when an image stage
 * ran + the user's own query.
 *
 * When an image was analysed the turn also states the model's ONLY job: turn
 * the structured analysis into a clear, friendly explanation with a
 * practical recommendation. It never carries the photo — Gemini is a pure
 * formatter in Step 3 and must not re-analyse anything — and it never names
 * the image model, which is what keeps the two stages interchangeable.
 */
function buildUserContent(
  message: string,
  context: AssistantContext | undefined,
  analysis: AnalysisData | null,
  isFirstTurn: boolean,
): string {
  const sections = [
    ...(isFirstTurn ? [`سياق المستخدم من ملفه الشخصي: ${describeContext(context)}`] : []),
    describeAnalysis(analysis),
    analysis
      ? "مهمتك الآن صياغة نتيجة الفحص أعلاه فقط: قدّم للمستخدم شرحاً واضحاً ومباشراً لهذا الفحص، بدافع تطبيقي، مع توصية عملية للعلاج والوقاية إن كان الفحص قد رصد مرضاً — بصوتك الخبير أنت، دون تكرار بيانات البطاقة المرئية ودون ذكر النموذج أو النظام الذي أنجز الفحص."
      : "",
    message
      ? `سؤال المستخدم: ${message}`
      : analysis
        ? "لم يكتب المستخدم سؤالاً — قدّم نتيجة الفحص وخطة العلاج والوقاية مباشرة بناءً على البيانات أعلاه."
        : "قدّم نفسك في جملة واحدة كمساعد زراعي خبير واطلب سؤال المستخدم دون أي حشو.",
  ].filter(Boolean);
  return sections.join("\n\n");
}

/**
 * Everything one Gemini round-trip needs, so the transport can serve both
 * Gemini roles (structured image analysis and plain narration) without
 * branching on a "mode" flag.
 */
interface GeminiPrompt {
  /** `systemInstruction` — extraction rules, or the advisor persona. */
  systemInstruction: string;
  /** The single user turn (text part). */
  userContent: string;
  /** Pixels as an `inlineData` part. ONLY the Step 1 image analysis sets it. */
  image?: AssistantImagePayload | null;
  /** Prior conversation turns (narration only). */
  history?: AssistantHistoryTurn[];
  /**
   * Extra `generationConfig` keys — the image analysis passes
   * `responseMimeType: "application/json"` + `responseSchema` here to pin a
   * machine-readable answer.
   */
  extraConfig?: Record<string, unknown>;
}

/** Any Gemini failure; the caller degrades to the next stage either way. */
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
 * than the request. Three distinct shapes must all walk the chain:
 *
 *   • a mistyped/retired id — `models/gemini-3.6 is not found for API version
 *     v1beta, or is not supported for generateContent`;
 *   • an id withheld from this key — `models/gemini-2.5-flash is no longer
 *     available to new users. Please update your code to use …` (Google has
 *     shipped this with both 404 and 400, so the status check alone is not
 *     enough);
 *   • an id that exists but cannot serve this method.
 *
 * Together with an HTTP 404 these are the only Gemini failures that walk the
 * model chain — invalid keys (400/403), quota (429), safety blocks, 5xx,
 * network errors and the timeout abort are surfaced immediately, because
 * another model id can't fix them.
 */
const GEMINI_MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /is not found/i,
  /not supported for generateContent/i,
  /\bunknown model\b/i,
  /\bno such model\b/i,
  // Withheld from this key rather than globally retired.
  /no longer available to (?:new )?users/i,
  /not available (?:to|for) (?:new )?users/i,
];

/** True when the failure looks like "this Gemini model id is retired/gone". */
function isGeminiModelAvailabilityError(error: unknown): boolean {
  if (!(error instanceof GeminiError)) return false;
  if (error.status === 404) return true;
  return GEMINI_MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

/**
 * One `models.generateContent` round-trip against a single Gemini id.
 *
 * The same transport serves BOTH Gemini roles in the orchestrator, which is
 * why the payload is described by {@link GeminiPrompt} rather than by fixed
 * arguments:
 *   • Step 1 image analysis — `systemInstruction` is the structured-extraction
 *     instruction, `image` is the raw photo, and `extraConfig` pins
 *     `responseMimeType`/`responseSchema` so the answer is a JSON object;
 *   • Step 3 text fallback — the expert advisor prompt, NO image (Gemini is
 *     strictly a formatter there and must not re-analyse anything).
 *
 * Throws {@link GeminiError} on every failure mode (status kept for the
 * chain-walk decision); a fetch aborted by the shared signal is reported as
 * the timeout.
 */
async function generateWithGeminiModel(
  model: GeminiModel,
  prompt: GeminiPrompt,
  signal: AbortSignal,
  apiKey: string,
): Promise<string> {
  const { systemInstruction, userContent, image, history, extraConfig } = prompt;
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [
            ...(history ?? []).map((turn) => ({
              role: turn.role === "assistant" ? "model" : "user",
              parts: [{ text: turn.content }],
            })),
            {
              role: "user",
              parts: image
                ? [
                    // The photo itself. Only the Step 1 image-analysis call
                    // ever sets this: the text stage is fed ANALYSIS_DATA and
                    // is never given pixels to re-interpret.
                    { inlineData: { mimeType: image.mimeType, data: image.data } },
                    { text: userContent },
                  ]
                : [{ text: userContent }],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            topP: 0.9,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            // Answer-first latency, per generation: Gemini 2.5 →
            // thinkingBudget 0; the stable 1.5/2.0 ids (and unknown
            // GEMINI_MODEL overrides) predate thinking and 400 on the
            // parameter, so they get NO thinkingConfig at all.
            ...(model.thinking ? { thinkingConfig: { ...model.thinking } } : {}),
            // Structured-output pins (image analysis only).
            ...(extraConfig ?? {}),
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

/** A completed Gemini round-trip: the model id that answered, its text and any
 *  non-fatal degradations (retired-id 404s) the chain walked past to get there. */
interface GeminiResult {
  model: string;
  text: string;
  warnings: string[];
}

/* ---- Health check — validate the chain against ListModels ---------- */

/**
 * One monitor per process: single-flight, 6-hour TTL, and the source of the
 * "these ids are dead" set that {@link resolveGeminiModels} filters the chain
 * with. Exported so tests can reset it between cases.
 */
export const geminiModelHealth = new GeminiModelHealthMonitor();

/**
 * Validate the configured Gemini chain against `GET /v1beta/models` and log a
 * one-line verdict, at most once per monitor TTL and always from the single
 * Gemini entry point — so both Gemini roles are covered by one check.
 *
 * Never throws: a ListModels outage degrades to one "could not verify" warning.
 */
async function ensureGeminiModelHealth(
  geminiApiKeys: readonly string[],
): Promise<void> {
  if (geminiApiKeys.length === 0) return;

  const report = await geminiModelHealth.ensure(resolveGeminiModels(), {
    apiKey: geminiApiKeys[0],
  });
  if (!report) return;

  for (const line of formatGeminiHealthReport(report, resolveGeminiModels())) {
    // A broken chain is a deployment problem, not a request problem — it must
    // be impossible to miss in the platform logs.
    if (line.includes("❌") || line.includes("⚠")) console.error(line);
    else console.log(line);
  }
}

/**
 * Run the per-request Gemini model chain ({@link resolveGeminiModels}) against
 * a single credential, starting at the shared default (`gemini-3.8-flash`, or
 * the `GEMINI_MODEL` override) and walking to the long-lived fallbacks on a
 * model-availability failure.
 *
 * The whole chain is bounded by ONE 18 s `AbortController` deadline
 * ({@link GEMINI_TIMEOUT_MS}) instead of per-call timeouts: a fast
 * model-availability failure (404 / model-not-found / "no longer available to
 * new users" — the signature of a retired generation) walks to the next id
 * with whatever budget remains (each walk is recorded in the result's
 * `warnings` so the client still sees the degradation), while any other
 * failure — invalid/missing key (400/403), safety block, empty candidate list,
 * network error or the timeout abort — throws {@link GeminiError} immediately
 * for the outer key-rotation loop.
 * Quota and transient upstream failures (HTTP 429/500/503) are likewise
 * surfaced to that loop, which backs off and tries the next credential.
 */
async function runGeminiChain(
  prompt: GeminiPrompt,
  apiKey: string,
): Promise<GeminiResult> {
  const controller = new AbortController();
  // Explicit AbortController + shared deadline (rather than per-call
  // AbortSignal.timeout) so the WHOLE model chain — not one call — is bounded
  // by the 18 s window, and the pending round-trip and timer are always
  // cancelled/cleared.
  const deadline = Date.now() + GEMINI_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  // Resolve the chain once per request so a `GEMINI_MODEL` change is picked
  // up without a restart (same convention as the Gemini key pool).
  const models = resolveGeminiModels();

  try {
    const failures: string[] = [];
    const warnings: string[] = [];
    for (const [index, model] of models.entries()) {
      // Only reachable after fast 404 walks that consumed the window — no
      // budget left for another round-trip.
      if (Date.now() >= deadline) break;

      try {
        const text = await generateWithGeminiModel(model, prompt, controller.signal, apiKey);
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

        const next = models[index + 1];
        if (next) {
          warnings.push(`Gemini unavailable — ${error.message}`.slice(0, 400));
          console.warn(`[Gemini: Model Fallback] ${error.message} — retrying with ${next.id}`);
          continue;
        }
        // Availability failure on the LAST id — fall through to the summary.
      }
    }
    // Every id in the chain was retired/gone (or the budget ran out) —
    // report all of them so the operator can tell "Google retired these
    // models" from "this key lacks access".
    throw new GeminiError(
      `no Gemini model could answer (tried ${models.map((m) => m.id).join(", ")}) — ${failures.join(" | ")}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Google's rate-limit / quota signatures that must trigger a KEY rotation
 * (retry with the next credential) rather than an immediate stage failure —
 * the HTTP status covers the usual case, the message patterns catch quota
 * rejections surfaced in the body (e.g. `RESOURCE_EXHAUSTED`, "quota limit").
 */
const GEMINI_QUOTA_ERROR_PATTERNS: readonly RegExp[] = [
  /RESOURCE_EXHAUSTED/i,
  /\bquota(?:\s+limit| exceeded)?\b/i,
  /rate[ _-]?limit/i,
];

/** True when Gemini returned a rate-limit/quota or transient server failure. */
function isGeminiRetryableError(error: unknown): error is GeminiError {
  if (!(error instanceof GeminiError)) return false;
  if (error.status === 429 || error.status === 500 || error.status === 503) return true;
  return GEMINI_QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

/**
 * Run the Gemini model chain against each configured credential in order —
 * the multi-key rotation loop shared by both Gemini roles (Step 1 image
 * analysis and Step 3 text fallback).
 *
 * Rate-limit / quota failures (HTTP 429, RESOURCE_EXHAUSTED, quota limit —
 * see {@link isGeminiRetryableError}) and transient server failures (500,
 * 503) get a one-second backoff before the next key is tried; other Gemini
 * failures (e.g. an invalid or revoked key) also advance through the
 * remaining keys without a delay. The request retries the next key in the
 * pool until one answers successfully or ALL keys are exhausted. API keys
 * are represented only by their ordinal in logs and warnings; their values
 * never leave the server or appear in a client response.
 */
async function runGeminiWithKeyPool(
  prompt: GeminiPrompt,
  geminiApiKeys: readonly string[],
): Promise<GeminiResult> {
  // Once per process (TTL-bounded): proves the configured model ids still
  // exist BEFORE they are used, so a Google deprecation surfaces as one loud
  // log line instead of 404-ing silently on every request.
  await ensureGeminiModelHealth(geminiApiKeys);

  const failures: string[] = [];
  const rotationWarnings: string[] = [];

  for (let keyIndex = 0; keyIndex < geminiApiKeys.length; keyIndex += 1) {
    const apiKey = geminiApiKeys[keyIndex];
    try {
      const result = await runGeminiChain(prompt, apiKey);
      return {
        ...result,
        warnings: [...rotationWarnings, ...result.warnings],
      };
    } catch (error) {
      if (!(error instanceof GeminiError)) throw error;

      const keyLabel = `key ${keyIndex + 1}/${geminiApiKeys.length}`;
      failures.push(`${keyLabel}: ${error.message}`);
      const nextKeyIndex = keyIndex + 1;
      const hasNextKey = nextKeyIndex < geminiApiKeys.length;

      if (isGeminiRetryableError(error) && hasNextKey) {
        const status = error.status ?? "unknown";
        const warning =
          `Gemini HTTP ${status} transient/quota failure on ${keyLabel} — ` +
          `key rotation attempt ${nextKeyIndex + 1}/${geminiApiKeys.length}.`;
        rotationWarnings.push(warning);
        console.warn(
          `[Gemini: Key Rotation] ${warning} Retrying after 1 second.`,
        );
        await new Promise((res) => setTimeout(res, 1000));
      } else if (hasNextKey) {
        // A different failure can also be isolated to one credential (for
        // example an invalid or revoked key). Try the next configured key
        // before allowing the request to fall through to the next stage.
        const warning =
          `Gemini failed on ${keyLabel} — ` +
          `key rotation attempt ${nextKeyIndex + 1}/${geminiApiKeys.length}.`;
        rotationWarnings.push(warning);
        console.warn(
          `[Gemini: Key Rotation] ${error.message} — retrying with key ${nextKeyIndex + 1}/${geminiApiKeys.length}.`,
        );
      }
    }
  }

  throw new GeminiError(
    `all Gemini API keys failed — ${failures.join(" | ")}`,
  );
}

/* ------------------------------------------------------------------ */
/*  Step 2 — Hugging Face text model, the PRIMARY chain (STRICT)       */
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
 * rather than the request itself: model not served by any provider (the
 * router's `400 — { code: "model_not_supported" } The requested model '…' is
 * not supported by any provider you have enabled`, or the legacy per-provider
 * `Model not supported by provider hf-inference`), retired or mistyped ids
 * (`404 — Model not found`), gated models whose license the token owner never
 * accepted (`403 — You cannot access this model… / accepting the terms`), and
 * endpoints that don't support chat completions. Together with an HTTP 404
 * these are the only failures that trigger the fallback chain — invalid or
 * under-scoped tokens (401/403 "insufficient permissions"), exhausted credits
 * (402), quota (429), 5xx, other 400s (bad request body) and network errors
 * are surfaced immediately, because another model id can't fix them and the
 * extra round-trips would just burn the request budget (`maxDuration`).
 */
const HF_LLM_MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /\bnot found\b/i,
  /does not (?:seem to )?exist/i,
  /no such model/i,
  /\bnot supported\b/i,
  /\bmodel_not_supported\b/i,
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
  choices?: { message?: { content?: string | null } }[];
}

/**
 * Error envelopes the router can answer with. The OpenAI-compatible router
 * uses the OpenAI object shape (`{ error: { message, type, param, code } }`,
 * e.g. `code: "model_not_supported"`); the legacy per-provider endpoints and
 * some upstream providers still answer a bare string (`{ error: "…" }`).
 */
interface HfErrorEnvelope {
  error?: string | { message?: string; code?: string; type?: string };
}

/**
 * Human-readable detail for a non-2xx router response: the JSON error message
 * (plus the machine `code` when present, so `model_not_supported` is visible
 * in logs/warnings) or, failing that, the raw body prefix.
 */
function describeHfHttpError(status: number, bodyText: string): string {
  const fallback = `HTTP ${status}${bodyText ? ` — ${bodyText.slice(0, 400)}` : ""}`;
  try {
    const parsed = JSON.parse(bodyText) as HfErrorEnvelope;
    const envelope = parsed?.error;
    if (typeof envelope === "string" && envelope) return `HTTP ${status} — ${envelope}`;
    if (envelope && typeof envelope === "object") {
      const message = typeof envelope.message === "string" ? envelope.message.trim() : "";
      const code = typeof envelope.code === "string" ? envelope.code.trim() : "";
      if (message || code) {
        return `HTTP ${status} — ${[code && `[${code}]`, message].filter(Boolean).join(" ")}`;
      }
    }
  } catch {
    // keep raw detail
  }
  return fallback;
}

/**
 * A single chat-completions round-trip for one HF LLM id through the
 * Inference Providers router ({@link HF_ROUTER_CHAT_URL}) — Bearer token
 * header, OpenAI-compatible body with the model id inside it.
 * Throws {@link HfLlmRequestError} on transport/HTTP failures (status kept)
 * and {@link HfLlmEmptyResponseError} when the model returns no text.
 */
async function generateWithHfLlmModel(
  model: string,
  userContent: string,
  apiKey: string,
  history: AssistantHistoryTurn[] = [],
): Promise<string> {
  let res: Response;
  try {
    res = await timedFetch(HF_ROUTER_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
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
    throw new HfLlmRequestError(describeHfHttpError(res.status, bodyText), res.status);
  }

  const json = (await res.json().catch(() => null)) as HfChatCompletion | null;
  const text = json?.choices?.[0]?.message?.content?.trim() ?? "";

  if (!text) {
    throw new HfLlmEmptyResponseError(`Empty response from ${model} (no usable choice text).`);
  }
  return text;
}

/**
 * Strict Step 2 (PRIMARY text model): concise Arabic text response formatting via
 * the Hugging Face Inference Providers router, starting at
 * {@link HF_LLM_MODELS Qwen/Qwen3-4B-Instruct-2507} and falling back
 * through the remaining open, non-gated ids when the router reports a model
 * as unavailable (404 not-found / 400 model_not_supported / 403
 * gated-license / empty choices). Any failure throws an "LLM Error:" — the
 * handler catches it and hands the request to Step 3 (Gemini) and then to
 * the built-in formatter, so a Step 2 outage never breaks the response.
 * - Never called without a token: the handler skips the stage synchronously
 *   when no Hugging Face token is configured.
 * - Runs FIRST in the text chain: Gemini (Step 3) is only consulted once this
 *   stage failed, timed out or could not be configured.
 * - Receives the exact same user turn Gemini would get — built by
 *   {@link buildUserContent}, so it carries the Step 1 ANALYSIS_DATA reference
 *   block (when an image was analysed), the user's text message and the
 *   Firestore profile context (Wilaya, crop). It never receives the photo:
 *   narrating structured data is the whole job.
 * - Uses the concise professional Arabic advisor system prompt.
 * - Throws an Error prefixed with "LLM Error:" once no model can answer.
 */
async function askHfLlmStrict(apiKey: string, userContent: string, history: AssistantHistoryTurn[] = []): Promise<string> {
  const failures: string[] = [];

  for (const [index, model] of HF_LLM_MODELS.entries()) {
    try {
      const text = await generateWithHfLlmModel(model, userContent, apiKey, history);

      console.log(
        `[Step 2: HF LLM Success] model=${model} replyLength=${text.length}`,
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
/*  STEP 2 output validation — (b) malformed and (c) off-analysis        */
/* ------------------------------------------------------------------ */

/**
 * Normalise a text-model reply for comparison: case-fold, strip Arabic
 * diacritics/tatweel, fold alef/ta-marbuta/alef-maksura variants, and drop
 * everything that is not a letter or digit.
 */
function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The terms a reply must be grounded in: the disease, the crop, the affected
 * parts and the observed symptoms — i.e. everything the image model actually
 * asserted. Multi-word names are kept whole, and a name made only of very
 * short/stop words is dropped so it cannot accidentally match everything.
 */
function analysisKeyTerms(analysis: AnalysisData): string[] {
  const terms = [
    analysis.disease_name,
    analysis.plant_type,
    ...analysis.affected_parts,
    ...analysis.symptoms_observed,
  ]
    .map((term) => normalizeForMatch(term ?? ""))
    .filter((term) => term.length > 0);

  return [...new Set(terms)].filter(
    (term) => term.length >= 3 && !STOP_TERMS.has(term),
  );
}

/** Terms too generic to prove a reply is about *this* analysis. */
const STOP_TERMS: ReadonlySet<string> = new Set([
  "نبتة",
  "الورقة",
  "الاوراق",
  "المريض",
  "المرض",
  "الاصابة",
  "الاصابات",
]);

/**
 * Detect the classic small-model degeneration: the same short phrase emitted
 * over and over ("نعم نعم نعم" / "asdf asdf asdf"). Returns true when some
 * 1–3 word unit fills at least three consecutive positions and covers most
 * of the reply.
 */
function looksLikeRepetitionLoop(reply: string): boolean {
  const words = normalizeForMatch(reply).split(" ").filter(Boolean);
  if (words.length < 6) return false;

  for (const size of [1, 2, 3]) {
    for (let start = 0; start + size * 3 <= words.length; start += 1) {
      const unit = words.slice(start, start + size).join(" ");
      if (!unit) continue;
      let run = 0;
      for (let i = start; i + size <= words.length; i += size) {
        if (words.slice(i, i + size).join(" ") === unit) run += 1;
        else break;
      }
      if (run >= 3 && run * size >= words.length * 0.6) return true;
    }
  }
  return false;
}

/** Raised when a text model answered but its reply is not usable. */
class TextStageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextStageError";
  }
}

/**
 * Reject a Step-2 / Step-3 reply that cannot be shown to the farmer, per the
 * orchestrator's text-stage failure rules:
 *
 *   (b) empty, malformed, or nonsensical output — an empty/whitespace reply,
 *       one carrying no letters or digits at all (a lone emoji, "…", a
 *       truncated token), or a small-model repetition loop;
 *   (c) output that does not correspond to ANALYSIS_DATA — when the analysis
 *       asserted a DISEASE, the reply must actually be about it. Grounding is
 *       checked on NORMALISED text, so rephrasing "اللفحة المتأخرة" as "اللفحة
 *       المتأخرة على الطماطم" still passes while a hallucinated answer about an
 *       unrelated crop does not.
 *
 * Two deliberate design choices keep this from firing on good answers:
 *   • there is NO length threshold — a short answer to a short question is a
 *     perfectly good answer, and the fallbacks are graceful enough that a
 *     false rejection only costs a round-trip;
 *   • grounding is skipped for a HEALTHY verdict. "No disease found" is not a
 *     claim the text has to echo back, and a reassuring reply ("النبتة سليمة،
 *     اسقِ عند القاعدة") that never names the crop is exactly what we want.
 *     The check therefore only runs where hallucination actually matters: a
 *     named disease the reply is expected to talk about.
 */
function assertUsableTextReply(reply: string, analysis: AnalysisData | null): string {
  const trimmed = reply.trim();

  if (!trimmed) {
    throw new TextStageError("the text model returned an empty reply");
  }
  // No letters or digits at all — punctuation, emoji or a truncated token.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    throw new TextStageError("the text model returned no words (punctuation/emoji only)");
  }
  if (looksLikeRepetitionLoop(trimmed)) {
    throw new TextStageError("the text model returned a degenerate repetition loop");
  }

  if (analysis?.disease_detected) {
    const terms = analysisKeyTerms(analysis);
    if (terms.length > 0) {
      const normalizedReply = normalizeForMatch(trimmed);
      if (!terms.some((term) => normalizedReply.includes(term))) {
        throw new TextStageError(
          `the reply does not correspond to the image analysis (none of: ${terms.slice(0, 4).join(", ")})`,
        );
      }
    }
  }

  return trimmed;
}

/* ------------------------------------------------------------------ */
/*  Built-in direct formatter — the zero-failure safety net             */
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

/**
 * Family advice for a verdict, whichever image model produced it.
 *
 * The matcher keys off the raw PlantVillage label ("late blight", …), so a
 * MobileNetV2 verdict matches directly. A Gemini verdict already carries an
 * Arabic name, which is mapped back to its English family first — otherwise
 * the primary image model would silently lose all disease-specific advice and
 * fall back to the generic plan.
 */
function adviceForLabel(label: string): DirectAdvice {
  const direct = DIRECT_ADVICE_BY_DISEASE.find((entry) => entry.match.test(label));
  if (direct) return direct.advice;

  const family = diseaseFamilyForArabic(label);
  if (family) {
    const viaFamily = DIRECT_ADVICE_BY_DISEASE.find((entry) => entry.match.test(family));
    if (viaFamily) return viaFamily.advice;
  }

  return DIRECT_GENERAL_ADVICE;
}

/**
 * Zero-failure safety net: builds a clean, concise Arabic Markdown
 * diagnosis card directly from the Step 1 label + confidence, with practical
 * general advice. Used ONLY when the image analysis succeeded but both text
 * models failed or are unavailable — the request then answers 200 with
 * `{ source: "direct" }` instead of a 500.
 */
function buildDirectDiagnosisCard(diagnosis: AssistantDiagnosis): string {
  const alternates = diagnosis.candidates
    .slice(1)
    .map((c) => parsePlantLabel(c.label).labelAr)
    .join("، ");

  if (diagnosis.healthy) {
    const lines = [
      "- **يبدو أن النبتة سليمة**.",
      diagnosis.confidence < 0.45
        ? "- النتيجة أولية: أرسل صورة أوضح (ورقة كاملة، إضاءة نهارية) للتأكيد."
        : "",
      alternates ? `- احتمالات أخرى: ${alternates}` : "",
    ].filter(Boolean);
    return [
      `## 🔬 التشخيص\n${lines.join("\n")}`,
      "## 🛡️ وقاية\n- سقي صباحي منتظم عند القاعدة دون بلل الأوراق.\n- تسميد متوازن ومراقبة الأوراق الجديدة أسبوعياً.",
      "## 📅 متابعة موصى بها\n- فحص أسبوعي للأوراق السفلية والبراعم؛ عند أول بقعة أرسل صورة واضحة للتشخيص المبكر.",
    ].join("\n\n");
  }

  // Reuse the vision engine's own plan when the verdict carried one (the
  // optional enrichment fields) — the direct card then carries exactly the
  // findings the LLM stages receive, in the same voice; on the streamlined
  // MobileNetV2 pipeline these fields are unset, so the built-in
  // disease-family advice applies.
  const fallbackAdvice = adviceForLabel(diagnosis.label);
  const advice: DirectAdvice = {
    treatment:
      diagnosis.treatment && diagnosis.treatment.length > 0
        ? diagnosis.treatment
        : fallbackAdvice.treatment,
    prevention:
      diagnosis.prevention && diagnosis.prevention.length > 0
        ? diagnosis.prevention
        : fallbackAdvice.prevention,
  };
  const lowConfidence = diagnosis.confidence < 0.45;
  const lines = [
    `- الإصابة المحتملة: **${diagnosis.labelAr}**`,
    diagnosis.severity ? `- درجة الخطورة: ${diagnosis.severity}` : "",
    alternates ? `- تشخيصات بديلة محتملة: ${alternates}` : "",
    lowConfidence
      ? "- النتيجة أولية: أرسل صورة أوضح (ورقة كاملة، إضاءة نهارية) للتأكيد قبل المعالجة."
      : "",
  ].filter(Boolean);

  return [
    `## 🔬 التشخيص\n${lines.join("\n")}`,
    `## 💊 خطة العلاج\n${advice.treatment.map((line) => `- ${line}`).join("\n")}`,
    `## 🛡️ الوقاية مستقبلاً\n${advice.prevention.map((line) => `- ${line}`).join("\n")}`,
    "## 📅 متابعة موصى بها\n- راقب تطور الأعراض كل 3–5 أيام؛ إن انتشرت رغم العلاج، استشر مهندساً زراعياً محلياً.",
  ].join("\n\n");
}

/* ------------------------------------------------------------------ */
/*  Built-in formatter (text-only) — basic-mode replies (ZERO-FAILURE)   */
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
 * Friendly basic-mode text reply used when the whole text chain (Step 2
 * Hugging Face + Step 3 Gemini) is unavailable on a request without a usable
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
    "- أو أرفق صورة واضحة لورقة مصابة — سأشخّصها وأقدّم خطة علاج مباشرة حتى في الوضع الأساسي.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/*  Handler — the fail-proof orchestrator + built-in formatter          */
/* ------------------------------------------------------------------ */

/**
 * Fail-proof pipeline body. Every upstream stage is non-fatal:
 * - Step 1 (image analysis): Gemini first, MobileNetV2 only after it fails.
 *   When BOTH fail on a photo request → Step 4 replies with the pre-written
 *   retake message and no text model is called at all.
 * - Step 2 (Hugging Face, the PRIMARY text model) failure, timeout, a
 *   rejected reply, or a missing `HUGGINGFACE_API_KEY` → warning, fall
 *   through to Step 3.
 * - Step 3 (Gemini, format-only) failure or a missing `GEMINI_API_KEY` →
 *   warning, answer 200 from the built-in formatters: a diagnosis card when
 *   Step 1 produced an analysis, a friendly basic-mode reply otherwise.
 * - A text-only request has no image stage at all and runs Steps 2 → 3 →
 *   built-in formatter.
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
  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          (turn): turn is AssistantHistoryTurn =>
            Boolean(turn) &&
            (turn.role === "user" || turn.role === "assistant") &&
            typeof turn.content === "string" &&
            turn.content.trim().length > 0,
        )
        .slice(-10)
    : [];
  const isFirstTurn = history.length === 0;
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

  /* ---- DEMO MOCK (ON by default; `DEMO_MOCK=0` restores the pipeline) - */
  // First thing the pipeline does, BEFORE any provider key is read: a scripted
  // turn is answered straight from `@/lib/assistant/demo-mock` after a
  // simulated 600 ms round-trip, so the demo recording can never burn a quota,
  // hit a rate limit, wait on a cold model — or silently fall back to the old
  // basic-mode reply because a flag was missing on the server. A turn that is
  // not part of the script returns null and every stage below runs exactly as
  // before; `DEMO_MOCK=0` (or `PHYTOSCAN_DEMO_MOCK=0`) makes this block a
  // no-op, which is what production and the test suite pin.
  if (isDemoMockEnabled()) {
    // The request contract is the app's own ({ message, image, history }) —
    // the script evaluates the history plus the current turn, so the second
    // photo of the demo is recognised as the second one.
    const demoReply = await getDemoMockResponse(
      buildDemoMockMessages(message, image?.data, history),
    );
    if (demoReply !== null) {
      // Photo turns report `hybrid` and text turns `llm`, so the demo bubble
      // renders exactly like a real model answer (no "vision only" notice).
      const demoSource: AssistantSource = image ? "hybrid" : "llm";
      console.log(
        `[Demo Mock] scripted reply served (source=${demoSource}, ${demoReply.length} chars) — no provider was called.`,
      );
      return NextResponse.json({
        reply: demoReply,
        diagnosis: null,
        source: demoSource,
        warnings: [
          "Demo mock reply — no provider call was made (set DEMO_MOCK=0 to restore real diagnoses).",
        ],
      } satisfies AssistantResponseBody);
    }
  }

  // Server-only secrets — never exposed to the client bundle. Read on every
  // request (never at module load) so a rotated/added key is picked up without
  // a restart.
  //   GEMINI_API_KEY        → Step 1 PRIMARY image model (Gemini) AND Step 3
  //                           text fallback (comma-separated keys supported).
  //   GEMINI_API_KEYS      → optional comma-separated Gemini key pool.
  //   GEMINI_API_KEY_N     → optional numbered Gemini keys (`_1`, `_2`, …).
  //                           All sources above are combined into ONE pool
  //                           (trimmed, deduplicated, rotation-ordered) and
  //                           rotated on 429 / RESOURCE_EXHAUSTED / quota.
  //   HUGGINGFACE_API_KEY   → Step 1 FALLBACK image model (MobileNetV2) +
  //                           Step 2 PRIMARY text model (HF_TOKEN, Hugging
  //                           Face's own conventional variable name, is
  //                           honoured as an alias).
  const geminiApiKeys = resolveGeminiApiKeys();
  const huggingfaceKey = resolveHuggingFaceToken();

  if (geminiApiKeys.length === 0 && !huggingfaceKey) {
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
  /** Answer language, resolved once and shared by every stage. */
  const lang: "ar" | "fr" = context?.lang === "fr" ? "fr" : "ar";

  /* ---- STEP 0: leaf Detection & Cropping (image requests only) ------ */
  // An open-source object detector localises the leaf and sharp crops the
  // photo. The crop exists to keep background noise (hands, soil, pots) out
  // of a narrow classifier, so it feeds the MobileNetV2 FALLBACK in Step 1
  // only — Gemini, the primary image model, reasons over the full scene and
  // receives the original frame. Non-fatal by construction: every failure
  // degrades to the untouched original.
  let preprocessing: AssistantPreprocessing | null = null;
  let analysis: AnalysisResult | null = null;

  if (image) {
    const detection = await runLeafDetectionStage(image, huggingfaceKey, warnings);
    preprocessing = detection.preprocessing;

    // ---- STEP 1: IMAGE ANALYSIS (Gemini → MobileNetV2 → give up) ----
    analysis = await runImageAnalysisStage({
      geminiImage: image,
      mobilenetImage: detection.image,
      geminiApiKeys,
      huggingfaceKey,
      lang,
      warnings,
    });
  }

  // ---- STEP 4: FINAL FALLBACK (both image models failed) ------------
  // The spec is explicit: no text model is ever called with empty analysis
  // data. A photo arrived, neither Gemini nor MobileNetV2 could read it, so
  // the user gets a polite, pre-written retake request — not a guess.
  if (image && analysis === null) {
    const reply = buildImageAnalysisUnavailableReply();
    warnings.push("Image analysis unavailable — replied with the final-fallback message.");
    console.log(
      `[Step 4: Final Fallback] no image model could analyse the photo — ${warnings.length} degradation(s) recorded`,
    );
    const payload: AssistantResponseBody = {
      reply,
      diagnosis: null,
      source: "direct",
      ...(preprocessing ? { preprocessing } : {}),
      analysisSource: null,
      textSource: null,
      warnings,
    };
    return NextResponse.json(payload);
  }

  // One user turn for both text stages: user query + Firestore profile
  // context (Wilaya, crop type, role) + the Step 1 ANALYSIS_DATA reference
  // block. It never carries the photo — the text stage narrates structured
  // data, it does not re-analyse pixels.
  const userContent = buildUserContent(message, context, analysis?.data ?? null, isFirstTurn);

  // ---- STEP 2: Hugging Face text model (PRIMARY) --------------------
  // Called FIRST: the open Qwen chain through the Inference Providers
  // router, with the shared system prompt and the same user turn. Non-fatal:
  // a transport failure, a missing token, an empty/degenerate reply, or a
  // reply that is not about ANALYSIS_DATA all walk to Step 3.
  let reply: string | null = null;
  let textSource: TextSource | null = null;
  if (huggingfaceKey) {
    try {
      reply = assertUsableTextReply(
        await askHfLlmStrict(huggingfaceKey, userContent, history),
        analysis?.data ?? null,
      );
      textSource = "huggingface";
      console.log(
        `[Step 2: HF LLM Success] analysis=${analysis?.source ?? "none"} replyLength=${reply.length}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const detail = msg.startsWith("LLM Error:") ? msg.slice("LLM Error:".length).trim() : msg;
      console.warn(`[Step 2: HF LLM Failed → Step 3] ${detail}`);
      warnings.push(`Step 2 HF text model unavailable — ${detail}`.slice(0, 400));
    }
  } else {
    // No Hugging Face token anywhere in the environment → skip the stage
    // synchronously (no request, no throw, no timer) and let Step 3
    // (Gemini) answer right away.
    const detail =
      "HUGGINGFACE_API_KEY is not configured (HF_TOKEN unset too) — skipping the primary text model.";
    console.warn(`[Step 2: HF LLM Skipped] ${detail} → Step 3 (Gemini formatter)`);
    warnings.push(`Step 2 HF text model unavailable — ${detail}`.slice(0, 400));
  }

  // ---- STEP 3: Google Gemini (FALLBACK text model) -------------------
  // Runs ONLY when the primary Hugging Face stage produced nothing.
  // gemini-3.8-flash or the GEMINI_MODEL override (→ 3.5-flash →
  // 3.5-flash-lite on a retired-id 404) via the Generative Language REST API,
  // keyed with the full
  // Gemini key pool and bounded by a shared 18 s AbortController.
  // Gemini is a FORMATTER here: the prompt is ANALYSIS_DATA and NO image is
  // attached, so it cannot re-analyse the photo even by accident. This also
  // covers the edge case where the analysis came from MobileNetV2 and the HF
  // text model then failed.
  if (reply === null && geminiApiKeys.length > 0) {
    try {
      const geminiResult = await runGeminiWithKeyPool(
        {
          systemInstruction: SYSTEM_PROMPT,
          userContent,
          history,
        },
        geminiApiKeys,
      );
      reply = assertUsableTextReply(geminiResult.text, analysis?.data ?? null);
      textSource = "gemini_fallback";
      // Non-fatal degradations the chain walked past (a retired id 404ing
      // before its successor answered) are still surfaced to the client.
      warnings.push(...geminiResult.warnings);
      console.log(
        `[Step 3: Gemini Formatter Success] model=${geminiResult.model} analysis=${analysis?.source ?? "none"} replyLength=${reply.length}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Step 3: Gemini Failed → built-in formatter] ${detail}`);
      warnings.push(`Step 3 Gemini text fallback unavailable — ${detail}`.slice(0, 400));
    }
  } else if (reply === null) {
    const detail = "No GEMINI_API_KEY is configured — skipping the text fallback.";
    console.warn(`[Step 3: Gemini Skipped] ${detail} → built-in formatter`);
    warnings.push(`Step 3 Gemini text fallback unavailable — ${detail}`.slice(0, 400));
  }

  if (reply !== null) {
    console.log(
      `[Orchestrator] analysisSource=${analysis?.source ?? "none"} textSource=${textSource}`,
    );
    const payload: AssistantResponseBody = {
      reply,
      diagnosis: analysis?.diagnosis ?? null,
      source: analysis ? "hybrid" : "llm",
      ...(preprocessing ? { preprocessing } : {}),
      analysisSource: analysis?.source ?? null,
      textSource,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return NextResponse.json(payload);
  }

  // ---- BUILT-IN FORMATTER (both text models down, ZERO-FAILURE) ------
  // Reachable only for a request that already has ANALYSIS_DATA (an image
  // request cannot get here: the Step 4 branch above returns first) or for a
  // text-only question.
  let directReply: string;
  if (analysis) {
    directReply = buildDirectDiagnosisCard(analysis.diagnosis);
  } else {
    directReply = buildTextFallbackReply(message);
  }
  warnings.push("Reply formatted locally — no upstream AI stage was available.");

  const payload: AssistantResponseBody = {
    reply: directReply,
    diagnosis: analysis?.diagnosis ?? null,
    source: "direct",
    ...(preprocessing ? { preprocessing } : {}),
    analysisSource: analysis?.source ?? null,
    textSource: null,
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

