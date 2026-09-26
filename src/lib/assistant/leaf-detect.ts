/**
 * Step 0 — leaf detection & smart cropping: shared geometry, label policy and
 * payload parsing for the "Detection & Cropping" preprocessing stage.
 *
 * The stage runs BEFORE the PlantVillage disease classifier (Step 1): an
 * open-source object detector localises the leaf in the photo, the handler
 * crops the detected region (removing hands, soil, pots and other background
 * noise) and forwards ONLY the cropped pixels to the classifier — background
 * clutter is the most common cause of confident-but-wrong PlantVillage
 * verdicts, because the classifier has no notion of "leaf" and happily
 * classifies dirt.
 *
 * Two accuracy levers live here:
 *   1. a GENEROUS detection policy — a low score threshold (0.22) plus an
 *      expanded vegetation label set ("plant", "potted plant", "foliage",
 *      "leaf", "grass", "weed", …) so green regions are rarely missed;
 *   2. a Smart Fallback Crop — when the detector answers with nothing above
 *      threshold, the photo is STILL trimmed locally (HSV green-dominant
 *      bounding box first, centre-focused 80% crop as the always-available
 *      last resort) instead of forwarding the raw frame full of desks,
 *      watches, hands and walls to MobileNetV2.
 *
 * This module is deliberately dependency-free (no sharp, no fetch, no DOM) so
 * it is importable from the route handler AND from `node --test` unit tests.
 * The I/O half (Hugging Face call + sharp crop + pixel readback) lives in the
 * route.
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
  /**
   * Detections below this confidence are ignored entirely.
   *
   * 0.22 — deliberately lowered from the former 0.45 so partially
   * out-of-focus, back-lit or side-lit foliage still clears the bar (the
   * cluster merge + coverage guards already weed out the extra false
   * positives a low threshold lets through). Kept within the 0.20–0.25
   * band: below 0.20 detectors answer with mostly noise, above 0.25
   * dim/indoor leaves start getting dropped.
   */
  minScore: 0.22,
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

/* ------------------------------------------------------------------ */
/*  Label policy — plant / vegetation detections only                  */
/* ------------------------------------------------------------------ */

/**
 * Words that mark a detection as plant (vegetation) material.
 *
 * The Step 0 pipeline queries PLANT-SPECIFIC labels: the detector's answer
 * is filtered down to vegetative classes, so a box on the farmer's hand,
 * watch, desk or the wall never crops, while every plant-flavoured answer
 * does — `leaf`/`leaves` (PlantDoc-style fine-tunes), `plant`/`potted
 * plant` (the COCO class), `foliage`/`vegetation`/`grass`/`weed`/`vine`…
 * (general vegetative boxes from foliage-oriented detectors), plus common
 * crop names, which is how several field-trained checkpoints label their
 * single vegetation class ("Tomato", "Wheat", "Maize"…).
 */
const VEGETATION_WORDS = [
  "plant", "plants", "potted", "leaf", "leaves", "foliage", "vegetation",
  "vegetative", "crop", "crops", "grass", "grasses", "weed", "weeds",
  "vine", "vines", "tree", "trees", "bush", "bushes", "shrub", "shrubs",
  "canopy", "branch", "branches", "seedling", "seedlings", "sprout",
  "sprouts", "fern", "herb", "herbs", "palm", "houseplant",
  // Field crops — PlantDoc-style label spaces name the plant, not "leaf".
  "tomato", "potato", "maize", "corn", "wheat", "barley", "rice",
  "soybean", "cassava", "banana", "apple", "grape", "strawberry",
  "pepper", "cucumber", "cotton", "olive", "coffee",
] as const;

/**
 * Whether a detector label counts as leaf/plant material.
 *
 * Labels are normalised first — lower-cased with every run of
 * non-alphanumerics collapsed to a single space — so underscore/hyphen
 * separated class names from fine-tuned checkpoints (`"Tomato___leaf"`,
 * `"potted-plant"`, `"POTTED PLANT"`) match just like COCO's plain
 * `"potted plant"`.
 */
export function isVegetationLabel(label: string): boolean {
  const words = ` ${label.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return VEGETATION_WORDS.some((word) => words.includes(` ${word} `));
}

/* ------------------------------------------------------------------ */
/*  Smart Fallback Crop — green mask → centre-focused 80% crop         */
/* ------------------------------------------------------------------ */

/**
 * Small RGBA pixel grid (typically the photo downscaled to ≤160 px) that
 * feeds the green-dominant mask. Plain data on purpose: the route reads it
 * through sharp, unit tests build it by hand.
 */
export interface PixelGrid {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major (`length ≥ width·height·4`). */
  data: ArrayLike<number>;
}

/** Tunables for the automated fallback crop (used when detection finds nothing). */
export const SMART_FALLBACK_DEFAULTS = {
  /** Centre-focused crop keeps this share of EACH axis (0.8 → an 80 % crop). */
  centerFraction: 0.8,
  /** Below this green-pixel share the mask is noise — use the centre crop. */
  minGreenRatio: 0.03,
  /** Margin around the green bounding box (of the box's own size). */
  greenMargin: 0.12,
  /** Green hue window in degrees (yellow-green 35° … cyan-green 175°). */
  minHue: 35,
  maxHue: 175,
  /** Minimum HSV saturation — rejects grey walls and white desks. */
  minSaturation: 0.15,
  /** Minimum HSV value — rejects near-black underexposed frames. */
  minValue: 0.05,
  /** Same coverage guard as the detector crop: tiny crops are unreliable… */
  minCoverage: 0.03,
  /** …and near-full crops are pointless. */
  maxCoverage: 0.92,
} as const;

export type SmartFallbackOptions = Partial<typeof SMART_FALLBACK_DEFAULTS>;

/**
 * HSV green-dominance test: a pixel is "vegetation" when it falls inside
 * the green hue band with enough saturation and brightness. Handled in HSV
 * (not raw `g > r && g > b`) so a bright yellow wall or a blue shirt can
 * never pass while shaded olive/forest-green leaves still do.
 */
export function isGreenPixel(
  r: number,
  g: number,
  b: number,
  options: SmartFallbackOptions = {},
): boolean {
  const opts = { ...SMART_FALLBACK_DEFAULTS, ...options };
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) return false;
  if (max / 255 < opts.minValue) return false;
  const chroma = max - min;
  if (chroma === 0) return false;
  if (chroma / max < opts.minSaturation) return false;
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / chroma) % 6);
  else if (max === g) hue = 60 * ((b - r) / chroma + 2);
  else hue = 60 * ((r - g) / chroma + 4);
  if (hue < 0) hue += 360;
  return hue >= opts.minHue && hue <= opts.maxHue;
}

/**
 * Tight bounding box of every green pixel in the grid (grid space,
 * `xmax`/`ymax` exclusive). `null` when the grid holds no meaningful
 * vegetation — too few green pixels, or none at all.
 */
export function greenMaskBox(
  grid: PixelGrid,
  options: SmartFallbackOptions = {},
): LeafBox | null {
  const opts = { ...SMART_FALLBACK_DEFAULTS, ...options };
  const { width, height, data } = grid;
  if (!(width >= 1 && height >= 1) || data.length < width * height * 4) return null;

  let count = 0;
  let xmin = width;
  let ymin = height;
  let xmax = -1;
  let ymax = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!isGreenPixel(data[i], data[i + 1], data[i + 2], opts)) continue;
      count++;
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  if (xmax < 0) return null;
  if (count < opts.minGreenRatio * width * height) return null;
  return { xmin, ymin, xmax: xmax + 1, ymax: ymax + 1 };
}

/** Map a box from one pixel space into another (e.g. mask grid → full frame). */
export function scaleBox(
  box: LeafBox,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): LeafBox {
  const sx = toWidth / Math.max(1, fromWidth);
  const sy = toHeight / Math.max(1, fromHeight);
  return {
    xmin: Math.round(box.xmin * sx),
    ymin: Math.round(box.ymin * sy),
    xmax: Math.round(box.xmax * sx),
    ymax: Math.round(box.ymax * sy),
  };
}

/**
 * Centre-focused crop keeping `fraction` (default 0.8 → 80 %) of each axis:
 * the always-available fallback that trims the outer frame — where desks,
 * watches, hands and walls mostly live — with no pixel analysis at all.
 * Returns an integer, in-bounds, non-degenerate rect or `null`.
 */
export function centerFallbackCrop(
  imageWidth: number,
  imageHeight: number,
  fraction: number = SMART_FALLBACK_DEFAULTS.centerFraction,
): CropRect | null {
  const width = Math.round(imageWidth);
  const height = Math.round(imageHeight);
  if (!(width >= 1 && height >= 1)) return null;
  const clampedFraction = Math.min(1, Math.max(0.01, fraction));
  const cropWidth = Math.max(1, Math.min(width, Math.round(width * clampedFraction)));
  const cropHeight = Math.max(1, Math.min(height, Math.round(height * clampedFraction)));
  const left = Math.min(width - cropWidth, Math.max(0, Math.round((width - cropWidth) / 2)));
  const top = Math.min(height - cropHeight, Math.max(0, Math.round((height - cropHeight) / 2)));
  return { left, top, width: cropWidth, height: cropHeight };
}

/**
 * Smart Fallback Crop — what Step 0 sends to MobileNetV2 when the detector
 * returned no box above threshold. NEVER the raw frame:
 *
 *   1. **Green-mask crop** — bounding box of the HSV green-dominant pixels
 *      (from a downscaled `grid`), padded by `greenMargin` and guarded by
 *      the same coverage rules as the detector crop;
 *   2. **Centre-focused 80 % crop** — used when there is no grid, no
 *      meaningful green, or the mask would keep (almost) the whole frame.
 *
 * Pure geometry — the route only supplies pixels and applies the returned
 * rect with `sharp().extract()`. Returns `null` for invalid image sizes.
 */
export function smartFallbackCrop(
  imageWidth: number,
  imageHeight: number,
  grid?: PixelGrid | null,
  options: SmartFallbackOptions = {},
): CropRect | null {
  const opts = { ...SMART_FALLBACK_DEFAULTS, ...options };
  const width = Math.round(imageWidth);
  const height = Math.round(imageHeight);
  if (!(width >= 1 && height >= 1)) return null;

  if (grid) {
    const mask = greenMaskBox(grid, opts);
    if (mask) {
      const scaled = scaleBox(mask, grid.width, grid.height, width, height);
      const padX = Math.round((scaled.xmax - scaled.xmin) * opts.greenMargin);
      const padY = Math.round((scaled.ymax - scaled.ymin) * opts.greenMargin);
      const padded = clampBox(
        {
          xmin: scaled.xmin - padX,
          ymin: scaled.ymin - padY,
          xmax: scaled.xmax + padX,
          ymax: scaled.ymax + padY,
        },
        width,
        height,
      );
      if (padded) {
        const coverage =
          ((padded.xmax - padded.xmin) * (padded.ymax - padded.ymin)) /
          (width * height);
        if (coverage >= opts.minCoverage && coverage <= opts.maxCoverage) {
          return {
            left: padded.xmin,
            top: padded.ymin,
            width: padded.xmax - padded.xmin,
            height: padded.ymax - padded.ymin,
          };
        }
      }
    }
  }
  return centerFallbackCrop(width, height, opts.centerFraction);
}

/** Normalised crop window `[xMin, yMin, xMax, yMax]`, every value in [0, 1]. */
export type NormalizedCropBox = [number, number, number, number];

/**
 * Convert an integer crop rect into the reported wire format:
 * **normalised `[xMin, yMin, xMax, yMax]`** — corners (not size), scaled to
 * the original image so the tuple is resolution-independent, clamped to
 * `[0, 1]` and rounded to 4 decimals to stay JSON-stable.
 */
export function normalizedCropBox(
  rect: CropRect,
  imageWidth: number,
  imageHeight: number,
): NormalizedCropBox {
  const width = Math.max(1, Math.round(imageWidth));
  const height = Math.max(1, Math.round(imageHeight));
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
  return [
    round4(clamp01(rect.left / width)),
    round4(clamp01(rect.top / height)),
    round4(clamp01((rect.left + rect.width) / width)),
    round4(clamp01((rect.top + rect.height) / height)),
  ];
}
