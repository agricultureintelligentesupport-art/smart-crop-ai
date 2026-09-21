/**
 * Step 0 — leaf detection & smart cropping: shared geometry and payload
 * parsing for the "Detection & Cropping" preprocessing stage.
 *
 * The stage runs BEFORE the PlantVillage disease classifier (Step 1): an
 * open-source object detector localises the leaf in the photo, the handler
 * crops the detected region (removing hands, soil, pots and other background
 * noise) and forwards ONLY the cropped pixels to the classifier — background
 * clutter is the most common cause of confident-but-wrong PlantVillage
 * verdicts, because the classifier has no notion of "leaf" and happily
 * classifies dirt.
 *
 * This module is deliberately dependency-free (no sharp, no fetch, no DOM) so
 * it is importable from the route handler AND from `node --test` unit tests.
 * The I/O half (Hugging Face call + sharp crop) lives in the route.
 *
 * Server-safe: no browser APIs, no React.
 */

/** Pixel-space axis-aligned bounding box (HF object-detection convention). */
export interface LeafBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

/** One raw candidate from the object detector (label kept for logging). */
export interface LeafDetection {
  label: string;
  score: number;
  box: LeafBox;
}

/** Integer crop window, `sharp().extract()`-ready. */
export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Outcome of the crop decision, surfaced for logging/telemetry. */
export interface LeafCropDecision {
  rect: CropRect;
  /** Rect area ÷ image area, in [0, 1]. */
  coverage: number;
  /** How many raw detections survived the score threshold. */
  detections: number;
  /** Score of the top detection that seeded the cluster. */
  topScore: number;
}

/** Tunables (fractions of the image / box, not pixels). */
export const LEAF_DETECT_DEFAULTS = {
  /** Detections below this confidence are ignored entirely. */
  minScore: 0.45,
  /** Margin added around the cluster box on every side (of the box size). */
  margin: 0.12,
  /** A crop smaller than this share of the image is too risky — keep all. */
  minCoverage: 0.03,
  /** A crop this large keeps (almost) everything — cropping is pointless. */
  maxCoverage: 0.92,
} as const;

export type LeafCropOptions = Partial<typeof LEAF_DETECT_DEFAULTS>;

/**
 * Parse and validate the Hugging Face object-detection payload:
 * `[{ "score": 0.99, "label": "Tomato leaf", "box": {xmin, ymin, xmax, ymax} }]`.
 * Coordinates may be floats and may touch/outstep the image edges — they are
 * rounded and validated here (non-finite/negative/inverted boxes dropped),
 * so the caller receives clean pixel-space detections or an empty array.
 * A classification-shaped payload (`{label, score}` without `box`) parses to
 * `[]` — which lets the route degrade to "no crop" instead of crashing when
 * an endpoint answers with the wrong task's shape.
 */
export function parseObjectDetections(payload: unknown): LeafDetection[] {
  if (!Array.isArray(payload)) return [];
  const detections: LeafDetection[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const { label, score, box } = item as {
      label?: unknown;
      score?: unknown;
      box?: unknown;
    };
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    if (!box || typeof box !== "object") continue;
    const { xmin, ymin, xmax, ymax } = box as Record<string, unknown>;
    const coords = [xmin, ymin, xmax, ymax];
    if (coords.some((c) => typeof c !== "number" || !Number.isFinite(c))) continue;
    const [x0, y0, x1, y1] = coords.map((c) => Math.round(c as number));
    if (x1 <= x0 || y1 <= y0) continue;
    detections.push({
      label: typeof label === "string" ? label : "unknown",
      score,
      box: { xmin: x0, ymin: y0, xmax: x1, ymax: y1 },
    });
  }
  return detections;
}

/** Clamp a box into `[0,width]×[0,height]`, keeping it non-degenerate. */
export function clampBox(box: LeafBox, width: number, height: number): LeafBox | null {
  const xmin = Math.max(0, Math.min(box.xmin, width));
  const ymin = Math.max(0, Math.min(box.ymin, height));
  const xmax = Math.max(0, Math.min(box.xmax, width));
  const ymax = Math.max(0, Math.min(box.ymax, height));
  if (xmax - xmin < 1 || ymax - ymin < 1) return null;
  return { xmin, ymin, xmax, ymax };
}

/** Area of intersection over the smaller box's area (overlap ∈ [0, 1]). */
export function overlapRatio(a: LeafBox, b: LeafBox): number {
  const ix = Math.max(0, Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin));
  const iy = Math.max(0, Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const areaA = (a.xmax - a.xmin) * (a.ymax - a.ymin);
  const areaB = (b.xmax - b.xmin) * (b.ymax - b.ymin);
  return inter / Math.max(1, Math.min(areaA, areaB));
}

/** Union of two boxes. */
export function unionBox(a: LeafBox, b: LeafBox): LeafBox {
  return {
    xmin: Math.min(a.xmin, b.xmin),
    ymin: Math.min(a.ymin, b.ymin),
    xmax: Math.max(a.xmax, b.xmax),
    ymax: Math.max(a.ymax, b.ymax),
  };
}

/**
 * Grow the dominant detection cluster and turn it into a padded crop rect.
 *
 * Farmers photograph ONE leaf; extra boxes usually mark secondary leaves or
 * noise in the background. So instead of blindly unioning everything (one
 * false positive in a corner would wreck the crop), the highest-scoring box
 * seeds a cluster and only boxes overlapping it are merged, repeated until
 * stable. The cluster box is then padded by `margin` on every side and
 * clamped to the image.
 *
 * Returns `null` when the crop is not worth doing: no detection above
 * `minScore`, or the padded cluster covers ≤ `minCoverage` (a speck — likely
 * a bad read) or ≥ `maxCoverage` (cropping would keep the whole frame
 * anyway, so the original image is just as good).
 */
export function selectLeafCrop(
  detections: LeafDetection[],
  imageWidth: number,
  imageHeight: number,
  options: LeafCropOptions = {},
): LeafCropDecision | null {
  const opts = { ...LEAF_DETECT_DEFAULTS, ...options };
  const width = Math.round(imageWidth);
  const height = Math.round(imageHeight);
  if (!(width >= 1 && height >= 1)) return null;

  const kept: LeafDetection[] = [];
  for (const det of detections) {
    if (!(det.score >= opts.minScore)) continue;
    // Snap to integer pixels first so pads, clamps and the final rect are
    // always `sharp().extract()`-ready even when callers skip the parser.
    const clamped = clampBox(
      {
        xmin: Math.round(det.box.xmin),
        ymin: Math.round(det.box.ymin),
        xmax: Math.round(det.box.xmax),
        ymax: Math.round(det.box.ymax),
      },
      width,
      height,
    );
    if (clamped) kept.push({ ...det, box: clamped });
  }
  if (kept.length === 0) return null;

  kept.sort((a, b) => b.score - a.score);

  // Grow the dominant cluster: seed with the top box, absorb any box that
  // overlaps the current union, re-scan until a full pass merges nothing.
  let cluster = kept[0].box;
  let changed = true;
  const inCluster = new Set<number>([0]);
  while (changed) {
    changed = false;
    for (let i = 0; i < kept.length; i++) {
      if (inCluster.has(i)) continue;
      if (overlapRatio(cluster, kept[i].box) > 0) {
        cluster = unionBox(cluster, kept[i].box);
        inCluster.add(i);
        changed = true;
      }
    }
  }

  // Pad the cluster box by `margin` of its own size on every side, then clamp.
  const padX = Math.round((cluster.xmax - cluster.xmin) * opts.margin);
  const padY = Math.round((cluster.ymax - cluster.ymin) * opts.margin);
  const padded = clampBox(
    {
      xmin: cluster.xmin - padX,
      ymin: cluster.ymin - padY,
      xmax: cluster.xmax + padX,
      ymax: cluster.ymax + padY,
    },
    imageWidth,
    imageHeight,
  );
  if (!padded) return null;

  const coverage =
    ((padded.xmax - padded.xmin) * (padded.ymax - padded.ymin)) /
    (width * height);
  if (coverage < opts.minCoverage || coverage > opts.maxCoverage) return null;

  return {
    rect: {
      left: padded.xmin,
      top: padded.ymin,
      width: padded.xmax - padded.xmin,
      height: padded.ymax - padded.ymin,
    },
    coverage,
    detections: inCluster.size,
    topScore: kept[0].score,
  };
}
