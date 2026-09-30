/**
 * The plot-details NDVI layer: pixel → colour mapping, the polygon clipping
 * mask, the layer switcher's config, the stats and the tap probe.
 *
 * The one rule everything below enforces: a pixel without a real measurement
 * is never given a colour, never counted, never probed — `dataMask 0` means
 * fully transparent, and the bilinear pass may soften an edge but never fill
 * a hole.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NdviRaster } from "@/lib/field-data/types";
import {
  composeNdviLayer,
  measuredPixelMask,
  nearestMeasuredPixel,
  ndviColorAt,
  ndviColorDomain,
  ndviColorFor,
  NDVI_COLOR_STOPS,
  NDVI_LAYER_ALPHA,
  ndviLegendGradientCss,
  pixelAtIsMeasured,
  pixelCenter,
  polygonClipMask,
  PLOT_LAYERS,
  rasterStats,
} from "@/lib/plot/ndvi-layers";

/** A raster over a 100 m × 100 m box (10 px at 10 m), values row-major. */
function makeRaster(
  width: number,
  height: number,
  fill: (x: number, y: number) => { ndvi: number | null; measured: boolean },
): NdviRaster {
  const ndvi: (number | null)[] = [];
  const dataMask: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { ndvi: value, measured } = fill(x, y);
      ndvi.push(measured ? value : null);
      dataMask.push(measured ? 1 : 0);
    }
  }
  return {
    bbox: { west: 3.05, south: 36.75, east: 3.051, north: 36.7509 },
    width,
    height,
    resolutionM: 10,
    ndvi,
    dataMask,
  };
}

const RING: [number, number][] = [
  [3.05, 36.75],
  [3.051, 36.75],
  [3.051, 36.7509],
  [3.05, 36.7509],
];

/* ---------------------------- layer config ----------------------------- */

test("the layer switcher is config-driven and only NDVI is wired", () => {
  assert.ok(PLOT_LAYERS.length >= 1);
  const ids = PLOT_LAYERS.map((layer) => layer.id);
  assert.equal(new Set(ids).size, ids.length, "layer ids are unique");
  for (const layer of PLOT_LAYERS) {
    assert.equal(typeof layer.id, "string");
    assert.equal(typeof layer.labelAr, "string");
    assert.ok(layer.labelAr.length > 0);
    assert.equal(typeof layer.unit, "string");
    assert.equal(typeof layer.source, "string");
    assert.equal(typeof layer.available, "boolean");
  }
  const wired = PLOT_LAYERS.filter((layer) => layer.available);
  assert.deepEqual(wired.map((layer) => layer.id), ["ndvi"], "exactly NDVI is available today");
  assert.ok(wired[0].source.includes("Sentinel-2"), "the wired layer names its source");
});

/* ------------------------- pixel → colour scale ------------------------ */

test("the colour scale maps the field's real min and max onto the ramp ends", () => {
  const first = NDVI_COLOR_STOPS[0].rgb;
  const last = NDVI_COLOR_STOPS[NDVI_COLOR_STOPS.length - 1].rgb;
  const domain: [number, number] = [0.32, 0.74];
  assert.deepEqual(ndviColorFor(0.32, domain), first, "the field minimum is the ramp's low end");
  assert.deepEqual(ndviColorFor(0.74, domain), last, "the field maximum is the ramp's high end");
  // Out-of-domain values clamp, they do not extrapolate.
  assert.deepEqual(ndviColorFor(0.1, domain), first);
  assert.deepEqual(ndviColorFor(0.9, domain), last);
});

test("mid-domain colours are exact interpolations of the neighbouring stops", () => {
  // t = (0.5 - 0.32) / (0.74 - 0.32) = 0.4286 → between the 0.3 and 0.55 stops.
  const [r, g, b] = ndviColorFor(0.5, [0.32, 0.74]);
  const lo = NDVI_COLOR_STOPS[1].rgb;
  const hi = NDVI_COLOR_STOPS[2].rgb;
  const local = (0.4285714 - 0.3) / (0.55 - 0.3);
  assert.equal(r, Math.round(lo[0] + (hi[0] - lo[0]) * local));
  assert.equal(g, Math.round(lo[1] + (hi[1] - lo[1]) * local));
  assert.equal(b, Math.round(lo[2] + (hi[2] - lo[2]) * local));
  assert.ok(ndviColorAt(0)[0] > ndviColorAt(1)[0], "the ramp runs warm (bare) → green (dense)");
});

test("the domain is the real min/max, with a floor so uniform noise is not stretched", () => {
  const varied = makeRaster(2, 2, (x) => ({ ndvi: x === 0 ? 0.3 : 0.7, measured: true }));
  assert.deepEqual(ndviColorDomain(varied), [0.3, 0.7]);
  // A 0.01 spread is under the floor: the domain centres on the mean instead.
  const uniform = makeRaster(2, 2, (x) => ({ ndvi: x === 0 ? 0.4 : 0.41, measured: true }));
  const domain = ndviColorDomain(uniform)!;
  assert.ok(Math.abs(domain[0] - 0.395) < 1e-9 && Math.abs(domain[1] - 0.415) < 1e-9);
  // Nothing measured → no domain, no layer.
  const empty = makeRaster(2, 2, () => ({ ndvi: 0.5, measured: false }));
  assert.equal(ndviColorDomain(empty), null);
});

test("the legend gradient is the same ramp the canvas paints", () => {
  const css = ndviLegendGradientCss();
  assert.match(css, /^linear-gradient\(to right,/);
  const [r0, g0, b0] = NDVI_COLOR_STOPS[0].rgb;
  const [r1, g1, b1] = NDVI_COLOR_STOPS[NDVI_COLOR_STOPS.length - 1].rgb;
  assert.ok(css.includes(`rgb(${r0}, ${g0}, ${b0}) 0%`));
  assert.ok(css.includes(`rgb(${r1}, ${g1}, ${b1}) 100%`));
});

/* ------------------------ polygon clipping mask ------------------------ */

test("the clipping mask keeps only pixels whose centre is inside the drawn boundary", () => {
  // A boundary covering the middle half of the bbox: only the 2×2 centre of a
  // 4×4 grid has pixel centres inside it.
  const raster = makeRaster(4, 4, () => ({ ndvi: 0.5, measured: true }));
  raster.bbox = { west: 0, south: 0, east: 4, north: 4 };
  const inset: [number, number][] = [
    [1, 1],
    [3, 1],
    [3, 3],
    [1, 3],
  ];
  const mask = polygonClipMask(inset, raster);
  const rows: string[] = [];
  for (let y = 0; y < 4; y += 1) rows.push(Array.from(mask.slice(y * 4, y * 4 + 4)).join(""));
  // Row 0 is the NORTH edge: pixel centres sit at 12.5 % (outside), 37.5 % /
  // 62.5 % (inside), 87.5 % (outside) of each axis.
  assert.deepEqual(rows, ["0000", "0110", "0110", "0000"], `got ${rows.join(",")}`);
});

test("the measured mask is the intersection of the provider's dataMask and the boundary", () => {
  const raster = makeRaster(4, 4, (x, y) => ({ ndvi: 0.5, measured: !(x === 1 && y === 1) }));
  raster.bbox = { west: 0, south: 0, east: 4, north: 4 };
  const full: [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];
  const mask = measuredPixelMask(full, raster);
  assert.equal(mask.reduce((s, m) => s + m, 0), 15, "the one cloud-masked pixel is excluded");
  assert.equal(mask[1 * 4 + 1], 0);
});

/* ------------------------------ stats ---------------------------------- */

test("stats come from measured pixels only", () => {
  const raster = makeRaster(3, 1, (x) => ({
    ndvi: [0.2, 0.4, 0.8][x],
    measured: x !== 1,
  }));
  const stats = rasterStats(raster);
  assert.equal(stats.count, 2);
  assert.ok(Math.abs((stats.mean as number) - 0.5) < 1e-9);
  assert.equal(stats.min, 0.2);
  assert.equal(stats.max, 0.8);

  const withPolygon = measuredPixelMask(RING, raster);
  const clipped = rasterStats(raster, withPolygon);
  assert.equal(clipped.count, 2, "the same pixels lie inside the boundary");

  const none = rasterStats(makeRaster(2, 1, () => ({ ndvi: 0.5, measured: false })));
  assert.deepEqual(none, { count: 0, mean: null, min: null, max: null });
});

/* --------------------- display composition (bilinear) ------------------ */

test("a masked pixel is never filled: it stays fully transparent", () => {
  const raster = makeRaster(2, 2, (x, y) => ({ ndvi: 0.6, measured: x === 0 && y === 0 }));
  const mask = measuredPixelMask(RING, raster);
  const layer = composeNdviLayer(raster, mask, [0.2, 0.8]);
  let coloured = 0;
  for (let i = 3; i < layer.data.length; i += 4) if (layer.data[i] > 0) coloured += 1;
  assert.ok(coloured > 0, "the measured pixel is painted");
  // Bilinear reaches at most one source pixel beyond the measured one; the
  // far side of the raster (whose four neighbours are ALL masked) can never
  // receive a colour — that would be an estimate.
  const far = (layer.width - 1) * layer.height + (layer.height - 1); // bottom-right output px
  assert.equal(layer.data[far * 4 + 3], 0, "a pixel with no measured neighbour stays transparent");
  // Every coloured pixel shows EXACTLY the measured pixel's colour — the
  // smoothing may fade it towards the edge, never shift its hue.
  const expected = ndviColorFor(0.6, [0.2, 0.8]);
  for (let i = 0; i < layer.data.length; i += 4) {
    if (layer.data[i + 3] === 0) continue;
    assert.deepEqual([layer.data[i], layer.data[i + 1], layer.data[i + 2]], expected);
    assert.ok(layer.data[i + 3] <= Math.round(NDVI_LAYER_ALPHA * 255) + 1);
  }
});

test("an all-measured raster paints every pixel at the layer alpha, blended bilinearly", () => {
  const raster = makeRaster(2, 2, (x, y) => ({ ndvi: [0.25, 0.75, 0.75, 0.25][(y === 0 ? 0 : 2) + x], measured: true }));
  const mask = measuredPixelMask(RING, raster);
  const layer = composeNdviLayer(raster, mask, [0.25, 0.75]);
  assert.equal(layer.data.length % 4, 0);
  const full = Math.round(NDVI_LAYER_ALPHA * 255);
  // Interior pixels (all four neighbours valid) reach the layer alpha exactly.
  const interior = Array.from({ length: layer.width * layer.height }, (_, i) => i).find(
    (i) => layer.data[i * 4 + 3] === full,
  );
  assert.ok(interior !== undefined, "some pixel is fully opaque at the layer alpha");
  // A bilinear blend of different colours stays inside their convex hull.
  const colors = [0.25, 0.75].map((v) => ndviColorFor(v, [0.25, 0.75]));
  for (let i = 0; i < layer.width * layer.height; i += 1) {
    const a = layer.data[i * 4 + 3];
    if (a === 0) continue;
    for (let c = 0; c < 3; c += 1) {
      const lo = Math.min(colors[0][c], colors[1][c]);
      const hi = Math.max(colors[0][c], colors[1][c]);
      assert.ok(
        layer.data[i * 4 + c] >= lo - 1 && layer.data[i * 4 + c] <= hi + 1,
        `channel ${c} of pixel ${i} escapes the source colours`,
      );
    }
  }
});

/* ------------------------------ tap probe ------------------------------ */

test("pixel centres land at their own quarter of the bbox", () => {
  const raster = makeRaster(2, 2, () => ({ ndvi: 0.5, measured: true }));
  raster.bbox = { west: 0, south: 0, east: 1, north: 1 };
  assert.deepEqual(pixelCenter(raster, 0, 0), { lon: 0.25, lat: 0.75 });
  assert.deepEqual(pixelCenter(raster, 1, 1), { lon: 0.75, lat: 0.25 });
});

test("a tap reports the nearest REAL pixel, skipping cloud holes", () => {
  // 3×3, the centre pixel is cloud-masked. One pixel ≈ 30 m in this bbox.
  const raster = makeRaster(3, 3, (x, y) => ({ ndvi: 0.3 + 0.1 * x, measured: !(x === 1 && y === 1) }));
  const mask = measuredPixelMask(RING, raster);
  const centre = pixelCenter(raster, 1, 1);
  assert.equal(pixelAtIsMeasured(raster, mask, centre.lon, centre.lat), false);
  const probe = nearestMeasuredPixel(raster, mask, centre.lon, centre.lat)!;
  assert.ok(probe, "a probe exists even on a cloud hole");
  assert.ok(!(probe.x === 1 && probe.y === 1), "the masked centre is never answered");
  // Adjacent, not the far corner: under one pixel's width away.
  assert.ok(probe.distanceM < 31, `nearest measured pixel is adjacent, got ${probe.distanceM} m`);
  assert.ok(probe.ndvi > 0, "the probe carries the pixel's real value");
  // A tap on a measured pixel answers that pixel itself.
  const northWest = pixelCenter(raster, 0, 0);
  const exact = nearestMeasuredPixel(raster, mask, northWest.lon, northWest.lat)!;
  assert.equal(exact.x, 0);
  assert.equal(exact.y, 0);
  assert.ok(exact.distanceM < 1);
  assert.equal(pixelAtIsMeasured(raster, mask, northWest.lon, northWest.lat), true);
});

test("a raster with no measured pixel answers no probe", () => {
  const raster = makeRaster(2, 2, () => ({ ndvi: 0.5, measured: false }));
  const mask = measuredPixelMask(RING, raster);
  assert.equal(nearestMeasuredPixel(raster, mask, 3.0505, 36.7504), null);
});
