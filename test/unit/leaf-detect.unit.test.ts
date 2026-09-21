import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampBox,
  LEAF_DETECT_DEFAULTS,
  overlapRatio,
  parseObjectDetections,
  selectLeafCrop,
  unionBox,
  type LeafDetection,
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
