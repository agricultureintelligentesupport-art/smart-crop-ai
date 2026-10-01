/**
 * The client half of the NDVI time series: everything between the series the
 * route returns and the pixels on the Home card — status, change %, the
 * monotone path (no overshoot), the chart geometry, snapping, the tooltip and
 * how a response is interpreted. All of it is pure, so it is all tested here
 * (the card component itself only renders what these functions return).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ndviBand } from "@/lib/agronomy";
import { NDVI_COLOR_STOPS, ndviColorAt } from "@/lib/plot/ndvi-layers";
import {
  areaGradientStops,
  buildChartModel,
  formatChangePct,
  formatCloudPct,
  interpretSeriesResponse,
  linearPath,
  monotonePath,
  monotoneSegments,
  ndviPaletteCss,
  ndviStatus,
  NDVI_BAND_TONE,
  nearestPointIndex,
  neighborByX,
  networkFailureView,
  niceTicks,
  placeTooltip,
  seriesChange,
  shiftDay,
  SMOOTH_MIN_POINTS,
  yDomainFor,
  type BezierSegment,
  type NdviSeriesPoint,
  type XY,
} from "@/lib/satellite/ndvi-series";

/* ---- helpers ------------------------------------------------------ */

/** A point of a Bézier segment at parameter t. */
function bezier(p0: XY, seg: BezierSegment, t: number): XY {
  const u = 1 - t;
  const mix = (a: number, b: number, c: number, d: number) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return {
    x: mix(p0.x, seg.c1.x, seg.c2.x, seg.to.x),
    y: mix(p0.y, seg.c1.y, seg.c2.y, seg.to.y),
  };
}

/** Densely samples the whole curve through `pts`. */
function sampleCurve(pts: XY[], perSegment = 64): { segment: number; x: number; y: number }[] {
  const out: { segment: number; x: number; y: number }[] = [];
  monotoneSegments(pts).forEach((seg, i) => {
    for (let k = 0; k <= perSegment; k += 1) out.push({ segment: i, ...bezier(pts[i], seg, k / perSegment) });
  });
  return out;
}

/** Deterministic pseudo-random numbers (LCG), so a failing property test reproduces. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const EPS = 1e-9;

/* ---- monotone cubic: never leaves the data's range ------------------ */

test("the curve passes through every real point and ends exactly on the last one", () => {
  const pts: XY[] = [
    { x: 0, y: 50 },
    { x: 40, y: 20 },
    { x: 90, y: 70 },
    { x: 130, y: 35 },
  ];
  const segments = monotoneSegments(pts);
  assert.equal(segments.length, pts.length - 1);
  segments.forEach((seg, i) => assert.deepEqual(seg.to, pts[i + 1]));
  const path = monotonePath(pts);
  assert.match(path, /^M0 50C/);
  assert.equal((path.match(/C/g) ?? []).length, 3);
  assert.ok(path.endsWith("130 35"));
});

test("no overshoot: between two real points the curve never leaves their range", () => {
  // The classic Catmull-Rom/cubic-spline failure: a step. Ours must stay inside [0, 1].
  const step: XY[] = [0, 0, 0, 1, 1, 1].map((y, i) => ({ x: i * 10, y }));
  for (const s of sampleCurve(step)) {
    assert.ok(s.y >= -EPS && s.y <= 1 + EPS, `y=${s.y} left [0, 1]`);
  }
  // A spike and a trough: no value above the peak or below the trough is ever drawn.
  const zigzag: XY[] = [0.2, 0.8, 0.3, 0.5, 0.1, 0.45].map((y, i) => ({ x: i * 17, y }));
  const curve = sampleCurve(zigzag);
  for (const s of curve) {
    const a = zigzag[s.segment].y;
    const b = zigzag[s.segment + 1].y;
    assert.ok(s.y >= Math.min(a, b) - EPS && s.y <= Math.max(a, b) + EPS, `segment ${s.segment}: y=${s.y} outside [${a}, ${b}]`);
  }
  assert.ok(Math.max(...curve.map((s) => s.y)) <= 0.8 + EPS);
  assert.ok(Math.min(...curve.map((s) => s.y)) >= 0.1 - EPS);
});

test("no overshoot holds for any series: 200 random ones, both axis directions", () => {
  const next = rng(20261001);
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 2 + Math.floor(next() * 14);
    let x = 0;
    const raw = Array.from({ length: n }, () => {
      x += 3 + next() * 40; // uneven calendar gaps
      return { x, y: next() * 100 };
    });
    const direction = trial % 2 === 0 ? 1 : -1; // RTL draws x decreasing
    const pts = raw.map((p) => ({ x: direction * p.x, y: p.y }));
    const lo = Math.min(...pts.map((p) => p.y));
    const hi = Math.max(...pts.map((p) => p.y));
    let previousX: number | null = null;
    for (const s of sampleCurve(pts, 24)) {
      const a = pts[s.segment].y;
      const b = pts[s.segment + 1].y;
      assert.ok(s.y >= Math.min(a, b) - 1e-7 && s.y <= Math.max(a, b) + 1e-7, `trial ${trial} segment ${s.segment}: ${s.y} outside [${a}, ${b}]`);
      assert.ok(s.y >= lo - 1e-7 && s.y <= hi + 1e-7, `trial ${trial}: left the data range`);
      // x only ever moves forward, so the curve is a function of time (no loops).
      if (previousX !== null && s.segment === 0) assert.ok((s.x - previousX) * direction >= -1e-9);
      previousX = s.x;
    }
  }
});

test("between two neighbours the curve is monotone: rising data never dips, falling never rises", () => {
  const rising: XY[] = [0.1, 0.15, 0.4, 0.45, 0.9].map((y, i) => ({ x: i * 25, y }));
  const ys = sampleCurve(rising).map((s) => s.y);
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] >= ys[i - 1] - EPS, `dip at sample ${i}`);
  const falling = rising.map((p) => ({ x: p.x, y: -p.y }));
  const fy = sampleCurve(falling).map((s) => s.y);
  for (let i = 1; i < fy.length; i += 1) assert.ok(fy[i] <= fy[i - 1] + EPS, `rise at sample ${i}`);
});

test("a local peak or trough gets a flat tangent, so the curve cannot go past it", () => {
  const pts: XY[] = [0.3, 0.7, 0.4].map((y, i) => ({ x: i * 30, y }));
  const [rise, fall] = monotoneSegments(pts);
  assert.equal(rise.c2.y, 0.7, "arrives at the peak horizontally");
  assert.equal(fall.c1.y, 0.7, "leaves the peak horizontally");
});

test("the curve is mirror-safe: drawing right-to-left gives the same shape reflected", () => {
  const values = [0.2, 0.6, 0.5, 0.9];
  const ltr: XY[] = values.map((y, i) => ({ x: i * 20, y }));
  const rtl: XY[] = values.map((y, i) => ({ x: 60 - i * 20, y }));
  const a = sampleCurve(ltr, 8);
  const b = sampleCurve(rtl, 8);
  assert.equal(a.length, b.length);
  a.forEach((s, i) => {
    assert.ok(Math.abs(s.y - b[i].y) < 1e-9);
    assert.ok(Math.abs(60 - s.x - b[i].x) < 1e-9);
  });
});

test("one point is a bare M, two points are a straight line, none is empty", () => {
  assert.equal(monotonePath([]), "");
  assert.equal(monotonePath([{ x: 5, y: 7 }]), "M5 7");
  assert.deepEqual(monotoneSegments([{ x: 5, y: 7 }]), []);
  const [seg] = monotoneSegments([
    { x: 0, y: 0 },
    { x: 30, y: 60 },
  ]);
  assert.deepEqual(seg.c1, { x: 10, y: 20 });
  assert.deepEqual(seg.c2, { x: 20, y: 40 });
  assert.equal(linearPath([]), "");
  assert.equal(
    linearPath([
      { x: 0, y: 1 },
      { x: 2, y: 3 },
      { x: 4, y: 0 },
    ]),
    "M0 1L2 3L4 0",
  );
});

test("coincident x (it cannot happen on a calendar axis) is survived without NaN", () => {
  const path = monotonePath([
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 20, y: 5 },
  ]);
  assert.ok(!/NaN|Infinity/.test(path), path);
});

/* ---- change % ------------------------------------------------------ */

test("change is the latest real mean against the first real mean", () => {
  const up = seriesChange([{ mean: 0.4 }, { mean: 0.5 }]);
  assert.ok(up);
  assert.ok(Math.abs(up.pct - 25) < 1e-9);
  assert.equal(up.direction, "up");
  assert.equal(formatChangePct(up), "+25%");

  const down = seriesChange([{ mean: 0.5 }, { mean: 0.4 }]);
  assert.ok(down);
  assert.ok(Math.abs(down.pct + 20) < 1e-9);
  assert.equal(down.direction, "down");
  assert.equal(formatChangePct(down), "−20%");
});

test("only the first and the last real points count", () => {
  const change = seriesChange([{ mean: 0.4 }, { mean: 0.95 }, { mean: 0.1 }, { mean: 0.6 }]);
  assert.ok(change);
  assert.ok(Math.abs(change.pct - 50) < 1e-9);
});

test("fewer than two real points: no change is reported at all", () => {
  assert.equal(seriesChange([]), null);
  assert.equal(seriesChange([{ mean: 0.5 }]), null);
});

test("a first mean of zero or below has no relative change", () => {
  assert.equal(seriesChange([{ mean: 0 }, { mean: 0.4 }]), null);
  assert.equal(seriesChange([{ mean: -0.1 }, { mean: 0.4 }]), null);
});

test("a change that rounds to 0% is flat, not an arrow", () => {
  const flat = seriesChange([{ mean: 0.5 }, { mean: 0.5019 }]); // +0.38 %
  assert.ok(flat);
  assert.equal(flat.direction, "flat");
  assert.equal(formatChangePct(flat), "0%");
  const barely = seriesChange([{ mean: 0.5 }, { mean: 0.4981 }]);
  assert.ok(barely);
  assert.equal(barely.direction, "flat");
  assert.equal(formatChangePct(barely), "0%", "never \"-0%\"");
});

test("cloud cover reads honestly: a trace of cloud is never rounded to a perfectly clear 0%", () => {
  assert.equal(formatCloudPct(0), "0%");
  assert.equal(formatCloudPct(0.4), "<1%");
  assert.equal(formatCloudPct(0.99), "<1%");
  assert.equal(formatCloudPct(1), "1%");
  assert.equal(formatCloudPct(12.4), "12%");
  assert.equal(formatCloudPct(96.04), "96%");
  assert.equal(formatCloudPct(100), "100%");
});

/* ---- status: the app's existing NDVI bands ------------------------- */

test("the status chip is exactly the existing ndviBand — no thresholds of its own", () => {
  for (let v = -0.2; v <= 1.1; v += 0.001) {
    assert.equal(ndviStatus(v).band, ndviBand(v), `v=${v.toFixed(3)}`);
  }
});

test("the band boundaries are the ones the app already uses (0.35 / 0.55 / 0.72)", () => {
  assert.equal(ndviStatus(0.349).band, "poor");
  assert.equal(ndviStatus(0.35).band, "fair");
  assert.equal(ndviStatus(0.549).band, "fair");
  assert.equal(ndviStatus(0.55).band, "good");
  assert.equal(ndviStatus(0.719).band, "good");
  assert.equal(ndviStatus(0.72).band, "excellent");
});

test("poor/fair are amber and good/excellent are emerald, as on the previous card", () => {
  assert.deepEqual({ ...NDVI_BAND_TONE }, { poor: "amber", fair: "amber", good: "emerald", excellent: "emerald" });
  assert.equal(ndviStatus(0.2).tone, "amber");
  assert.equal(ndviStatus(0.8).tone, "emerald");
});

/* ---- snapping ------------------------------------------------------ */

test("a touch snaps to the nearest REAL point", () => {
  const xs = [30, 80, 210, 260];
  assert.equal(nearestPointIndex(xs, 0), 0);
  assert.equal(nearestPointIndex(xs, 54), 0);
  assert.equal(nearestPointIndex(xs, 56), 1);
  assert.equal(nearestPointIndex(xs, 140), 1, "the gap between 80 and 210 is split at 145");
  assert.equal(nearestPointIndex(xs, 150), 2);
  assert.equal(nearestPointIndex(xs, 999), 3);
});

test("snapping works on a right-to-left axis (x decreasing with time)", () => {
  const xs = [260, 210, 80, 30];
  assert.equal(nearestPointIndex(xs, 255), 0);
  assert.equal(nearestPointIndex(xs, 100), 2);
  assert.equal(nearestPointIndex(xs, -50), 3);
});

test("a tie goes to the earlier point, and no points means nothing to snap to", () => {
  assert.equal(nearestPointIndex([10, 30], 20), 0);
  assert.equal(nearestPointIndex([], 5), -1);
});

test("snapping never returns anything but an existing index, for any x", () => {
  const xs = [14, 52, 61, 130, 207, 280];
  for (let x = -40; x < 340; x += 0.5) {
    const i = nearestPointIndex(xs, x);
    assert.ok(i >= 0 && i < xs.length);
    const distance = Math.abs(xs[i] - x);
    assert.ok(xs.every((other) => Math.abs(other - x) >= distance - 1e-9), `x=${x}`);
  }
});

test("arrow keys move to the neighbour on screen, whichever way time runs", () => {
  const ltr = [30, 80, 210];
  assert.equal(neighborByX(ltr, 1, 1), 2);
  assert.equal(neighborByX(ltr, 1, -1), 0);
  assert.equal(neighborByX(ltr, 2, 1), 2, "stays on the last point");
  assert.equal(neighborByX(ltr, 0, -1), 0, "stays on the first point");
  const rtl = [210, 80, 30];
  assert.equal(neighborByX(rtl, 1, 1), 0, "to the right on screen is the OLDER point in RTL");
  assert.equal(neighborByX(rtl, 1, -1), 2);
  assert.equal(neighborByX(rtl, 5, 1), 5, "an out-of-range start is left alone");
});

/* ---- y range and ticks ---------------------------------------------- */

test("the y range is the real min/max plus padding", () => {
  const [lo, hi] = yDomainFor([0.31, 0.52, 0.74]);
  assert.ok(lo < 0.31 && hi > 0.74, "padded on both sides");
  assert.ok(Math.abs(lo - (0.31 - 0.086)) < 1e-6);
  assert.ok(Math.abs(hi - (0.74 + 0.086)) < 1e-6);
});

test("a flat or single-point series is not zoomed into its noise", () => {
  for (const values of [[0.62], [0.62, 0.62, 0.621]]) {
    const [lo, hi] = yDomainFor(values);
    assert.ok(hi - lo >= 0.2 - 1e-9, `span ${hi - lo}`);
    assert.ok(lo < 0.62 && hi > 0.62);
  }
});

test("the y range stays inside the physical NDVI range by shifting, not squashing", () => {
  const [lo, hi] = yDomainFor([0.93, 0.97]);
  assert.equal(hi, 1);
  assert.ok(lo >= -1 && hi - lo >= 0.2 - 1e-9);
  const [lo2, hi2] = yDomainFor([-0.95, -0.9]);
  assert.equal(lo2, -1);
  assert.ok(hi2 - lo2 >= 0.2 - 1e-9);
});

test("gridlines land on round values inside the range, at most four", () => {
  for (const [lo, hi] of [
    [0.224, 0.826],
    [0.52, 0.72],
    [0.31, 0.51],
    [-0.2, 0.6],
    [0.9, 1],
  ] as [number, number][]) {
    const ticks = niceTicks(lo, hi);
    assert.ok(ticks.length >= 1 && ticks.length <= 4, `${lo}..${hi}: ${ticks.join(",")}`);
    for (const t of ticks) assert.ok(t >= lo - 1e-9 && t <= hi + 1e-9);
  }
  assert.deepEqual(niceTicks(0.224, 0.826), [0.4, 0.6, 0.8]);
});

/* ---- chart geometry ------------------------------------------------- */

const pointOf = (date: string, mean: number, cloud: number | null = null): NdviSeriesPoint => ({
  date,
  mean,
  min: mean - 0.1,
  max: mean + 0.1,
  sampleCount: 100,
  cloudCoverPct: cloud,
});

const FROM = "2026-09-02";
const TO = "2026-10-01";
const POINTS = [pointOf("2026-09-04", 0.31), pointOf("2026-09-09", 0.36, 12), pointOf("2026-09-19", 0.52), pointOf("2026-09-24", 0.58), pointOf("2026-09-29", 0.63, 0.4)];
const CLOUDY = [
  { date: "2026-09-06", cloudCoverPct: 96 },
  { date: "2026-09-14", cloudCoverPct: null },
];
const model = (rtl: boolean, points = POINTS, width = 296) =>
  buildChartModel({ points, cloudyDates: CLOUDY, from: FROM, to: TO, width, height: 148, rtl });

test("one dot per real observation — nothing is added between them", () => {
  const m = model(false);
  assert.equal(m.points.length, POINTS.length);
  assert.deepEqual(
    m.points.map((p) => p.date),
    POINTS.map((p) => p.date),
  );
  assert.deepEqual(
    m.points.map((p) => p.value),
    POINTS.map((p) => p.mean),
  );
  assert.equal(m.cloudy.length, CLOUDY.length);
});

test("x is the calendar position in the 30-day window, so real gaps stay visible", () => {
  const m = model(false);
  const w = m.plot.right - m.plot.left;
  const xOf = (date: string) => m.points.find((p) => p.date === date)?.x ?? NaN;
  // 29 days span the window; 2026-09-04 is day 2, 2026-09-19 is day 17.
  assert.ok(Math.abs(xOf("2026-09-04") - (m.plot.left + (2 / 29) * w)) < 0.01);
  assert.ok(Math.abs(xOf("2026-09-19") - (m.plot.left + (17 / 29) * w)) < 0.01);
  // Gaps are proportional to the calendar (5, 10, 5, 5 days), not evenly spaced.
  const gaps = m.points.slice(1).map((p, i) => p.x - m.points[i].x);
  assert.ok(gaps[0] > 0 && Math.abs(gaps[0] / gaps[2] - 5 / 5) < 0.01 && gaps[1] > gaps[0], gaps.join(","));
});

test("right-to-left mirrors the axis: oldest on the right, newest on the left", () => {
  const ltr = model(false);
  const rtl = model(true);
  rtl.points.forEach((p, i) => {
    assert.ok(Math.abs(p.x + ltr.points[i].x - 296) < 0.02, `point ${i} mirrors about the middle`);
    assert.equal(p.y, ltr.points[i].y, "heights do not change");
  });
  assert.ok(rtl.points[0].x > rtl.points[rtl.points.length - 1].x, "the oldest point is to the right of the newest");
  assert.ok(ltr.points[0].x < ltr.points[ltr.points.length - 1].x);
  // The y labels sit on the start side: right in RTL, left in LTR.
  assert.ok(rtl.plot.right < 296 - 12 && rtl.plot.left === 12);
  assert.ok(ltr.plot.left > 12 && ltr.plot.right === 296 - 12);
});

test("every dot sits inside the plot area, and the extremes touch the padded range", () => {
  for (const rtl of [false, true]) {
    const m = model(rtl);
    for (const p of m.points) {
      assert.ok(p.y >= m.plot.top && p.y <= m.plot.bottom, `y=${p.y}`);
      assert.ok(p.x >= m.plot.left - 0.01 && p.x <= m.plot.right + 0.01, `x=${p.x}`);
    }
    const [lo, hi] = m.yDomain;
    assert.ok(lo < 0.31 && hi > 0.63);
  }
});

test("the drawn path never leaves the range of the dots, whatever the data", () => {
  const next = rng(42);
  for (let trial = 0; trial < 60; trial += 1) {
    const count = 3 + Math.floor(next() * 10);
    const days = new Set<number>();
    while (days.size < count) days.add(Math.floor(next() * 30));
    const points = [...days]
      .sort((a, b) => a - b)
      .map((d) => pointOf(shiftDay(FROM, d), Math.round((0.1 + next() * 0.8) * 1000) / 1000));
    const m = buildChartModel({ points, cloudyDates: [], from: FROM, to: TO, width: 320, height: 148, rtl: trial % 2 === 0 });
    const ys = m.points.map((p) => p.y);
    const numbers = [...m.linePath.matchAll(/-?\d+(?:\.\d+)?/g)].map((n) => Number(n[0]));
    // Path numbers alternate x, y — every y (control points included) is inside the dots' own range.
    const pathYs = numbers.filter((_, i) => i % 2 === 1);
    assert.ok(pathYs.length >= points.length);
    for (const y of pathYs) {
      assert.ok(y >= Math.min(...ys) - 0.011 && y <= Math.max(...ys) + 0.011, `trial ${trial}: y=${y}`);
    }
    assert.equal(m.sparse, false);
  }
});

test("fewer than three real points: straight segments, flagged sparse, no curve commands", () => {
  assert.equal(SMOOTH_MIN_POINTS, 3);
  const two = model(false, POINTS.slice(0, 2));
  assert.equal(two.sparse, true);
  assert.ok(!two.linePath.includes("C"));
  assert.match(two.linePath, /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
  const one = model(false, POINTS.slice(0, 1));
  assert.equal(one.sparse, true);
  assert.match(one.linePath, /^M[\d.]+ [\d.]+$/);
  const three = model(false, POINTS.slice(0, 3));
  assert.equal(three.sparse, false);
  assert.ok(three.linePath.includes("C"));
});

test("the area closes down to the baseline", () => {
  const m = model(false);
  assert.ok(m.areaPath.startsWith(m.linePath));
  assert.ok(m.areaPath.endsWith("Z"));
  assert.ok(m.areaPath.includes(`L${m.points[m.points.length - 1].x} ${m.plot.bottom}`));
  assert.ok(m.areaPath.includes(`L${m.points[0].x} ${m.plot.bottom}Z`));
});

test("the date axis has weekly ticks counted back from today", () => {
  const m = model(false);
  assert.deepEqual(
    m.xTicks.map((t) => t.date),
    ["2026-10-01", "2026-09-24", "2026-09-17", "2026-09-10", "2026-09-03"],
  );
  assert.ok(Math.abs(m.xTicks[0].x - (m.plot.left + m.plot.right - m.plot.left)) < 0.01, "today is the end of the axis");
  const rtl = model(true);
  assert.ok(rtl.xTicks[0].x < rtl.xTicks[4].x, "right-to-left: today is on the left");
});

test("cloudy dates sit on the axis row, at their own calendar position", () => {
  const m = model(false);
  assert.deepEqual(
    m.cloudy.map((c) => c.date),
    ["2026-09-06", "2026-09-14"],
  );
  assert.ok(m.markerY > m.plot.bottom);
  const w = m.plot.right - m.plot.left;
  assert.ok(Math.abs(m.cloudy[0].x - (m.plot.left + (4 / 29) * w)) < 0.01);
  assert.equal(m.cloudy[0].cloudCoverPct, 96);
  assert.equal(m.cloudy[1].cloudCoverPct, null);
  assert.ok(m.cloudy.every((c) => !m.points.some((p) => p.date === c.date)), "a cloudy date is never also a dot");
});

test("an empty series builds an empty chart without throwing", () => {
  const m = model(false, []);
  assert.equal(m.points.length, 0);
  assert.equal(m.linePath, "");
  assert.equal(m.areaPath, "");
  assert.deepEqual(m.yTicks, []);
});

/* ---- palette --------------------------------------------------------- */

test("dot and area colours come from the fixed NDVI palette, by absolute NDVI value", () => {
  for (const v of [0, 0.15, 0.3, 0.55, 0.8, 1]) {
    const [r, g, b] = ndviColorAt(v);
    assert.equal(ndviPaletteCss(v), `rgb(${r}, ${g}, ${b})`);
  }
  assert.equal(ndviPaletteCss(0), "rgb(154, 103, 60)", "bare soil is the palette's first stop");
  assert.equal(ndviPaletteCss(1), "rgb(11, 78, 52)", "dense canopy is its last");
});

test("the area gradient uses only palette colours, top (high NDVI) to baseline (low), fading out", () => {
  const stops = areaGradientStops([0.31, 0.74]);
  assert.ok(stops.length >= 3);
  assert.equal(stops[0].offset, 0);
  assert.equal(stops[stops.length - 1].offset, 1);
  assert.equal(stops[0].color, ndviPaletteCss(0.74));
  assert.equal(stops[stops.length - 1].color, ndviPaletteCss(0.31));
  const insideValues = NDVI_COLOR_STOPS.map((s) => s.at).filter((at) => at > 0.31 && at < 0.74);
  for (const at of insideValues) assert.ok(stops.some((s) => s.color === ndviPaletteCss(at)), `palette stop ${at} is in the gradient`);
  for (let i = 1; i < stops.length; i += 1) {
    assert.ok(stops[i].offset >= stops[i - 1].offset);
    assert.ok(stops[i].opacity < stops[i - 1].opacity, "fades toward the baseline");
  }
  assert.deepEqual(areaGradientStops([0.5, 0.5]), []);
});

/* ---- tooltip --------------------------------------------------------- */

test("the tooltip sits above its point, clamped inside the chart, and flips below near the top", () => {
  const base = { tipWidth: 124, tipHeight: 56, boxWidth: 296, boxHeight: 148 };
  const middle = placeTooltip({ ...base, x: 150, y: 100 });
  assert.equal(middle.placement, "above");
  assert.equal(middle.left, 150 - 62);
  assert.equal(middle.top, 100 - 12 - 56);

  assert.equal(placeTooltip({ ...base, x: 4, y: 100 }).left, 2, "clamped to the left edge");
  assert.equal(placeTooltip({ ...base, x: 295, y: 100 }).left, 296 - 124 - 2, "clamped to the right edge");

  const flipped = placeTooltip({ ...base, x: 150, y: 30 });
  assert.equal(flipped.placement, "below");
  assert.equal(flipped.top, 42);
  const cramped = placeTooltip({ ...base, x: 150, y: 140 });
  assert.equal(cramped.placement, "above");
});

/* ---- reading the route's answer --------------------------------------- */

const okBody = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  cached: false,
  from: FROM,
  to: TO,
  points: POINTS,
  cloudyDates: CLOUDY,
  fetchedAt: "2026-10-01T14:20:00.000Z",
  ...extra,
});

test("a good answer is passed through untouched", () => {
  const view = interpretSeriesResponse(200, okBody({ cached: true }));
  assert.equal(view.kind, "ready");
  if (view.kind !== "ready") return;
  assert.equal(view.cached, true);
  assert.deepEqual(view.series.points, POINTS, "points are not sorted, filled or clamped on the way");
  assert.deepEqual(view.series.cloudyDates, CLOUDY);
  assert.equal(view.series.from, FROM);
});

test("cloud info that cannot be trusted becomes unknown, not empty", () => {
  const view = interpretSeriesResponse(200, okBody({ cloudyDates: null }));
  assert.equal(view.kind === "ready" && view.series.cloudyDates, null);
});

test("an answer that is not exactly the documented shape is malformed — never a half-drawn chart", () => {
  const broken: [string, unknown][] = [
    ["not JSON", null],
    ["a string", "hello"],
    ["no points", okBody({ points: [] })],
    ["points not an array", okBody({ points: "x" })],
    ["a NaN mean", okBody({ points: [{ ...POINTS[0], mean: Number.NaN }] })],
    ["a missing min", okBody({ points: [{ date: "2026-09-04", mean: 0.3, max: 0.4, sampleCount: 5, cloudCoverPct: null }] })],
    ["a bad date", okBody({ points: [{ ...POINTS[0], date: "04/09/2026" }] })],
    ["unsorted dates", okBody({ points: [POINTS[1], POINTS[0]] })],
    ["a repeated date", okBody({ points: [POINTS[0], POINTS[0]] })],
    ["no window", okBody({ from: undefined })],
  ];
  for (const [name, body] of broken) {
    const view = interpretSeriesResponse(200, body);
    assert.equal(view.kind, "error", name);
    if (view.kind === "error") {
      assert.equal(view.reason, "malformed", name);
      assert.match(view.technical, /^ndvi-series · HTTP 200 · /, name);
    }
  }
});

test("empty-series is its own state, with the masked passes", () => {
  const view = interpretSeriesResponse(200, {
    ok: false,
    reason: "empty-series",
    technical: "empty-series · 2026-09-02..2026-10-01 · 30 day(s), none with a usable pixel, 2 masked pass(es)",
    window: { from: FROM, to: TO },
    cloudyDates: CLOUDY,
  });
  assert.equal(view.kind, "empty");
  if (view.kind !== "empty") return;
  assert.deepEqual(view.cloudyDates, CLOUDY);
  assert.equal(view.from, FROM);
  assert.match(view.technical, /^empty-series/);
  const bare = interpretSeriesResponse(200, { ok: false, reason: "empty-series", technical: "x", cloudyDates: null });
  assert.equal(bare.kind === "empty" && bare.cloudyDates.length, 0, "unknown passes read as none to list, never invented");
});

test("a failure keeps its reason, status and technical line", () => {
  const view = interpretSeriesResponse(200, {
    ok: false,
    reason: "quota",
    status: 429,
    technical: "sh-statistics · sh.dataspace.copernicus.eu · HTTP 429 · RATE_LIMIT: slow down",
  });
  assert.deepEqual(view, {
    kind: "error",
    reason: "quota",
    status: 429,
    technical: "sh-statistics · sh.dataspace.copernicus.eu · HTTP 429 · RATE_LIMIT: slow down",
  });
});

test("a 400 invalid-input answer is an error with the exact condition", () => {
  const view = interpretSeriesResponse(400, {
    ok: false,
    reason: "invalid-input",
    technical: "validate · invalid-input: the boundary crosses itself",
    message: "the boundary crosses itself",
  });
  assert.equal(view.kind, "error");
  if (view.kind === "error") {
    assert.equal(view.reason, "invalid-input");
    assert.equal(view.status, 400);
  }
});

test("an unknown reason degrades to http, and a long technical line is cut to 150 characters", () => {
  const view = interpretSeriesResponse(502, { ok: false, reason: "gremlins", technical: "x".repeat(400) });
  assert.equal(view.kind, "error");
  if (view.kind === "error") {
    assert.equal(view.reason, "http");
    assert.equal(view.technical.length, 150);
  }
  const bare = interpretSeriesResponse(502, { ok: false });
  assert.equal(bare.kind === "error" && bare.technical, "ndvi-series · HTTP 502");
});

test("a request that never got an answer is a network or timeout failure with a technical line", () => {
  const offline = networkFailureView(new TypeError("Failed to fetch"), false);
  assert.deepEqual(offline, { kind: "error", reason: "network", status: null, technical: "ndvi-series · no response · TypeError: Failed to fetch" });
  const slow = networkFailureView(new DOMException("aborted", "AbortError"), true);
  assert.equal(slow.kind === "error" && slow.reason, "timeout");
  assert.equal(slow.kind === "error" && slow.technical, "ndvi-series · no response · timed out");
  const unknown = networkFailureView("x", false);
  assert.equal(unknown.kind === "error" && unknown.technical, "ndvi-series · no response · request failed");
});
