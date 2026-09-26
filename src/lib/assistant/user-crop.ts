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

/* ------------------------------------------------------------------ */
/*  Polygonal masking & contour edge-snapping                          */
/* ------------------------------------------------------------------ */

/** Tunables for the drawn-loop → snapped-contour pipeline. */
export const CONTOUR_DEFAULTS = {
  /** Maximum vertex displacement while snapping, in image px. */
  searchRadius: 20,
  /** Densify the loop so no segment is longer than this (px) — long edges
   * get mid-vertex samples too, so the WHOLE outline tightens, not just
   * the corners the finger happened to place. */
  sampleStep: 14,
  /** Half-window of the gradient probe along the vertex normal (px). */
  edgeProbe: 3,
  /** Below this colour jump there is no physical edge — leave the vertex
   * where the user drew it (texture/luminance gradients stay put). */
  minEdgeStrength: 35,
  /** Extra score when the probe straddles the green mask boundary — this
   * is what biases vertices onto the foliage contour specifically. */
  greenBonus: 80,
  /** |signed area| below this (px²) → the gesture was a drag, not a loop. */
  degenerateArea: 24,
} as const;

/** See {@link CONTOUR_DEFAULTS} — plain numbers (defaults are `as const`). */
export interface ContourOptions {
  searchRadius?: number;
  sampleStep?: number;
  edgeProbe?: number;
  minEdgeStrength?: number;
  greenBonus?: number;
  degenerateArea?: number;
}

/** Signed polygon area (shoelace / 2) — positive for clockwise loops. */
export function polygonArea(points: readonly CropPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Insert vertices along every segment (including the closing one) so no
 * edge is longer than `step` px — the input order/closure is preserved and
 * the result is a cyclic list (the last point connects back to the first).
 */
export function densifyPolygon(
  points: readonly CropPoint[],
  step: number = CONTOUR_DEFAULTS.sampleStep,
): CropPoint[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const spacing = Math.max(1, step);
  const out: CropPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const segments = Math.max(1, Math.ceil(length / spacing));
    for (let k = 0; k < segments; k++) {
      const t = k / segments;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out.length >= 3 ? out : points.map((p) => ({ ...p }));
}

/** Axis-aligned box → the 4 corner vertices (clockwise from top-left). */
export function rectPolygonFromBox(box: LeafBox): CropPoint[] {
  return [
    { x: box.xmin, y: box.ymin },
    { x: box.xmax, y: box.ymin },
    { x: box.xmax, y: box.ymax },
    { x: box.xmin, y: box.ymax },
  ];
}

/** Integer bounding box of a polygon (floor/ceil, clamped by the caller). */
export function polygonBounds(points: readonly CropPoint[]): LeafBox | null {
  if (points.length < 3) return null;
  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < xmin) xmin = p.x;
    if (p.y < ymin) ymin = p.y;
    if (p.x > xmax) xmax = p.x;
    if (p.y > ymax) ymax = p.y;
  }
  if (!Number.isFinite(xmin)) return null;
  return {
    xmin: Math.floor(xmin),
    ymin: Math.floor(ymin),
    xmax: Math.ceil(xmax),
    ymax: Math.ceil(ymax),
  };
}

/** Vertex-average centroid — used only to orient normals OUTWARD. */
export function polygonCentroid(points: readonly CropPoint[]): CropPoint | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** Nearest in-bounds pixel colour of the grid (clamped sampling). */
function colorAt(grid: PixelGrid, x: number, y: number): [number, number, number] {
  const gx = Math.min(grid.width - 1, Math.max(0, Math.round(x)));
  const gy = Math.min(grid.height - 1, Math.max(0, Math.round(y)));
  const i = (gy * grid.width + gx) * 4;
  return [grid.data[i], grid.data[i + 1], grid.data[i + 2]];
}

/** RGB euclidean distance between two grid samples. */
function colorDistance(
  grid: PixelGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const a = colorAt(grid, ax, ay);
  const b = colorAt(grid, bx, by);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Walk `[-searchRadius, +searchRadius]` along `dir` from `point` and move
 * the vertex onto the strongest physical edge found there — the actual
 * foliage boundary:
 *
 *   1. **coarse pass** — a ±`edgeProbe` colour-gradient probe, boosted
 *      when it straddles the green mask boundary, ranks candidate hits
 *      (distance is a tie-breaker so thin leaves never fling a vertex to
 *      their far side);
 *   2. **fine pass** — the exact 1-px colour/mask flip nearest the coarse
 *      hit, so the vertex lands ON the contour (sub-pixel) instead of
 *      somewhere inside the probe window.
 *
 * Returns the original point when no edge clears `minEdgeStrength`
 * (texture/luminance ramps below the threshold are left untouched).
 */
function snapVertexAlongNormal(
  grid: PixelGrid,
  point: CropPoint,
  dir: CropPoint,
  opts: { searchRadius: number; edgeProbe: number; minEdgeStrength: number; greenBonus: number },
): CropPoint {
  const radius = Math.round(opts.searchRadius);

  // ---- Pass 1: coarse (probe ±edgeProbe around each candidate) --------
  let coarseT = 0;
  let coarseRaw = -1;
  let coarseRank = Number.NEGATIVE_INFINITY;
  for (let t = -radius; t <= radius; t++) {
    const ax = point.x + dir.x * (t - opts.edgeProbe);
    const ay = point.y + dir.y * (t - opts.edgeProbe);
    const bx = point.x + dir.x * (t + opts.edgeProbe);
    const by = point.y + dir.y * (t + opts.edgeProbe);
    // Never probe outside the frame — the image border is not a leaf edge.
    if (
      ax < 0 ||
      ay < 0 ||
      bx < 0 ||
      by < 0 ||
      ax > grid.width - 1 ||
      bx > grid.width - 1 ||
      ay > grid.height - 1 ||
      by > grid.height - 1
    ) {
      continue;
    }
    let score = colorDistance(grid, ax, ay, bx, by);
    const a = colorAt(grid, ax, ay);
    const b = colorAt(grid, bx, by);
    if (isGreenPixel(a[0], a[1], a[2]) !== isGreenPixel(b[0], b[1], b[2])) {
      score += opts.greenBonus;
    }
    // Strongest edge wins; distance is a tie-breaker.
    const rank = score - 0.25 * Math.abs(t);
    if (rank > coarseRank) {
      coarseRank = rank;
      coarseT = t;
      coarseRaw = score;
    }
  }
  if (coarseRaw < opts.minEdgeStrength) return point;

  // ---- Pass 2: fine (the exact 1-px flip nearest the coarse hit) ------
  const lo = Math.max(-radius - 1, coarseT - opts.edgeProbe - 2);
  const hi = Math.min(radius, coarseT + opts.edgeProbe + 2);
  let fineT = coarseT;
  let fineRank = Number.NEGATIVE_INFINITY;
  for (let t = lo; t < hi; t++) {
    const a = colorAt(grid, point.x + dir.x * t, point.y + dir.y * t);
    const b = colorAt(grid, point.x + dir.x * (t + 1), point.y + dir.y * (t + 1));
    let delta = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (isGreenPixel(a[0], a[1], a[2]) !== isGreenPixel(b[0], b[1], b[2])) {
      delta += opts.greenBonus;
    }
    const rank = delta - 0.1 * Math.abs(t + 0.5 - coarseT);
    if (rank > fineRank) {
      fineRank = rank;
      fineT = t + 0.5; // midpoint of the flipping pixel pair — on the contour.
    }
  }
  const bestT = fineRank >= opts.minEdgeStrength ? fineT : coarseT;
  return {
    x: Math.min(grid.width - 1, Math.max(0, point.x + dir.x * bestT)),
    y: Math.min(grid.height - 1, Math.max(0, point.y + dir.y * bestT)),
  };
}

/**
 * Edge-snapped contour: densify the drawn loop, then for every vertex
 * walk perpendicular to its incident segments (oriented outward from the
 * centroid) and snap it onto the nearest strong edge — a colour gradient
 * with a bonus for green-mask crossings, i.e. the actual foliage
 * boundary. The outline tightens onto the leaf automatically while the
 * shape stays the user's loop.
 *
 * Degenerate inputs (fewer than 3 points, near-zero area, broken grid)
 * return the input unchanged. Output points are always inside the grid.
 */
export function snapPolygonToEdges(
  points: readonly CropPoint[],
  grid: PixelGrid,
  options: ContourOptions = {},
): CropPoint[] {
  const opts = { ...CONTOUR_DEFAULTS, ...options };
  if (points.length < 3 || Math.abs(polygonArea(points)) < opts.degenerateArea) {
    return points.map((p) => ({ ...p }));
  }
  if (!(grid.width >= 2 && grid.height >= 2) || grid.data.length < grid.width * grid.height * 4) {
    return points.map((p) => ({ ...p }));
  }

  const dense = densifyPolygon(points, opts.sampleStep);
  const centroid = polygonCentroid(dense);
  if (!centroid) return points.map((p) => ({ ...p }));

  const outwardNormal = (a: CropPoint, b: CropPoint): CropPoint => {
    // Segment direction (dx, dy) → left normal (-dy, dx), flipped to point
    // away from the centroid (outward = toward the background).
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    const midX = (a.x + b.x) / 2 - centroid.x;
    const midY = (a.y + b.y) / 2 - centroid.y;
    if (nx * midX + ny * midY < 0) {
      nx = -nx;
      ny = -ny;
    }
    const length = Math.hypot(nx, ny);
    return length < 1e-6 ? { x: 0, y: 0 } : { x: nx / length, y: ny / length };
  };

  const count = dense.length;
  const snapped: CropPoint[] = [];
  for (let i = 0; i < count; i++) {
    const prev = dense[(i - 1 + count) % count];
    const cur = dense[i];
    const next = dense[(i + 1) % count];
    const n1 = outwardNormal(prev, cur);
    const n2 = outwardNormal(cur, next);
    let dx = n1.x + n2.x;
    let dy = n1.y + n2.y;
    let length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      // Straight-through vertex (or collapsed neighbours) → radial fallback.
      dx = cur.x - centroid.x;
      dy = cur.y - centroid.y;
      length = Math.hypot(dx, dy);
    }
    if (length < 1e-6) {
      snapped.push({ ...cur });
      continue;
    }
    const dir = { x: dx / length, y: dy / length };
    snapped.push(snapVertexAlongNormal(grid, cur, dir, opts));
  }
  return snapped;
}
