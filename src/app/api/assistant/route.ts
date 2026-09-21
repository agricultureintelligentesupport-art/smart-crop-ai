/**
 * `/api/assistant` — fail-proof 3-stage resilient AI chain for the
 * agricultural assistant. The route NEVER returns HTTP 500.
 *
 * Pipeline (Google Gemini first, Hugging Face fallback, built-in formatter
 * last — a vision pre-step feeds both LLM stages):
 *
 *   Step 0 (when an image is attached): leaf Detection & Cropping — the SAME
 *     free Hugging Face Inference router now ALSO runs an open-source object
 *     detector (DETR-ResNet-50 fine-tuned on PlantDoc, every one of its 30
 *     classes is a plant/leaf; the COCO `facebook/detr-resnet-50` with a
 *     plant-only label filter is the fallback id — the chain is overridable
 *     via `HF_LEAF_DETECT_MODELS`). The detected box is grown into a padded,
 *     clamped crop window and the photo is cropped server-side with sharp,
 *     so background noise (hands, soil, pots) NEVER reaches the PlantVillage
 *     classifier: Step 1 sees ONLY the cropped pixels. Strictly an accuracy
 *     pre-step — every failure mode is non-fatal and falls back to the
 *     untouched original frame (the exact pre-Step-0 behaviour): missing HF
 *     key, an undecodable image, an unreachable/loading detector, a payload
 *     that is not object-detection-shaped, or "no leaf above threshold". The
 *     outcome is reported in the new `preprocessing` response field and in
 *     `warnings[]` when the stage could not run at all.
 *     Vercel-friendly by design: no model weights ever touch the function
 *     (the detector runs on Hugging Face's free serverless CPU tier) and
 *     sharp adds only a few tens of ms of decode/crop work; the whole stage
 *     is bounded by its own 9 s deadline inside the 60 s `maxDuration`.
 *
 *   Step 1 — Vision Model Cascade (when an image is attached):
 *     Hugging Face Serverless Inference API cascade, non-blocking after
 *     Step 0 cropping:
 *       Step 1a — PRIMARY Field-Trained Vision Model (e.g.
 *         `dima806/plant_disease_image_detection` or `fxmeng/plantdoc-vit`):
 *         high-accuracy field-trained HF model, bounded by a strict 4 s
 *         timeout (>4s → immediate fallback). ViT trained on real field
 *         imagery (PlantDoc / field datasets) — the most accurate leaf
 *         classifier in the cascade.
 *       Step 1b — SECONDARY Fallback Model (KEPT INTACT):
 *         `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`
 *         — the CURRENT baseline MobileNetV2 PlantVillage classifier is NOT
 *         removed or overwritten; plus `wambugu71/crop_leaf_diseases_vit`
 *         tertiary. If the Primary fails, times out (>4s), or returns an
 *         error (503/530 loading, 4xx/5xx, network), the request seamlessly
 *         routes to this baseline. Both models parse the returned array to
 *         extract the primary predicted disease class + confidence percentage
 *         + candidate diseases. Handles 503/530 loading with a clear message.
 *         Non-fatal: a vision outage is recorded in `warnings[]` and the
 *         request continues through Stage 1 → 2 → 3 without a diagnosis.
 *         Receives the Step 0 crop when detection succeeded, the full frame
 *         otherwise.
 *         Env override: `HF_VISION_PRIMARY_MODELS` (comma list) or
 *         `HF_VISION_MODEL`/`HF_PRIMARY_VISION_MODEL` — the baseline
 *         fallback is ALWAYS preserved after any custom primary.
 *
 *   Stage 1 — Google Gemini (`gemini-3.5-flash` → `gemini-3.5-flash-lite` →
 *     `gemini-2.5-flash`) — PRIMARY LLM: REST call to
 *     https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=$GEMINI_API_KEY
 *     authenticated with the server-only Gemini key pool: `GEMINI_API_KEY`
 *     (including comma-separated values) plus numbered variants such as
 *     `GEMINI_API_KEY_2` and `GEMINI_API_KEY_3`, and guarded by one
 *     shared 18 s `AbortController` deadline for the whole model chain (an
 *     Arabic ~200-word answer regularly needs 10–15 s on a cold Flash model,
 *     so the previous 9 s window aborted healthy generations and pushed
 *     traffic onto the weaker fallbacks). Google retires model generations on a fast
 *     cadence — the 1.5 family shut down Sep 2025 and the 2.0 flash family
 *     Jun 2026, and both now answer 404 "is not found for API version
 *     v1beta" — so the model ids form a chain: a 404 / model-not-found
 *     walks to the next id within the remaining budget, while key/quota/5xx/
 *     safety/network/timeout failures fail the stage immediately (another
 *     model id can't fix them). Each generation receives its own
 *     `thinkingConfig` — Gemini 3.x models take `thinkingLevel: "low"` and
 *     reject a numeric `thinkingBudget`, Gemini 2.5 takes
 *     `thinkingBudget: 0` and rejects `thinkingLevel` (the wrong parameter
 *     is a 400, so the payload is model-aware).
 *     The expert system instruction ("أنت مساعد زراعي خبير…") is sent as
 *     `systemInstruction`; the user turn carries the user query, the Firestore
 *     profile context (Wilaya, crop, role…) and — whenever Step 1 produced one
 *     — the MobileNet vision diagnosis (disease label, confidence score and
 *     candidate diseases).
 *     Success → HTTP 200 `{ source: "llm" }` (promoted to `"hybrid"` when the
 *     answer ships together with a Step 1 diagnosis) carrying Gemini's
 *     generated Arabic reply.
 *
 *   Stage 2 (Gemini failed / timed out / `GEMINI_API_KEY` missing): Hugging
 *     Face Inference Providers LLM chat completion for concise text response
 *     formatting through the official OpenAI-compatible router
 *     `https://router.huggingface.co/v1/chat/completions` (Bearer
 *     `HUGGINGFACE_API_KEY`, model id in the JSON body). The router picks a
 *     live serving provider for the requested id and fails over between
 *     providers by itself; the monthly free Inference Providers credits of
 *     every Hugging Face account apply to these routed calls. Open,
 *     non-gated, lightweight ids only: `Qwen/Qwen3-4B-Instruct-2507`
 *     primary, then `Qwen/Qwen2.5-7B-Instruct` and the tiny
 *     `Qwen/Qwen2.5-1.5B-Instruct`.
 *     The per-provider `hf-inference` chat URLs the route used before
 *     (`/hf-inference/models/<id>/v1/chat/completions`) are gone for LLMs:
 *     since July 2025 the `hf-inference` provider only serves CPU tasks
 *     (classification, embeddings…), so every instruct model — including the
 *     previous `Llama-3.2-3B` / `Qwen2.5-7B` / `Mistral-7B` chain — answered
 *     `400 — Model not supported by provider hf-inference`; `Llama-3.2-3B`
 *     is additionally a gated repository (403 on tokens that never accepted
 *     Meta's license). Availability failures (`404 — Model not found`,
 *     `400 — model_not_supported` / "not supported by any provider", gated
 *     403s, empty choices) walk the chain and fail gracefully into Stage 3.
 *     When no Hugging Face token is configured at all, Stage 2 is skipped
 *     synchronously — no request, no exception, no waiting — and Stage 3
 *     answers immediately.
 *     The same system prompt, the same user query and the same Step 1 vision
 *     context are fed into the LLM behind a system prompt that enforces a
 *     direct, precise and practical Arabic answer in the voice of the serious
 *     professional agricultural expert ("أنت مساعد زراعي خبير…"): no repeated
 *     greetings, no introductory pleasantries once the conversation is
 *     underway, and no rehashed advice — strictly within the agriculture /
 *     date-palm / Algerian farming domain.
 *
 *   Stage 3 (both LLM stages down — zero-failure formatting):
 *     built-in TypeScript formatters answer 200 with `{ source: "direct" }`:
 *       • diagnosis available   → concise Arabic Markdown diagnosis card
 *                                 built from the Step 1 label + confidence;
 *       • text-only request     → friendly basic-mode Arabic reply: greets
 *                                 back simple salutations ("هلا"، "مرحبا"،
 *                                 "السلام عليكم"…) and asks how to help with
 *                                 the farm, otherwise explains the basic mode
 *                                 and invites crop symptoms or a leaf photo;
 *       • image but vision down → basic-mode reply + a "photo analysis
 *                                 unavailable, retry" note.
 *
 *   Final safety net: `POST` wraps the whole handler in a try/catch, so even
 *     an unexpected internal exception becomes a 200 basic-mode reply.
 *
 * Gemini credentials (`GEMINI_API_KEY` — including comma-separated values —
 * and optional `GEMINI_API_KEY_2`) and the Hugging Face secret
 * (`HUGGINGFACE_API_KEY` — with
 * Hugging Face's conventional `HF_TOKEN` accepted as an alias) are read from
 * `process.env` on the server only — they are never shipped to the browser
 * and never echoed back in a response body.
 *
 * Status contract: 200 for every AI outcome (including all upstream
 * failures); 400/413 only for invalid client input; 503 + code MISSING_KEYS
 * when NO provider key is configured at all (the explicit
 * server-misconfiguration signal). No HTTP 500 ever.
 *
 * Error reporting: each stage logs to the server console
 * (`[Step 1: HF Success]` / `[Stage 1: Gemini Success]` /
 * `[Stage 2: HF LLM Success]` and corresponding warning logs;
 * `[Stage 1: Gemini Fallback]` / `[Stage 2: HF LLM Fallback]` mark a model
 * switch,
 * `[Step 1: HF Unavailable]` / `[Stage 1: Gemini Unavailable → Stage 2]` /
 * `[Stage 2: HF LLM Unavailable → Stage 3]` mark graceful degradation and
 * `[Safety Net]` an unexpected internal error).
 * Non-fatal degradations are surfaced to the client in `warnings[]`.
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
 * Vision Model Cascade — PlantVillage classifiers on the HF Inference API,
 * tried in order. Implements the EXACT cascade required by spec:
 *
 *   Step 1a — PRIMARY Field-Trained Vision Model: high-accuracy field-trained
 *     HF model via HF Serverless Inference API. Examples:
 *     `dima806/plant_disease_image_detection` (ViT trained on real field data)
 *     or `fxmeng/plantdoc-vit` (ViT trained on PlantDoc). Bounded by a tight
 *     4 s timeout — if it fails, times out, or returns error, we seamlessly
 *     route to the secondary.
 *
 *   Step 1b — SECONDARY Fallback Model (KEPT INTACT): the CURRENT baseline
 *     classifier `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`
 *     is NOT removed or overwritten. It is the reliable fallback when the
 *     primary is cold, loading, or unavailable.
 *
 *   Tertiary — `wambugu71/crop_leaf_diseases_vit` kept as warm fallback for
 *     extra resilience.
 *
 * Environment override: `HF_VISION_PRIMARY_MODELS` (comma-separated) or
 * `HF_VISION_MODEL` / `HF_PRIMARY_VISION_MODEL` single id. When set, the
 * custom primary id(s) replace the default primary while the fallback chain
 * (baseline + tertiary) is ALWAYS preserved — the baseline is never dropped.
 */
export const HF_VISION_PRIMARY_MODELS = [
  "dima806/plant_disease_image_detection",
  "fxmeng/plantdoc-vit",
] as const;

export const HF_VISION_FALLBACK_MODELS = [
  "linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification",
  "wambugu71/crop_leaf_diseases_vit",
] as const;

export const HF_PLANT_MODELS = [
  ...HF_VISION_PRIMARY_MODELS,
  ...HF_VISION_FALLBACK_MODELS,
] as const;

/** Primary field-trained model(s) get a tight 4 s deadline per spec (>4s → fallback). */
export const VISION_PRIMARY_TIMEOUT_MS = 4_000;

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

/* ---- Stage 1 — Google Gemini (primary LLM) ----------------------- */

/**
 * Stage 1 model chain, in order. Google retires whole generations on a fast
 * cadence — the 1.5 family shut down Sep 2025 and the 2.0 flash family Jun
 * 2026 (both now 404 "is not found for API version v1beta"), and
 * `gemini-2.5-flash` is next in line — so a single hardcoded id is a time
 * bomb: a retired id's fast 404 walks the chain to the next id within the
 * remaining Stage-1 budget.
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
 * Stage 1 hard timeout for the WHOLE model chain: 18 s. A full Arabic
 * ~200-word answer (system prompt + profile context + vision verdict in, up
 * to {@link GEMINI_MAX_OUTPUT_TOKENS} out) regularly takes 10–15 s on a cold
 * Flash model; the previous 9 s window aborted those healthy generations
 * mid-flight and sent the request to the weaker fallbacks for nothing. 18 s
 * still leaves the Stage 2 round-trip and the Stage 3 formatter comfortably
 * inside {@link maxDuration}. Enforced with an explicit `AbortController`
 * (not `AbortSignal.timeout`) so the abort reason and the timer are both
 * inspectable/clearable per request; a fast 404 on an earlier id hands the
 * remaining budget to the next id.
 */
const GEMINI_TIMEOUT_MS = 18_000;

/**
 * Output cap for Stage 1. Slightly above {@link MAX_REPLY_TOKENS} because
 * Gemini counts any internal reasoning tokens against `maxOutputTokens`;
 * the per-model thinking config (`thinkingLevel: "low"` on Gemini 3.x,
 * `thinkingBudget: 0` on 2.5) keeps the model in fast, answer-first mode so
 * the 18 s budget is spent on the reply.
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

/* ---- Step 1 (vision) + Stage 2 — Hugging Face -------------------- */

/**
 * Lightweight open-source LLM ids tried by Stage 2, in order, through the
 * Hugging Face Inference Providers router ({@link HF_ROUTER_CHAT_URL}).
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
 * model-availability errors, and the Stage 3 direct formatter
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
 * Resolve the ordered vision model list for this request. Honors
 * `HF_VISION_PRIMARY_MODELS` (comma-separated), `HF_VISION_MODEL`, or
 * `HF_PRIMARY_VISION_MODEL` env overrides for the primary — the fallback
 * baseline is always appended intact so the cascade never loses it.
 * Primary models are the field-trained ones; fallback is the mobilenet
 * baseline + ViT kept intact.
 */
function resolveVisionModels(): readonly string[] {
  const raw =
    process.env.HF_VISION_PRIMARY_MODELS?.trim() ||
    process.env.HF_VISION_MODEL?.trim() ||
    process.env.HF_PRIMARY_VISION_MODEL?.trim();
  if (raw) {
    const ids = raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length > 0) {
      const fallback = [...HF_VISION_FALLBACK_MODELS] as string[];
      const dedupedFallback = fallback.filter((id) => !ids.includes(id));
      return [...ids, ...dedupedFallback];
    }
  }
  return HF_PLANT_MODELS;
}

function visionTimeoutForIndex(index: number, primaryCount: number): number {
  return index < primaryCount ? VISION_PRIMARY_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
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
 * token that authenticates Step 1 (vision) and Stage 2 (router LLM).
 * `HUGGINGFACE_API_KEY` is this project's documented name; `HF_TOKEN` is the
 * name Hugging Face's own SDKs/CLI read, so a deployment configured the
 * "Hugging Face way" still gets the fallback LLM instead of a silent skip.
 */
const HF_TOKEN_ENV_VARS = ["HUGGINGFACE_API_KEY", "HF_TOKEN"] as const;

/**
 * The first usable Hugging Face token found in the environment, whitespace
 * trimmed — or `null` when none is configured (unset or blank). Purely
 * synchronous: a missing token lets the handler skip Step 1 and Stage 2
 * instantly, with no request, no exception and no waiting.
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
 * Strict Step 1 — Vision Model Cascade: classify leaf image via Hugging Face.
 * Implements the EXACT cascade required by spec:
 *   Step 1a — PRIMARY field-trained HF model (e.g. dima806/plant_disease_image_detection
 *     or fxmeng/plantdoc-vit) via HF Serverless Inference API, bounded by
 *     VISION_PRIMARY_TIMEOUT_MS (4 s). High-accuracy ViT trained on real field data.
 *   Step 1b — SECONDARY fallback (KEPT INTACT): linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification
 *     (the CURRENT baseline MobileNetV2) + wambugu71/crop_leaf_diseases_vit tertiary.
 *     If Primary fails, times out (>4s), or returns error, seamlessly routes to Secondary.
 * - Sends the raw image bytes (cropped by Step 0 when available) to the plant-disease model.
 * - Parses the returned array to extract the primary predicted class + confidence.
 * - Handles 503/530 model-loading responses with a clear message and walks the cascade.
 * - Per-model timeout: Primary 4 s, Secondary/Tertiary 25 s (UPSTREAM_TIMEOUT_MS).
 * - Throws an Error prefixed with "HF Error:" on any failure so the caller can degrade gracefully.
 * - DETR smart cropping remains non-blocking (Step 0 already ran before this).
 */
async function classifyPlantImageStrict(
  imageBase64: string,
  mimeType: string,
  apiKey: string,
): Promise<AssistantDiagnosis> {
  const body = Buffer.from(imageBase64, "base64");

  let lastErrorDetail: string | null = null;
  let loadingEstimate: number | null = null;

  const models = resolveVisionModels();
  // Primary count is the number of field-trained ids before the fallback.
  // Default: HF_VISION_PRIMARY_MODELS.length (2). When env overrides, it's the custom id count.
  const envRaw =
    process.env.HF_VISION_PRIMARY_MODELS?.trim() ||
    process.env.HF_VISION_MODEL?.trim() ||
    process.env.HF_PRIMARY_VISION_MODEL?.trim();
  const primaryCount = envRaw
    ? envRaw.split(",").map((id) => id.trim()).filter(Boolean).length
    : HF_VISION_PRIMARY_MODELS.length;

  for (let idx = 0; idx < models.length; idx++) {
    const model = models[idx];
    const isPrimary = idx < primaryCount;
    const stepLabel = isPrimary ? "1a" : "1b";
    const timeoutMs = visionTimeoutForIndex(idx, primaryCount);
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
        if (isPrimary) {
          console.warn(`[Step 1a: HF Loading] ${model} → ${detail} — falling back to secondary baseline`);
        } else {
          console.warn(`[Step 1b: HF Loading] ${model} → ${detail}`);
        }
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
        if (isPrimary) {
          console.warn(`[Step 1a: HF Warning] ${model} → ${detail} — falling back to secondary`);
        } else {
          console.warn(`[Step 1b: HF Warning] ${model} → ${detail}`);
        }
        continue;
      }

      const json: unknown = await res.json();

      // HF should return an array of { label, score }. Validate and parse.
      if (!isHfClassificationArray(json)) {
        const detail = `unexpected payload shape from ${model}: ${JSON.stringify(json).slice(0, 500)}`;
        lastErrorDetail = detail;
        if (isPrimary) {
          console.warn(`[Step 1a: HF Warning] ${detail} — falling back to secondary`);
        } else {
          console.warn(`[Step 1b: HF Warning] ${detail}`);
        }
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
        `[Step 1${stepLabel}: HF Success] label=${top.label} confidence=${pct}% model=${model} timeout=${timeoutMs}ms candidates=${candidates.length}`,
      );
      return diagnosis;
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      const isTimeout =
        /timeout|abort|TimeoutError|AbortError/i.test(detail) || detail.includes("timed out");
      if (isTimeout && isPrimary) {
        console.warn(
          `[Step 1a: Primary Vision Timeout] ${model} timed out after ${timeoutMs}ms — falling back to secondary baseline`,
        );
      } else if (isPrimary) {
        console.warn(`[Step 1a: HF Warning] ${model} → ${detail} — falling back to secondary`);
      } else {
        console.warn(`[Step 1b: HF Warning] ${model} → ${detail}`);
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
/*  Shared prompting — one system prompt + user turn for BOTH LLMs      */
/*  (Stage 1 Gemini and Stage 2 Hugging Face receive identical input)   */
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
- عند وجود تشخيص من نموذج الرؤية (PlantVillage): اعتمد عليه مباشرة، اذكر المرض بالعربية مع نسبة الثقة (مثال: Tomato___Early_blight 95%)، ثم قدّم العلاج والوقاية في نقاط عملية.
- إن كانت نسبة الثقة ضعيفة (<45%)، اطلب صورة أوضح في سطر واحد مع ذكر التشخيصات البديلة المحتملة.
- اذكر مواد وممارسات متوفرة فعلاً في السوق الجزائرية (مبيدات نحاسية، مانكوزيب، كبريت ميكروني، تناوب زراعي…) مع جرعات إرشادية مختصرة وفترة الأمان قبل الجني.
- خصّص التوصيات حسب ولاية المستخدم ومناخها ومحصوله ودوره إن وردت في السياق المرفق.

حدود المجال (التزام صارم):
- اختصاصك 100٪: الفلاحة، صحة النخيل والتمور، السقي، العناية بالتربة، والسياق الفلاحي الجزائري المحلي.
- إن خرج السؤال عن الفلاحة، أعد المحادثة بجملة مهنية واحدة نحو اختصاصك دون محاضرة.
- لا تدّعي اليقين المطلق: في الحالات الحرجة انصح بمعاينة مهندس زراعي محلي، في سطر واحد.`;

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
    "نتيجة نموذج الرؤية (PlantVillage — MobileNetV2) على صورة المستخدم:",
    `- المرض المشخّص (disease label): ${diagnosis.labelAr} — التسمية الخام: ${diagnosis.label}`,
    `- درجة الثقة (confidence score): ${pct}% (${bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة"})`,
    alternates ? `- الأمراض المرشّحة البديلة (candidate diseases): ${alternates}` : "",
    diagnosis.healthy
      ? "- النموذج يرى أن النبتة سليمة؛ طمئن المستخدم وقدّم نصائح وقائية."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the single user turn shared by Stage 1 (Gemini `contents`) and
 * Stage 2 (HF `messages[1]`): Firestore profile context (Wilaya, crop, role,
 * language, name) + the Step 1 MobileNet vision diagnosis (disease label,
 * confidence score and candidate diseases) when one is available + the user's
 * own query. Keeping one builder guarantees the fallback LLM answers from
 * exactly the same context the primary was given.
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
      ? `تشخيص PlantVillage (من Step 1 — مرّر مباشرة إلى نموذج اللغة): ${diagnosis.label} بثقة ${Math.round(diagnosis.confidence * 100)}% — ${diagnosis.labelAr}`
      : "",
    message
      ? `سؤال المستخدم: ${message}`
      : diagnosis
        ? "لم يكتب المستخدم سؤالاً — قدّم التشخيص وخطة العلاج والوقاية مباشرة بناءً على نتيجة PlantVillage أعلاه."
        : "قدّم نفسك في جملة واحدة كمساعد زراعي خبير واطلب سؤال المستخدم دون أي حشو.",
  ].filter(Boolean);
  return sections.join("\n\n");
}

/** Any Stage-1 failure; the caller degrades to Stage 2 (and then 3) either way. */
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
 * only Stage-1 failures that walk the Gemini model chain — invalid keys
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

/**
 * One `models.generateContent` round-trip against a single Gemini id:
 *   • `systemInstruction` — the expert Arabic advisor system prompt;
 *   • `contents[0].parts[0].text` — the user query + profile context + the
 *     Step 1 MobileNet vision diagnosis (label, confidence, candidates);
 *   • `generationConfig` — the sampling params plus the model's own
 *     `thinkingConfig` ({@link GeminiModel.thinking}).
 *
 * Throws {@link GeminiError} on every failure mode (status kept for the
 * chain-walk decision); a fetch aborted by the shared signal is reported as
 * the Stage-1 timeout.
 */
async function generateWithGeminiModel(
  model: GeminiModel,
  userContent: string,
  signal: AbortSignal,
  apiKey: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userContent }] }],
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

/** Stage-1 outcome: the model id that answered, its text and any non-fatal
 *  degradations (retired-id 404s) the chain walked past to get there. */
interface GeminiResult {
  model: string;
  text: string;
  warnings: string[];
}

/**
 * Stage 1 — Google Gemini, the PRIMARY LLM.
 *
 * POSTs to
 * `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<GEMINI_API_KEY>`
 * walking {@link GEMINI_MODELS} in order — starting at `gemini-3.5-flash`.
 *
 * The whole chain is bounded by ONE 18 s `AbortController` deadline
 * ({@link GEMINI_TIMEOUT_MS}) instead of per-call timeouts: a fast
 * model-availability failure (404 / model-not-found — the signature of a
 * retired generation)
 * walks to the next id with whatever budget remains (each walk is recorded
 * in the result's `warnings` so the client still sees the degradation),
 * while any other failure — invalid/missing key (400/403), quota (429),
 * upstream 5xx, safety block, empty candidate list, network error or the
 * timeout abort — throws {@link GeminiError} immediately so the caller can
 * walk to Stage 2 (Hugging Face) and finally Stage 3 (built-in formatter).
 */
async function generateWithGeminiForKey(
  userContent: string,
  apiKey: string,
): Promise<GeminiResult> {
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
        const text = await generateWithGeminiModel(
          model,
          userContent,
          controller.signal,
          apiKey,
        );
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

        const next = GEMINI_MODELS[index + 1];
        if (next) {
          warnings.push(`Stage 1 Gemini unavailable — ${error.message}`.slice(0, 400));
          console.warn(`[Stage 1: Gemini Fallback] ${error.message} — retrying with ${next.id}`);
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

/** True when Gemini rejected this credential because its quota is exhausted. */
function isGeminiQuotaError(error: unknown): error is GeminiError {
  return error instanceof GeminiError && error.status === 429;
}

/**
 * Run the Gemini model chain against each configured credential in order.
 *
 * A 429 is credential-specific, so it gets a one-second backoff before the
 * next key is tried. Other Gemini failures also advance through the remaining
 * keys without a delay: Stage 1 only gives up to Hugging Face after every
 * configured Gemini key has had a chance to answer. API keys are represented
 * only by their ordinal in logs and warnings; their values never leave the
 * server or appear in a client response.
 */
async function generateWithGemini(
  userContent: string,
  geminiApiKeys: readonly string[],
): Promise<GeminiResult> {
  const failures: string[] = [];
  const rotationWarnings: string[] = [];

  for (let keyIndex = 0; keyIndex < geminiApiKeys.length; keyIndex += 1) {
    const apiKey = geminiApiKeys[keyIndex];
    try {
      const result = await generateWithGeminiForKey(userContent, apiKey);
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

      if (isGeminiQuotaError(error) && hasNextKey) {
        const warning =
          `Stage 1 Gemini HTTP 429 quota/rate limit on ${keyLabel} — ` +
          `key rotation attempt ${nextKeyIndex + 1}/${geminiApiKeys.length}.`;
        rotationWarnings.push(warning);
        console.warn(
          `[Stage 1: Gemini Key Rotation] ${warning} Retrying after 1 second.`,
        );
        await new Promise((res) => setTimeout(res, 1000));
      } else if (hasNextKey) {
        // A non-quota failure can also be isolated to one credential (for
        // example an invalid or revoked key). Try the next configured key
        // before allowing the request to fall through to Hugging Face.
        const warning =
          `Stage 1 Gemini failed on ${keyLabel} — ` +
          `key rotation attempt ${nextKeyIndex + 1}/${geminiApiKeys.length}.`;
        rotationWarnings.push(warning);
        console.warn(
          `[Stage 1: Gemini Key Rotation] ${error.message} — retrying with key ${nextKeyIndex + 1}/${geminiApiKeys.length}.`,
        );
      }
    }
  }

  throw new GeminiError(
    `all Gemini API keys failed — ${failures.join(" | ")}`,
  );
}

/* ------------------------------------------------------------------ */
/*  Stage 2 — Hugging Face LLM fallback chain (STRICT)                 */
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
 * Strict Stage 2 (fallback): concise Arabic text response formatting via the
 * Hugging Face Inference Providers router, starting at
 * {@link HF_LLM_MODELS Qwen/Qwen3-4B-Instruct-2507} and falling back
 * through the remaining open, non-gated ids when the router reports a model
 * as unavailable (404 not-found / 400 model_not_supported / 403
 * gated-license / empty choices). Any failure throws an "LLM Error:" — the
 * handler catches it and answers from Stage 3, so a Stage 2 outage never
 * breaks the HTTP response.
 * - Never called without a token: the handler skips the stage synchronously
 *   when no Hugging Face token is configured.
 * - Runs only after Stage 1 (Gemini) failed, timed out or its key is missing.
 * - Receives the exact same user turn as Gemini — built by
 *   {@link buildUserContent}, so it carries the PlantVillage label +
 *   confidence from Step 1 (when available), the user's text message and the
 *   Firestore profile context (Wilaya, crop).
 * - Uses the concise professional Arabic advisor system prompt.
 * - Throws an Error prefixed with "LLM Error:" once no model can answer.
 */
async function askHfLlmStrict(apiKey: string, userContent: string): Promise<string> {
  const failures: string[] = [];

  for (const [index, model] of HF_LLM_MODELS.entries()) {
    try {
      const text = await generateWithHfLlmModel(model, userContent, apiKey);

      console.log(
        `[Stage 2: HF LLM Success] model=${model} replyLength=${text.length}`,
      );
      return text;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const modelLevel = isHfLlmModelAvailabilityError(error);
      failures.push(`${model}: ${detail}`);

      const nextModel = index < HF_LLM_MODELS.length - 1 ? HF_LLM_MODELS[index + 1] : null;
      if (modelLevel && nextModel) {
        console.warn(`[Stage 2: HF LLM Fallback] ${detail} — retrying with ${nextModel}`);
        continue;
      }

      // Anything that isn't about model availability (bad key, quota, HF 5xx,
      // timeout) fails the stage immediately.
      if (!modelLevel) {
        const wrapped = new Error(`LLM Error: ${detail}`);
        console.error(`[Stage 2: HF LLM Error] ${wrapped.message}`);
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
  console.error(`[Stage 2: HF LLM Error] ${wrapped.message}`);
  throw wrapped;
}

/* ------------------------------------------------------------------ */
/*  Stage 3 — direct formatting safety net (ZERO-FAILURE)              */
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
 * Zero-failure safety net (Stage 3): builds a clean, concise Arabic Markdown
 * diagnosis card directly from the Step 1 label + confidence, with practical
 * general advice. Used ONLY when Step 1 succeeded but the entire 3-stage LLM
 * chain failed or is unavailable — the request then answers 200 with
 * `{ source: "direct" }` instead of a 500.
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
    "> ⚠️ بطاقة تشخيص تلقائية مبنية مباشرة على نموذج الرؤية — خدمة النصوص الذكية غير متاحة حالياً.";

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
/*  Stage 3 (text-only) — basic-mode replies (ZERO-FAILURE)            */
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
 * Friendly basic-mode text reply used when the whole LLM chain (Stage 1
 * Gemini + Stage 2 Hugging Face) is unavailable on a request without a usable
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
    "- أو أرفق صورة واضحة لورقة مصابة — نموذج الرؤية يشخّصها ويقدم خطة علاج مباشرة حتى في الوضع الأساسي.",
  ].join("\n");
}

/** Note appended when a photo was sent but the vision step couldn't analyse it. */
const VISION_UNAVAILABLE_NOTE = [
  "⚠️ تعذّر تحليل صورة الورقة حالياً — نموذج الرؤية غير متاح أو ما زال يقلع.",
  "- أعد المحاولة بعد دقيقة بصورة أوضح (ورقة كاملة، إضاءة نهارية).",
  "- أو صف أعراض النبتة بالنص وسأجيبك مباشرة.",
].join("\n");

/* ------------------------------------------------------------------ */
/*  Handler — fail-proof 3-stage chain + direct-formatting fallbacks   */
/* ------------------------------------------------------------------ */

/**
 * Fail-proof pipeline body. Every upstream stage is non-fatal:
 * - Step 1 (vision) failure → warning, continue through Stage 1/2 (an LLM can
 *   still answer the text part) or straight to the Stage 3 direct replies.
 * - Stage 1 (Gemini) failure, timeout, or missing `GEMINI_API_KEY` → warning,
 *   fall through to Stage 2 (the Hugging Face LLM chain).
 * - Stage 2 (Hugging Face) failure or missing `HUGGINGFACE_API_KEY` → warning,
 *   answer 200 from the Stage 3 built-in formatters: diagnosis card when
 *   Step 1 succeeded, friendly basic-mode text otherwise.
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
  //   GEMINI_API_KEY        → Stage 1, the primary LLM (comma-separated keys
  //                           are supported).
  //   GEMINI_API_KEY_N     → optional numbered Gemini keys (`_2`, `_3`, …).
  //   HUGGINGFACE_API_KEY   → Step 1 PlantVillage vision + Stage 2 fallback LLM
  //                           (HF_TOKEN, Hugging Face's own conventional
  //                           variable name, is honoured as an alias).
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

  // ---- Fail-proof sequential pipeline ------------------------------
  // Step 0: leaf Detection & Cropping (when image attached). An open-source
  // object detector localises the leaf, the photo is cropped with sharp and
  // ONLY the crop continues down the pipeline — background noise (hands,
  // soil, pots) can no longer reach the disease classifier. Non-fatal by
  // construction: every failure degrades to the untouched original frame.
  let preprocessing: AssistantPreprocessing | null = null;
  /** What actually reaches Step 1: the Step 0 crop or the original image. */
  let classifyImage: AssistantImagePayload | null = image ?? null;

  // Step 1: Hugging Face MobileNet vision classification (when image attached).
  // Non-fatal: a vision outage (or a missing HF key) degrades to the LLM /
  // direct replies instead of failing the request.
  let diagnosis: AssistantDiagnosis | null = null;
  if (image) {
    const detection = await runLeafDetectionStage(image, huggingfaceKey, warnings);
    preprocessing = detection.preprocessing;
    classifyImage = detection.image;

    if (!huggingfaceKey) {
      const detail =
        "HUGGINGFACE_API_KEY is not configured (HF_TOKEN unset too) — vision step skipped.";
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

  // One user turn for both LLM stages: user query + Firestore profile context
  // (Wilaya, crop type, role) + the Step 1 MobileNet vision diagnosis (disease
  // label, confidence score, candidate diseases) whenever it exists.
  const userContent = buildUserContent(message, context, diagnosis);

  // ---- Stage 1: Google Gemini (PRIMARY LLM) -------------------------
  // gemini-3.5-flash (→ 3.5-flash-lite → 2.5-flash on a retired-id 404) via
  // the Generative Language REST API, keyed with GEMINI_API_KEY and bounded
  // by a shared 18 s AbortController. Non-fatal: on any failure (or a missing
  // key) the request walks to Stage 2.
  let reply: string | null = null;
  if (geminiApiKeys.length > 0) {
    try {
      const geminiResult = await generateWithGemini(userContent, geminiApiKeys);
      reply = geminiResult.text;
      // Non-fatal degradations the chain walked past (a retired primary id
      // 404ing before its successor answered) are still surfaced to the
      // client — the operator should see that the primary is gone.
      warnings.push(...geminiResult.warnings);
      console.log(
        `[Stage 1: Gemini Success] model=${geminiResult.model} diagnosis=${diagnosis?.label ?? "none"} confidence=${diagnosis ? `${Math.round(diagnosis.confidence * 100)}%` : "n/a"} replyLength=${reply.length}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[Stage 1: Gemini Unavailable → Stage 2] ${detail}`);
      warnings.push(`Stage 1 Gemini unavailable — ${detail}`.slice(0, 400));
    }
  } else {
    const detail =
      "GEMINI_API_KEY is not configured (GEMINI_API_KEY_2 is also empty) — skipping the primary LLM.";
    console.warn(`[Stage 1: Gemini Skipped] ${detail} → Stage 2 (Hugging Face LLM chain)`);
    warnings.push(`Stage 1 Gemini unavailable — ${detail}`.slice(0, 400));
  }

  // ---- Stage 2: Hugging Face LLM fallback chain ---------------------
  // Runs only when Stage 1 produced nothing: the open Qwen chain through the
  // Inference Providers router, same system prompt and the same user turn
  // (query + profile + Step 1 vision context). Non-fatal: on total LLM
  // failure Stage 3 answers locally with 200.
  if (reply === null) {
    if (huggingfaceKey) {
      try {
        reply = await askHfLlmStrict(huggingfaceKey, userContent);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const detail = msg.startsWith("LLM Error:") ? msg.slice("LLM Error:".length).trim() : msg;
        console.warn(`[Stage 2: HF LLM Unavailable → Stage 3] ${detail}`);
        warnings.push(`Stage 2 LLM unavailable — ${detail}`.slice(0, 400));
      }
    } else {
      // No Hugging Face token anywhere in the environment → skip the stage
      // synchronously (no request, no throw, no timer) and let Stage 3
      // answer right away.
      const detail =
        "HUGGINGFACE_API_KEY is not configured (HF_TOKEN unset too) — skipping the fallback LLM.";
      console.warn(`[Stage 2: HF LLM Skipped] ${detail} → Stage 3 (built-in formatter)`);
      warnings.push(`Stage 2 LLM unavailable — ${detail}`.slice(0, 400));
    }
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

  // ---- Stage 3: direct formatting, zero-failure ----------------------
  // Both LLM stages are down: answer 200 from the built-in TypeScript
  // formatters.
  let directReply: string;
  if (diagnosis) {
    // Image + successful vision → concise Arabic Markdown diagnosis card.
    directReply = buildDirectDiagnosisCard(diagnosis);
  } else if (image) {
    // Image but vision failed too → basic-mode text (when a message exists)
    // plus a clear note about the photo analysis being unavailable.
    directReply = message
      ? `${buildTextFallbackReply(message)}\n\n${VISION_UNAVAILABLE_NOTE}`
      : VISION_UNAVAILABLE_NOTE;
  } else {
    // Text-only → friendly basic-mode reply (greeting-aware).
    directReply = buildTextFallbackReply(message);
  }
  warnings.push("Reply formatted locally — no upstream AI stage was available.");

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
