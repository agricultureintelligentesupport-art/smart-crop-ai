/**
 * `/api/assistant` — fail-proof field-trained AI chain for the agricultural
 * assistant. The route NEVER returns HTTP 500.
 *
 * Pipeline:
 *
 *   Step 0 (when an image is attached): leaf Detection & Cropping — the SAME
 *     free Hugging Face Inference router now ALSO runs an open-source object
 *     detector (DETR-ResNet-50 fine-tuned on PlantDoc, every one of its 30
 *     classes is a plant/leaf; the COCO `facebook/detr-resnet-50` with a
 *     plant-only label filter is the fallback id — the chain is overridable
 *     via `HF_LEAF_DETECT_MODELS`). The detected box is grown into a padded,
 *     clamped crop window and the photo is cropped server-side with sharp,
 *     so background noise (hands, soil, pots) NEVER reaches the Step 1
 *     classifier: it sees ONLY the cropped pixels. Strictly an accuracy
 *     pre-step — every failure mode is non-fatal and falls back to the
 *     untouched original frame. The outcome is reported in the
 *     `preprocessing` response field and in `warnings[]` when the stage
 *     could not run at all. Vercel-friendly by design: no model weights ever
 *     touch the function (the detector runs on Hugging Face's free
 *     serverless CPU tier) and the whole stage is bounded by its own 9 s
 *     deadline inside the 60 s `maxDuration`.
 *
 *   Step 1 (when an image is attached): FIELD-TRAINED VISION TRANSFORMER
 *     disease classifier on the Hugging Face Serverless Inference API
 *     (auth: `HUGGINGFACE_API_KEY`, with `HF_TOKEN` / `HGF_TOKEN` honoured
 *     as aliases). The old MobileNetV2 is GONE — the model chain is now a
 *     high-accuracy ViT fine-tuned on real plant-disease field data:
 *       1. `kimcomehome/plantvillage-vit-leaf-disease` — ViT-base
 *          patch16-224 (ImageNet-21k pretrained) fine-tuned on PlantVillage
 *          (38 crop-disease classes across 14 crop species, ~99.8 % held-out
 *          accuracy; same `Crop___Disease` label space the app already
 *          localises to Arabic);
 *       2. `nateraw/vit-base-beans` — ViT-base fine-tuned on the field
 *          "beans" leaf-disease dataset (bean rust, angular leaf spot,
 *          healthy);
 *       3. `wambugu71/crop_leaf_diseases_vit` — ViT-tiny multi-crop
 *          (corn / potato / rice / wheat) last resort.
 *     Every id is an open, non-gated repository served on-demand on
 *     Hugging Face's free serverless CPU tier — no new keys, no cost.
 *     The returned `{ label, score }[]` array is sorted and parsed into the
 *     primary disease class + confidence + differential diagnoses (top-3
 *     candidates). Handles 503/530 model-loading responses and walks the
 *     model chain on availability errors. Non-fatal: a vision outage is
 *     recorded in `warnings[]` and the request continues through Step 2 /
 *     the safety net without a diagnosis. Receives the Step 0 crop when
 *     detection succeeded, the full frame otherwise.
 *
 *   Step 2 (Gemini LLM Formatter): Google Gemini is the SOLE conversational
 *     orchestrator and final response generator. It receives, in one
 *     `generateContent` call:
 *       • the Step 1 vision diagnosis (disease label + Arabic localisation,
 *         confidence score and the differential / candidate diseases)
 *         whenever one was produced;
 *       • the user context (wilaya/region, crop, role, language, name);
 *       • the recent conversation history (the client's `history` field —
 *         the smart-memory / progressive-detailing context);
 *       • the user's current query.
 *     REST call to
 *     https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=$GEMINI_API_KEY
 *     (server-only `GEMINI_API_KEY`), guarded by one shared 18 s
 *     `AbortController` deadline for the whole model chain. Google retires
 *     model generations on a fast cadence, so the model ids form a chain
 *     (`gemini-3.5-flash` → `gemini-3.5-flash-lite` → `gemini-2.5-flash`):
 *     a 404 / model-not-found walks to the next id within the remaining
 *     budget, while key/quota/5xx/safety/network/timeout failures fail the
 *     step immediately (another model id can't fix them). Each generation
 *     receives its own `thinkingConfig` — Gemini 3.x models take
 *     `thinkingLevel: "low"`, Gemini 2.5 takes `thinkingBudget: 0`.
 *     Success → HTTP 200 `{ source: "llm" }` (promoted to `"hybrid"` when
 *     the answer ships together with a Step 1 diagnosis) carrying Gemini's
 *     generated Arabic reply.
 *
 *   Safety net (Step 1 AND Step 2 both down — zero-failure formatting):
 *     built-in TypeScript formatters answer 200 with `{ source: "direct" }`:
 *       • diagnosis available   → concise Arabic Markdown diagnosis card
 *                                 built from the Step 1 label + confidence;
 *       • text-only request     → friendly basic-mode Arabic reply: greets
 *                                 back simple salutations ("هلا"، "مرحبا"،
 *                                 "السلام عليكم"…) and asks how to help
 *                                 with the farm, otherwise explains the
 *                                 basic mode and invites crop symptoms or a
 *                                 leaf photo;
 *       • image but vision down → basic-mode reply + a "photo analysis
 *                                 unavailable, retry" note.
 *     This is the ONLY case the client surfaces its amber fallback warning
 *     (both classification and Gemini failed completely).
 *
 *   Final safety net: `POST` wraps the whole handler in a try/catch, so even
 *     an unexpected internal exception becomes a 200 basic-mode reply.
 *
 * Both server secrets (`GEMINI_API_KEY`, and the Hugging Face token under
 * `HUGGINGFACE_API_KEY` — with `HF_TOKEN` / `HGF_TOKEN` accepted as
 * aliases) are read from `process.env` on the server only — they are never
 * shipped to the browser and never echoed back in a response body.
 *
 * Status contract: 200 for every AI outcome (including all upstream
 * failures); 400/413 only for invalid client input; 503 + code MISSING_KEYS
 * when NO provider key is configured at all (the explicit
 * server-misconfiguration signal). No HTTP 500 ever.
 *
 * Error reporting: each step logs to the server console
 * (`[Step 1: HF Success]` / `[Step 2: Gemini Success]` and corresponding
 * warning logs; `[Step 2: Gemini Fallback]` marks a model switch,
 * `[Step 1: HF Unavailable]` / `[Step 2: Gemini Unavailable → Direct]`
 * mark graceful degradation and `[Safety Net]` an unexpected internal
 * error). Non-fatal degradations are surfaced to the client in `warnings[]`.
 */

import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import {
  LEAF_DETECT_DEFAULTS,
  parseObjectDetections,
  selectLeafCrop,
  type CropRect,
  type LeafDetection,
} from "@/lib/assistant/leaf-detect";
import { confidenceBucket, parsePlantLabel } from "@/lib/assistant/plantvillage";
import type {
  AssistantContext,
  AssistantDiagnosis,
  AssistantHistoryEntry,
  AssistantImagePayload,
  AssistantPreprocessing,
  AssistantRequestBody,
  AssistantResponseBody,
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
 * Step 1 — field-trained Vision Transformer classifiers on the HF
 * Inference API, tried in order. All open, non-gated, free serverless CPU
 * tier; the first two are ViT-BASE (high accuracy), the third ViT-TINY
 * (last resort).
 */
const HF_PLANT_MODELS = [
  "kimcomehome/plantvillage-vit-leaf-disease",
  "nateraw/vit-base-beans",
  "wambugu71/crop_leaf_diseases_vit",
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
 *   • `suryanshgoel/detr-finetuned-plantdoc` — DETR-ResNet-50 fine-tuned on
 *     the PlantDoc plant-disease dataset (30 classes, every one of them a
 *     plant leaf or lesion — "apple scab", "tomato late blight", …), so any
 *     box it returns localises leaf material. Open weights, transformers
 *     checkpoint, served on Hugging Face's free serverless CPU tier.
 *   • `facebook/detr-resnet-50` — general COCO fallback for when the
 *     specialised checkpoint is unavailable: only its plant-flavoured labels
 *     ("potted plant") are accepted, so a houseplant photo still crops while
 *     a photo of the farmer's hand never passes the filter.
 *
 * Both are open-source and free — the weights live on Hugging Face's
 * infrastructure, the function only parses the returned boxes, so the
 * serverless bundle and the cold start stay untouched.
 */
interface LeafDetectModel {
  id: string;
  /** Which detected labels count as leaf/plant material for this id. */
  acceptLabel: (label: string) => boolean;
}

const DEFAULT_LEAF_DETECT_MODELS: LeafDetectModel[] = [
  { id: "suryanshgoel/detr-finetuned-plantdoc", acceptLabel: () => true },
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

/* ---- Step 2 — Google Gemini (the SOLE LLM / final formatter) ------ */

/**
 * Step 2 model chain, in order. Google retires whole generations on a fast
 * cadence — the 1.5 family shut down Sep 2025 and the 2.0 flash family Jun
 * 2026 (both now 404 "is not found for API version v1beta"), and
 * `gemini-2.5-flash` is next in line — so a single hardcoded id is a time
 * bomb: a retired id's fast 404 walks the chain to the next id within the
 * remaining Step-2 budget.
 *
 * `thinking` carries the per-generation `thinkingConfig`, because each
 * generation rejects the other's parameter with 400 INVALID_ARGUMENT:
 * Gemini 3.x models take a qualitative `thinkingLevel` (2.5 rejects it —
 * "Thinking level is not supported for this model"), while Gemini 2.5 takes
 * a numeric `thinkingBudget` (`0` = skip the reasoning pass, answer-first).
 */
const GEMINI_MODELS = [
  { id: "gemini-3.5-flash", thinking: { thinkingLevel: "low" } },
  { id: "gemini-3.5-flash-lite", thinking: { thinkingLevel: "low" } },
  { id: "gemini-2.5-flash", thinking: { thinkingBudget: 0 } },
] as const;

type GeminiModel = (typeof GEMINI_MODELS)[number];

/**
 * Step 2 hard timeout for the WHOLE model chain: 18 s. A full Arabic
 * ~200-word answer (system prompt + profile context + conversation history
 * + vision verdict in, up to {@link GEMINI_MAX_OUTPUT_TOKENS} out) regularly
 * takes 10–15 s on a cold Flash model; the previous 9 s window aborted those
 * healthy generations mid-flight. 18 s still leaves the safety-net
 * formatting comfortably inside {@link maxDuration}. Enforced with an
 * explicit `AbortController` (not `AbortSignal.timeout`) so the abort reason
 * and the timer are both inspectable/clearable per request; a fast 404 on an
 * earlier id hands the remaining budget to the next id.
 */
const GEMINI_TIMEOUT_MS = 18_000;

/**
 * Output cap for Step 2. Slightly above a typical ~150-word answer because
 * Gemini counts any internal reasoning tokens against `maxOutputTokens`;
 * the per-model thinking config (`thinkingLevel: "low"` on Gemini 3.x,
 * `thinkingBudget: 0` on 2.5) keeps the model in fast, answer-first mode so
 * the 18 s budget is spent on the reply.
 */
const GEMINI_MAX_OUTPUT_TOKENS = 1024;

/**
 * Per-call deadline for the HF Inference round-trips (Step 0 detection +
 * Step 1 ViT classification). Generous for a cold ViT-base on the serverless
 * CPU tier (model download + inference can exceed 10 s on first load), but
 * comfortably inside the route's 60 s `maxDuration` budget — the Step 0
 * detector runs under its own tighter 9 s window regardless.
 */
const UPSTREAM_TIMEOUT_MS = 25_000;

/** Hard cap on the user's message — the system prompt demands brevity. */
const MAX_MESSAGE_CHARS = 4000;

/** ~6 MB of raw base64 ≈ 4.5 MB image — plenty for a leaf photo. */
const MAX_IMAGE_B64_CHARS = 6 * 1024 * 1024;

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
 * token that authenticates Step 0 (detection) and Step 1 (vision).
 * `HUGGINGFACE_API_KEY` is this project's documented name; `HF_TOKEN` is the
 * name Hugging Face's own SDKs/CLI read; `HGF_TOKEN` is the short alias
 * accepted by this project. A deployment configured any of the three ways
 * still gets the vision step instead of a silent skip.
 */
const HF_TOKEN_ENV_VARS = ["HUGGINGFACE_API_KEY", "HF_TOKEN", "HGF_TOKEN"] as const;

/**
 * The first usable Hugging Face token found in the environment, whitespace
 * trimmed — or `null` when none is configured (unset or blank). Purely
 * synchronous: a missing token lets the handler skip Steps 0/1 instantly,
 * with no request, no exception and no waiting.
 */
function resolveHuggingFaceToken(): string | null {
  for (const name of HF_TOKEN_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Step 1 — Hugging Face field-trained ViT diagnosis (STRICT)         */
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
 * Strict Step 1: classify the (Step 0-cropped) leaf image with the
 * field-trained ViT chain on the Hugging Face Serverless Inference API.
 * - Sends the raw image bytes to the classifier (auth: Bearer token +
 *   `X-Wait-For-Model`).
 * - Walks the model chain on 503/530 model-loading, 4xx/5xx and
 *   wrong-payload-shape responses (availability errors), surfacing the
 *   model's estimated loading time when present.
 * - Parses the returned `{ label, score }[]` array: sorted descending →
 *   primary predicted disease class + confidence percentage + differential
 *   diagnoses (top-3 candidates), localised to Arabic via
 *   {@link parsePlantLabel}.
 * - Throws an Error prefixed with "HF Error:" when every model failed, so
 *   the caller degrades gracefully (warning, no HTTP 500).
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

      // The Inference API should return an array of { label, score }.
      // Validate and parse.
      if (!isHfClassificationArray(json)) {
        const detail = `unexpected payload shape from ${model}: ${JSON.stringify(json).slice(0, 500)}`;
        lastErrorDetail = detail;
        console.warn(`[Step 1: HF Warning] ${detail}`);
        continue;
      }

      // Properly parse returned array: sort descending and extract the
      // primary class + confidence, plus the differential candidates.
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
      `HF Error: Model is loading — ${msg}. The ViT model is warming up on Hugging Face; please retry after ${loadingEstimate ? Math.ceil(loadingEstimate) : 20}s.`,
    );
  }
  throw new Error(
    `HF Error: ${lastErrorDetail ?? "Unable to classify image with the ViT model chain (all HF endpoints failed)"}`,
  );
}

/* ------------------------------------------------------------------ */
/*  Step 2 prompting — system prompt + history + user turn for Gemini  */
/* ------------------------------------------------------------------ */

/**
 * Shared system prompt for the Gemini LLM formatter (Step 2): the serious
 * professional agricultural expert («خبير زراعي محترف وجدي») — direct,
 * precise and practical Arabic answers with only a very subtle touch of
 * politeness: no affectionate greetings, no long-winded essays, no repeated
 * pleasantries or rehashed advice on ongoing conversations, strictly within
 * the agriculture / date-palm / Algerian farming domain.
 */
const SYSTEM_PROMPT = `أنت مساعد زراعي خبير داخل تطبيق "محصولي الذكي" (Smart Crop AI): خبير زراعي محترف وجدي، دقيق وموثوق. تقدم مشورة علمية صحيحة بأسلوب مهني متوازن وطبيعي، مع لمسة لباقة خفيفة فقط — دون ترحيبات عاطفية، دون خطب طويلة، ودون دفء زائد.

النبرة والدقة:
- أجب مباشرة على سؤال الفلاح دون مقدمات أو إطالة؛ ادخل في صلب الموضوع من السطر الأول.
- هدفك الأول هو الدقة وبناء الثقة: معلومات علمية دقيقة بصياغة واضحة وفي متناول الفلاح الميداني.
- أجب دائماً باللغة العربية الفصحى المبسطة، إلا إذا طُلبت الفرنسية صراحةً في سياق المستخدم.
- حافظ على الجواب عملياً ومختصراً (في حدود ~١٥٠ كلمة)، بنقاط واضحة عند الحاجة.

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
- عند وجود تشخيص من نموذج الرؤية (ViT المدرّب ميدانياً على أمراض المحاصيل): اعتمد عليه مباشرة، اذكر المرض بالعربية مع نسبة الثقة (مثال: Tomato___Early_blight 95%)، ثم قدّم العلاج والوقاية في نقاط عملية.
- إن كانت نسبة الثقة ضعيفة (<45%)، اطلب صورة أوضح في سطر واحد مع ذكر التشخيصات البديلة المحتملة.
- اذكر مواد وممارسات متوفرة فعلاً في السوق الجزائرية (مبيدات نحاسية، مانكوزيب، كبريت ميكروني، تناوب زراعي…) مع جرعات إرشادية مختصرة وفترة الأمان قبل الجني.
- خصّص التوصيات حسب ولاية المستخدم ومناخها ومحصوله ودوره إن وردت في السياق المرفق.

حدود المجال (التزام صارم):
- اختصاصك 100٪: الفلاحة، صحة النخيل والتمور، السقي، العناية بالتربة، والسياق الفلاحي الجزائري المحلي.
- إن خرج السؤال عن الفلاحة، أعد المحادثة بجملة مهنية واحدة نحو اختصاصك دون محاضرة.
- لا تدّعي اليقين المطلق: في الحالات الحرجة انصح بمعاينة مهندس زراعي محلي، في سطر واحد.`;

/** Conversation-history budget for Step 2 (keep the payload lean + cheap). */
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_TEXT_CHARS = 1500;

/**
 * Defensively normalise the client-sent `history` into clean, strictly
 * alternating Gemini turns:
 *   • drop entries that are not `{ role: "user" | "assistant", text }` or
 *     carry no text;
 *   • keep only the most recent {@link MAX_HISTORY_TURNS} turns, each
 *     truncated to {@link MAX_HISTORY_TEXT_CHARS};
 *   • merge consecutive same-role turns (a client bug must never produce an
 *     API 400) and drop leading assistant turns (Gemini's first content must
 *     be a user turn).
 */
function sanitizeHistory(raw: unknown): AssistantHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const clean: AssistantHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { role, text } = item as { role?: unknown; text?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    clean.push({ role, text: text.slice(0, MAX_HISTORY_TEXT_CHARS) });
  }
  const recent = clean.slice(-MAX_HISTORY_TURNS);
  const alternating: AssistantHistoryEntry[] = [];
  for (const entry of recent) {
    const last = alternating[alternating.length - 1];
    if (last && last.role === entry.role) {
      last.text = `${last.text}\n${entry.text}`.slice(0, MAX_HISTORY_TEXT_CHARS);
    } else {
      alternating.push({ ...entry });
    }
  }
  while (alternating.length > 0 && alternating[0].role === "assistant") {
    alternating.shift();
  }
  return alternating;
}

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
    "نتيجة نموذج الرؤية (ViT — مدرّب ميدانياً على أمراض المحاصيل) على صورة المستخدم:",
    `- المرض المشخّص (disease label): ${diagnosis.labelAr} — التسمية الخام: ${diagnosis.label}`,
    `- درجة الثقة (confidence score): ${pct}% (${bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة"})`,
    alternates ? `- الأمراض المرشّحة البديلة (candidate diseases / التشخيص التفريقي): ${alternates}` : "",
    diagnosis.healthy
      ? "- النموذج يرى أن النبتة سليمة؛ طمئن المستخدم وقدّم نصائح وقائية."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the single user turn for the Step 2 Gemini call: Firestore profile
 * context (Wilaya, crop, role, language, name) + the Step 1 ViT vision
 * diagnosis (disease label, confidence score and differential candidate
 * diseases) when one is available + the user's own query.
 */
function buildUserContent(
  message: string,
  context: AssistantContext | undefined,
  diagnosis: AssistantDiagnosis | null,
): string {
  const sections = [
    `سياق المستخدم من ملفه الشخصي: ${describeContext(context)}`,
    describeDiagnosis(diagnosis),
    diagnosis
      ? `تشخيص نموذج الرؤية (من Step 1 — مرّر مباشرة إلى نموذج اللغة): ${diagnosis.label} بثقة ${Math.round(diagnosis.confidence * 100)}% — ${diagnosis.labelAr}`
      : "",
    message
      ? `سؤال المستخدم: ${message}`
      : diagnosis
        ? "لم يكتب المستخدم سؤالاً — قدّم التشخيص وخطة العلاج والوقاية مباشرة بناءً على نتيجة نموذج الرؤية أعلاه."
        : "قدّم نفسك في جملة واحدة كمساعد زراعي خبير واطلب سؤال المستخدم دون أي حشو.",
  ].filter(Boolean);
  return sections.join("\n\n");
}

/** Any Step-2 failure; the caller degrades to the built-in safety net either way. */
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
 * than the request: a retired or mistyped id answers
 * `404 — models/gemini-1.5-flash is not found for API version v1beta, or is
 * not supported for generateContent`. Together with an HTTP 404 these are the
 * only Step-2 failures that walk the Gemini model chain — invalid keys
 * (400/403), quota (429), safety blocks, 5xx, network errors and the timeout
 * abort are surfaced immediately, because another model id can't fix them.
 */
const GEMINI_MODEL_ERROR_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /is not found/i,
  /not supported for generateContent/i,
  /\bunknown model\b/i,
  /\bno such model\b/i,
];

/** True when the failure looks like "this Gemini model id is retired/gone". */
function isGeminiModelAvailabilityError(error: unknown): boolean {
  if (!(error instanceof GeminiError)) return false;
  if (error.status === 404) return true;
  return GEMINI_MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

interface GeminiContentTurn {
  role: "user" | "model";
  parts: { text: string }[];
}

/**
 * One `models.generateContent` round-trip against a single Gemini id:
 *   • `systemInstruction` — the expert Arabic advisor system prompt;
 *   • `contents` — the (sanitised) conversation history followed by the
 *     final user turn carrying the user query + profile context + the Step 1
 *     ViT vision diagnosis (label, confidence, differential candidates);
 *   • `generationConfig` — the sampling params plus the model's own
 *     `thinkingConfig` ({@link GeminiModel.thinking}).
 *
 * Throws {@link GeminiError} on every failure mode (status kept for the
 * chain-walk decision); a fetch aborted by the shared signal is reported as
 * the Step-2 timeout.
 */
async function generateWithGeminiModel(
  model: GeminiModel,
  contents: GeminiContentTurn[],
  signal: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: {
            temperature: 0.4,
            topP: 0.9,
            maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
            // Answer-first latency, per generation: Gemini 3.x →
            // thinkingLevel "low", Gemini 2.5 → thinkingBudget 0. Each
            // generation 400s the other's parameter, so spread the model's
            // own config instead of hardcoding one shape.
            thinkingConfig: { ...model.thinking },
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

/** Step-2 outcome: the model id that answered, its text and any non-fatal
 *  degradations (retired-id 404s) the chain walked past to get there. */
interface GeminiResult {
  model: string;
  text: string;
  warnings: string[];
}

/**
 * Step 2 — Google Gemini, the SOLE conversational orchestrator and final
 * response generator.
 *
 * POSTs to
 * `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<GEMINI_API_KEY>`
 * walking {@link GEMINI_MODELS} in order — starting at `gemini-3.5-flash`.
 *
 * The `contents` payload is the conversation: the sanitised history turns
 * (assistant turns mapped to Gemini's `model` role) followed by the final
 * user turn (query + profile context + Step 1 ViT diagnosis).
 *
 * The whole chain is bounded by ONE 18 s `AbortController` deadline
 * ({@link GEMINI_TIMEOUT_MS}) instead of per-call timeouts: a fast
 * model-availability failure (404 / model-not-found — the signature of a
 * retired generation) walks to the next id with whatever budget remains
 * (each walk is recorded in the result's `warnings` so the client still sees
 * the degradation), while any other failure — invalid/missing key (400/403),
 * quota (429), upstream 5xx, safety block, empty candidate list, network
 * error or the timeout abort — throws {@link GeminiError} immediately so the
 * caller answers from the built-in safety net.
 */
async function generateWithGemini(
  userContent: string,
  history: AssistantHistoryEntry[],
): Promise<GeminiResult> {
  const contents: GeminiContentTurn[] = [
    ...history.map((turn) => ({
      role: turn.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: turn.text }],
    })),
    { role: "user", parts: [{ text: userContent }] },
  ];

  const controller = new AbortController();
  // Explicit AbortController + shared deadline (rather than per-call
  // AbortSignal.timeout) so the WHOLE model chain — not one call — is bounded
  // by the 18 s window, and the pending round-trip and timer are always
  // cancelled/cleared.
  const deadline = Date.now() + GEMINI_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const failures: string[] = [];
    const warnings: string[] = [];
    for (const [index, model] of GEMINI_MODELS.entries()) {
      // Only reachable after fast 404 walks that consumed the window — no
      // budget left for another round-trip.
      if (Date.now() >= deadline) break;

      try {
        const text = await generateWithGeminiModel(model, contents, controller.signal);
        return { model: model.id, text, warnings };
      } catch (error) {
        if (!(error instanceof GeminiError)) throw error;
        failures.push(`${model.id}: ${error.message}`);

        if (!isGeminiModelAvailabilityError(error)) {
          // Anything that isn't about model availability (bad key, quota,
          // Google 5xx, timeout) fails the step immediately — another id
          // can't fix it.
          throw error;
        }

        const next = GEMINI_MODELS[index + 1];
        if (next) {
          warnings.push(`Step 2 Gemini unavailable — ${error.message}`.slice(0, 400));
          console.warn(`[Step 2: Gemini Fallback] ${error.message} — retrying with ${next.id}`);
          continue;
        }
        // Availability failure on the LAST id — fall through to the summary.
      }
    }
    // Every id in the chain was retired/gone (or the budget ran out) —
    // report all of them so the operator can tell "Google retired these
    // models" from "this key lacks access".
    throw new GeminiError(
      `no Gemini model could answer (tried ${GEMINI_MODELS.map((m) => m.id).join(", ")}) — ${failures.join(" | ")}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Safety net — direct formatting (ZERO-FAILURE)                      */
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

function adviceForLabel(label: string): DirectAdvice {
  return (
    DIRECT_ADVICE_BY_DISEASE.find((entry) => entry.match.test(label))?.advice ??
    DIRECT_GENERAL_ADVICE
  );
}

/**
 * Zero-failure safety net: builds a clean, concise Arabic Markdown diagnosis
 * card directly from the Step 1 label + confidence, with practical general
 * advice. Used ONLY when Step 1 succeeded but Step 2 (Gemini) failed or is
 * unavailable — the request then answers 200 with `{ source: "direct" }`
 * instead of a 500. When Step 1 failed TOO (image sent, no diagnosis), the
 * basic-mode replies below answer instead — that is the one case the client
 * shows its amber fallback warning.
 */
function buildDirectDiagnosisCard(diagnosis: AssistantDiagnosis): string {
  const pct = Math.round(diagnosis.confidence * 100);
  const bucket = confidenceBucket(diagnosis.confidence);
  const bucketAr = bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة";
  const alternates = diagnosis.candidates
    .slice(1)
    .map((c) => `${parsePlantLabel(c.label).labelAr} (${Math.round(c.score * 100)}%)`)
    .join("، ");
  const footer =
    "> ⚠️ بطاقة تشخيص تلقائية مبنية مباشرة على نموذج الرؤية (ViT) — نموذج اللغة غير متاح حالياً.";

  if (diagnosis.healthy) {
    const lines = [
      `- **النبتة سليمة** حسب نموذج الرؤية — نسبة الثقة: ${pct}% (${bucketAr}).`,
      alternates ? `- احتمالات أخرى: ${alternates}` : "",
    ].filter(Boolean);
    return [
      `## 🔬 التشخيص\n${lines.join("\n")}`,
      "## 🛡️ وقاية\n- سقي صباحي منتظم عند القاعدة دون بلل الأوراق.\n- تسميد متوازن ومراقبة الأوراق الجديدة أسبوعياً.",
      "## 📅 متابعة موصى بها\n- فحص أسبوعي للأوراق السفلية والبراعم؛ عند أول بقعة أرسل صورة واضحة للتشخيص المبكر.",
      footer,
    ].join("\n\n");
  }

  const advice = adviceForLabel(diagnosis.label);
  const lowConfidence = diagnosis.confidence < 0.45;
  const lines = [
    `- الإصابة: **${diagnosis.labelAr}** — التسمية الخام: \`${diagnosis.label}\``,
    `- نسبة الثقة: ${pct}% (${bucketAr})`,
    alternates ? `- تشخيصات بديلة محتملة: ${alternates}` : "",
    lowConfidence
      ? "- الثقة ضعيفة: أرسل صورة أوضح (ورقة كاملة، إضاءة نهارية) للتأكيد قبل المعالجة."
      : "",
  ].filter(Boolean);

  return [
    `## 🔬 التشخيص\n${lines.join("\n")}`,
    `## 💊 خطة العلاج\n${advice.treatment.map((line) => `- ${line}`).join("\n")}`,
    `## 🛡️ الوقاية مستقبلاً\n${advice.prevention.map((line) => `- ${line}`).join("\n")}`,
    "## 📅 متابعة موصى بها\n- راقب تطور الأعراض كل 3–5 أيام؛ إن انتشرت رغم العلاج، استشر مهندساً زراعياً محلياً.",
    footer,
  ].join("\n\n");
}

/* ------------------------------------------------------------------ */
/*  Safety net (text-only) — basic-mode replies (ZERO-FAILURE)         */
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
 * Friendly basic-mode text reply used when Step 2 (Gemini) is unavailable on
 * a request without a usable diagnosis. Greets back simple salutations
 * ("هلا"، "مرحبا"، "السلام عليكم"…) and asks how to help with the farm;
 * otherwise explains the basic mode and invites crop symptoms or a leaf
 * photo (which Step 1 + the direct formatter can still handle without the
 * LLM).
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
    "- أو أرفق صورة واضحة لورقة مصابة — نموذج الرؤية (ViT) يشخّصها ويقدم خطة علاج مباشرة حتى في الوضع الأساسي.",
  ].join("\n");
}

/** Note appended when a photo was sent but the vision step couldn't analyse it. */
const VISION_UNAVAILABLE_NOTE = [
  "⚠️ تعذّر تحليل صورة الورقة حالياً — نموذج الرؤية غير متاح أو ما زال يقلع.",
  "- أعد المحاولة بعد دقيقة بصورة أوضح (ورقة كاملة، إضاءة نهارية).",
  "- أو صف أعراض النبتة بالنص وسأجيبك مباشرة.",
].join("\n");

/* ------------------------------------------------------------------ */
/*  Handler — fail-proof chain + direct-formatting fallbacks           */
/* ------------------------------------------------------------------ */

/**
 * Fail-proof pipeline body. Every upstream step is non-fatal:
 * - Step 1 (vision) failure → warning, continue through Step 2 (Gemini can
 *   still answer the text part) or straight to the safety net.
 * - Step 2 (Gemini) failure, timeout, or missing `GEMINI_API_KEY` → warning,
 *   answer 200 from the built-in safety net: diagnosis card when Step 1
 *   succeeded, friendly basic-mode text otherwise.
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

  // Server-only secrets — never exposed to the client bundle. Read on every
  // request (never at module load) so a rotated/added key is picked up without
  // a restart.
  //   GEMINI_API_KEY        → Step 2, the SOLE LLM (final response generator).
  //   HUGGINGFACE_API_KEY   → Step 0 leaf detection + Step 1 ViT vision
  //                           (HF_TOKEN / HGF_TOKEN, the conventional Hugging
  //                           Face names, are honoured as aliases).
  const configuredGeminiKey = process.env.GEMINI_API_KEY;
  const geminiKey = configuredGeminiKey?.trim() || null;
  // Keep the fetch URL's required process.env.GEMINI_API_KEY interpolation
  // exact while still tolerating accidental whitespace in deployment secrets.
  if (geminiKey && configuredGeminiKey !== geminiKey) {
    process.env.GEMINI_API_KEY = geminiKey;
  }
  const huggingfaceKey = resolveHuggingFaceToken();

  if (!geminiKey && !huggingfaceKey) {
    // Explicit misconfiguration signal (503 Service Unavailable — the route
    // contract no longer includes any HTTP 500). The UI shows its dedicated
    // "assistant unavailable" notice for code MISSING_KEYS. With either key
    // present the route still answers: the steps below degrade gracefully.
    return NextResponse.json(
      { error: "API keys missing on server", code: "MISSING_KEYS" },
      { status: 503 },
    );
  }

  const warnings: string[] = [];

  // ---- Fail-proof sequential pipeline ------------------------------
  // Step 0: leaf Detection & Cropping (when image attached). An open-source
  // object detector localises the leaf, the photo is cropped with sharp and
  // ONLY the crop continues down the pipeline — background noise (hands,
  // soil, pots) can no longer reach the disease classifier. Non-fatal by
  // construction: every failure degrades to the untouched original frame.
  let preprocessing: AssistantPreprocessing | null = null;
  /** What actually reaches Step 1: the Step 0 crop or the original image. */
  let classifyImage: AssistantImagePayload | null = image ?? null;

  // Step 1: field-trained ViT vision classification (when image attached).
  // Non-fatal: a vision outage (or a missing HF key) degrades to Gemini /
  // the safety net instead of failing the request.
  let diagnosis: AssistantDiagnosis | null = null;
  if (image) {
    const detection = await runLeafDetectionStage(image, huggingfaceKey, warnings);
    preprocessing = detection.preprocessing;
    classifyImage = detection.image;

    if (!huggingfaceKey) {
      const detail =
        "HUGGINGFACE_API_KEY is not configured (HF_TOKEN / HGF_TOKEN unset too) — vision step skipped.";
      console.warn(`[Step 1: HF Skipped] ${detail}`);
      warnings.push(`Step 1 vision unavailable — ${detail}`.slice(0, 400));
    } else {
      try {
        diagnosis = await classifyPlantImageStrict(
          classifyImage.data,
          classifyImage.mimeType,
          huggingfaceKey,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const detail = msg.startsWith("HF Error:") ? msg.slice("HF Error:".length).trim() : msg;
        console.warn(`[Step 1: HF Unavailable] ${detail}`);
        warnings.push(`Step 1 vision unavailable — ${detail}`.slice(0, 400));
      }
    }
  }

  // One user turn for Step 2: user query + Firestore profile context
  // (Wilaya, crop type, role) + the Step 1 ViT vision diagnosis (disease
  // label, confidence score, differential candidates) whenever it exists.
  const userContent = buildUserContent(message, context, diagnosis);
  // Recent conversation turns (client-sent) → the smart-memory context that
  // lets Gemini build on the previous turns instead of rehashing them.
  const history = sanitizeHistory(body.history);

  // ---- Step 2: Google Gemini — SOLE LLM, final response generator ---
  // gemini-3.5-flash (→ 3.5-flash-lite → 2.5-flash on a retired-id 404) via
  // the Generative Language REST API, keyed with GEMINI_API_KEY and bounded
  // by a shared 18 s AbortController. Non-fatal: on any failure (or a
  // missing key) the built-in safety net answers below.
  let reply: string | null = null;
  if (geminiKey) {
    try {
      const geminiResult = await generateWithGemini(userContent, history);
      reply = geminiResult.text;
      // Non-fatal degradations the chain walked past (a retired primary id
      // 404ing before its successor answered) are still surfaced to the
      // client — the operator should see that the primary is gone.
      warnings.push(...geminiResult.warnings);
      console.log(
        `[Step 2: Gemini Success] model=${geminiResult.model} diagnosis=${diagnosis?.label ?? "none"} confidence=${diagnosis ? `${Math.round(diagnosis.confidence * 100)}%` : "n/a"} historyTurns=${history.length} replyLength=${reply.length}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Step 2: Gemini Unavailable → Direct] ${detail}`);
      warnings.push(`Step 2 Gemini unavailable — ${detail}`.slice(0, 400));
    }
  } else {
    const detail = "GEMINI_API_KEY is not configured — skipping the LLM step.";
    console.warn(`[Step 2: Gemini Skipped] ${detail} → built-in formatter`);
    warnings.push(`Step 2 Gemini unavailable — ${detail}`.slice(0, 400));
  }

  if (reply !== null) {
    const payload: AssistantResponseBody = {
      reply,
      diagnosis,
      source: diagnosis ? "hybrid" : "llm",
      ...(preprocessing ? { preprocessing } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    return NextResponse.json(payload);
  }

  // ---- Safety net: direct formatting, zero-failure -------------------
  // Step 2 is down: answer 200 from the built-in TypeScript formatters.
  let directReply: string;
  if (diagnosis) {
    // Image + successful vision → concise Arabic Markdown diagnosis card.
    // (The client does NOT show its amber fallback warning here: the
    // classification succeeded, only the LLM was missing.)
    directReply = buildDirectDiagnosisCard(diagnosis);
  } else if (image) {
    // Image but vision failed too → basic-mode text (when a message exists)
    // plus a clear note about the photo analysis being unavailable. THIS is
    // the "both classification and Gemini failed completely" case that
    // surfaces the client's amber fallback warning.
    directReply = message
      ? `${buildTextFallbackReply(message)}\n\n${VISION_UNAVAILABLE_NOTE}`
      : VISION_UNAVAILABLE_NOTE;
  } else {
    // Text-only → friendly basic-mode reply (greeting-aware).
    directReply = buildTextFallbackReply(message);
  }
  warnings.push("Reply formatted locally — the AI stages were unavailable.");

  const payload: AssistantResponseBody = {
    reply: directReply,
    diagnosis,
    source: "direct",
    ...(preprocessing ? { preprocessing } : {}),
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
