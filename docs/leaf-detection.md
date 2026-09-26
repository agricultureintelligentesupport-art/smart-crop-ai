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
| Step 0 · detection | Server (route) | `facebook/detr-resnet-101` primary → `facebook/detr-resnet-50` fallback (higher-accuracy COCO DETR-ResNet-101, plant/vegetation-labelled boxes only — `plant`, `potted plant`, `foliage`, `leaf`, general vegetative classes — at a generous `0.22` score threshold; chain overridable via `HF_LEAF_DETECT_MODELS`) | Free — Hugging Face serverless `hf-inference` CPU tier, same router + `HUGGINGFACE_API_KEY` the app already uses for Step 1. No new key. |
| Step 0 · crop | Server (route) | `sharp` extract + re-encode (≤1024 px edge, JPEG q88 — mirrors the client's own downscale) | Free, MIT; ~tens of ms on the function. `sharp` is in Next.js' default server-external packages and is what Vercel uses for image optimisation anyway. |
| Step 1 · classification | Server (route) | `linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification` (MobileNetV2 PlantVillage — the single clean default, overridable via `HF_VISION_MODEL`) | Free tier. |
| Stages 1–3 · LLM chain | Server (route) | HF router LLMs (PRIMARY) → Gemini `gemini-3.6` (FALLBACK, image + MobileNetV2 reference) → built-in formatter | Existing behaviour. |

The obsolete fine-tuned PlantDoc detector
(`suryanshgoel/detr-finetuned-plantdoc`) and the 400-prone vision cascade
ids (`dima806/plant_disease_image_detection`, `fxmeng/plantdoc-vit`,
`wambugu71/crop_leaf_diseases_vit`) are **removed**: they no longer answer
reliably on the free router and only cost round-trips before a known-good
id would have answered anyway. No foliage-finetuned detector
(`foduucom/plant-leaf-detection-and-classification`,
`nickmuchi/yolos-small-plant-disease-detection`, …) is currently served by
the Inference Providers router at all (`inferenceProviderMapping` is
empty), so the accuracy upgrade is the deeper **ResNet-101 backbone** plus
the expanded plant-specific label query and the lowered threshold — not a
label-space swap.

The detector weights (~166 MB DETR-ResNet-50 checkpoint) live on
**Hugging Face's infrastructure** — the serverless function only POSTs the
photo bytes and parses a small JSON array of boxes, so the Vercel bundle
size and cold start are unaffected. The whole stage is bounded by its own 9 s deadline inside the
route's 60 s `maxDuration`, comfortably within Vercel's limits.

## The crop decision (`src/lib/assistant/leaf-detect.ts`)

Pure, dependency-free, fully unit-tested geometry:

1. **Validate** the HF object-detection payload (`{score,label,box}` items,
   rounded to integer pixels; wrong-task payloads degrade to "nothing found"
   instead of throwing).
2. **Query plant-specific labels**: only boxes whose label matches
   `isVegetationLabel` survive — `plant`, `potted plant`, `foliage`,
   `leaf`/`leaves`, `grass`, `weed`, `vine`, crop names… — a `person` or
   `hand` box never crops, however confident.
3. **Filter** detections below `minScore = 0.22` (lowered from 0.45 to
   catch dim/back-lit foliage; the cluster + coverage guards absorb the
   extra false positives).
4. **Grow the dominant cluster**: the highest-scoring box seeds a cluster; any
   box overlapping the current union is merged, repeated until stable. Boxes
   that don't touch the cluster (background leaves, false positives) are
   ignored — a farmer photographs one leaf, and a single stray detection must
   not wreck the crop window.
5. **Pad** the cluster by 12 % of its own size per side and **clamp** to the
   image so `sharp().extract()` always receives an in-bounds integer rect.
6. **Refuse pointless crops**: a padded box covering < 3 % of the frame
   (speck — bad read) or > 92 % (nothing would be removed) keeps the
   candidate — which now falls through to the Smart Fallback Crop below
   instead of the raw frame.

**Smart Fallback Crop** (same module, when no box cleared the threshold):
the frame is STILL trimmed locally before MobileNetV2 ever sees it —

1. **Green-mask crop** — the photo is downscaled (≤160 px), every pixel is
   tested in HSV for green dominance (hue 35°–175°, saturation ≥ 0.15), and
   the bounding box of the vegetation pixels (+12 % padding, same coverage
   guard) becomes the crop window;
2. **Centre-focused 80 % crop** — used when there is no meaningful green or
   the mask would keep (almost) the whole frame; always available, pure
   geometry, no pixels analysed.

Both outcomes report the crop window as a **normalised
`[xMin, yMin, xMax, yMax]` tuple** (corners, each value in `[0, 1]`, rounded
to 4 decimals) in `preprocessing.box`.

## Failure modes — all non-fatal

| Case | Behaviour |
| --- | --- |
| No `HUGGINGFACE_API_KEY`/`HF_TOKEN` | Step 0 reports `status: "skipped"` (no request, no delay); Step 1 keeps its existing skip warning. |
| Undecodable/too-small image | `status: "unavailable"`, warning pushed, original classified. |
| Detector 503/530 (loading), 4xx/5xx, network, timeout | Walk the model chain; when all ids fail → `status: "unavailable"` + warning, original classified. |
| Payload is not object-detection-shaped | Treated as "this id can't serve detection" → next id in the chain. |
| No detection above threshold / useless box | **Smart Fallback Crop** → `status: "smart-fallback"` (a **normal** outcome — no warning): the green-mask or centre-focused 80 % crop is classified instead of the raw frame. |
| `image.isUserCropped: true` (pre-submit cropper confirmed) | **User-Guided Crop bypass** → `status: "user-cropped"`: Step 0 detection is skipped entirely and the farmer's exact tensor (byte-identical) goes straight to Step 1. |
| Even the fallback crop impossible (degenerate frame) | Legacy `status: "no-leaf"` (normal — no warning), original classified. |

The outcome travels to the client in `AssistantResponseBody.preprocessing`
(`cropped | smart-fallback | user-cropped | no-leaf | unavailable | skipped`, detector id,
normalised `[xMin, yMin, xMax, yMax]` crop box, wall
time). The assistant UI shows a two-phase thinking label
("تحديد الورقة واقتصاص الخلفية…" → "تحليل الصورة وتشخيص المرض…") while the
longer pipeline runs, and a small ✂️ note on the answer when a crop was
applied (detected, automatic fallback or user-guided) — the farmer always
knows what happened to their photo.

## Interactive User-Guided Crop (pre-submit, client-side)

Attaching/capturing a photo opens the **interactive cropper modal**
(`ImageCropModal.tsx`) *before* anything is sent:

1. **Draw a stroke or drag a bounding box** over the leaf (pointer/touch,
   `touch-action: none`, 44 px targets, RTL chrome).
2. **Smart Snap** (`src/lib/assistant/user-crop.ts`, pure + unit-tested):
   the path's bounding box auto-expands outward while the probe band just
   outside each edge is ≥ 30 % HSV-green — the selection hugs the foliage
   and stops at desks/hands/walls. A bare tap is widened to a minimum
   12 % box first.
3. **Cropped Leaf Preview** ("معاينة الورقة المحددة") renders the exact
   isolated tensor that will be evaluated, with two actions:
   **إعادة التحديد / Redo Crop** (resets the canvas) and
   **تأكيد وإرسال للتحليل / Confirm & Analyze** (proceeds with the query).
4. Confirm sends the crop with `image.isUserCropped: true` → the server
   bypasses Step 0 and routes it directly to MobileNetV2 (Step 1).

## Why not client-side detection?

The task allowed either. Server-side was chosen because:

- **Accuracy** — the only open leaf-specific detectors usable in-browser are
  either COCO-SSD (no leaf class — `potted plant` at best) or ~40–170 MB
  zero-shot checkpoints; the PlantDoc DETR is *trained on leaves*, which is
  the whole point of the step.
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
npm run test:unit    # includes test/unit/leaf-detect.unit.test.ts,
                     # user-crop.unit.test.ts (Smart Snap maths) and the
                     # Step 0 route suites (crop reaches the classifier,
                     # smart fallback crop (green mask + centre 80 %),
                     # isUserCropped bypass, outage degrades, chain
                     # walk, env override, keyless skip)
npm run lint
npm run build
```
