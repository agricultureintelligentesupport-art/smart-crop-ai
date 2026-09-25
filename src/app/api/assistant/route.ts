/**
 * `/api/assistant` — fail-proof 3-stage resilient AI chain for the
 * agricultural assistant. The route NEVER returns HTTP 500.
 *
 * Pipeline (Google Gemini first, Hugging Face fallback, built-in formatter
 * last — a vision pre-step feeds both LLM stages):
 *
 *   Step 0 (when an image is attached): leaf Detection & Cropping — the SAME
 *     free Hugging Face Inference router now ALSO runs an open-source object
 *     detector: the COCO `facebook/detr-resnet-50` (DETR-ResNet-50) with a
 *     plant-only label filter is the primary id (the obsolete fine-tuned
 *     PlantDoc checkpoint is gone — it no longer serves on the free router;
 *     the chain stays overridable via `HF_LEAF_DETECT_MODELS`). The detected
 *     box is grown into a padded, clamped crop window and the photo is
 *     cropped server-side with sharp, so background noise (hands, soil, pots)
 *     NEVER reaches the PlantVillage classifier: Step 1 sees ONLY the
 *     cropped pixels. Strictly an accuracy
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
 *   Step 1 — DUAL-ENGINE vision (when an image is attached), on the Step 0
 *     crop when detection succeeded, the full frame otherwise:
 *
 *     PRIMARY — CodeCraft vision API (OpenAI-compatible,
 *       `CODECRAFT_BASE_URL` = https://codecraftapi.com/v1, model `gpt-4o`
 *       → `gpt-4o-mini`) through the dedicated service
 *       {@link analyzePlantImageWithCodeCraft} in
 *       `@/lib/assistant/codecraft-vision`. It returns STRUCTURED diagnostic
 *       data (disease name, severity, immediate treatment, prevention,
 *       symptoms) which is normalised into the very same
 *       `AssistantDiagnosis` contract the pipeline already consumes — so the
 *       agent's persona, system prompt, tone and response format are 100 %
 *       untouched: the findings simply become the reference diagnosis that
 *       the existing LLM stage turns into the reply, exactly like the
 *       MobileNetV2 reference did.
 *       Server-only secrets (`CODECRAFT_API_KEY`, `CODECRAFT_BASE_URL` — no
 *       `NEXT_PUBLIC_` prefix), read per request; a missing OR placeholder
 *       key disables the engine instantly (no request, no latency).
 *
 *     FALLBACK (safety net) — the whole CodeCraft call is wrapped in a
 *       try/catch: an invalid/unpaid key, HTTP 401/402/403/429, a timeout, a
 *       network error, a non-JSON answer or "this is not a plant" silently
 *       fails over to the EXISTING MobileNetV2 PlantVillage + Gemini vision
 *       path below. The user never sees a broken UI or a code error: the
 *       degradation is logged on the server and appended to `warnings[]`.
 *
 *   Step 1 (fallback engine) — MobileNetV2 PlantVillage classification (when
 *     an image is attached), via the Hugging Face Serverless Inference API
 *     after Step 0 cropping — used whenever CodeCraft did not answer:
 *       PRIMARY (and only default) classifier —
 *         `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification`
 *         (MobileNetV2 PlantVillage, 38 crop/disease classes). The obsolete
 *         field-trained cascade ids (`dima806/plant_disease_image_detection`,
 *         `fxmeng/plantdoc-vit`) and the 400-prone extra ids
 *         (`wambugu71/crop_leaf_diseases_vit`, the legacy `Abuzaid01/…` and
 *         `nateraw/…` experiments) are REMOVED — one known-good model, one
 *         round-trip, zero 400s. Parses the returned array to extract the
 *         primary predicted disease class + confidence percentage + candidate
 *         diseases; handles 503/530 loading with a clear message. Non-fatal:
 *         a vision outage is recorded in `warnings[]` and the request
 *         continues — Stage 1 (Gemini) then inspects the raw image
 *         INDEPENDENTLY (Fallback A below). Receives the Step 0 crop when
 *         detection succeeded, the full frame otherwise.
 *         Env override: `HF_VISION_MODEL` (single id) replaces the default.
 *
 *   Stage 1 — Google Gemini (`gemini-1.5-flash-latest` — overridable with
 *     `GEMINI_MODEL` — then `gemini-2.0-flash-exp` → `gemini-2.5-flash` when an
 *     id is retired) — PRIMARY LLM: REST call to
 *     https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=$GEMINI_API_KEY
 *     authenticated with the server-only Gemini key pool: `GEMINI_API_KEY`
 *     (including comma-separated values) plus numbered variants such as
 *     `GEMINI_API_KEY_2` and `GEMINI_API_KEY_3`, and guarded by one
 *     shared 18 s `AbortController` deadline for the whole model chain (an
 *     Arabic ~200-word answer regularly needs 10–15 s on a cold Flash model,
 *     so the previous 9 s window aborted healthy generations and pushed
 *     traffic onto the weaker fallbacks). The primary defaults to the stable
 *     `gemini-1.5-flash-latest` id — its free tier carries the generous
 *     ~1,500 RPD / 15 RPM allowance, while the preview generations
 *     (`gemini-3.5-flash`…) are throttled to ~20 RPD — and `GEMINI_MODEL`
 *     pins a different primary (e.g. `gemini-2.0-flash-exp`) without a code
 *     change. Google still retires model generations on a fast cadence, so
 *     the model ids form a chain: a 404 / model-not-found walks to the next
 *     id within the remaining budget, while key/safety/network/timeout
 *     failures fail the current key immediately. Quota and transient server
 *     errors (HTTP 429/500/503) rotate to the next Gemini credential before
 *     the stage is declared unavailable. The payload is generation-aware:
 *     Gemini 2.5 takes `thinkingBudget: 0`, while the 1.5/2.0 generations
 *     predate thinking and receive NO `thinkingConfig` (the wrong parameter
 *     is a 400).
 *     The expert system instruction ("أنت مساعد زراعي خبير…") is sent as
 *     `systemInstruction`; the user turn carries the user query, the Firestore
 *     profile context (Wilaya, crop, role…) and — whenever Step 1 produced one
 *     — the MobileNetV2 reference diagnosis (disease label, confidence score
 *     and candidate diseases). Whenever a photo is attached, the image
 *     itself travels with the turn as an `inlineData` part (the Step 0 crop
 *     when detection succeeded, the raw frame otherwise), so:
 *       • HYBRID PRIMARY PATH — MobileNetV2 ran: Gemini inspects the image,
 *         evaluates MobileNetV2's reference and generates the final
 *         structured diagnosis report;
 *       • FALLBACK A — MobileNetV2 failed: Gemini inspects the raw image
 *         independently and generates the report on its own.
 *     Key pool: EVERY environment variable starting with `GEMINI_API_KEY`
 *     participates — `GEMINI_API_KEY` and `GEMINI_API_KEYS` (comma-separated
 *     pool) plus numbered variants (`GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`,
 *     …). All values are trimmed, deduplicated and rotation-ordered; rate-
 *     limit / quota failures (HTTP 429, RESOURCE_EXHAUSTED, quota limit)
 *     rotate to the next key and retry until one answers or every key is
 *     exhausted.
 *     Success → HTTP 200 `{ source: "llm" }` (promoted to `"hybrid"` when the
 *     answer ships together with a Step 1 diagnosis) carrying Gemini's
 *     generated Arabic reply.
 *
 *   FALLBACK B (MobileNetV2 succeeded but every Gemini key failed): the
 *     route constructs a valid structured response DIRECTLY from
 *     MobileNetV2's findings (the built-in Arabic diagnosis card,
 *     `source: "direct"`) — the farmer still gets the full diagnosis +
 *     treatment plan without any LLM.
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
 * Gemini credentials — every environment variable starting with
 * `GEMINI_API_KEY` (`GEMINI_API_KEY`, `GEMINI_API_KEYS` comma-separated pool,
 * and numbered `GEMINI_API_KEY_N` variants; combined, trimmed, deduplicated,
 * rotation-ordered) —, the Hugging Face secret (`HUGGINGFACE_API_KEY` —
 * with Hugging Face's conventional `HF_TOKEN` accepted as an alias) and the
 * CodeCraft vision secret (`CODECRAFT_API_KEY`, with `CODECRAFT_BASE_URL`
 * and `CODECRAFT_VISION_MODEL` as optional overrides — never a
 * `NEXT_PUBLIC_` variable) are read from `process.env` on the server only —
 * they are never shipped to the browser and never echoed back in a response
 * body.
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
import {
  resolveCodeCraftApiKey,
  tryAnalyzePlantImageWithCodeCraft,
  type CodeCraftVisionContext,
} from "@/lib/assistant/codecraft-vision";
import { confidenceBucket, parsePlantLabel } from "@/lib/assistant/plantvillage";
import type {
  AssistantContext,
  AssistantDiagnosis,
  AssistantImagePayload,
  AssistantHistoryTurn,
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

/* ---- Step 1 (PRIMARY) — CodeCraft vision engine ------------------- */

/**
 * Step 1, primary engine: CodeCraft vision (OpenAI-compatible chat
 * completions at `CODECRAFT_BASE_URL`, model `gpt-4o` → `gpt-4o-mini`).
 *
 * The photo is sent as a data URL together with a STRICT structured-output
 * instruction (disease name, severity, immediate treatment, prevention,
 * symptoms). The dedicated service
 * {@link import("@/lib/assistant/codecraft-vision").analyzePlantImageWithCodeCraft}
 * normalises the answer into the SAME `AssistantDiagnosis` contract the
 * MobileNetV2 classifier already produced — that is what keeps the agent's
 * personality, system prompt, tone and response format 100 % intact: the
 * verdict simply flows through the existing context builders
 * ({@link describeDiagnosis} → {@link buildUserContent}) into the very same
 * LLM stage that writes the reply.
 *
 * FALLBACK ENGINE (safety net): the call goes through
 * `tryAnalyzePlantImageWithCodeCraft`, which never throws — an invalid or
 * unpaid key, HTTP 401/402/403/429, a timeout, a network error, a
 * non-JSON answer or "this is not a plant" are all captured here, logged on
 * the server, pushed to `warnings[]` and the function returns `null` so the
 * caller runs the pre-existing MobileNetV2 PlantVillage + Gemini vision path
 * instead. The user never sees an error, a degraded UI or a code exception.
 *
 * @returns the CodeCraft diagnosis, or `null` when the engine could not
 *   answer (the caller then falls back).
 */
async function runCodeCraftVisionStage(
  image: AssistantImagePayload,
  context: AssistantContext | undefined,
  warnings: string[],
): Promise<AssistantDiagnosis | null> {
  const startedAt = Date.now();
  const visionContext: CodeCraftVisionContext = {
    mimeType: image.mimeType,
    profile: context ?? null,
  };

  const { diagnosis, error } = await tryAnalyzePlantImageWithCodeCraft(
    image.data,
    visionContext,
  );

  if (diagnosis) {
    console.log(
      `[Step 1: CodeCraft Accepted] engine=codecraft label=${diagnosis.label} severity=${diagnosis.severity ?? "n/a"} treatment=${diagnosis.treatment?.length ?? 0} ${Date.now() - startedAt}ms`,
    );
    return diagnosis;
  }

  if (error) {
    // The message already starts with "HTTP <status> …" for upstream failures.
    const detail =
      error.status && !/^HTTP\b/.test(error.message)
        ? `HTTP ${error.status} — ${error.message}`
        : error.message;
    console.warn(
      `[Step 1: CodeCraft Unavailable → MobileNetV2 fallback] ${detail} (${Date.now() - startedAt}ms)`,
    );
    warnings.push(`Step 1 CodeCraft vision unavailable — ${detail}`.slice(0, 400));
  }
  return null;
}

/* ---- Stage 1 — Google Gemini (primary LLM) ----------------------- */

/**
 * The stable Gemini id Stage 1 defaults to. The preview generations
 * (`gemini-3.5-flash` and friends) are throttled to a strict ~20 RPD
 * free-tier quota, which normal usage exhausts almost immediately; the
 * stable `gemini-1.5-flash-latest` id carries the generous free-tier allowance
 * (~1,500 RPD / 15 RPM). `GEMINI_MODEL` overrides the primary at request
 * time (e.g. to pin `gemini-2.0-flash-exp`, which shares the same free-tier
 * quota bucket); the fallback ids below still catch a retired or mistyped
 * override.
 */
const GEMINI_MODEL_DEFAULT = "gemini-3.6-flash";

/**
 * Stage 1 model chain entry. `thinking` carries the per-generation
 * `thinkingConfig` — OPTIONAL, because each generation 400s on the wrong
 * shape: Gemini 2.5 takes a numeric `thinkingBudget` (`0` = skip the
 * reasoning pass, answer-first), while the stable 1.5/2.0 Flash ids (and
 * unknown `GEMINI_MODEL` overrides) predate thinking entirely and reject
 * the parameter — `undefined` means "send no `thinkingConfig` at all".
 */
interface GeminiModel {
  id: string;
  thinking?: { thinkingLevel: "low" } | { thinkingBudget: number };
}

/**
 * Built-in fallback ids walked (within the remaining Stage-1 budget) when
 * the primary answers 404 / model-not-found — a retired or mistyped id
 * never kills the stage while a successor can still answer.
 */
const GEMINI_FALLBACK_MODELS: readonly GeminiModel[] = [
  { id: "gemini-2.0-flash-exp" },
  { id: "gemini-2.5-flash", thinking: { thinkingBudget: 0 } },
];

/**
 * Resolve the ordered Stage-1 model chain at request time: the
 * `GEMINI_MODEL` override (whitespace-trimmed) or
 * {@link GEMINI_MODEL_DEFAULT} first, then the built-in fallback ids —
 * deduplicated, so pinning an id that is also a fallback never doubles it.
 * Reading the environment per request (like the Gemini key pool) lets a
 * deployment switch models without a restart; tests can override it too.
 */
function resolveGeminiModels(): GeminiModel[] {
  const override = process.env.GEMINI_MODEL?.trim();
  const primary: GeminiModel = { id: override || GEMINI_MODEL_DEFAULT };
  return [primary, ...GEMINI_FALLBACK_MODELS.filter((model) => model.id !== primary.id)];
}

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
 * the per-generation thinking payload (no `thinkingConfig` on 1.5/2.0,
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
 * Strict Step 1 — MobileNetV2 PlantVillage classification via Hugging Face:
 * the PRIMARY (and only default) classifier is
 * `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification` — a clean
 * single-model pipeline, the obsolete field-trained ids and the 400-prone
 * cascade fallbacks are gone. `HF_VISION_MODEL` may pin a replacement id.
 * - Sends the raw image bytes (cropped by Step 0 when available) to the model.
 * - Parses the returned array to extract the primary predicted class + confidence.
 * - Handles 503/530 model-loading responses with a clear message.
 * - Per-model timeout: UPSTREAM_TIMEOUT_MS (25 s) — long enough for a cold
 *   serverless start under `X-Wait-For-Model: true`.
 * - Throws an Error prefixed with "HF Error:" on any failure so the caller can
 *   degrade gracefully (Fallback A: Gemini inspects the raw image; Fallback B:
 *   the built-in formatter answers from the diagnosis when one exists).
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
        `[Step 1: HF Success] label=${top.label} confidence=${pct}% model=${model} timeout=${timeoutMs}ms candidates=${candidates.length}`,
      );
      return diagnosis;
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
- عند تحليل صورة نبات: قدّم النتيجة بوصفها خلاصة فحصك أنت للصورة بصوت واحد (نظام التحليل يعمل في الخلفية كوحدة واحدة)، واذكر المرض بالعربية مع نسبة الثقة (مثال: Tomato___Early_blight 95%)، ثم قدّم العلاج والوقاية في نقاط عملية، دون نسبة النتيجة إلى «نموذج» أو «نظام» منفصل — لا تقل «النموذج يقول/يرى/يرجّح» أو «التشخيص المرجعي».
- عندما ترفق نتيجة فحص آلي للصورة: لا تُقدِّم مرضًا أو عرضاً أو نقصًا أو سبباً أو مرشّحاً لم تُرجِعه تلك النتيجة — اقتصر على تسميتها العليا مع نسبة ثقتها ومرشّحاتها البديلة المذكورين فيها (بنِسَبهم)، ولا تُبدِل النتيجة بتشخيص آخر من اجتهادك الخاص بالصورة.
- إن كانت نسبة الثقة ضعيفة (<45%)، اطلب صورة أوضح في سطر واحد مع ذكر التشخيصات البديلة الواردة في النتيجة فقط؛ لا تقترح تشخيصاً بديلاً عمّا أرجعه الفحص.
- اذكر مواد وممارسات متوفرة فعلاً في السوق الجزائرية (مبيدات نحاسية، مانكوزيب، كبريت ميكروني، تناوب زراعي…) مع جرعات إرشادية مختصرة وفترة الأمان قبل الجني.
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
 * Extra reference lines for a verdict that carries more than a label —
 * today only the CodeCraft vision engine reports them (severity, symptoms,
 * immediate treatment, prevention). Appended INSIDE the reference block,
 * above its "only report what is listed here" boundary, so the reply keeps
 * the agent's single voice while reusing the engine's own findings.
 * Emits nothing for a plain PlantVillage verdict (no extra fields set).
 */
function describeDiagnosisExtras(diagnosis: AssistantDiagnosis): string[] {
  const lines: string[] = [];
  if (diagnosis.severity) {
    lines.push(
      `- درجة الخطورة (severity): ${diagnosis.severity}${
        diagnosis.severityPercent !== null && diagnosis.severityPercent !== undefined
          ? ` (${Math.round(diagnosis.severityPercent)}% من النبتة مصابة)`
          : ""
      }`,
    );
  }
  if (diagnosis.symptoms && diagnosis.symptoms.length > 0) {
    lines.push(`- الأعراض المرصودة (symptoms): ${diagnosis.symptoms.join(" · ")}`);
  }
  if (diagnosis.treatment && diagnosis.treatment.length > 0) {
    lines.push(
      `- العلاج الفوري المقترح (immediate treatment): ${diagnosis.treatment.join(" · ")}`,
    );
  }
  if (diagnosis.prevention && diagnosis.prevention.length > 0) {
    lines.push(`- الوقاية (prevention): ${diagnosis.prevention.join(" · ")}`);
  }
  if (diagnosis.notes) lines.push(`- ملاحظة فنية: ${diagnosis.notes}`);
  return lines;
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
    "خلاصة فحص صورة المستخدم (تحليل آلي أولي — نظام التحليل يعمل في الخلفية كوحدة واحدة؛ اعرضها بوصفها تحليلك أنت بصوت واحد دون نسبتها إلى «نموذج» أو «نظام» منفصل):",
    `- المرض المشخّص (disease label): ${diagnosis.labelAr} — التسمية الخام: ${diagnosis.label}`,
    `- درجة الثقة (confidence score): ${pct}% (${bucket === "high" ? "مرتفعة" : bucket === "medium" ? "متوسطة" : "منخفضة"})`,
    alternates ? `- الأمراض المرشّحة البديلة (candidate diseases): ${alternates}` : "",
    diagnosis.healthy
      ? "- يبدو أن النبتة سليمة؛ طمئن المستخدم وقدّم نصائح وقائية."
      : "",
    // Engine extras (CodeCraft: severity + immediate treatment) stay INSIDE
    // the reference block…
    ...describeDiagnosisExtras(diagnosis),
    // …and the display boundary remains the last line.
    "- حدّ العرض: اذكر فقط ما ورد أعلاه — التسمية العليا ونسبة الثقة ومرشّحات بديلة إن وُجدت بنِسَبها — ويُمنع ذكر أي مرض أو نقص أو سبب أو مرشّح خارج هذه القائمة حتى لو بدا لك مرجحاً؛ الثقة المنخفضة سبب لطلب صورة أوضح لا لاقتراح تشخيص مختلف.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Builds the single user turn shared by Stage 1 (Gemini `contents`) and
 * Stage 2 (HF `messages[1]`): Firestore profile context (Wilaya, crop, role,
 * language, name) + the Step 1 MobileNetV2 reference diagnosis (disease
 * label, confidence score and candidate diseases) when one is available +
 * the user's own query. When a photo is attached, an image instruction is
 * added: with a MobileNetV2 verdict in hand (HYBRID PRIMARY PATH) Gemini
 * must inspect the attached image, evaluate the reference and issue the
 * final structured report; without one (FALLBACK A) it must diagnose the
 * raw image independently. Keeping one builder guarantees the fallback LLM
 * answers from exactly the same context the primary was given.
 */
function buildUserContent(
  message: string,
  context: AssistantContext | undefined,
  diagnosis: AssistantDiagnosis | null,
  hasImage: boolean,
  isFirstTurn: boolean,
): string {
  const sections = [
    ...(isFirstTurn ? [`سياق المستخدم من ملفه الشخصي: ${describeContext(context)}`] : []),
    describeDiagnosis(diagnosis),
    diagnosis
      ? `نتيجة الفحص الأولي للصورة: ${diagnosis.label} بثقة ${Math.round(diagnosis.confidence * 100)}% — ${diagnosis.labelAr}`
      : hasImage
        ? "لا تتوفر نتيجة فحص آلي مسبقة للصورة — افحص الصورة المرفقة مباشرةً وابدأ التشخيص من الصورة."
        : "",
    hasImage && diagnosis
      ? "افحص الصورة المرفقة بنفسك وقارن نتيجة الفحص الأولي أعلاه بما تراه فعلاً في الصورة، ثم أطلِق تقرير التشخيص النهائي المهيكل بناءً على حكمك (أكّد النتيجة أعلاه دون تبديلها)، مع خطة العلاج والوقاية — وقدّم كل ذلك بوصفه تحليلك أنت بصوت واحد دون ذكر «النموذج» كطرف منفصل. ولا تُقدِّم أي مرض أو تشخيص أو مرشّح لم يرد في نتيجة الفحص أعلاه: اقتصر على التسمية العليا والمرشّحين البديلين المذكورين بنِسَبهم، وإن كانت الثقة ضعيفة فاطلب صورة أوضح دون اقتراح تشخيص مختلف."
      : "",
    message
      ? `سؤال المستخدم: ${message}`
      : diagnosis
        ? "لم يكتب المستخدم سؤالاً — قدّم التشخيص وخطة العلاج والوقاية مباشرة بناءً على نتيجة الفحص أعلاه."
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
 * `404 — models/gemini-1.5-flash-latest is not found for API version v1beta, or is
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
 *   • `contents[0].parts` — the user query + profile context + the Step 1
 *     MobileNetV2 reference diagnosis (label, confidence, candidates); when
 *     `image` is set the photo travels too as an `inlineData` part — the
 *     HYBRID PRIMARY PATH (with a MobileNetV2 verdict) or FALLBACK A (raw
 *     image inspected independently);
 *   • `generationConfig` — the sampling params plus the model's own
 *     `thinkingConfig` when its generation supports one
 *     ({@link GeminiModel.thinking}).
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
  image?: AssistantImagePayload | null,
  history: AssistantHistoryTurn[] = [],
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
          contents: [
            ...history.map((turn) => ({
              role: turn.role === "assistant" ? "model" : "user",
              parts: [{ text: turn.content }],
            })),
            {
              role: "user",
              parts: image
                ? [
                    // The photo itself (Step 0 crop or the raw frame) —
                    // Gemini inspects it and cross-checks the MobileNetV2
                    // reference carried in the text part.
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
 * walking the per-request chain from {@link resolveGeminiModels} in order —
 * starting at `gemini-1.5-flash-latest` (or the `GEMINI_MODEL` override).
 *
 * The whole chain is bounded by ONE 18 s `AbortController` deadline
 * ({@link GEMINI_TIMEOUT_MS}) instead of per-call timeouts: a fast
 * model-availability failure (404 / model-not-found — the signature of a
 * retired generation)
 * walks to the next id with whatever budget remains (each walk is recorded
 * in the result's `warnings` so the client still sees the degradation),
 * while any other failure — invalid/missing key (400/403), safety block,
 * empty candidate list, network error or the timeout abort — throws
 * {@link GeminiError} immediately for the outer key-rotation loop. Quota and
 * transient upstream failures (HTTP 429/500/503) are likewise surfaced to
 * that loop, which backs off and tries the next credential before walking to
 * Stage 2 (Hugging Face) and finally Stage 3 (built-in formatter).
 */
async function generateWithGeminiForKey(
  userContent: string,
  apiKey: string,
  image?: AssistantImagePayload | null,
  history: AssistantHistoryTurn[] = [],
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
        const text = await generateWithGeminiModel(
          model,
          userContent,
          controller.signal,
          apiKey,
          image,
          history,
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

        const next = models[index + 1];
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
 * the multi-key rotation loop.
 *
 * Rate-limit / quota failures (HTTP 429, RESOURCE_EXHAUSTED, quota limit —
 * see {@link isGeminiRetryableError}) and transient server failures (500,
 * 503) get a one-second backoff before the next key is tried; other Gemini
 * failures (e.g. an invalid or revoked key) also advance through the
 * remaining keys without a delay. The request retries the next key in the
 * pool until one answers successfully or ALL keys are exhausted. `image`
 * (the Step 0 crop or the raw frame) is attached to every attempt so both
 * the hybrid primary path and Fallback A reach Gemini with the photo. API
 * keys are represented only by their ordinal in logs and warnings; their
 * values never leave the server or appear in a client response.
 */
async function generateWithGemini(
  userContent: string,
  geminiApiKeys: readonly string[],
  image?: AssistantImagePayload | null,
  history: AssistantHistoryTurn[] = [],
): Promise<GeminiResult> {
  const failures: string[] = [];
  const rotationWarnings: string[] = [];

  for (let keyIndex = 0; keyIndex < geminiApiKeys.length; keyIndex += 1) {
    const apiKey = geminiApiKeys[keyIndex];
    try {
      const result = await generateWithGeminiForKey(userContent, apiKey, image, history);
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
          `Stage 1 Gemini HTTP ${status} transient/quota failure on ${keyLabel} — ` +
          `key rotation attempt ${nextKeyIndex + 1}/${geminiApiKeys.length}.`;
        rotationWarnings.push(warning);
        console.warn(
          `[Stage 1: Gemini Key Rotation] ${warning} Retrying after 1 second.`,
        );
        await new Promise((res) => setTimeout(res, 1000));
      } else if (hasNextKey) {
        // A different failure can also be isolated to one credential (for
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
async function askHfLlmStrict(apiKey: string, userContent: string, history: AssistantHistoryTurn[] = []): Promise<string> {
  const failures: string[] = [];

  for (const [index, model] of HF_LLM_MODELS.entries()) {
    try {
      const text = await generateWithHfLlmModel(model, userContent, apiKey, history);

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
    "> ⚠️ بطاقة تشخيص تلقائية — خدمة النصوص الذكية غير متاحة حالياً.";

  if (diagnosis.healthy) {
    const lines = [
      `- **يبدو أن النبتة سليمة** — نسبة الثقة: ${pct}% (${bucketAr}).`,
      alternates ? `- احتمالات أخرى: ${alternates}` : "",
    ].filter(Boolean);
    return [
      `## 🔬 التشخيص\n${lines.join("\n")}`,
      "## 🛡️ وقاية\n- سقي صباحي منتظم عند القاعدة دون بلل الأوراق.\n- تسميد متوازن ومراقبة الأوراق الجديدة أسبوعياً.",
      "## 📅 متابعة موصى بها\n- فحص أسبوعي للأوراق السفلية والبراعم؛ عند أول بقعة أرسل صورة واضحة للتشخيص المبكر.",
      footer,
    ].join("\n\n");
  }

  // Reuse the vision engine's own plan when it reported one (CodeCraft) —
  // the direct card then carries exactly the findings the LLM stages receive,
  // in the same voice; otherwise the built-in disease-family advice applies
  // unchanged (PlantVillage path).
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
    `- الإصابة: **${diagnosis.labelAr}** — التسمية الخام: \`${diagnosis.label}\``,
    `- نسبة الثقة: ${pct}% (${bucketAr})`,
    diagnosis.severity ? `- درجة الخطورة: ${diagnosis.severity}` : "",
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
    "- أو أرفق صورة واضحة لورقة مصابة — سأشخّصها وأقدّم خطة علاج مباشرة حتى في الوضع الأساسي.",
  ].join("\n");
}

/** Note appended when a photo was sent but the vision step couldn't analyse it. */
const VISION_UNAVAILABLE_NOTE = [
  "⚠️ تعذّر تحليل صورة الورقة حالياً — خدمة تحليل الصور غير متاحة أو ما زالت تقلع.",
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

  // Server-only secrets — never exposed to the client bundle. Read on every
  // request (never at module load) so a rotated/added key is picked up without
  // a restart.
  //   GEMINI_API_KEY        → Stage 1, the primary LLM (comma-separated keys
  //                           are supported).
  //   GEMINI_API_KEYS      → optional comma-separated Gemini key pool.
  //   GEMINI_API_KEY_N     → optional numbered Gemini keys (`_1`, `_2`, …).
  //                           All sources above are combined into ONE pool
  //                           (trimmed, deduplicated, rotation-ordered) and
  //                           rotated on 429 / RESOURCE_EXHAUSTED / quota.
  //   HUGGINGFACE_API_KEY   → Step 1 PlantVillage vision + Stage 2 fallback LLM
  //                           (HF_TOKEN, Hugging Face's own conventional
  //                           variable name, is honoured as an alias).
  //   CODECRAFT_API_KEY     → Step 1 PRIMARY vision engine (CodeCraft,
  //                           OpenAI-compatible). Server-only, never
  //                           NEXT_PUBLIC_; a missing OR placeholder value
  //                           disables the engine instantly.
  //   CODECRAFT_BASE_URL    → optional endpoint override (default
  //                           https://codecraftapi.com/v1).
  const geminiApiKeys = resolveGeminiApiKeys();
  const huggingfaceKey = resolveHuggingFaceToken();
  const codecraftKey = resolveCodeCraftApiKey();

  if (geminiApiKeys.length === 0 && !huggingfaceKey && !codecraftKey) {
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

    // Step 1 — PRIMARY engine: CodeCraft vision (gpt-4o → gpt-4o-mini). Only
    // attempted when a real key is configured: `resolveCodeCraftApiKey()`
    // returns null for a missing OR placeholder value, so an unconfigured
    // deployment keeps the previous pipeline byte-for-byte (no request, no
    // latency, no warning). Any failure is captured inside the stage → silent
    // failover to MobileNetV2 + Gemini below.
    if (codecraftKey) {
      diagnosis = await runCodeCraftVisionStage(classifyImage, context, warnings);
    }

    // Step 1 — FALLBACK engine: MobileNetV2 PlantVillage (Hugging Face).
    // Runs whenever CodeCraft is unavailable, unconfigured or could not
    // diagnose the photo — the pre-existing behaviour, untouched.
    if (!diagnosis) {
      if (!huggingfaceKey) {
        // Only warn when CodeCraft is not the reason we got here: when the
        // primary engine is configured, a missing HF key is not a degradation.
        if (!codecraftKey) {
          const detail =
            "HUGGINGFACE_API_KEY is not configured (HF_TOKEN unset too) — vision step skipped.";
          console.warn(`[Step 1: HF Skipped] ${detail}`);
          warnings.push(`Step 1 vision unavailable — ${detail}`.slice(0, 400));
        }
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
  }

  // One user turn for both LLM stages: user query + Firestore profile context
  // (Wilaya, crop type, role) + the Step 1 MobileNetV2 reference diagnosis
  // (disease label, confidence score, candidate diseases) whenever it exists
  // + the image instruction whenever a photo is attached (hybrid primary
  // path with the reference, Fallback A without it).
  const userContent = buildUserContent(message, context, diagnosis, Boolean(classifyImage), isFirstTurn);

  // ---- Stage 1: Google Gemini (PRIMARY LLM) -------------------------
  // gemini-1.5-flash-latest or the GEMINI_MODEL override (→ 2.0-flash-exp →
  // 2.5-flash on a retired-id 404) via
  // the Generative Language REST API, keyed with the full Gemini key pool
  // (GEMINI_API_KEY + GEMINI_API_KEYS + numbered GEMINI_API_KEY_N — rotated
  // on 429 / RESOURCE_EXHAUSTED / quota) and bounded by a shared 18 s
  // AbortController. When a photo is attached it travels with the turn
  // (inlineData): HYBRID PRIMARY PATH with the MobileNetV2 reference
  // diagnosis, FALLBACK A (raw image, independent inspection) when Step 1
  // failed. If every key is exhausted and MobileNetV2 DID produce a
  // diagnosis, FALLBACK B answers the structured diagnosis card directly
  // from its findings. Non-fatal: on any failure (or a missing key) the
  // request walks to Stage 2.
  let reply: string | null = null;
  if (geminiApiKeys.length > 0) {
    try {
      const geminiResult = await generateWithGemini(userContent, geminiApiKeys, classifyImage, history);
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
        reply = await askHfLlmStrict(huggingfaceKey, userContent, history);
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

