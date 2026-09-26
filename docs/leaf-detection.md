# Step 0 — Leaf Detection & Cropping (preprocessing before classification)

## Why

The PlantVillage MobileNetV2 classifier (Step 1) is a **38-class crop/disease
classifier with no notion of "leaf"**. When a farmer's photo contains a hand
holding the leaf, soil, a pot or half a field, the classifier happily labels
the *background* and returns a confident-but-wrong disease. Localising the
leaf first and forwarding **only the cropped pixels** removes the single
largest source of misdiagnosis in the pipeline.

## What runs, where

| Stage | Where | Model | Cost |
| --- | --- | --- | --- |
| Step 0 · detection | Server (route) | `facebook/detr-resnet-101` (COCO DETR-ResNet-101, 43.5 AP on COCO — plant/leaf-labelled boxes only) with `facebook/detr-resnet-50` (COCO DETR-ResNet-50) as the fallback id; chain overridable via `HF_LEAF_DETECT_MODELS` | Free — Hugging Face serverless `hf-inference` CPU tier, same router + `HUGGINGFACE_API_KEY` the app already uses for Step 1. No new key. |
| Step 0 · crop | Server (route) | `sharp` **rectangular** extract + re-encode (≤1024 px edge, JPEG q88 — mirrors the client's own downscale). NO pixel masking/background removal: stem, leaf margins and surrounding foliage stay in the frame | Free, MIT; ~tens of ms on the function. `sharp` is in Next.js' default server-external packages and is what Vercel uses for image optimisation anyway. |
| Step 1 · classification | Server (route) | `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification` (MobileNetV2 PlantVillage — the single clean default, overridable via `HF_VISION_MODEL`) | Free tier. |
| Stages 1–3 · LLM chain | Server (route) | HF router LLMs (PRIMARY) → Gemini `gemini-3.6` (FALLBACK, image + MobileNetV2 reference) → built-in formatter | Existing behaviour. |

Why DETR-ResNet-101: it is the most precise open detector **natively
supported by HF Serverless Inference** — 43.5 AP on COCO vs 42.0 AP for the
previous production id (DETR-ResNet-50), in the exact same
`DetrForObjectDetection` model family the free router is proven to serve
(same label space, same payload shape). The COCO DETR-ResNet-50 id remains
as the chain's FALLBACK id (known-good on the free router) so Step 0 still
crops even if the ResNet-101 id ever stops serving.

Model selection is strict about router support: the RT-DETR candidate
(`PekingU/rtdetr_r50vd_coco_o365` — higher on paper at 55.3 AP) answers
**HTTP 400 on the `hf-inference` serverless router** (the RT-DETR task is
not served on the free tier), so it is **excluded from the default chain**;
a self-hosted RT-DETR endpoint can still be pinned via
`HF_LEAF_DETECT_MODELS`. The obsolete fine-tuned PlantDoc detector
(`suryanshgoel/detr-finetuned-plantdoc`) and the 400-prone vision cascade
ids (`dima806/plant_disease_image_detection`, `fxmeng/plantdoc-vit`,
`wambugu71/crop_leaf_diseases_vit`) are **removed**: they no longer answer
reliably on the free router and only cost round-trips before a known-good
id would have answered anyway.

The detector weights (~240 MB DETR-ResNet-101 checkpoint) live on
**Hugging Face's infrastructure** — the serverless function only POSTs the
photo bytes and parses a small JSON array of boxes, so the Vercel bundle
size and cold start are unaffected. The whole stage is bounded by a **15 s
stage budget** (9 s per model-chain attempt) inside the route's 60 s
`maxDuration`, comfortably within Vercel's limits.

## The crop decision (`src/lib/assistant/leaf-detect.ts`)

Pure, dependency-free, fully unit-tested geometry:

1. **Validate** the HF object-detection payload (`{score,label,box}` items,
   rounded to integer pixels; wrong-task payloads degrade to "nothing found"
   instead of throwing).
2. **Filter** detections below `minScore = 0.45`.
3. **Grow the dominant cluster**: the highest-scoring box seeds a cluster; any
   box overlapping the current union is merged, repeated until stable. Boxes
   that don't touch the cluster (background leaves, false positives) are
   ignored — a farmer photographs one leaf, and a single stray detection must
   not wreck the crop window.
4. **Pad** the cluster by a **12 %–15 % context margin** (of the box's own
   size, per side; default **13 %**, clamped into the band by
   `clampLeafMargin` whatever a caller passes) and **clamp** to the image so
   `sharp().extract()` always receives an in-bounds integer rect. The result
   is a plain **rectangular window that contains the whole detected leaf** —
   there is deliberately **no pixel-level masking or background removal**:
   the stem, the leaf margins and the surrounding foliage stay inside the
   crop, which is exactly the natural context MobileNetV2 (Step 1) relies on
   (a synthetic masked background would be an image it was never trained on).
5. **Refuse pointless crops**: a padded box covering < 3 % of the frame
   (speck — bad read) or > 92 % (nothing would be removed) keeps the original.

## Failure modes — all non-fatal, all → full intact original frame

When Step 0 cannot produce a trustworthy crop, the **full intact image** is
passed straight to Step 1 classification — never a partial, masked or
degraded frame:

| Case | Behaviour |
| --- | --- |
| No `HUGGINGFACE_API_KEY`/`HF_TOKEN` | Step 0 reports `status: "skipped"` (no request, no delay); Step 1 keeps its existing skip warning. |
| Undecodable/too-small image | `status: "unavailable"`, warning pushed, original classified. |
| Detector 503/530 (loading), 4xx/5xx, network, timeout | Walk the model chain (DETR-ResNet-101 primary → ResNet-50 fallback) within the 15 s stage budget; when all ids fail → `status: "unavailable"` + warning, original classified. |
| Payload is not object-detection-shaped | Treated as "this id can't serve detection" → next id in the chain. |
| No detection above threshold / useless box | `status: "no-leaf"` (a **normal** outcome — no warning), original classified. |

The outcome travels to the client in `AssistantResponseBody.preprocessing`
(`cropped | no-leaf | unavailable | skipped`, detector id, crop box, wall
time). The assistant UI shows a two-phase thinking label
("تحديد الورقة واقتصاص الخلفية…" → "تحليل الصورة وتشخيص المرض…") while the
longer pipeline runs, and a small ✂️ note on the answer when a crop was
applied (or a note when no leaf was found) — the farmer always knows what
happened to their photo.

## Why not client-side detection?

The task allowed either. Server-side was chosen because:

- **Accuracy** — a full DETR-class detector would mean a ~240 MB
  checkpoint in the browser bundle; the server-side call costs zero bytes of
  JS and runs the same (higher-precision) model on Hugging Face's
  infrastructure.
- **Free & key-free equivalent** — the HF serverless CPU tier that Step 1
  already depends on serves the detection call; no additional provider, key
  or quota is introduced.
- **Vercel-safe** — zero bundle weight (weights stay on HF), one extra
  sub-second-parse HTTP call bounded by its own timeout, and `sharp` (the
  crop) is the same native lib Vercel's image pipeline uses.

If air-gapped/on-device inference is ever required, the model chain is a
single env var (`HF_LEAF_DETECT_MODELS`) away from pointing at a
self-hosted endpoint, and `leaf-detect.ts` is already reusable client-side
(pure TypeScript).

## Local verification

```bash
npm run test:unit    # includes test/unit/leaf-detect.unit.test.ts and the
                     # Step 0 route suites (crop reaches the classifier,
                     # 12–15 % padding band, rectangular no-masking proof,
                     # no-leaf keeps the full frame, primary→fallback chain
                     # walk, outage degrades, env override, keyless skip)
npm run lint
npm run build
```
