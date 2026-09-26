import assert from "node:assert/strict";
import { test } from "node:test";
import type { PixelGrid } from "../../src/lib/assistant/leaf-detect";
import {
  boxFromPath,
  expandBoxToGreen,
  smartSnapBox,
  toCropRect,
  USER_CROP_DEFAULTS,
} from "../../src/lib/assistant/user-crop";

const GREY: readonly [number, number, number] = [128, 128, 128];
const GREEN: readonly [number, number, number] = [34, 120, 45];

/** RGBA grid from a per-pixel RGB function (same helper style as leaf-detect). */
function makeGrid(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
): PixelGrid {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/* ------------------------------------------------------------------ */
/*  boxFromPath — stroke/drag → minimum-sized, clamped box             */
/* ------------------------------------------------------------------ */

test("boxFromPath takes the bounds of a dragged rectangle (with its path samples)", () => {
  const box = boxFromPath(
    [
      { x: 10, y: 10 },
      { x: 25, y: 22 },
      { x: 40, y: 25 },
      { x: 50, y: 40 },
    ],
    100,
    80,
  );
  assert.deepEqual(box, { xmin: 10, ymin: 10, xmax: 50, ymax: 40 });
});

test("boxFromPath widens a bare tap to the minimum selection size", () => {
  // 100×80 → min side = 12 px / 10 px (12 % of each axis); the grown box
  // is centred on the tap.
  const centre = boxFromPath([{ x: 50, y: 40 }], 100, 80);
  assert.deepEqual(centre, { xmin: 44, ymin: 35, xmax: 56, ymax: 45 });
  // A tap near the corner grows too, clamped into the frame, still
  // containing the tap point.
  const corner = boxFromPath([{ x: 5, y: 5 }], 100, 80);
  assert.ok(corner);
  assert.ok(corner.xmax - corner.xmin >= 1, "tap must not produce a degenerate box");
  assert.ok(corner.ymax - corner.ymin >= 1);
  assert.ok(corner.xmin <= 5 && corner.xmax >= 5 && corner.ymin <= 5 && corner.ymax >= 5);
  assert.ok(corner.xmin >= 0 && corner.ymin >= 0);
  assert.ok(corner.xmax <= 100 && corner.ymax <= 80);
});

test("boxFromPath rejects empty paths and degenerate images", () => {
  assert.equal(boxFromPath([], 100, 80), null);
  assert.equal(boxFromPath([{ x: 10, y: 10 }], 0, 80), null);
  assert.equal(boxFromPath([{ x: Number.NaN, y: 3 }], 100, 80), null);
});

test("boxFromPath ignores non-finite samples but keeps the finite ones", () => {
  const box = boxFromPath(
    [
      { x: 8, y: 12 },
      { x: Number.POSITIVE_INFINITY, y: 0 },
      { x: 44, y: 36 },
    ],
    100,
    80,
  );
  assert.deepEqual(box, { xmin: 8, ymin: 12, xmax: 44, ymax: 36 });
});

/* ------------------------------------------------------------------ */
/*  expandBoxToGreen — the Smart Snap expansion                        */
/* ------------------------------------------------------------------ */

test("expandBoxToGreen grows through green pixels and stops at the grey background", () => {
  // 60×40 frame: a full-height green column at x∈[10,50), grey elsewhere.
  const grid = makeGrid(60, 40, (x) => (x >= 10 && x < 50 ? GREEN : GREY));
  const probe = 10;
  const box = expandBoxToGreen(grid, { xmin: 20, ymin: 10, xmax: 40, ymax: 30 }, { probePx: probe });
  // Left/right bands (10 px) stay inside the green column → edges snap to
  // its boundaries; the next band is pure grey → expansion stops.
  assert.equal(box.xmin, 10);
  assert.equal(box.xmax, 50);
  // The column spans the full height, so the vertical bands are green too.
  assert.equal(box.ymin, 0);
  assert.equal(box.ymax, 40);
});

test("expandBoxToGreen leaves the box untouched on a background-only frame", () => {
  const grid = makeGrid(60, 40, () => GREY);
  const before = { xmin: 20, ymin: 10, xmax: 40, ymax: 30 };
  assert.deepEqual(expandBoxToGreen(grid, before, { probePx: 8 }), before);
});

test("expandBoxToGreen never lets the snap swallow the whole frame (maxCoverage)", () => {
  // Entirely green 20×20 frame — expanding would cover 100 % > 95 % cap.
  const grid = makeGrid(20, 20, () => GREEN);
  const before = { xmin: 5, ymin: 5, xmax: 10, ymax: 10 };
  assert.deepEqual(expandBoxToGreen(grid, before), before);
});

test("expandBoxToGreen stops after maxIterations even on an endless green field", () => {
  const grid = makeGrid(400, 400, () => GREEN);
  const box = expandBoxToGreen(
    grid,
    { xmin: 190, ymin: 190, xmax: 210, ymax: 210 },
    { maxIterations: 3, probePx: 20, maxCoverage: 1 },
  );
  // 3 rounds × 20 px per side: the 20 px start grows exactly 60 px per
  // side (→ 140 px), never a round beyond the cap.
  assert.deepEqual(box, { xmin: 130, ymin: 130, xmax: 270, ymax: 270 });
});

test("expandBoxToGreen returns an integer box clamped into the grid", () => {
  const grid = makeGrid(30, 30, () => GREY);
  const box = expandBoxToGreen(grid, { xmin: -5, ymin: 2.4, xmax: 40, ymax: 28.6 });
  assert.deepEqual(box, { xmin: 0, ymin: 2, xmax: 30, ymax: 29 });
  for (const value of Object.values(box)) {
    assert.equal(Number.isInteger(value), true);
  }
});

/* ------------------------------------------------------------------ */
/*  smartSnapBox + toCropRect — end-to-end modal maths                 */
/* ------------------------------------------------------------------ */

test("smartSnapBox clamps a stroke box and expands it over the foliage", () => {
  const grid = makeGrid(60, 40, (x) => (x >= 10 && x < 50 ? GREEN : GREY));
  const snapped = smartSnapBox(grid, { xmin: 20, ymin: 10, xmax: 40, ymax: 30 }, { probePx: 10 });
  assert.ok(snapped);
  assert.deepEqual(snapped, { xmin: 10, ymin: 0, xmax: 50, ymax: 40 });
});

test("smartSnapBox returns null for degenerate grids", () => {
  const grid = { width: 0, height: 0, data: new Uint8Array(0) };
  assert.equal(smartSnapBox(grid, { xmin: 1, ymin: 1, xmax: 5, ymax: 5 }), null);
});

test("drawn stroke → snap → crop rect is integer, positive and in-frame", () => {
  const grid = makeGrid(64, 48, (x, y) =>
    x >= 16 && x < 48 && y >= 8 && y < 40 ? GREEN : GREY,
  );
  const drawn = boxFromPath(
    [
      { x: 24.6, y: 16.2 },
      { x: 30, y: 22 },
      { x: 40.4, y: 30.8 },
    ],
    64,
    48,
  );
  assert.ok(drawn);
  const snapped = smartSnapBox(grid, drawn, { probePx: 8 });
  assert.ok(snapped);
  const rect = toCropRect(snapped);
  assert.ok(Number.isInteger(rect.left) && Number.isInteger(rect.top));
  assert.ok(Number.isInteger(rect.width) && Number.isInteger(rect.height));
  assert.ok(rect.width >= 1 && rect.height >= 1);
  assert.ok(rect.left >= 0 && rect.top >= 0);
  assert.ok(rect.left + rect.width <= 64);
  assert.ok(rect.top + rect.height <= 48);
  // Smart snap must have reached the green region's own bounds.
  assert.ok(rect.left <= 16 && rect.left + rect.width >= 48);
});

test("USER_CROP_DEFAULTS keeps sensible tap-guard and probe values", () => {
  assert.ok(USER_CROP_DEFAULTS.minSizeFrac > 0 && USER_CROP_DEFAULTS.minSizeFrac <= 0.25);
  assert.ok(USER_CROP_DEFAULTS.minBandGreenRatio > 0 && USER_CROP_DEFAULTS.minBandGreenRatio < 1);
  assert.ok(USER_CROP_DEFAULTS.maxCoverage <= 1);
  assert.ok(USER_CROP_DEFAULTS.probePx >= 1);
});
