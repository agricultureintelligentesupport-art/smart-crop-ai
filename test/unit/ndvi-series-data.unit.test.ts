/**
 * The data half of the NDVI time series (`lib/satellite/ndvi-series.ts`):
 * the 30-day window, the Statistical API request, parsing the answer, the
 * geometry hash + 12 h cache, and request validation.
 *
 * The rule under test everywhere: a date is in the series only if Sentinel-2
 * produced a usable pixel over the plot — nothing is ever filled or estimated.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Ring } from "@/lib/geo/polygon";
import {
  BAD_SCL_CLASSES,
  buildStatisticsRequest,
  canonicalRingKey,
  coalesce,
  DEFAULT_STATISTICS_URL,
  dayDiff,
  geometryHash,
  mergeSeries,
  NDVI_STATISTICS_EVALSCRIPT,
  NdviSeriesCache,
  parseSeriesRequest,
  parseStatistics,
  reasonForHttpStatus,
  seriesCacheKey,
  SERIES_CACHE_TTL_MS,
  SERIES_MAX_RING_POINTS,
  seriesWindow,
  shiftDay,
  statisticsUrlFrom,
  utcDay,
  type NdviSeriesPayload,
  type NdviSeriesPoint,
} from "@/lib/satellite/ndvi-series";
import { EVALSCRIPT } from "@/lib/satellite/sentinelhub";

/* ---- fixtures ---------------------------------------------------- */

/** ≈ 58.3 m square next to Biskra ≈ 0.34 ha, counter-clockwise (lon = x, lat = y). */
const SIDE_M = 58.3;
const DLON = SIDE_M / (111_320 * Math.cos((34.85 * Math.PI) / 180));
const DLAT = SIDE_M / 110_574;
const CCW: Ring = [
  [5.72, 34.85],
  [5.72 + DLON, 34.85],
  [5.72 + DLON, 34.85 + DLAT],
  [5.72, 34.85 + DLAT],
];
const CW: Ring = [...CCW].reverse();

const NOW = Date.parse("2026-10-01T14:20:00Z");

const interval = (day: string, stats: Record<string, unknown>) => ({
  interval: { from: `${day}T00:00:00Z`, to: `${shiftDay(day, 1)}T00:00:00Z` },
  outputs: { ndvi: { bands: { B0: { stats } } } },
});
/** A day Sentinel-2 measured: 120 grid pixels, 20 of them no-data → 100 usable. */
const clear = (day: string, mean: number, min = mean - 0.1, max = mean + 0.1, sampleCount = 120, noDataCount = 20) =>
  interval(day, { min, max, mean, stDev: 0.05, sampleCount, noDataCount });
/** A day with nothing usable: the API reports "NaN" strings and every pixel as no-data. */
const masked = (day: string) =>
  interval(day, { min: "NaN", max: "NaN", mean: "NaN", stDev: "NaN", sampleCount: 120, noDataCount: 120 });

/* ---- window ------------------------------------------------------ */

test("the window is the 30 UTC days ending today, with tomorrow's midnight as the open end", () => {
  const w = seriesWindow(NOW);
  assert.equal(w.to, "2026-10-01");
  assert.equal(w.from, "2026-09-02");
  assert.equal(dayDiff(w.from, w.to) + 1, 30, "30 daily intervals, today included");
  assert.equal(w.timeFrom, "2026-09-02T00:00:00Z");
  // Open end = the midnight AFTER today, else the trailing partial interval (today) is skipped.
  assert.equal(w.timeTo, "2026-10-02T00:00:00Z");
});

test("the window follows the UTC calendar, not the local one", () => {
  assert.equal(seriesWindow(Date.parse("2026-10-01T23:59:59Z")).to, "2026-10-01");
  assert.equal(seriesWindow(Date.parse("2026-10-02T00:00:00Z")).to, "2026-10-02");
  assert.equal(utcDay(Date.parse("2026-12-31T23:30:00Z")), "2026-12-31");
});

test("the window crosses month and year boundaries and leap days correctly", () => {
  assert.equal(seriesWindow(Date.parse("2027-01-10T08:00:00Z")).from, "2026-12-12");
  // 29 days before 1 March: 1 Feb in a leap year (29-day February), 31 Jan otherwise.
  assert.equal(seriesWindow(Date.parse("2028-03-01T08:00:00Z")).from, "2028-02-01");
  assert.equal(seriesWindow(Date.parse("2026-03-01T08:00:00Z")).from, "2026-01-31");
  assert.equal(shiftDay("2028-02-28", 2), "2028-03-01");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
});

/* ---- evalscript -------------------------------------------------- */

const lineOf = (script: string, needle: string): string => {
  const line = script.split("\n").find((l) => l.includes(needle));
  assert.ok(line, `missing "${needle}"`);
  return line.trim();
};

test("the statistics evalscript reuses the existing NDVI logic unchanged", () => {
  // Same SCL exclusion list, same band sum, same validity rule, same formula.
  assert.equal(lineOf(NDVI_STATISTICS_EVALSCRIPT, "var bad ="), lineOf(EVALSCRIPT, "var bad ="));
  assert.equal(lineOf(NDVI_STATISTICS_EVALSCRIPT, "var sum ="), lineOf(EVALSCRIPT, "var sum ="));
  assert.equal(lineOf(NDVI_STATISTICS_EVALSCRIPT, "var valid ="), lineOf(EVALSCRIPT, "var valid ="));
  assert.ok(NDVI_STATISTICS_EVALSCRIPT.includes("(s.B08 - s.B04) / sum"));
  assert.ok(EVALSCRIPT.includes("(s.B08 - s.B04) / sum"));
  assert.deepEqual([...BAD_SCL_CLASSES], [1, 3, 8, 9, 10, 11]);
  assert.match(NDVI_STATISTICS_EVALSCRIPT, /input: \[\{ bands: \["B04", "B08", "SCL", "dataMask"\] \}\]/);
});

test("the statistics evalscript has the outputs the Statistical API requires", () => {
  assert.match(NDVI_STATISTICS_EVALSCRIPT, /^\/\/VERSION=3/);
  assert.match(NDVI_STATISTICS_EVALSCRIPT, /\{ id: "ndvi", bands: 1, sampleType: "FLOAT32" \}/);
  assert.match(NDVI_STATISTICS_EVALSCRIPT, /\{ id: "dataMask", bands: 1 \}/);
  assert.match(NDVI_STATISTICS_EVALSCRIPT, /dataMask: \[valid\]/);
});

/* ---- request ----------------------------------------------------- */

test("the statistics request is one P1D aggregation over the plot polygon", () => {
  const window = seriesWindow(NOW);
  const bbox = { west: 5.72, south: 34.85, east: 5.72 + DLON, north: 34.85 + DLAT };
  const request = buildStatisticsRequest({ ring: CCW, bbox, width: 6, height: 6, window }) as {
    input: {
      bounds: { bbox: number[]; geometry: { type: string; coordinates: number[][][] }; properties: { crs: string } };
      data: { type: string; dataFilter: Record<string, unknown> }[];
    };
    aggregation: Record<string, unknown>;
  };
  assert.deepEqual(request.input.bounds.bbox, [bbox.west, bbox.south, bbox.east, bbox.north]);
  assert.equal(request.input.bounds.geometry.type, "Polygon");
  const ring = request.input.bounds.geometry.coordinates[0];
  assert.equal(ring.length, CCW.length + 1, "the polygon is closed");
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(request.input.bounds.properties.crs, "http://www.opengis.net/def/crs/EPSG/0/4326");
  assert.equal(request.input.data[0].type, "sentinel-2-l2a");
  assert.equal("timeRange" in request.input.data[0].dataFilter, false, "the Statistical API takes the range from `aggregation`");
  assert.deepEqual(request.aggregation.timeRange, { from: "2026-09-02T00:00:00Z", to: "2026-10-02T00:00:00Z" });
  assert.deepEqual(request.aggregation.aggregationInterval, { of: "P1D" });
  assert.equal(request.aggregation.evalscript, NDVI_STATISTICS_EVALSCRIPT);
  assert.equal(request.aggregation.width, 6);
  assert.equal(request.aggregation.height, 6);
});

test("the Statistical API URL is derived from the process URL (both CDSE path styles)", () => {
  assert.equal(statisticsUrlFrom("https://sh.dataspace.copernicus.eu/api/v1/process"), "https://sh.dataspace.copernicus.eu/api/v1/statistics");
  assert.equal(statisticsUrlFrom("https://sh.dataspace.copernicus.eu/process/v1"), "https://sh.dataspace.copernicus.eu/statistics/v1");
  assert.equal(statisticsUrlFrom("https://sh.dataspace.copernicus.eu/process/v1/"), "https://sh.dataspace.copernicus.eu/statistics/v1");
  assert.equal(statisticsUrlFrom("https://proxy.example.org/custom"), "https://proxy.example.org/api/v1/statistics");
  assert.equal(statisticsUrlFrom("not a url"), DEFAULT_STATISTICS_URL);
});

/* ---- parsing: drop empty dates, never fill ------------------------ */

test("a date with no usable pixel is dropped, never filled", () => {
  const parsed = parseStatistics({
    data: [clear("2026-09-04", 0.41), masked("2026-09-05"), masked("2026-09-06"), clear("2026-09-09", 0.52), masked("2026-09-10")],
    status: "OK",
  });
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.points.map((p) => p.date),
    ["2026-09-04", "2026-09-09"],
  );
  assert.equal(parsed.intervals, 5);
  assert.equal(parsed.withoutUsablePixels, 3);
  // No date between the two real ones was invented, and no value was blended.
  assert.deepEqual(
    parsed.points.map((p) => p.mean),
    [0.41, 0.52],
  );
});

test("30 daily intervals with 5 clear days give exactly 5 points", () => {
  const window = seriesWindow(NOW);
  const clearDays = new Map([
    ["2026-09-04", 0.31],
    ["2026-09-09", 0.36],
    ["2026-09-19", 0.52],
    ["2026-09-24", 0.58],
    ["2026-09-29", 0.63],
  ]);
  const data = Array.from({ length: 30 }, (_, i) => {
    const day = shiftDay(window.from, i);
    const mean = clearDays.get(day);
    return mean === undefined ? masked(day) : clear(day, mean);
  });
  const parsed = parseStatistics({ data });
  assert.ok(parsed.ok);
  assert.equal(parsed.intervals, 30);
  assert.equal(parsed.points.length, 5);
  assert.deepEqual(
    parsed.points.map((p) => p.date),
    [...clearDays.keys()],
  );
});

test("usable pixels are sampleCount minus noDataCount, and min/mean/max pass through", () => {
  const parsed = parseStatistics({ data: [clear("2026-09-04", 0.4123456, 0.2, 0.7, 150, 38)] });
  assert.ok(parsed.ok);
  const [p] = parsed.points;
  assert.equal(p.sampleCount, 112);
  assert.equal(p.mean, 0.412, "rounded to 3 decimals (finer than Sentinel-2's own quantisation)");
  assert.equal(p.min, 0.2);
  assert.equal(p.max, 0.7);
  assert.equal(p.cloudCoverPct, null, "cloud cover comes from the Catalog, merged later");
});

test("an interval whose only pixels are masked never contributes, whatever its stats say", () => {
  // "NaN" strings, or even finite-looking numbers, are ignored when nothing is usable.
  const parsed = parseStatistics({ data: [interval("2026-09-04", { min: 0, max: 0, mean: 0, sampleCount: 40, noDataCount: 40 })] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.points, []);
  assert.equal(parsed.withoutUsablePixels, 1);
});

test("a window with no usable pixel at all parses to an empty series", () => {
  const parsed = parseStatistics({ data: [masked("2026-09-04"), masked("2026-09-05")] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.points, []);
  assert.equal(parsed.intervals, 2);
});

test("points are sorted oldest to newest and one per date", () => {
  const parsed = parseStatistics({ data: [clear("2026-09-20", 0.5), clear("2026-09-04", 0.3), clear("2026-09-04", 0.31)] });
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.points.map((p) => p.date),
    ["2026-09-04", "2026-09-20"],
  );
  assert.equal(parsed.points[0].mean, 0.31, "a repeated date keeps one entry");
});

test("another output id or band key is tolerated; dataMask is never read as NDVI", () => {
  const stats = { min: 0.3, max: 0.5, mean: 0.4, sampleCount: 10, noDataCount: 0 };
  const parsed = parseStatistics({
    data: [
      {
        interval: { from: "2026-09-04T00:00:00Z" },
        outputs: { dataMask: { bands: { B0: { stats: { mean: 1, min: 1, max: 1, sampleCount: 10, noDataCount: 0 } } } }, index: { bands: { value: { stats } } } },
      },
    ],
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.points[0].mean, 0.4);
});

test("an unreadable answer is malformed, never a silent gap", () => {
  const bad: [string, unknown][] = [
    ["null", null],
    ["a string", "oops"],
    ["no data array", { status: "OK" }],
    ["data is not an array", { data: {} }],
    ["an interval without a start", { data: [{ outputs: {} }] }],
    ["an interval with a bad start", { data: [{ interval: { from: "yesterday" }, outputs: {} }] }],
    ["an interval without statistics", { data: [{ interval: { from: "2026-09-04T00:00:00Z" } }] }],
    ["missing sample counts", { data: [interval("2026-09-04", { mean: 0.4, min: 0.3, max: 0.5 })] }],
    ["usable pixels but a NaN mean", { data: [interval("2026-09-04", { mean: "NaN", min: 0.3, max: 0.5, sampleCount: 10, noDataCount: 0 })] }],
    ["usable pixels but no min", { data: [interval("2026-09-04", { mean: 0.4, max: 0.5, sampleCount: 10, noDataCount: 0 })] }],
    ["NDVI above 1", { data: [interval("2026-09-04", { mean: 1.4, min: 0.3, max: 1.5, sampleCount: 10, noDataCount: 0 })] }],
    ["NDVI below -1", { data: [interval("2026-09-04", { mean: -1.2, min: -1.3, max: 0, sampleCount: 10, noDataCount: 0 })] }],
  ];
  for (const [name, payload] of bad) {
    const parsed = parseStatistics(payload);
    assert.equal(parsed.ok, false, name);
    if (!parsed.ok) assert.ok(parsed.detail.length > 0, name);
  }
});

/* ---- merge with the Catalog -------------------------------------- */

const pointOf = (date: string, mean: number): NdviSeriesPoint => ({
  date,
  mean,
  min: mean - 0.1,
  max: mean + 0.1,
  sampleCount: 100,
  cloudCoverPct: null,
});

test("scene cloud cover is joined to real points; passes with no real point are the cloudy dates", () => {
  const window = seriesWindow(NOW);
  const merged = mergeSeries({
    window,
    points: [pointOf("2026-09-04", 0.4), pointOf("2026-09-09", 0.5)],
    scenes: [
      { date: "2026-09-04", cloudCoverPct: 3.14 },
      { date: "2026-09-06", cloudCoverPct: 96.04 },
      { date: "2026-09-09", cloudCoverPct: null },
      { date: "2026-09-14", cloudCoverPct: null },
      { date: "2026-08-01", cloudCoverPct: 80 }, // outside the window
    ],
    fetchedAt: "2026-10-01T14:20:00.000Z",
  });
  assert.deepEqual(
    merged.points.map((p) => [p.date, p.cloudCoverPct]),
    [
      ["2026-09-04", 3.1],
      ["2026-09-09", null],
    ],
  );
  assert.deepEqual(merged.cloudyDates, [
    { date: "2026-09-06", cloudCoverPct: 96 },
    { date: "2026-09-14", cloudCoverPct: null },
  ]);
  assert.equal(merged.from, "2026-09-02");
  assert.equal(merged.to, "2026-10-01");
  assert.equal(merged.points.length, 2, "merging adds no points");
});

test("an unreachable Catalog leaves cloud info UNKNOWN (null), not empty", () => {
  const merged = mergeSeries({ window: seriesWindow(NOW), points: [pointOf("2026-09-04", 0.4)], scenes: null, fetchedAt: "x" });
  assert.equal(merged.cloudyDates, null);
  assert.equal(merged.points[0].cloudCoverPct, null);
});

test("HTTP statuses map to the same reasons the Process API client uses", () => {
  const table: [number, string][] = [
    [401, "auth"],
    [403, "auth"],
    [402, "quota"],
    [429, "quota"],
    [408, "timeout"],
    [504, "timeout"],
    [400, "http"],
    [404, "http"],
    [500, "http"],
    [503, "http"],
  ];
  for (const [status, reason] of table) assert.equal(reasonForHttpStatus(status), reason, String(status));
});

/* ---- request validation ------------------------------------------ */

test("clockwise and counter-clockwise boundaries are both accepted, and normalised to counter-clockwise", () => {
  const a = parseSeriesRequest({ ring: CCW });
  const b = parseSeriesRequest({ ring: CW });
  assert.ok(a.ok && b.ok);
  const signed = (ring: Ring) => ring.reduce((sum, [x1, y1], i) => sum + (x1 * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y1), 0);
  assert.ok(signed(a.ring) > 0);
  assert.ok(signed(b.ring) > 0, "the clockwise input was reversed");
});

test("a closed ring and a bare array are understood", () => {
  const closed = parseSeriesRequest({ ring: [...CCW, CCW[0]] });
  assert.ok(closed.ok);
  assert.equal(closed.ring.length, CCW.length, "the repeated closing point is dropped");
  const bare = parseSeriesRequest(CW);
  assert.ok(bare.ok);
});

test("the existing validators reject what is not a field, with the exact condition", () => {
  const cases: [string, unknown, RegExp][] = [
    ["no body", undefined, /request body must be/],
    ["a string", "ring", /request body must be/],
    ["no ring", {}, /request body must be/],
    ["a ring that is not an array", { ring: "x" }, /request body must be/],
    ["two points", { ring: CCW.slice(0, 2) }, /2 usable point\(s\), at least 3/],
    ["junk entries are not counted", { ring: [CCW[0], "a", null, { lon: 1 }, CCW[1]] }, /2 usable point\(s\)/],
    ["outside Algeria", { ring: CCW.map(([lon, lat]) => [lon + 20, lat]) }, /outside Algeria/],
    ["a bow-tie", { ring: [[5.72, 34.85], [5.7215, 34.8515], [5.7215, 34.85], [5.72, 34.8515]] }, /crosses itself/],
    ["a speck under 0.05 ha", { ring: [[5.72, 34.85], [5.7201, 34.85], [5.7201, 34.8501]] }, /under the 0\.05 ha minimum/],
    ["a whole district (over 50 ha)", { ring: [[5.7, 34.8], [5.75, 34.8], [5.75, 34.85], [5.7, 34.85]] }, /over the 50 ha maximum/],
  ];
  for (const [name, body, pattern] of cases) {
    const parsed = parseSeriesRequest(body);
    assert.equal(parsed.ok, false, name);
    if (!parsed.ok) assert.match(parsed.detail, pattern, name);
  }
});

test("an absurdly long ring is refused before any geometry work", () => {
  const ring = Array.from({ length: SERIES_MAX_RING_POINTS + 1 }, (_, i) => [5.72 + i * 1e-6, 34.85]);
  const parsed = parseSeriesRequest({ ring });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.detail, /at most 500/);
});

/* ---- geometry hash + cache key ----------------------------------- */

test("the canonical geometry is the same whichever way the field was drawn", () => {
  const key = canonicalRingKey(CCW);
  assert.ok(key.length > 0);
  assert.equal(canonicalRingKey(CW), key, "clockwise equals counter-clockwise");
  for (let shift = 1; shift < CCW.length; shift += 1) {
    assert.equal(canonicalRingKey([...CCW.slice(shift), ...CCW.slice(0, shift)]), key, `rotated by ${shift}`);
  }
  assert.equal(canonicalRingKey([...CCW, CCW[0]]), key, "a closed ring keys like an open one");
});

test("the canonical geometry ignores sub-metre noise but separates different fields", () => {
  const jitter: Ring = CCW.map(([lon, lat]) => [lon + 2e-7, lat - 3e-7]);
  assert.equal(canonicalRingKey(jitter), canonicalRingKey(CCW));
  const moved: Ring = CCW.map(([lon, lat]) => [lon + 1e-3, lat]);
  assert.notEqual(canonicalRingKey(moved), canonicalRingKey(CCW));
});

test("a longitude that rounds to zero keys identically from either side of the meridian", () => {
  const east: Ring = [[0.000004, 35], [0.0009, 35], [0.0009, 35.0009], [0.000004, 35.0009]];
  const west: Ring = east.map(([lon, lat]) => [lon === 0.000004 ? -0.000004 : lon, lat]);
  assert.equal(canonicalRingKey(east), canonicalRingKey(west));
});

test("the geometry hash is a stable 128-bit SHA-256 prefix of the canonical key", async () => {
  const hash = await geometryHash(CCW);
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.equal(hash, createHash("sha256").update(canonicalRingKey(CCW)).digest("hex").slice(0, 32));
  assert.equal(await geometryHash(CW), hash);
  assert.notEqual(await geometryHash(CCW.map(([lon, lat]) => [lon + 1e-3, lat])), hash);
});

test("the cache key is per (geometry, day)", async () => {
  const today = await seriesCacheKey(CCW, "2026-10-01");
  assert.equal(await seriesCacheKey(CW, "2026-10-01"), today, "clockwise and counter-clockwise share an entry");
  assert.notEqual(await seriesCacheKey(CCW, "2026-10-02"), today, "a new day is a new entry");
  assert.match(today, /^[0-9a-f]{32}:2026-10-01$/);
});

/* ---- 12 h cache --------------------------------------------------- */

const payload = (n = 2): NdviSeriesPayload => ({
  from: "2026-09-02",
  to: "2026-10-01",
  points: Array.from({ length: n }, (_, i) => pointOf(shiftDay("2026-09-04", i), 0.4 + i / 10)),
  cloudyDates: [],
  fetchedAt: "2026-10-01T14:20:00.000Z",
});

test("the TTL is 12 hours", () => {
  assert.equal(SERIES_CACHE_TTL_MS, 12 * 60 * 60 * 1000);
});

test("a cached series is served until 12 h have passed, then it is gone", () => {
  const cache = new NdviSeriesCache();
  const t0 = NOW;
  assert.equal(cache.get("k", t0), null, "miss before any set");
  cache.set("k", payload(), t0);
  assert.equal(cache.get("k", t0)?.points.length, 2);
  assert.ok(cache.get("k", t0 + SERIES_CACHE_TTL_MS - 1), "still fresh 1 ms before the TTL");
  assert.equal(cache.get("k", t0 + SERIES_CACHE_TTL_MS), null, "expired exactly at the TTL");
  assert.equal(cache.size, 0, "an expired entry is evicted on read");
});

test("setting a key again restarts its TTL", () => {
  const cache = new NdviSeriesCache();
  cache.set("k", payload(), NOW);
  cache.set("k", payload(3), NOW + 6 * 3_600_000);
  assert.equal(cache.get("k", NOW + 13 * 3_600_000)?.points.length, 3);
});

test("a failure is never cached: an empty series is refused by the cache itself", () => {
  const cache = new NdviSeriesCache();
  cache.set("k", { ...payload(), points: [] }, NOW);
  assert.equal(cache.size, 0);
  assert.equal(cache.get("k", NOW), null);
});

test("the cache is bounded: the oldest entries go first", () => {
  const cache = new NdviSeriesCache({ maxEntries: 3 });
  for (const key of ["a", "b", "c", "d"]) cache.set(key, payload(), NOW);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a", NOW), null, "the oldest was evicted");
  assert.ok(cache.get("d", NOW));
  cache.clear();
  assert.equal(cache.size, 0);
});

test("expired entries are dropped before a live one is evicted", () => {
  const cache = new NdviSeriesCache({ maxEntries: 2, ttlMs: 1000 });
  cache.set("old", payload(), 0);
  cache.set("fresh", payload(), 900);
  cache.set("new", payload(), 1500); // "old" expired at 1000, so "fresh" survives
  assert.ok(cache.get("fresh", 1500));
  assert.ok(cache.get("new", 1500));
});

/* ---- in-flight coalescing ---------------------------------------- */

test("concurrent identical jobs share one run; the next one after it settles starts fresh", async () => {
  const inFlight = new Map<string, Promise<number>>();
  let runs = 0;
  const work = async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return runs;
  };
  const [a, b] = await Promise.all([coalesce(inFlight, "k", work), coalesce(inFlight, "k", work)]);
  assert.equal(runs, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(inFlight.size, 0);
  assert.equal(await coalesce(inFlight, "k", work), 2);
});

test("a failed job leaves nothing behind, so a retry runs again", async () => {
  const inFlight = new Map<string, Promise<string>>();
  await assert.rejects(coalesce(inFlight, "k", async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(inFlight.size, 0);
  assert.equal(await coalesce(inFlight, "k", async () => "ok"), "ok");
});
