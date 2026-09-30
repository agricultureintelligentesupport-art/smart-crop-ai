import test from "node:test";
import assert from "node:assert/strict";
import { ancestorCrop, mercator, perimeterMetres, plotGeometry, tileGrid } from "../../src/lib/plot/geometry";
import { hasImageryPixels } from "../../src/lib/plot/imagery";
import { ringAreaHa, type Ring } from "../../src/lib/geo/polygon";

const rectangle = (area: number, ratio = 1): Ring => {
  const width = Math.sqrt(area * 10000 * ratio), height = width / ratio;
  const dx = width / (111319.49 * Math.cos(35 * Math.PI / 180)), dy = height / 111319.49;
  return [[6, 35], [6 + dx, 35], [6 + dx, 35 + dy], [6, 35 + dy]];
};
for (const area of [0.17, 40]) {
  test(`${area} ha: metres, proportions, uniform fit and bounded tile budget`, () => {
    const ring = rectangle(area, 1.8), geo = plotGeometry(ring);
    assert.ok(Math.abs(ringAreaHa(ring) - area) < area * 0.001);
    assert.ok(Math.abs(geo.svgWidth / geo.svgHeight - 1.8) < 0.001);
    assert.ok(Math.abs(perimeterMetres(ring) - 2 * (Math.sqrt(area * 10000 * 1.8) + Math.sqrt(area * 10000 / 1.8))) < 0.2);
    assert.ok(Math.abs(geo.svgWidth - 1000) < 1e-9);
    assert.ok(tileGrid(geo).count <= 36);
    assert.ok(tileGrid(geo).zoom <= 23);
    assert.equal(plotGeometry([...ring, ring[0]]).vertices, 4);
    assert.equal(perimeterMetres([...ring, ring[0]]), perimeterMetres(ring));
  });
}
test("mercator north stays up, longitude east stays right", () => {
  const [x, y] = mercator([6, 35]);
  assert.ok(mercator([6.1, 35])[0] > x);
  assert.ok(mercator([6, 35.1])[1] < y);
});
test("long thin and concave boundaries are not stretched into squares", () => {
  const narrow = plotGeometry(rectangle(0.17, 40));
  assert.ok(narrow.svgWidth / narrow.svgHeight > 39.9);
  const ring: Ring = [[6,35],[6.01,35],[6.01,35.01],[6.005,35.006],[6,35.01]];
  assert.equal(plotGeometry(ring).points.split(" ").length, 5);
});
test("ancestor crops retain geographic alignment, not repeating whole parent tiles", () => {
  assert.deepEqual(ancestorCrop(5, 6, 1), { x: 128, y: 0, size: 128 });
  assert.deepEqual(ancestorCrop(5, 6, 2), { x: 64, y: 128, size: 64 });
  assert.deepEqual(ancestorCrop(5, 6, 0), { x: 0, y: 0, size: 256 });
});
function pixels(make: (i: number) => number[]) {
  return new Uint8ClampedArray(Array.from({ length: 4096 }, (_, i) => make(i)).flat());
}
test("HTTP200 neutral placeholders, black, transparent and flat tiles are rejected", () => {
  assert.equal(hasImageryPixels(pixels(() => [192,192,192,255])), false);
  assert.equal(hasImageryPixels(pixels((i) => i % 5 ? [192,192,192,255] : [40,40,40,255])), false);
  assert.equal(hasImageryPixels(pixels(() => [0,0,0,255])), false);
  assert.equal(hasImageryPixels(pixels(() => [80,120,60,0])), false);
  assert.equal(hasImageryPixels(pixels(() => [65,125,60,255])), false);
  assert.equal(hasImageryPixels([]), false);
});
test("textured green and arid satellite-like pixels pass conservative verification", () => {
  assert.equal(hasImageryPixels(pixels(i => [50 + i % 30, 95 + i % 25, 40 + i % 20,255])), true);
  assert.equal(hasImageryPixels(pixels(i => [175 + i % 45, 150 + i % 25, 112 + i % 20,255])), true);
});
