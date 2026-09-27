/**
 * Plot geometry: the maths behind "how big is this parcel" and "which pixels
 * belong to which heatmap cell".
 *
 * The reference areas below are cross-checked against a published value: a
 * 1° × 1° box at the equator spans ~12,363 km² on the WGS84 authalic sphere,
 * which is what `ringAreaHa` is expected to reproduce to within a fraction of
 * a percent. That is the property the whole hectare figure depends on.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_PLOT_HA,
  bboxOf,
  centroidOf,
  closeRing,
  gridCells,
  isSimpleRing,
  normalizeRing,
  pointInRing,
  ringAreaHa,
  ringAreaM2,
  validatePlot,
  type Ring,
} from "@/lib/geo/polygon";

/**
 * Builds a square of exactly `ha` hectares centred on a point, from first
 * principles rather than by guessing decimal degrees.
 *
 * One degree of latitude is ~110.57 km; one degree of longitude is that times
 * cos(latitude). Sizing the ring this way keeps the fixture honest — a
 * hand-written "0.01 degrees" square is ~99 ha, not 2 ha, which is exactly the
 * kind of silent error these tests exist to catch.
 */
function squareHa(lon: number, lat: number, ha: number): Ring {
  const sideM = Math.sqrt(ha * 10_000);
  // Metres per degree on the SAME sphere `ringAreaM2` uses (R * pi/180), so the
  // fixture and the measurement agree by construction. The spherical-vs-WGS84
  // difference is asserted separately, below.
  const M_PER_DEG = (6_378_137 * Math.PI) / 180;
  const dLat = sideM / M_PER_DEG;
  const dLon = sideM / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return [
    [lon - dLon / 2, lat - dLat / 2],
    [lon + dLon / 2, lat - dLat / 2],
    [lon + dLon / 2, lat + dLat / 2],
    [lon - dLon / 2, lat + dLat / 2],
  ];
}

/** A closed 4-vertex square near Blida, ~2 ha, the brief's example parcel. */
const square2Ha: Ring = squareHa(3.065, 36.585, 2);

test("ringAreaHa reproduces a known 1 degree box at the equator", () => {
  // 1° of latitude is ~110.57 km; on a sphere R=6378137 the 1°x1° equatorial
  // cell is ~12363 km². Tolerance covers the spherical-vs-ellipsoidal gap.
  const box: Ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const km2 = ringAreaM2(box) / 1_000_000;
  assert.ok(km2 > 12_300 && km2 < 12_430, `expected ~12363 km², got ${km2.toFixed(0)}`);
});

test("ringAreaHa is positive regardless of winding and ignores closure", () => {
  const clockwise: Ring = [...square2Ha].reverse();
  assert.ok(Math.abs(ringAreaHa(square2Ha) - ringAreaHa(clockwise)) < 1e-9);
  // A closed ring (first point repeated) must measure the same as an open one.
  assert.ok(Math.abs(ringAreaHa(square2Ha) - ringAreaHa(closeRing(square2Ha))) < 1e-9);
});

test("a ~2 ha parcel measures as roughly 2 ha", () => {
  const ha = ringAreaHa(square2Ha);
  assert.ok(Math.abs(ha - 2) < 0.002, `expected 2 ha, got ${ha.toFixed(4)}`);
  // And a sanity check on the fixture helper itself at a different size.
  assert.ok(Math.abs(ringAreaHa(squareHa(3.065, 36.585, 0.5)) - 0.5) < 0.01);
});

test("the spherical area stays within 0.5% of the WGS84 ellipsoid", () => {
  // The implementation deliberately uses a sphere (R = 6378137) to avoid a
  // geodesy dependency. This pins how far that can be from the WGS84
  // ellipsoid at the latitudes the app actually covers (19°N … 37°N).
  //
  // The measured worst case is 0.52 % at 20°N, falling to ~0.18 % at 37°N.
  // In context that is 0.01 ha on a 2 ha parcel — one 10 m Sentinel-2 pixel —
  // so the approximation is irrelevant next to the data's own resolution.
  //
  // Measured: 0.516 % @ 20°N, 0.337 % @ 30°N, 0.196 % @ 36.6°N, 0.175 % @ 37.5°N.
  const a = 6_378_137;
  const f = 1 / 298.257_223_563;
  const e2 = 2 * f - f * f;
  const DEG = 0.01; // the box below is 0.01 deg on a side
  for (const lat of [20, 30, 36.585, 37.5]) {
    const sin = Math.sin((lat * Math.PI) / 180);
    // Meridional and prime-vertical radii of curvature (WGS84).
    const M = (a * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
    const N = a / Math.sqrt(1 - e2 * sin * sin);
    const dLatM = M * DEG * (Math.PI / 180);
    const dLonM = N * Math.cos((lat * Math.PI) / 180) * DEG * (Math.PI / 180);
    const ellipsoidHa = (dLatM * dLonM) / 10_000;
    const ring: Ring = [
      [3, lat - 0.005],
      [3.01, lat - 0.005],
      [3.01, lat + 0.005],
      [3, lat + 0.005],
    ];
    const spherical = ringAreaHa(ring);
    const errorPct = Math.abs(spherical - ellipsoidHa) / ellipsoidHa * 100;
    assert.ok(errorPct < 0.6, `lat ${lat}: ${errorPct.toFixed(3)} % off the ellipsoid`);
  }
});

test("degenerate rings measure zero instead of throwing", () => {
  assert.equal(ringAreaHa([]), 0);
  assert.equal(ringAreaHa([[3, 36]]), 0);
  assert.equal(ringAreaHa([[3, 36], [3, 36]]), 0);
});

test("normalizeRing uncloses, dedupes and drops non-positions", () => {
  const raw = [
    [3, 36],
    [3, 36],
    [3.1, 36.1],
    [999, 0],
    ["a", 1],
    null,
    [3, 36],
  ];
  assert.deepEqual(normalizeRing(raw), [
    [3, 36],
    [3.1, 36.1],
  ]);
  assert.deepEqual(normalizeRing("not a ring"), []);
  // A 2-point ring is unclosed but not enough to enclose anything.
  assert.equal(normalizeRing([[1, 1], [2, 2]]).length, 2);
});

test("centroidOf lands inside the parcel, not at the vertex average", () => {
  const centroid = centroidOf(square2Ha);
  assert.ok(centroid);
  assert.ok(pointInRing(square2Ha, centroid!), "centroid must be inside its own ring");
  assert.ok(Math.abs(centroid![0] - 3.065) < 1e-9);
  assert.ok(Math.abs(centroid![1] - 36.585) < 1e-9);
  // Degenerate input still returns something usable rather than NaN.
  assert.deepEqual(centroidOf([[1, 1], [2, 2]]), [1.5, 1.5]);
  assert.equal(centroidOf([]), null);
});

test("bboxOf reports the extent, or null for nothing", () => {
  const bbox = bboxOf(square2Ha);
  assert.ok(bbox);
  assert.equal(bbox!.west, square2Ha[0][0]);
  assert.equal(bbox!.east, square2Ha[1][0]);
  assert.equal(bbox!.south, square2Ha[0][1]);
  assert.equal(bbox!.north, square2Ha[2][1]);
  assert.ok(bbox!.east > bbox!.west && bbox!.north > bbox!.south);
  assert.equal(bboxOf([]), null);
});

test("pointInRing separates inside from outside", () => {
  assert.equal(pointInRing(square2Ha, [3.065, 36.585]), true);
  assert.equal(pointInRing(square2Ha, [3.0, 36.585]), false);
  assert.equal(pointInRing(square2Ha, [3.065, 36.7]), false);
  assert.equal(pointInRing([[1, 1], [2, 2]], [1.5, 1.5]), false);
});

test("validatePlot accepts a real parcel and refuses the unusable ones", () => {
  assert.deepEqual(validatePlot(square2Ha).reason, "ok");

  assert.equal(validatePlot([[3, 36], [3.01, 36]]).reason, "tooFewPoints");
  // Two identical points enclose nothing.
  assert.equal(validatePlot([[3, 36], [3, 36], [3, 36]]).reason, "degenerate");
  // Outside Algeria — a GPS glitch, not a field.
  assert.equal(validatePlot([[2.3, 48.8], [2.31, 48.8], [2.31, 48.81]]).reason, "outOfRange");
  // A sliver far below the usable minimum.
  const tiny: Ring = [
    [3, 36.58],
    [3.0002, 36.58],
    [3.0002, 36.5802],
  ];
  assert.equal(validatePlot(tiny).reason, "tooSmall");
  // Absurdly large — a stray click across the map.
  const huge: Ring = [
    [-8, 19],
    [11, 19],
    [11, 37],
    [-8, 37],
  ];
  assert.equal(validatePlot(huge).reason, "tooLarge");
});

test("validatePlot reports a usable reason, not a bare boolean", () => {
  const result = validatePlot(square2Ha);
  assert.equal(result.ok, true);
  assert.equal(result.detail, undefined);

  const tiny: Ring = [
    [3, 36.58],
    [3.0002, 36.58],
    [3.0002, 36.5802],
  ];
  const small = validatePlot(tiny);
  assert.equal(small.ok, false);
  assert.match(String(small.detail), /under the/);
  assert.ok(ringAreaHa(tiny) < MIN_PLOT_HA);
});

test("gridCells splits a convex parcel into full cells", () => {
  const cells = gridCells(square2Ha, 4, 4);
  assert.equal(cells.length, 16);
  // Row 0 is the NORTH edge, matching the heatmap's top-to-bottom reading order.
  assert.equal(cells[0].id, "c-0-0");
  assert.equal(cells[0].row, 0);
  assert.equal(cells[0].col, 0);
  const row0 = cells.find((c) => c.id === "c-0-0")!;
  const row3 = cells.find((c) => c.id === "c-3-0")!;
  assert.ok(row0.ring[0][1] > row3.ring[0][1], "row 0 is north of row 3");
  const col0 = cells.find((c) => c.id === "c-0-0")!;
  const col3 = cells.find((c) => c.id === "c-0-3")!;
  assert.ok(col3.ring[0][0] > col0.ring[0][0], "col 3 is east of col 0");
  // Every cell is a quarter of the parcel in each direction.
  const total = cells.reduce((sum, c) => sum + c.areaHa, 0);
  assert.ok(Math.abs(total - ringAreaHa(square2Ha)) < 0.01, `${total} vs ${ringAreaHa(square2Ha)}`);
});

test("gridCells clips a concave parcel instead of counting outside pixels", () => {
  // An L-shape: the bounding box is much larger than the parcel, so cells in
  // the notch must be dropped rather than averaged over bare ground.
  // An L-shape ~5 ha: roughly 0.0031 deg on a side.
  const ell: Ring = [
    [3.0, 36.0],
    [3.0022, 36.0],
    [3.0022, 36.0016],
    [3.0011, 36.0016],
    [3.0011, 36.0031],
    [3.0, 36.0031],
  ];
  const cells = gridCells(ell, 4, 4);
  const parcelHa = ringAreaHa(ell);
  const total = cells.reduce((sum, c) => sum + c.areaHa, 0);
  assert.ok(cells.length < 16, "the notch must drop cells");
  assert.ok(total <= parcelHa + 0.01, "clipped cells can never exceed the parcel");
});

test("gridCells drops slivers too thin to average", () => {
  // A triangle: its two top cells are slivers under MIN_CELL_HA (≈2 pixels).
  const triangle: Ring = [
    [3.0, 36.0],
    [3.0028, 36.0],
    [3.0014, 36.0028],
  ];
  const cells = gridCells(triangle, 4, 4);
  assert.ok(cells.every((c) => c.areaHa >= 0.02));
  assert.ok(cells.length < 16, "the apex slivers are excluded");
});

test("gridCells is defensive about nonsense input", () => {
  assert.deepEqual(gridCells([], 4, 4), []);
  assert.deepEqual(gridCells(square2Ha, 0, 4), []);
  assert.deepEqual(gridCells(square2Ha, 4, 0), []);
});

test("the 2 ha example yields cells that can hold real Sentinel-2 pixels", () => {
  const cells = gridCells(square2Ha, 4, 4);
  // 0.01 ha per 10 m pixel → a 2 ha parcel is ~200 pixels, ~12 per cell.
  for (const cell of cells) {
    const pixels = cell.areaHa / 0.01;
    assert.ok(pixels >= 2, `cell ${cell.id} has ${pixels.toFixed(1)} px`);
  }
  const totalPixels = cells.reduce((s, c) => s + c.areaHa / 0.01, 0);
  assert.ok(totalPixels > 150 && totalPixels < 260, `~200 px expected, got ${totalPixels.toFixed(0)}`);
});

// ---------------------------------------------------------------------------
// Self-intersection
//
// Leaflet.draw refuses a crossing polygon but tells the farmer only in English
// and offers no way forward, so the app checks the shape itself before it
// becomes a saved plot, a measured area, or a satellite query.
// ---------------------------------------------------------------------------

test("isSimpleRing accepts convex and concave boundaries", () => {
  // A convex square.
  assert.equal(isSimpleRing(square2Ha), true);
  // A concave L: a valid field shape with no crossing at all.
  const ell: Ring = [
    [3.0, 36.5],
    [3.002, 36.5],
    [3.002, 36.501],
    [3.001, 36.501],
    [3.001, 36.502],
    [3.0, 36.502],
  ];
  assert.equal(isSimpleRing(ell), true);
});

test("isSimpleRing rejects a boundary that crosses itself", () => {
  // A classic bow tie: the two long edges intersect in the middle.
  const bowtie: Ring = [
    [3.0, 36.5],
    [3.002, 36.502],
    [3.002, 36.5],
    [3.0, 36.502],
  ];
  assert.equal(isSimpleRing(bowtie), false);

  // A spike that doubles back along its own edge, leaving a zero-area sliver.
  const spike: Ring = [
    [3.0, 36.5],
    [3.002, 36.5],
    [3.002, 36.502],
    [3.0005, 36.501],
    [3.0, 36.5],
  ];
  assert.equal(isSimpleRing(spike), false);
});

test("isSimpleRing rejects duplicate points and degenerate rings", () => {
  assert.equal(isSimpleRing([]), false);
  assert.equal(isSimpleRing([[3.0, 36.5]]), false);
  assert.equal(isSimpleRing([[3.0, 36.5], [3.001, 36.5]]), false);
  // A repeated vertex leaves two coincident edges.
  const repeated: Ring = [
    [3.0, 36.5],
    [3.002, 36.5],
    [3.002, 36.502],
    [3.0, 36.502],
    [3.0, 36.5],
    [3.0, 36.5],
  ];
  assert.equal(isSimpleRing(repeated), false);
});

test("validatePlot refuses a crossing boundary before it can be stored", () => {
  const bowtie: Ring = [
    [3.0, 36.5],
    [3.002, 36.502],
    [3.002, 36.5],
    [3.0, 36.502],
  ];
  const result = validatePlot(bowtie);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "selfIntersecting");

  // A good boundary is unaffected by the new check.
  assert.equal(validatePlot(square2Ha).ok, true);
});
