/**
 * `POST /api/ndvi-series` end to end with a mocked Copernicus: token →
 * Statistical API ∥ Catalog → merged real series.
 *
 * Pinned here: the exact upstream requests, that a date with no usable pixel
 * never appears, the 12 h cache (clockwise = counter-clockwise, per day, never
 * for failures), the failure reasons, the trace log format and that no secret
 * ever leaves the server. The live CDSE cannot be reached from CI, so this
 * suite is what keeps the request shape honest.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server";
import { dynamic, maxDuration, POST, runtime } from "../../src/app/api/ndvi-series/route";
import { bboxOf, type Ring } from "@/lib/geo/polygon";
import { resetTokenCache } from "@/lib/satellite/openeo";
import {
  NDVI_STATISTICS_EVALSCRIPT,
  seriesWindow,
  sharedSeriesCache,
  shiftDay,
  SERIES_CACHE_TTL_MS,
} from "@/lib/satellite/ndvi-series";
import { buildCatalogRequest, rasterSizeFor } from "@/lib/satellite/sentinelhub";

/* ---- fixtures ---------------------------------------------------- */

const SECRET = "super-secret-value";
const CLIENT_ID = "sh-test-client";
const TOKEN = "tok-abc-123";

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
const WINDOW = seriesWindow(NOW);

const ENV_KEYS = [
  "CDSE_CLIENT_ID",
  "CDSE_CLIENT_SECRET",
  "CDSE_TOKEN_URL",
  "CDSE_PROCESS_URL",
  "CDSE_CATALOG_URL",
  "CDSE_TIMEOUT_MS",
  "CDSE_USE_OPENEO",
  "CDSE_USE_GRID",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const statsInterval = (day: string, stats: Record<string, unknown>) => ({
  interval: { from: `${day}T00:00:00Z`, to: `${shiftDay(day, 1)}T00:00:00Z` },
  outputs: { ndvi: { bands: { B0: { stats } } } },
});

/** Sentinel-2 measured these days (mean NDVI); every other day of the window has nothing usable. */
const CLEAR_DAYS: [string, number][] = [
  ["2026-09-04", 0.31],
  ["2026-09-09", 0.36],
  ["2026-09-19", 0.52],
  ["2026-09-24", 0.58],
  ["2026-09-29", 0.63],
];

function statisticsAnswer(clear: [string, number][] = CLEAR_DAYS) {
  const means = new Map(clear);
  return {
    status: "OK",
    data: Array.from({ length: 30 }, (_, i) => {
      const day = shiftDay(WINDOW.from, i);
      const mean = means.get(day);
      return mean === undefined
        ? statsInterval(day, { min: "NaN", max: "NaN", mean: "NaN", stDev: "NaN", sampleCount: 120, noDataCount: 120 })
        : statsInterval(day, { min: mean - 0.1, max: mean + 0.1, mean, stDev: 0.04, sampleCount: 120, noDataCount: 20 });
    }),
  };
}

/** Every pass of the window the Catalog knows: the five clear days plus three masked ones. */
const CATALOG_PASSES: [string, number][] = [
  ["2026-09-04", 3.14],
  ["2026-09-06", 96.04],
  ["2026-09-09", 12],
  ["2026-09-14", 88],
  ["2026-09-19", 5],
  ["2026-09-24", 1.2],
  ["2026-09-29", 0.4],
  ["2026-10-01", 99],
];
const catalogAnswer = (passes: [string, number][] = CATALOG_PASSES) => ({
  type: "FeatureCollection",
  features: passes.map(([date, cloud]) => ({ properties: { datetime: `${date}T10:15:00Z`, "eo:cloud_cover": cloud } })),
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}
interface Upstream {
  token?: () => Response | Promise<Response>;
  statistics?: (init: RequestInit) => Response | Promise<Response>;
  catalog?: (init: RequestInit) => Response | Promise<Response>;
}

/** The handlers the single `fetch` mock (installed in `beforeEach`) dispatches to; `null` = nothing may be called. */
let upstream: Upstream | null = null;

/** Routes `fetch` by URL to `handlers` and records every call. Calling it again swaps the handlers and the call log. */
function installUpstream(handlers: Upstream = {}): Call[] {
  const calls: Call[] = [];
  upstream = handlers;
  recorded = calls;
  return calls;
}
let recorded: Call[] = [];

/** Every `console.log` line of the running test (the route's trace lines), kept out of the TAP output. */
const logLines: string[] = [];
const captureLogs = (): string[] => logLines;

const request = (body: unknown, raw = false) =>
  new NextRequest("http://localhost:3000/api/ndvi-series", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body),
  });

const callsTo = (calls: Call[], fragment: string) => calls.filter((c) => c.url.includes(fragment));

beforeEach(() => {
  process.env.CDSE_CLIENT_ID = CLIENT_ID;
  process.env.CDSE_CLIENT_SECRET = SECRET;
  for (const key of ENV_KEYS.slice(2)) delete process.env[key];
  resetTokenCache();
  sharedSeriesCache().clear();
  mock.timers.enable({ apis: ["Date"], now: NOW });
  logLines.length = 0;
  mock.method(console, "log", (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
  // Nothing may reach the network unless a test installs an upstream.
  upstream = null;
  recorded = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!upstream) throw new Error(`unexpected upstream request: ${url}`);
    recorded.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? "") });
    if (url.includes("identity.dataspace.copernicus.eu")) {
      return upstream.token ? upstream.token() : json({ access_token: TOKEN, expires_in: 600 });
    }
    if (url.endsWith("/api/v1/statistics")) return upstream.statistics ? upstream.statistics(init) : json(statisticsAnswer());
    if (url.endsWith("/api/v1/catalog/1.0.0/search")) return upstream.catalog ? upstream.catalog(init) : json(catalogAnswer());
    throw new Error(`unexpected upstream request: ${url}`);
  });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetTokenCache();
  sharedSeriesCache().clear();
});

/* ---- route config ------------------------------------------------ */

test("the route is dynamic, Node-run and has a bounded duration", () => {
  assert.equal(dynamic, "force-dynamic");
  assert.equal(runtime, "nodejs");
  assert.ok(maxDuration > 0 && maxDuration <= 60);
});

/* ---- invalid input ------------------------------------------------ */

test("a body that is not JSON is a 400 invalid-input and reaches no upstream", async () => {
  const calls = installUpstream();
  const res = await POST(request("{not json", true));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "invalid-input");
  assert.match(body.technical, /^validate · invalid-input: request body is not valid JSON/);
  assert.equal(calls.length, 0);
});

test("an oversized body is refused before it is read, and reaches no upstream", async () => {
  const calls = installUpstream();
  const big = new NextRequest("http://localhost:3000/api/ndvi-series", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(70 * 1024) },
    body: JSON.stringify({ ring: CCW }),
  });
  const res = await POST(big);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.reason, "invalid-input");
  assert.match(body.message, /larger than 64 KB/);
  assert.equal(calls.length, 0);
  // A normal body still goes through.
  assert.equal((await POST(request({ ring: CCW }))).status, 200);
});

test("a boundary the existing validators reject is a 400 with the exact condition", async () => {
  const calls = installUpstream();
  const cases: [unknown, RegExp][] = [
    [{ ring: CCW.slice(0, 2) }, /2 usable point\(s\), at least 3/],
    [{ ring: CCW.map(([lon, lat]) => [lon + 20, lat]) }, /outside Algeria/],
    [{ ring: [[5.72, 34.85], [5.7215, 34.8515], [5.7215, 34.85], [5.72, 34.8515]] }, /crosses itself/],
    [{}, /request body must be/],
  ];
  for (const [body, pattern] of cases) {
    const res = await POST(request(body));
    assert.equal(res.status, 400);
    const answer = await res.json();
    assert.equal(answer.reason, "invalid-input");
    assert.match(answer.message, pattern);
    assert.match(answer.technical, /^validate · invalid-input: /);
  }
  assert.equal(calls.length, 0, "a local check failed before any request was made");
});

test("without CDSE credentials the answer is notConfigured, with no upstream call and nothing cached", async () => {
  delete process.env.CDSE_CLIENT_ID;
  delete process.env.CDSE_CLIENT_SECRET;
  const calls = installUpstream();
  const res = await POST(request({ ring: CCW }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "notConfigured");
  assert.equal(calls.length, 0);
  assert.equal(sharedSeriesCache().size, 0);
});

/* ---- the happy path ----------------------------------------------- */

test("a real series: only the days Sentinel-2 measured, with the exact upstream requests", async () => {
  const calls = installUpstream();
  const res = await POST(request({ ring: CW }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.cached, false);
  assert.equal(body.from, "2026-09-02");
  assert.equal(body.to, "2026-10-01");
  // The five measured days and NOTHING else: 25 empty days are neither filled nor reported as points.
  assert.deepEqual(
    body.points.map((p: { date: string }) => p.date),
    CLEAR_DAYS.map(([date]) => date),
  );
  assert.deepEqual(
    body.points.map((p: { mean: number }) => p.mean),
    CLEAR_DAYS.map(([, mean]) => mean),
  );
  const first = body.points[0];
  assert.deepEqual(
    { mean: first.mean, min: first.min, max: first.max, sampleCount: first.sampleCount, cloudCoverPct: first.cloudCoverPct },
    { mean: 0.31, min: 0.21, max: 0.41, sampleCount: 100, cloudCoverPct: 3.1 },
  );
  // Passes with no usable pixel are the cloudy dates (including today's).
  assert.deepEqual(body.cloudyDates, [
    { date: "2026-09-06", cloudCoverPct: 96 },
    { date: "2026-09-14", cloudCoverPct: 88 },
    { date: "2026-10-01", cloudCoverPct: 99 },
  ]);

  // ---- upstream: one token, one Statistical API call, one Catalog call ----
  assert.equal(calls.length, 3);
  const [stats] = callsTo(calls, "/api/v1/statistics");
  assert.equal(stats.url, "https://sh.dataspace.copernicus.eu/api/v1/statistics");
  assert.equal(stats.headers.authorization, `Bearer ${TOKEN}`);
  const sent = JSON.parse(stats.body);
  assert.deepEqual(sent.aggregation.timeRange, { from: "2026-09-02T00:00:00Z", to: "2026-10-02T00:00:00Z" });
  assert.deepEqual(sent.aggregation.aggregationInterval, { of: "P1D" });
  assert.equal(sent.aggregation.evalscript, NDVI_STATISTICS_EVALSCRIPT);
  assert.equal(sent.input.data[0].type, "sentinel-2-l2a");
  const bbox = bboxOf(CCW);
  assert.ok(bbox);
  assert.deepEqual(sent.input.bounds.bbox, [bbox.west, bbox.south, bbox.east, bbox.north]);
  const { width, height } = rasterSizeFor(bbox, 10);
  assert.equal(sent.aggregation.width, width);
  assert.equal(sent.aggregation.height, height);
  const polygon: number[][] = sent.input.bounds.geometry.coordinates[0];
  assert.deepEqual(polygon[0], polygon[polygon.length - 1], "the polygon is closed");
  assert.deepEqual(polygon.slice(0, -1), CCW, "the clockwise body was sent counter-clockwise");

  const [catalog] = callsTo(calls, "/catalog/1.0.0/search");
  assert.equal(catalog.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(catalog.body), buildCatalogRequest(bbox, "2026-09-02", "2026-10-01"));
});

test("every step is traced as one greppable line, and no secret appears anywhere", async () => {
  installUpstream();
  const logs = captureLogs();
  const res = await POST(request({ ring: CCW }));
  const text = JSON.stringify(await res.json());

  const line = (step: string) => logs.find((l) => l.includes(`step=${step} `));
  assert.match(line("cdse-token") ?? "", /^\[field-data\] route=ndvi-series geo=[0-9a-f]{8} step=cdse-token host=identity\.dataspace\.copernicus\.eu status=200 ok=true ms=\d+$/);
  assert.match(line("sh-statistics") ?? "", /step=sh-statistics host=sh\.dataspace\.copernicus\.eu status=200 ok=true message="30 day\(s\), 5 with usable pixels, 25 without" ms=\d+$/);
  assert.match(line("sh-catalog") ?? "", /step=sh-catalog host=sh\.dataspace\.copernicus\.eu status=200 ok=true message="8 pass\(es\) in 2026-09-02\.\.2026-10-01" ms=\d+$/);
  assert.match(line("result") ?? "", /step=result ok=true points=5 cloudy=3 cached=false ms=\d+$/);
  for (const forbidden of [SECRET, TOKEN, "Bearer "]) {
    assert.ok(!logs.some((l) => l.includes(forbidden)), `logs leak ${forbidden}`);
    assert.ok(!text.includes(forbidden), `response leaks ${forbidden}`);
  }
});

/* ---- 12 h cache ---------------------------------------------------- */

test("the same field drawn the other way round is served from the cache without any upstream call", async () => {
  const calls = installUpstream();
  const logs = captureLogs();
  const first = await (await POST(request({ ring: CCW }))).json();
  assert.equal(first.cached, false);
  const upstreamCalls = calls.length;

  const second = await (await POST(request({ ring: CW }))).json();
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.deepEqual(second.points, first.points);
  assert.equal(calls.length, upstreamCalls, "no new upstream request");
  assert.ok(logs.some((l) => /step=cache ok=true note="hit" points=5 ms=\d+$/.test(l)));
});

test("a different field is a different cache entry", async () => {
  const calls = installUpstream();
  await POST(request({ ring: CCW }));
  const moved = CCW.map(([lon, lat]): [number, number] => [lon + 0.01, lat]);
  const other = await (await POST(request({ ring: moved }))).json();
  assert.equal(other.cached, false);
  assert.equal(callsTo(calls, "/api/v1/statistics").length, 2);
});

test("the cache expires after 12 hours", async () => {
  mock.timers.setTime(Date.parse("2026-10-01T00:30:00Z"));
  const calls = installUpstream();
  await POST(request({ ring: CCW }));
  assert.equal(callsTo(calls, "/api/v1/statistics").length, 1);

  mock.timers.setTime(Date.parse("2026-10-01T00:30:00Z") + SERIES_CACHE_TTL_MS - 60_000);
  assert.equal((await (await POST(request({ ring: CCW }))).json()).cached, true, "11 h 59 min later: still cached");

  mock.timers.setTime(Date.parse("2026-10-01T00:30:00Z") + SERIES_CACHE_TTL_MS);
  const later = await (await POST(request({ ring: CCW }))).json();
  assert.equal(later.cached, false, "12 h later: read again");
  assert.equal(callsTo(calls, "/api/v1/statistics").length, 2);
});

test("the cache is per day: after midnight (UTC) the window moves and the series is read again", async () => {
  mock.timers.setTime(Date.parse("2026-10-01T23:50:00Z"));
  const calls = installUpstream();
  await POST(request({ ring: CCW }));
  mock.timers.setTime(Date.parse("2026-10-02T00:10:00Z"));
  const next = await (await POST(request({ ring: CCW }))).json();
  assert.equal(next.cached, false, "20 minutes later but a new day");
  assert.equal(next.to, "2026-10-02");
  const sent = JSON.parse(callsTo(calls, "/api/v1/statistics")[1].body);
  assert.equal(sent.aggregation.timeRange.to, "2026-10-03T00:00:00Z");
});

/* ---- failures are never cached ------------------------------------ */

test("a failure is never cached: the next request goes upstream again and can succeed", async () => {
  let statisticsStatus = 503;
  const calls = installUpstream({
    statistics: () => (statisticsStatus === 200 ? json(statisticsAnswer()) : json({ error: { status: statisticsStatus, message: "overloaded" } }, statisticsStatus)),
  });
  const failed = await (await POST(request({ ring: CCW }))).json();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "http");
  assert.equal(failed.status, 503);
  assert.equal(sharedSeriesCache().size, 0, "nothing stored for a failure");

  statisticsStatus = 200;
  const recovered = await (await POST(request({ ring: CCW }))).json();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.cached, false, "the outage was not pinned");
  assert.equal(callsTo(calls, "/api/v1/statistics").length, 2);

  assert.equal((await (await POST(request({ ring: CCW }))).json()).cached, true, "the success IS cached");
});

test("an empty series is a failure and is not cached", async () => {
  const calls = installUpstream({ statistics: () => json(statisticsAnswer([])) });
  const res = await POST(request({ ring: CCW }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "empty-series");
  assert.deepEqual(body.window, { from: "2026-09-02", to: "2026-10-01" });
  assert.equal(body.cloudyDates.length, 8, "every pass over the plot was masked");
  assert.match(body.technical, /^empty-series · 2026-09-02\.\.2026-10-01 · 30 day\(s\), none with a usable pixel, 8 masked pass\(es\)$/);
  assert.equal(sharedSeriesCache().size, 0);
  await POST(request({ ring: CCW }));
  assert.equal(callsTo(calls, "/api/v1/statistics").length, 2, "asked again, not served from a cache");
});

/* ---- failure reasons ----------------------------------------------- */

test("an upstream HTTP error maps to a reason, keeps its status and says which step failed", async () => {
  const table: [number, string][] = [
    [401, "auth"],
    [403, "auth"],
    [402, "quota"],
    [429, "quota"],
    [408, "timeout"],
    [504, "timeout"],
    [400, "http"],
    [500, "http"],
    [503, "http"],
  ];
  for (const [status, reason] of table) {
    resetTokenCache();
    sharedSeriesCache().clear();
    installUpstream({ statistics: () => json({ error: { status, reason: "Nope", code: "SOME_CODE", message: "upstream said no" } }, status) });
    const res = await POST(request({ ring: CCW }));
    assert.equal(res.status, 200, `HTTP ${status} must not become a 5xx`);
    const body = await res.json();
    assert.equal(body.ok, false, String(status));
    assert.equal(body.reason, reason, String(status));
    assert.equal(body.status, status);
    assert.equal(
      body.technical,
      `sh-statistics · sh.dataspace.copernicus.eu · HTTP ${status} · SOME_CODE: upstream said no`,
    );
    assert.ok(Array.isArray(body.diagnostics) && body.diagnostics.length >= 2);
  }
});

test("a rejected token is auth, an unreachable token endpoint is network, and neither calls the Statistical API", async () => {
  let calls = installUpstream({ token: () => json({ error: "invalid_client", error_description: "Invalid client or Invalid client credentials" }, 401) });
  let body = await (await POST(request({ ring: CCW }))).json();
  assert.equal(body.reason, "auth");
  assert.match(body.technical, /^cdse-token · identity\.dataspace\.copernicus\.eu · HTTP 401 · invalid_client/);
  assert.equal(callsTo(calls, "/api/v1/statistics").length, 0);

  resetTokenCache();
  calls = installUpstream({
    token: () => {
      throw new TypeError("fetch failed");
    },
  });
  body = await (await POST(request({ ring: CCW }))).json();
  assert.equal(body.reason, "network");
  assert.match(body.technical, /^cdse-token · identity\.dataspace\.copernicus\.eu · no response/);
  assert.equal(callsTo(calls, "/api/v1/statistics").length, 0);
});

test("a Statistical API call that never answers times out", async () => {
  process.env.CDSE_TIMEOUT_MS = "40";
  installUpstream({
    statistics: (init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      }),
    catalog: (init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
      }),
  });
  const res = await POST(request({ ring: CCW }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reason, "timeout");
  assert.match(body.technical, /^sh-statistics · sh\.dataspace\.copernicus\.eu · no response: timed out/);
  assert.equal(sharedSeriesCache().size, 0);
});

test("a network error, even a non-Error throw, is a network failure — never a 500", async () => {
  installUpstream({
    statistics: () => {
      throw "boom";
    },
  });
  const res = await POST(request({ ring: CCW }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reason, "network");
  assert.match(body.technical, /^sh-statistics · sh\.dataspace\.copernicus\.eu · no response/);
});

test("an unreadable Statistical API answer is malformed (HTTP 200 stays visible), not an empty chart", async () => {
  installUpstream({ statistics: () => new Response("<html>gateway</html>", { status: 200 }) });
  let body = await (await POST(request({ ring: CCW }))).json();
  assert.equal(body.reason, "malformed");
  assert.equal(body.status, 200);
  assert.match(body.technical, /HTTP 200: the Statistical API answer was not JSON/);

  resetTokenCache();
  installUpstream({ statistics: () => json({ status: "OK" }) });
  body = await (await POST(request({ ring: CCW }))).json();
  assert.equal(body.reason, "malformed");
  assert.match(body.technical, /unreadable: the answer has no `data` array/);
  assert.equal(sharedSeriesCache().size, 0);
});

test("a failing Catalog costs the cloud info, not the series", async () => {
  const logs = captureLogs();
  installUpstream({ catalog: () => json({ error: { message: "catalog down" } }, 500) });
  const body = await (await POST(request({ ring: CCW }))).json();
  assert.equal(body.ok, true);
  assert.equal(body.points.length, 5);
  assert.equal(body.cloudyDates, null, "unknown, not an empty list");
  assert.ok(body.points.every((p: { cloudCoverPct: number | null }) => p.cloudCoverPct === null));
  assert.ok(logs.some((l) => /step=sh-catalog host=sh\.dataspace\.copernicus\.eu status=500 ok=false/.test(l)));
  assert.ok(logs.some((l) => /step=result ok=true points=5 cloudy=unknown/.test(l)));
});

test("a Catalog that throws is the same: the series stands", async () => {
  installUpstream({
    catalog: () => {
      throw new TypeError("fetch failed");
    },
  });
  const body = await (await POST(request({ ring: CCW }))).json();
  assert.equal(body.ok, true);
  assert.equal(body.cloudyDates, null);
});

test("credentials echoed by an upstream error body never reach the browser", async () => {
  installUpstream({
    statistics: () => json({ error: { message: `bad request client_secret=${SECRET} Authorization: Bearer ${TOKEN}` } }, 400),
  });
  const logs = captureLogs();
  const text = JSON.stringify(await (await POST(request({ ring: CCW }))).json());
  for (const forbidden of [SECRET, TOKEN]) {
    assert.ok(!text.includes(forbidden), `response leaks ${forbidden}`);
    assert.ok(!logs.some((l) => l.includes(forbidden)), `logs leak ${forbidden}`);
  }
  assert.match(text, /\[redacted\]/);
});

/* ---- concurrency --------------------------------------------------- */

test("identical concurrent requests share ONE upstream job", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = installUpstream({
    statistics: async () => {
      await gate;
      return json(statisticsAnswer());
    },
  });
  const a = POST(request({ ring: CCW }));
  const b = POST(request({ ring: CW })); // the same field, drawn the other way
  await new Promise((resolve) => setTimeout(resolve, 25));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  const [ba, bb] = [await ra.json(), await rb.json()];
  assert.equal(ba.ok, true);
  assert.equal(bb.ok, true);
  assert.deepEqual(ba.points, bb.points);
  assert.equal(callsTo(calls, "/api/v1/statistics").length, 1, "one Statistical API call for two requests");
  assert.equal(callsTo(calls, "identity.dataspace").length, 1);
});
