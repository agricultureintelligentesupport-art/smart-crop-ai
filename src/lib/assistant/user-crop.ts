/**
 * Step 0 (client) — Interactive User-Guided Crop: pure geometry + Smart
 * Snap maths for the pre-submit cropper modal.
 *
 * The farmer draws a freehand stroke OR drags a bounding box over the leaf
 * on the modal's canvas. The drawn path's bounding box is then passed
 * through {@link smartSnapBox}, which auto-expands the selection outward
 * while the band just outside each edge is predominantly green/foliage
 * (the same HSV test the server-side Smart Fallback Crop uses — see
 * `leaf-detect.ts`), stopping as soon as the surrounding band turns to
 * background (desk, hand, wall, sky).
 *
 * Everything here is DOM-free: the modal feeds it a {@link PixelGrid} read
 * once from the image canvas, and unit tests feed it hand-built grids — so
 * the smart-snap behaviour is verifiable without a browser.
 *
 * Coordinate space: IMAGE space (the grid must be the image at its natural
 * size, 1 px = 1 px). Boxes are clamped, integer and `sharp`/canvas
 * `drawImage`-ready.
 */

import {
  clampBox,
  isGreenPixel,
  type CropRect,
  type LeafBox,
  type PixelGrid,
} from "./leaf-detect";

/** One sampled point of the user's stroke/drag, in image pixels. */
export interface CropPoint {
  x: number;
  y: number;
}

/** Tunables for path → box conversion and the Smart Snap expansion. */
export const USER_CROP_DEFAULTS = {
  /** Width of the probe band outside each edge (image px) per round. */
  probePx: 24,
  /** A band this green (or greener) pulls its edge outward. */
  minBandGreenRatio: 0.3,
  /** Hard cap on expansion rounds — bounds cost on huge frames. */
  maxIterations: 12,
  /** Minimum box side as a share of the image's smaller edge (tap guard). */
  minSizeFrac: 0.12,
  /** Safety cap: never auto-expand past this share of the frame. */
  maxCoverage: 0.95,
} as const;

/**
 * Option overrides — plain `number`s on purpose (the defaults object is
 * `as const`, so `Partial<typeof …>` would only accept the literal values).
 */
export interface UserCropOptions {
  probePx?: number;
  minBandGreenRatio?: number;
  maxIterations?: number;
  minSizeFrac?: number;
  maxCoverage?: number;
}

/**
 * Bounding box of a drawn path (stroke line or dragged rectangle), widened
 * to a minimum side so a plain tap still yields a usable selection, and
 * clamped into the image. Returns `null` for an empty path or a degenerate
 * image.
 */
export function boxFromPath(
  points: readonly CropPoint[],
  imageWidth: number,
  imageHeight: number,
  options: UserCropOptions = {},
): LeafBox | null {
  const opts = { ...USER_CROP_DEFAULTS, ...options };
  const width = Math.round(imageWidth);
  const height = Math.round(imageHeight);
  if (!(width >= 1 && height >= 1) || points.length === 0) return null;

  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (point.x < xmin) xmin = point.x;
    if (point.y < ymin) ymin = point.y;
    if (point.x > xmax) xmax = point.x;
    if (point.y > ymax) ymax = point.y;
  }
  if (!Number.isFinite(xmin)) return null;

  xmin = Math.floor(xmin);
  ymin = Math.floor(ymin);
  xmax = Math.ceil(xmax);
  ymax = Math.ceil(ymax);

  // Minimum side — grow around the centre so a tap/degenerate drag still
  // probes a leaf-sized neighbourhood for the smart snap.
  const minSideX = Math.max(1, Math.round(width * opts.minSizeFrac));
  const minSideY = Math.max(1, Math.round(height * opts.minSizeFrac));
  if (xmax - xmin < minSideX) {
    const cx = (xmin + xmax) / 2;
    xmin = Math.round(cx - minSideX / 2);
    xmax = xmin + minSideX;
  }
  if (ymax - ymin < minSideY) {
    const cy = (ymin + ymax) / 2;
    ymin = Math.round(cy - minSideY / 2);
    ymax = ymin + minSideY;
  }

  return clampBox({ xmin, ymin, xmax, ymax }, width, height);
}

/** Green-pixel share inside a half-open rect of the grid, `null` if empty. */
function bandGreenRatio(
  grid: PixelGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number | null {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(grid.width, Math.ceil(x1));
  const bottom = Math.min(grid.height, Math.ceil(y1));
  const area = (right - left) * (bottom - top);
  if (area <= 0) return null;
  let green = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * grid.width + x) * 4;
      if (isGreenPixel(grid.data[i], grid.data[i + 1], grid.data[i + 2])) green++;
    }
  }
  return green / area;
}

/**
 * Smart Snap: grow `box` outward edge by edge while the probe band just
 * outside that edge is predominantly green (≥ `minBandGreenRatio`). All
 * qualifying edges move simultaneously each round (evaluated against the
 * same snapshot), the loop stops when no edge wants to move, after
 * `maxIterations` rounds, or before the box would exceed `maxCoverage` of
 * the frame. Always returns an integer, clamped, non-degenerate box.
 */
export function expandBoxToGreen(
  grid: PixelGrid,
  box: LeafBox,
  options: UserCropOptions = {},
): LeafBox {
  const opts = { ...USER_CROP_DEFAULTS, ...options };
  const gw = Math.round(grid.width);
  const gh = Math.round(grid.height);
  const validGrid = gw >= 1 && gh >= 1 && grid.data.length >= gw * gh * 4;
  const base =
    clampBox(
      {
        xmin: Math.round(box.xmin),
        ymin: Math.round(box.ymin),
        xmax: Math.round(box.xmax),
        ymax: Math.round(box.ymax),
      },
      Math.max(gw, 1),
      Math.max(gh, 1),
    ) ?? null;
  if (!base) return box;
  if (!validGrid) return base;

  let current: LeafBox = { ...base };
  const probe = Math.max(1, Math.round(opts.probePx));

  for (let round = 0; round < opts.maxIterations; round++) {
    // All four bands are evaluated against the SAME snapshot, then the
    // qualifying edges move together (predictable, no edge-order bias).
    const snapshot: LeafBox = { ...current };
    const next: LeafBox = { ...snapshot };
    let changed = false;

    // Left band: [xmin - probe, xmin) × [ymin, ymax)
    const leftRatio = bandGreenRatio(
      grid,
      snapshot.xmin - probe,
      snapshot.ymin,
      snapshot.xmin,
      snapshot.ymax,
    );
    if (leftRatio !== null && leftRatio >= opts.minBandGreenRatio && snapshot.xmin > 0) {
      next.xmin = Math.max(0, snapshot.xmin - probe);
      changed = true;
    }
    // Right band: [xmax, xmax + probe) × [ymin, ymax)
    const rightRatio = bandGreenRatio(
      grid,
      snapshot.xmax,
      snapshot.ymin,
      snapshot.xmax + probe,
      snapshot.ymax,
    );
    if (rightRatio !== null && rightRatio >= opts.minBandGreenRatio && snapshot.xmax < gw) {
      next.xmax = Math.min(gw, snapshot.xmax + probe);
      changed = true;
    }
    // Top band: [xmin, xmax) × [ymin - probe, ymin)
    const topRatio = bandGreenRatio(
      grid,
      snapshot.xmin,
      snapshot.ymin - probe,
      snapshot.xmax,
      snapshot.ymin,
    );
    if (topRatio !== null && topRatio >= opts.minBandGreenRatio && snapshot.ymin > 0) {
      next.ymin = Math.max(0, snapshot.ymin - probe);
      changed = true;
    }
    // Bottom band: [xmin, xmax) × [ymax, ymax + probe)
    const bottomRatio = bandGreenRatio(
      grid,
      snapshot.xmin,
      snapshot.ymax,
      snapshot.xmax,
      snapshot.ymax + probe,
    );
    if (bottomRatio !== null && bottomRatio >= opts.minBandGreenRatio && snapshot.ymax < gh) {
      next.ymax = Math.min(gh, snapshot.ymax + probe);
      changed = true;
    }

    if (!changed) break;

    // Safety cap: never let the snap swallow (almost) the whole frame.
    const coverage =
      ((next.xmax - next.xmin) * (next.ymax - next.ymin)) / Math.max(1, gw * gh);
    if (coverage > opts.maxCoverage) break;
    current = next;
  }

  return current;
}

/**
 * Full Smart Snap pipeline for the cropper modal: clamp the drawn box into
 * the grid, then {@link expandBoxToGreen}. Returns `null` for degenerate
 * inputs so callers fall back to the raw path box.
 */
export function smartSnapBox(
  grid: PixelGrid,
  strokeBox: LeafBox,
  options: UserCropOptions = {},
): LeafBox | null {
  const width = Math.round(grid.width);
  const height = Math.round(grid.height);
  if (!(width >= 1 && height >= 1)) return null;
  const clamped = clampBox(
    {
      xmin: Math.round(strokeBox.xmin),
      ymin: Math.round(strokeBox.ymin),
      xmax: Math.round(strokeBox.xmax),
      ymax: Math.round(strokeBox.ymax),
    },
    width,
    height,
  );
  if (!clamped) return null;
  return expandBoxToGreen(grid, clamped, options);
}

/** Integer `canvas.drawImage`/`sharp().extract()`-ready rect from a box. */
export function toCropRect(box: LeafBox): CropRect {
  return {
    left: box.xmin,
    top: box.ymin,
    width: box.xmax - box.xmin,
    height: box.ymax - box.ymin,
  };
}
