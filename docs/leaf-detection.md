# Step 0 — Leaf Detection & Cropping (non-blocking preprocessing before the vision stages)

## Why

The vision stages that consume the photo — the PRIMARY Gemini Vision
direct diagnostician (Step 1a) and the SECONDARY PlantVillage MobileNetV2
cascade (Step 1b, a **38-class crop/disease classifier with no notion of
"leaf"**) — both do better on a clean leaf shot. When a farmer's photo
contains a hand holding the leaf, soil, a pot or half a field, a classifier
happily labels the *background* and returns a confident-but-wrong disease,
and even a multimodal LLM wastes its attention on the clutter. Localising the
leaf first and forwarding **only the cropped pixels** removes the single
largest source of misdiagnosis in the pipeline.

## What runs, where

| Stage | Where | Model | Cost |
| --- | --- | --- | --- |
| Step 0 · detection | Server (route) | `suryanshgoel/detr-finetuned-plantdoc` → `facebook/detr-resnet-50` (chain overridable via `HF_LEAF_DETECT_MODELS`) | Free — Hugging Face serverless `hf-inference` CPU tier, same router + `HUGGINGFACE_API_KEY` the app already uses for Step 1. No new key. |
| Step 0 · crop | Server (route) | `sharp` extract + re-encode (≤1024 px edge, JPEG q88 — mirrors the client's own downscale) | Free, MIT; ~tens of ms on the function. `sharp` is in Next.js' default server-external packages and is what Vercel uses for image optimisation anyway. |
| Step 1a · PRIMARY diagnosis | Server (route) | Gemini Vision (`gemini-3.5-flash` chain) — the crop travels inline and Gemini inspects it directly | Gemini API quota (`GEMINI_API_KEY`); ONE round-trip does vision + reasoning. |
| Step 1b · SECONDARY classification (fallback) | Server (route) | Field-trained ViTs → MobileNetV2 PlantVillage baseline — unchanged | Free tier, existing behaviour; runs only when Gemini Vision is unconfigured, times out or errors. |
| Stages 1–3 · LLM chain | Server (route) | Gemini text → HF router LLMs → built-in formatter — unchanged | Existing behaviour (fed by the Step 1b diagnosis on the fallback path). |

The detector weights (166 MB DETR checkpoint) live on **Hugging Face's
infrastructure** — the serverless function only POSTs the photo bytes and
parses a small JSON array of boxes, so the Vercel bundle size and cold start
are unaffected. The whole stage is bounded by its own 9 s deadline inside the
route's 60 s `maxDuration`, comfortably within Vercel's limits.

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
4. **Pad** the cluster by 12 % of its own size per side and **clamp** to the
   image so `sharp().extract()` always receives an in-bounds integer rect.
5. **Refuse pointless crops**: a padded box covering < 3 % of the frame
   (speck — bad read) or > 92 % (nothing would be removed) keeps the original.

## Failure modes — all non-fatal, all → original frame

| Case | Behaviour |
| --- | --- |
| No `HUGGINGFACE_API_KEY`/`HF_TOKEN` | Step 0 reports `status: "skipped"` (no request, no delay); the full frame goes straight to the primary vision step (Step 1 keeps its skip warning only if the fallback is actually needed). |
| Undecodable/too-small image | `status: "unavailable"`, warning pushed, original frame analysed. |
| Detector 503/530 (loading), 4xx/5xx, network, timeout | Walk the model chain; when all ids fail → `status: "unavailable"` + warning, the original frame goes straight to the primary vision step (non-blocking). |
| Payload is not object-detection-shaped | Treated as "this id can't serve detection" → next id in the chain. |
| No detection above threshold / useless box | `status: "no-leaf"` (a **normal** outcome — no warning), original frame analysed. |

The outcome travels to the client in `AssistantResponseBody.preprocessing`
(`cropped | no-leaf | unavailable | skipped`, detector id, crop box, wall
time). The assistant UI shows a two-phase thinking label
("تحديد الورقة واقتصاص الخلفية…" → "تحليل الصورة وتشخيص المرض…") while the
longer pipeline runs, and a small ✂️ note on the answer when a crop was
applied (or a note when no leaf was found) — the farmer always knows what
happened to their photo.

## Why not client-side detection?

The task allowed either. Server-side was chosen because:

- **Accuracy** — the only open leaf-specific detectors usable in-browser are
  either COCO-SSD (no leaf class — `potted plant` at best) or ~40–170 MB
  zero-shot checkpoints; the PlantDoc DETR is *trained on leaves*, which is
  the whole point of the step.
- **Free & key-free equivalent** — the HF serverless CPU tier that the
  Step 1b fallback already depends on serves the detection call; no
  additional provider, key or quota is introduced.
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
                     # Step 0 route suites (crop reaches the primary vision
                     # step, no-leaf keeps the full frame, outage degrades,
                     # chain walk, env override, keyless skip)
npm run lint
npm run build
```
