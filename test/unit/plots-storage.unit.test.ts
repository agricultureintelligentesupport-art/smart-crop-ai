/**
 * Firestore storage encoding for plots.
 *
 * Firestore rejects nested arrays, so the drawn ring cannot be stored as
 * `number[][]` — the previous attempt failed with "Nested arrays are not
 * supported" on every save. The document carries a flat `ringFlat`; the
 * in-memory `Plot` keeps `ring: [number, number][]`, which is the exact shape
 * POSTed to `/api/field-data`. This suite pins that boundary: the encoding
 * must round-trip losslessly and must never contain a nested array.
 *
 *   npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fromFirestoreDoc, toFirestoreDoc } from "../../src/lib/field-data/plots";
import type { Plot } from "../../src/lib/field-data/types";

const plot: Plot = {
  id: "p1",
  uid: "u1",
  name: "Parcelle nord",
  ring: [
    [3.05, 36.75],
    [3.051, 36.75],
    [3.051, 36.751],
    [3.05, 36.751],
  ],
  areaHa: 0.9,
  centroid: [3.0505, 36.7505],
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
};

test("the Firestore document carries no nested arrays", () => {
  const doc = toFirestoreDoc(plot) as unknown as Record<string, unknown>;
  assert.equal(Array.isArray(doc.ring), false, "ring must not be written");
  assert.ok(Array.isArray(doc.ringFlat), "ringFlat is a flat array");
  assert.ok(
    (doc.ringFlat as unknown[]).every((v) => typeof v === "number"),
    "ringFlat holds numbers only",
  );
  // JSON is a faithful stand-in for Firestore's value model here: after the
  // encoding, no value anywhere in the document is an array of arrays.
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      assert.ok(
        value.every((v) => !Array.isArray(v)),
        "no nested arrays anywhere in the document",
      );
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(doc);
});

test("the encoding round-trips the Plot shape — including [lon, lat] order", () => {
  const back = fromFirestoreDoc(toFirestoreDoc(plot));
  assert.deepEqual(back, plot);
});

test("legacy pair-array documents still read (defensive path)", () => {
  const back = fromFirestoreDoc({ ...plot });
  assert.deepEqual(back, plot);
});

test("malformed documents are rejected, not guessed at", () => {
  assert.equal(fromFirestoreDoc(null), null);
  assert.equal(fromFirestoreDoc({}), null);
  const encoded = toFirestoreDoc(plot) as unknown as Record<string, unknown>;
  assert.equal(fromFirestoreDoc({ ...encoded, ringFlat: [1, 2, 3] }), null, "odd length");
  assert.equal(fromFirestoreDoc({ ...encoded, ringFlat: [1, 2] }), null, "too few coordinates");
  assert.equal(fromFirestoreDoc({ ...plot, uid: 7 }), null, "non-string uid");
});
