import assert from "node:assert/strict";
import { test } from "node:test";
import {
  centerFallbackCrop,
  clampBox,
  greenMaskBox,
  isGreenPixel,
  isVegetationLabel,
  LEAF_DETECT_DEFAULTS,
  normalizedCropBox,
  overlapRatio,
  parseObjectDetections,
  selectLeafCrop,
  smartFallbackCrop,
  unionBox,
  type LeafDetection,
  type PixelGrid,
} from "../../src/lib/assistant/leaf-detect";

const box = (xmin: number, ymin: number, xmax: number, ymax: number) => ({ xmin, ymin, xmax, ymax });
const det = (score: number, xmin: number, ymin: number, xmax: number, ymax: number, label = "Tomato leaf"): LeafDetection => ({
  label,
  score,
  box: box(xmin, ymin, xmax, ymax),
});

/* ------------------------------------------------------------------ */
/*  parseObjectDetections — HF object-detection payload validation      */
/* ------------------------------------------------------------------ */

test("parseObjectDetections accepts a well-formed payload and rounds coordinates", () => {
  const parsed = parseObjectDetections([
    { score: 0.912, label: "Tomato leaf", box: { xmin: 10.4, ymin: 8.9, xmax: 50.2, ymax: 40.1 } },
    { score: 0.5, label: "LABEL_3", box: { xmin: 0, ymin: 0, xmax: 30, ymax: 20 } },
  ]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].box, box(10, 9, 50, 40));
  assert.equal(parsed[0].label, "Tomato leaf");
  assert.equal(parsed[1].score, 0.5);
});

test("parseObjectDetections drops malformed items (missing box, non-finite or inverted coords)", () => {
  assert.deepEqual(
    parseObjectDetections([
      { score: 0.9, label: "no box" },
      { score: 0.9, label: "non-finite", box: { xmin: 0, ymin: 0, xmax: Number.NaN, ymax: 10 } },
      { score: 0.9, label: "inverted", box: { xmin: 30, ymin: 0, xmax: 10, ymax: 20 } },
      { score: "high", label: "bad score", box: { xmin: 0, ymin: 0, xmax: 10, ymax: 10 } },
      null,
      "junk",
    ]),
    [],
  );
});

test("parseObjectDetections treats non-arrays and classification-shaped payloads as empty", () => {
  assert.deepEqual(parseObjectDetections(null), []);
  assert.deepEqual(parseObjectDetections({ error: "loading" }), []);
  // Step 1's classifier answers `[{ label, score }]` — no `box` — so a
  // classification endpoint hit by mistake degrades to "nothing detected".
  assert.deepEqual(parseObjectDetections([{ label: "Tomato___healthy", score: 0.95 }]), []);
});

/* ------------------------------------------------------------------ */
/*  clampBox / overlapRatio / unionBox — primitives                     */
/* ------------------------------------------------------------------ */

test("clampBox clamps into the image and rejects degenerate boxes", () => {
  assert.deepEqual(clampBox(box(-5, -5, 200, 200), 100, 80), box(0, 0, 100, 80));
  assert.deepEqual(clampBox(box(10, 20, 30, 40), 100, 80), box(10, 20, 30, 40));
  assert.equal(clampBox(box(50, 50, 50, 60), 100, 80), null);
  assert.equal(clampBox(box(200, 200, 300, 300), 100, 80), null);
});

test("overlapRatio measures intersection over the smaller box", () => {
  assert.equal(overlapRatio(box(0, 0, 10, 10), box(0, 0, 10, 10)), 1);
  assert.equal(overlapRatio(box(0, 0, 10, 10), box(20, 20, 30, 30)), 0);
  // 5×5 intersection into a 10×10 and a 20×10 box → 0.5 against the smaller.
  assert.equal(overlapRatio(box(0, 0, 10, 10), box(5, 0, 25, 10)), 0.5);
});

test("unionBox covers both inputs", () => {
  assert.deepEqual(unionBox(box(0, 0, 10, 10), box(20, 5, 30, 40)), box(0, 0, 30, 40));
});

/* ------------------------------------------------------------------ */
/*  selectLeafCrop — dominant-cluster crop decision                     */
/* ------------------------------------------------------------------ */

test("selectLeafCrop pads a single detection and reports its coverage", () => {
  const decision = selectLeafCrop([det(0.87, 10, 8, 50, 40)], 100, 80);
  assert.ok(decision);
  // 40×32 box + 12% padding (5, 4) → rect (5,4) 50×40, 25% of the frame.
  assert.deepEqual(decision.rect, { left: 5, top: 4, width: 50, height: 40 });
  assert.equal(Math.round(decision.coverage * 100), 25);
  assert.equal(decision.detections, 1);
  assert.equal(decision.topScore, 0.87);
});

test("selectLeafCrop clamps the padded box to the image edges", () => {
  const decision = selectLeafCrop([det(0.9, 0, 0, 20, 20)], 100, 80);
  assert.ok(decision);
  assert.deepEqual(decision.rect, { left: 0, top: 0, width: 22, height: 22 });
});

test("selectLeafCrop merges only the dominant overlapping cluster", () => {
  const detections = [
    det(0.55, 150, 150, 190, 190, "background leaf"), // far away — ignored
    det(0.7, 30, 30, 90, 90), // overlaps the seed → merged
    det(0.9, 10, 10, 60, 60), // seed
  ];
  const decision = selectLeafCrop(detections, 200, 200);
  assert.ok(decision);
  // Union (10,10)-(90,90), padded by 10 → (0,0) 100×100.
  assert.deepEqual(decision.rect, { left: 0, top: 0, width: 100, height: 100 });
  assert.equal(decision.detections, 2);
  assert.equal(decision.topScore, 0.9);
});

test("selectLeafCrop returns null below the score threshold or without detections", () => {
  assert.equal(selectLeafCrop([], 100, 80), null);
  assert.equal(selectLeafCrop([det(LEAF_DETECT_DEFAULTS.minScore - 0.01, 10, 10, 50, 50)], 100, 80), null);
});

test("selectLeafCrop refuses a speck-sized crop (unreliable detection)", () => {
  const decision = selectLeafCrop([det(0.9, 10, 10, 13, 13)], 100, 80);
  assert.equal(decision, null);
});

test("selectLeafCrop refuses a near-full-frame crop (nothing to remove)", () => {
  const decision = selectLeafCrop([det(0.9, 2, 2, 98, 78)], 100, 80);
  assert.equal(decision, null);
});

test("selectLeafCrop always returns integer rects ready for sharp().extract()", () => {
  const decision = selectLeafCrop([det(0.8, 3.7, 5.2, 41.9, 33.6)], 100, 80);
  assert.ok(decision);
  for (const value of Object.values(decision.rect)) {
    assert.equal(Number.isInteger(value), true, `rect value ${value} must be an integer`);
  }
});

test("the score threshold sits in the generous 0.20–0.25 band", () => {
  assert.ok(LEAF_DETECT_DEFAULTS.minScore >= 0.2, "threshold must reach down to 0.20");
  assert.ok(LEAF_DETECT_DEFAULTS.minScore <= 0.25, "threshold must stay at/below 0.25");
});

/* ------------------------------------------------------------------ */
/*  isVegetationLabel — plant-specific label query policy              */
/* ------------------------------------------------------------------ */

test("isVegetationLabel accepts plant/potted-plant/foliage and general vegetative labels", () => {
  for (const label of [
    "plant",
    "potted plant",
    "POTTED PLANT",
    "potted-plant",
    "foliage",
    "vegetation",
    "leaf",
    "leaves",
    "Tomato leaf",
    "Tomato___leaf", // underscore-separated fine-tune class names
    "grass",
    "weed",
    "crop",
    "vine",
    "houseplant",
    "Wheat",
    "maize",
  ]) {
    assert.equal(isVegetationLabel(label), true, `"${label}" must be accepted`);
  }
});

test("isVegetationLabel rejects non-vegetative boxes (person, hand, desk…)", () => {
  for (const label of ["person", "hand", "desk", "wall", "watch", "car", "cell phone", "cup", "book", "unknown"]) {
    assert.equal(isVegetationLabel(label), false, `"${label}" must be rejected`);
  }
});

/* ------------------------------------------------------------------ */
/*  Smart Fallback Crop — green mask → centre-focused 80% crop         */
/* ------------------------------------------------------------------ */

/** RGBA grid from a per-pixel RGB function. */
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

const GREY: readonly [number, number, number] = [128, 128, 128];
const GREEN: readonly [number, number, number] = [34, 120, 45];

test("isGreenPixel accepts vegetation hues and rejects walls, desks and hands", () => {
  assert.equal(isGreenPixel(34, 120, 45), true, "leaf green");
  assert.equal(isGreenPixel(20, 60, 25), true, "shaded forest green");
  assert.equal(isGreenPixel(60, 160, 40), true, "yellow-green");
  assert.equal(isGreenPixel(128, 128, 128), false, "grey wall");
  assert.equal(isGreenPixel(240, 240, 240), false, "white desk");
  assert.equal(isGreenPixel(224, 172, 140), false, "skin tone");
  assert.equal(isGreenPixel(40, 80, 200), false, "blue shirt");
  assert.equal(isGreenPixel(0, 0, 0), false, "black");
});

test("greenMaskBox returns the bounding box of the green pixels", () => {
  // 20×10 grey frame with a green patch at x∈[5,14], y∈[2,7].
  const grid = makeGrid(20, 10, (x, y) =>
    x >= 5 && x <= 14 && y >= 2 && y <= 7 ? GREEN : GREY,
  );
  assert.deepEqual(greenMaskBox(grid), { xmin: 5, ymin: 2, xmax: 15, ymax: 8 });
});

test("greenMaskBox rejects frames with no (or barely any) green", () => {
  assert.equal(greenMaskBox(makeGrid(20, 10, () => GREY)), null);
  // A single stray green pixel is noise, not a leaf.
  assert.equal(
    greenMaskBox(makeGrid(20, 10, (x, y) => (x === 3 && y === 3 ? GREEN : GREY))),
    null,
  );
});

test("smartFallbackCrop trims to the green-dominant region when one exists", () => {
  const grid = makeGrid(20, 10, (x, y) =>
    x >= 5 && x <= 14 && y >= 2 && y <= 7 ? GREEN : GREY,
  );
  // Mask (5,2)-(15,8) + 12 % padding (1,1) → rect (4,1) 12×8.
  assert.deepEqual(smartFallbackCrop(20, 10, grid), {
    left: 4,
    top: 1,
    width: 12,
    height: 8,
  });
});

test("smartFallbackCrop degrades to the centred 80% crop without a usable mask", () => {
  const expected = centerFallbackCrop(20, 10);
  assert.ok(expected);
  // No grid at all…
  assert.deepEqual(smartFallbackCrop(20, 10, null), expected);
  // …an all-grey grid…
  assert.deepEqual(smartFallbackCrop(20, 10, makeGrid(20, 10, () => GREY)), expected);
  // …and a fully-green frame (mask coverage ≈ 100 % > maxCoverage — the
  // box would keep everything, so the centre crop trims the outer frame).
  assert.deepEqual(smartFallbackCrop(20, 10, makeGrid(20, 10, () => GREEN)), expected);
});

test("centerFallbackCrop keeps a centred 80% window with integer in-bounds rects", () => {
  assert.deepEqual(centerFallbackCrop(100, 80), { left: 10, top: 8, width: 80, height: 64 });
  for (const [w, h] of [
    [64, 48],
    [63, 47],
    [1080, 720],
    [8, 8],
  ] as const) {
    const rect = centerFallbackCrop(w, h);
    assert.ok(rect);
    for (const value of Object.values(rect)) {
      assert.equal(Number.isInteger(value), true, `rect value ${value} must be an integer`);
    }
    assert.ok(rect.left >= 0 && rect.top >= 0);
    assert.ok(rect.left + rect.width <= w && rect.top + rect.height <= h);
    assert.ok(rect.width >= 1 && rect.height >= 1);
  }
});

test("smartFallbackCrop rejects degenerate image sizes", () => {
  assert.equal(smartFallbackCrop(0, 10), null);
  assert.equal(smartFallbackCrop(10, -1), null);
});

/* ------------------------------------------------------------------ */
/*  normalizedCropBox — the reported [xMin, yMin, xMax, yMax] format   */
/* ------------------------------------------------------------------ */

test("normalizedCropBox reports normalised corner coordinates", () => {
  // (5,4) 50×40 on a 64×48 frame → corners scaled to [0, 1].
  assert.deepEqual(
    normalizedCropBox({ left: 5, top: 4, width: 50, height: 40 }, 64, 48),
    [0.0781, 0.0833, 0.8594, 0.9167],
  );
  // A full-frame crop maps to the full [0, 1] range.
  assert.deepEqual(
    normalizedCropBox({ left: 0, top: 0, width: 64, height: 48 }, 64, 48),
    [0, 0, 1, 1],
  );
});

test("normalizedCropBox always yields ordered values inside [0, 1]", () => {
  const tuple = normalizedCropBox({ left: 12, top: 9, width: 40, height: 30 }, 64, 48);
  const [xMin, yMin, xMax, yMax] = tuple;
  for (const value of tuple) {
    assert.ok(value >= 0 && value <= 1, `${value} must be in [0, 1]`);
  }
  assert.ok(xMin < xMax);
  assert.ok(yMin < yMax);
});
