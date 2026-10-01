/**
 * A REAL Sentinel-2 NDVI time series for one saved plot — the data behind the
 * Home card «مؤشر الغطاء النباتي» (`/api/ndvi-series`).
 *
 * THE ONE RULE THIS MODULE ENFORCES
 * ---------------------------------
 * A date appears in a series only if Sentinel-2 produced at least one USABLE
 * pixel (inside the boundary, no cloud / shadow / cirrus / snow) over the plot
 * that day. Nothing is ever filled, estimated or interpolated: a date with no
 * usable pixel is dropped, and the line the farmer sees only ever joins real
 * observations. The smoothing in this file (`monotoneSegments`) bends the line
 * BETWEEN two real points and is mathematically unable to leave the range of
 * those two points, so it cannot invent a value either.
 *
 * WHAT LIVES HERE
 * ---------------
 *   server   window · statistics evalscript + request · response parser ·
 *            catalog merge · geometry hash · 12 h cache · in-flight coalescing
 *   client   response interpretation · status (existing NDVI bands) · change %
 *            · chart geometry · monotone-cubic path · nearest-point snapping ·
 *            tooltip placement · palette gradient
 *
 * It is pure and isomorphic on purpose: no `node:*` import (the card bundles it
 * for the browser — the hash uses Web Crypto, which Node and every browser
 * ship), no network, no clock except where a caller passes one in. The calls
 * to Copernicus are made by `app/api/ndvi-series/route.ts`, which reuses the
 * existing token helper, Catalog request and trace format.
 */

import { ndviBand } from "../agronomy";
import {
  closeRing,
  normalizeRing,
  ringSignedArea,
  validatePlot,
  type Bbox,
  type Position,
  type Ring,
} from "../geo/polygon";
import { NDVI_COLOR_STOPS, ndviColorAt } from "../plot/ndvi-layers";
import type { NdviFailure } from "./openeo";
import type { StepLog, TraceStep } from "./trace";

/* ------------------------------------------------------------------ */
/*  Shapes                                                             */
/* ------------------------------------------------------------------ */

/** One real observation: the plot's NDVI on one Sentinel-2 day. */
export interface NdviSeriesPoint {
  /** `YYYY-MM-DD` (UTC) of the acquisition. */
  date: string;
  /** Mean NDVI of the plot's usable pixels that day. */
  mean: number;
  min: number;
  max: number;
  /**
   * Usable 10 m pixels behind the mean (Statistical API `sampleCount −
   * noDataCount`). Always ≥ 1: a date with none is dropped, not reported.
   */
  sampleCount: number;
  /** Tile cloud cover (%) of that day's scene, from the Catalog; `null` when unreported. */
  cloudCoverPct: number | null;
}

/** A pass over the plot that produced no usable pixel (cloud, shadow, snow…). */
export interface NdviCloudyDate {
  date: string;
  /** Tile cloud cover (%) of that pass, or `null` when the Catalog did not report it. */
  cloudCoverPct: number | null;
}

/** What the route caches and answers on success. */
export interface NdviSeriesPayload {
  /** First day of the window, `YYYY-MM-DD` (UTC). */
  from: string;
  /** Last day of the window = today (UTC). */
  to: string;
  /** Real observations only, oldest → newest, one per date. Never empty on success. */
  points: NdviSeriesPoint[];
  /**
   * Passes with zero usable pixels, oldest → newest. `null` = the Catalog was
   * unreachable, so we do not know — never an empty list standing in for it.
   */
  cloudyDates: NdviCloudyDate[] | null;
  /** When the series was read from Copernicus (ISO timestamp). */
  fetchedAt: string;
}

/** Why a series is missing. A subset of the app's `NdviFailure`, plus `empty-series`. */
export type NdviSeriesFailureReason = Exclude<NdviFailure, "noScenes"> | "empty-series";

export const SERIES_FAILURE_REASONS: readonly NdviSeriesFailureReason[] = [
  "notConfigured",
  "auth",
  "network",
  "timeout",
  "http",
  "quota",
  "malformed",
  "invalid-input",
  "empty-series",
];

/** The failure body of `/api/ndvi-series`. */
export interface NdviSeriesFailure {
  ok: false;
  reason: NdviSeriesFailureReason;
  /** Upstream HTTP status, when the failure came from a response. */
  status?: number;
  /** One short line for the error card: `step · host · HTTP status · code: message`. */
  technical: string;
  /** `invalid-input`: the exact condition that failed. */
  message?: string;
  /** `empty-series`: the window that was searched and the passes that were all masked. */
  window?: { from: string; to: string };
  cloudyDates?: NdviCloudyDate[] | null;
  /** The per-call records behind the failure (host, status, code — no secrets). */
  diagnostics?: StepLog[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** The window: today and the 29 days before it. */
export const SERIES_WINDOW_DAYS = 30;
/** A series is reused for 12 h per (geometry, day). */
export const SERIES_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
/** Memory bound of the in-process cache. */
export const SERIES_CACHE_MAX_ENTRIES = 300;
/** A drawn parcel has a handful of vertices; more than this is not a field. */
export const SERIES_MAX_RING_POINTS = 500;
/** Coordinates are keyed at ~1 m (same rounding as the field-data cache). */
const KEY_DECIMALS = 5;
/** Fewer real points than this are drawn with straight segments and an honest note. */
export const SMOOTH_MIN_POINTS = 3;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const roundTo = (n: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
};
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* ------------------------------------------------------------------ */
/*  Window (UTC days — Sentinel Hub aggregates and dates scenes in UTC) */
/* ------------------------------------------------------------------ */

/** `YYYY-MM-DD` of an instant, in UTC. */
export function utcDay(now: Date | number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** `day` moved by `delta` calendar days. */
export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export interface SeriesWindow {
  /** First day, inclusive. */
  from: string;
  /** Last day, inclusive — today (UTC). */
  to: string;
  /** Statistical API `timeRange.from`: the first day's midnight. */
  timeFrom: string;
  /** Statistical API `timeRange.to`: the midnight AFTER today, so today's pass is not skipped. */
  timeTo: string;
}

/**
 * The 30 daily intervals ending today. `timeTo` is tomorrow's midnight: the
 * Statistical API skips a trailing partial interval (`lastIntervalBehavior`
 * defaults to SKIP), so a window ending "now" would drop today's scene.
 */
export function seriesWindow(now: Date | number = Date.now()): SeriesWindow {
  const to = utcDay(now);
  const from = shiftDay(to, -(SERIES_WINDOW_DAYS - 1));
  return { from, to, timeFrom: `${from}T00:00:00Z`, timeTo: `${shiftDay(to, 1)}T00:00:00Z` };
}

/* ------------------------------------------------------------------ */
/*  Request validation                                                 */
/* ------------------------------------------------------------------ */

/** The ring of a request, oriented counter-clockwise (GeoJSON's right-hand rule). */
export function orientCounterClockwise(ring: Ring): Ring {
  return ring.length >= 3 && ringSignedArea(ring) < 0 ? [...ring].reverse() : ring;
}

/**
 * Body → a ring the satellite may be asked about, using the app's own
 * validators (`normalizeRing` + `validatePlot`: ≥ 3 points, inside Algeria,
 * simple, 0.05–50 ha). Clockwise and counter-clockwise boundaries are both
 * accepted. `{ ring }` and a bare array are both understood.
 */
export function parseSeriesRequest(raw: unknown): { ok: true; ring: Ring } | { ok: false; detail: string } {
  const candidate = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { ring?: unknown }).ring
      : undefined;
  if (!Array.isArray(candidate)) return { ok: false, detail: "request body must be { ring: [[lon, lat], …] }" };
  if (candidate.length > SERIES_MAX_RING_POINTS) {
    return { ok: false, detail: `ring has ${candidate.length} points, at most ${SERIES_MAX_RING_POINTS} are accepted` };
  }
  const ring = normalizeRing(candidate);
  const check = validatePlot(ring);
  if (!check.ok) {
    const detail =
      check.reason === "tooFewPoints"
        ? `ring has ${ring.length} usable point(s), at least 3 are required`
        : (check.detail ?? check.reason);
    return { ok: false, detail };
  }
  return { ok: true, ring: orientCounterClockwise(ring) };
}

/* ------------------------------------------------------------------ */
/*  Geometry hash + cache key                                          */
/* ------------------------------------------------------------------ */

/**
 * One canonical string per geometry: counter-clockwise, rounded to ~1 m and
 * started at its lowest vertex. The same field keys identically whichever way
 * it was drawn (clockwise or not) and whichever vertex came first.
 */
export function canonicalRingKey(raw: unknown): string {
  const ring = normalizeRing(raw);
  if (ring.length < 3) return "";
  const rounded = orientCounterClockwise(ring).map(
    ([lon, lat]): Position => [Number(lon.toFixed(KEY_DECIMALS)), Number(lat.toFixed(KEY_DECIMALS))],
  );
  let start = 0;
  for (let i = 1; i < rounded.length; i += 1) {
    const [lon, lat] = rounded[i];
    const [bestLon, bestLat] = rounded[start];
    if (lon < bestLon || (lon === bestLon && lat < bestLat)) start = i;
  }
  return [...rounded.slice(start), ...rounded.slice(0, start)]
    .map(([lon, lat]) => `${lon.toFixed(KEY_DECIMALS)},${lat.toFixed(KEY_DECIMALS)}`)
    .join(";");
}

/** 128-bit hex digest (SHA-256, truncated) of the canonical geometry. Web Crypto: server and browser. */
export async function geometryHash(raw: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRingKey(raw));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** The cache key: one entry per (plot geometry, day). */
export async function seriesCacheKey(raw: unknown, day: string): Promise<string> {
  return `${await geometryHash(raw)}:${day}`;
}

/**
 * In-process cache of SUCCESSFUL series, one entry per (geometry, day) for
 * `ttlMs` (12 h). Failures are never stored — `set` refuses an empty series, and
 * the route only calls it on success — so a transient outage cannot be pinned
 * for half a day. The clock is injectable so TTL tests need no timers.
 */
export class NdviSeriesCache {
  private readonly entries = new Map<string, { payload: NdviSeriesPayload; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? SERIES_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? SERIES_CACHE_MAX_ENTRIES;
  }

  get(key: string, now: number = Date.now()): NdviSeriesPayload | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.payload;
  }

  set(key: string, payload: NdviSeriesPayload, now: number = Date.now()): void {
    if (payload.points.length === 0) return; // an empty series is a failure: never cached
    this.entries.delete(key); // re-insert so the oldest entry is always first
    if (this.entries.size >= this.maxEntries) {
      for (const [k, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(k);
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { payload, expiresAt: now + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

let sharedCache: NdviSeriesCache | null = null;

/** The route's process-wide cache (created on first use, so importing this module has no side effect). */
export function sharedSeriesCache(): NdviSeriesCache {
  sharedCache ??= new NdviSeriesCache();
  return sharedCache;
}

/**
 * One upstream job per key at a time: a second caller of the same key joins
 * the running promise instead of spending a second round of processing units.
 * The entry is removed when the job settles — success or failure.
 */
export function coalesce<T>(inFlight: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running;
  const job: Promise<T> = work().finally(() => {
    if (inFlight.get(key) === job) inFlight.delete(key);
  });
  inFlight.set(key, job);
  return job;
}

/* ------------------------------------------------------------------ */
/*  Statistical API request                                            */
/* ------------------------------------------------------------------ */

/**
 * SCL classes treated as unusable — the SAME list as the Process API's
 * `EVALSCRIPT` (`sentinelhub.ts`): 1 saturated/defective, 3 cloud shadow,
 * 8/9 cloud medium/high probability, 10 thin cirrus, 11 snow. A unit test pins
 * the two lists together so they cannot drift.
 */
export const BAD_SCL_CLASSES = [1, 3, 8, 9, 10, 11] as const;

/**
 * The existing NDVI logic, unchanged — `(B08 − B04) / (B08 + B04)` on pixels
 * that are inside the boundary (`dataMask`), not in a bad SCL class and with a
 * positive band sum — in the shape the Statistical API requires: named outputs
 * and a `dataMask` output, which is what keeps masked pixels out of every
 * statistic (the API does not exclude no-data pixels by itself).
 */
export const NDVI_STATISTICS_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: [
      { id: "ndvi", bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ],
    mosaicking: "SIMPLE"
  };
}
function evaluatePixel(s) {
  var bad = [${BAD_SCL_CLASSES.join(", ")}];
  var sum = s.B08 + s.B04;
  var valid = s.dataMask === 1 && bad.indexOf(s.SCL) === -1 && sum > 0 ? 1 : 0;
  // NDVI where usable (NaN where not — loud, never a plausible 0); dataMask is what the statistics honour.
  return { ndvi: [valid ? (s.B08 - s.B04) / sum : NaN], dataMask: [valid] };
}`;

const WGS84_CRS = "http://www.opengis.net/def/crs/EPSG/0/4326";
export const DEFAULT_STATISTICS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics";

/**
 * The Statistical API lives beside the Process API, so its URL is derived from
 * the configured process URL — no new environment variable. CDSE serves both
 * path styles: `/api/v1/process` ↔ `/api/v1/statistics` and `/process/v1` ↔ `/statistics/v1`.
 */
export function statisticsUrlFrom(processUrl: string): string {
  try {
    const url = new URL(processUrl);
    if (/\/process\/v1\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/process\/v1\/?$/, "/statistics/v1");
      return url.toString();
    }
    if (/\/process\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/process\/?$/, "/statistics");
      return url.toString();
    }
    return `${url.origin}/api/v1/statistics`;
  } catch {
    return DEFAULT_STATISTICS_URL;
  }
}

export interface StatisticsRequestOptions {
  /** Validated, unclosed ring. */
  ring: Ring;
  bbox: Bbox;
  /** Pixel grid over `bbox` at ~10 m (`rasterSizeFor` in `sentinelhub.ts`). */
  width: number;
  height: number;
  window: SeriesWindow;
}

/**
 * One Statistical API request: the plot polygon (pixels outside it are masked)
 * over the 30-day window, one aggregate per UTC day (`P1D`). Same bounds shape
 * as the existing Process request (bbox + closed polygon + WGS84 CRS).
 */
export function buildStatisticsRequest(options: StatisticsRequestOptions): Record<string, unknown> {
  const { ring, bbox, width, height, window } = options;
  return {
    input: {
      bounds: {
        bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
        geometry: { type: "Polygon", coordinates: [closeRing(ring)] },
        properties: { crs: WGS84_CRS },
      },
      data: [{ type: "sentinel-2-l2a", dataFilter: { mosaickingOrder: "leastCC" } }],
    },
    aggregation: {
      timeRange: { from: window.timeFrom, to: window.timeTo },
      aggregationInterval: { of: "P1D" },
      evalscript: NDVI_STATISTICS_EVALSCRIPT,
      width,
      height,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Statistical API response                                           */
/* ------------------------------------------------------------------ */

export type StatisticsParse =
  | {
      ok: true;
      /** Dates with ≥ 1 usable pixel, oldest → newest. `cloudCoverPct` is merged in later. */
      points: NdviSeriesPoint[];
      /** Daily intervals the API answered. */
      intervals: number;
      /** Of those, intervals with no usable pixel (dropped — never filled). */
      withoutUsablePixels: number;
    }
  | { ok: false; detail: string };

/** `outputs.ndvi.bands.B0.stats` (tolerating another output id / band key). */
function statsBlock(outputs: unknown): Record<string, unknown> | null {
  if (!outputs || typeof outputs !== "object") return null;
  const record = outputs as Record<string, unknown>;
  const output = record.ndvi ?? Object.entries(record).find(([id]) => id !== "dataMask")?.[1];
  const bands = (output as { bands?: unknown } | undefined)?.bands;
  if (!bands || typeof bands !== "object") return null;
  const bandMap = bands as Record<string, unknown>;
  const band = bandMap.B0 ?? Object.values(bandMap)[0];
  const stats = (band as { stats?: unknown } | undefined)?.stats;
  return stats && typeof stats === "object" ? (stats as Record<string, unknown>) : null;
}

/**
 * Statistical API JSON → the real observations.
 *
 *   • usable pixels = `sampleCount − noDataCount` (with a polygon, `noDataCount`
 *     includes the pixels outside it and every masked pixel);
 *   • an interval with none is DROPPED. The API reports its statistics as the
 *     string `"NaN"` there; nothing is read from it and nothing replaces it;
 *   • an interval that has usable pixels but no finite mean/min/max, an NDVI
 *     outside −1…1, or an unreadable shape makes the whole answer `malformed`
 *     — a parse failure must never masquerade as a cloudy day.
 */
export function parseStatistics(payload: unknown): StatisticsParse {
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return { ok: false, detail: "the answer has no `data` array" };

  const byDate = new Map<string, NdviSeriesPoint>();
  let withoutUsablePixels = 0;
  for (const entry of data) {
    const from = (entry as { interval?: { from?: unknown } } | null)?.interval?.from;
    if (typeof from !== "string" || !ISO_DAY.test(from.slice(0, 10))) {
      return { ok: false, detail: "an interval has no start date" };
    }
    const date = from.slice(0, 10);
    const stats = statsBlock((entry as { outputs?: unknown }).outputs);
    if (!stats) return { ok: false, detail: `${date}: no statistics block` };
    const sampleCount = finite(stats.sampleCount);
    const noDataCount = finite(stats.noDataCount);
    if (sampleCount === null || noDataCount === null) return { ok: false, detail: `${date}: sample counts are missing` };

    const usable = sampleCount - noDataCount;
    if (!(usable > 0)) {
      withoutUsablePixels += 1;
      continue;
    }
    const mean = finite(stats.mean);
    const min = finite(stats.min);
    const max = finite(stats.max);
    if (mean === null || min === null || max === null) {
      return { ok: false, detail: `${date}: ${usable} usable pixel(s) but mean/min/max are not numbers` };
    }
    if ([mean, min, max].some((v) => v < -1 || v > 1)) {
      return { ok: false, detail: `${date}: NDVI outside the −1…1 range` };
    }
    byDate.set(date, {
      date,
      mean: roundTo(mean, 3),
      min: roundTo(min, 3),
      max: roundTo(max, 3),
      sampleCount: Math.round(usable),
      cloudCoverPct: null,
    });
  }
  const points = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ok: true, points, intervals: data.length, withoutUsablePixels };
}

/** A Catalog pass, as `parseCatalog` (`sentinelhub.ts`) returns it. */
export interface CatalogPass {
  date: string;
  cloudCoverPct: number | null;
}

/**
 * Joins the Catalog onto the statistics:
 *   • each real point gets its pass's tile cloud cover (when reported);
 *   • a pass with NO real point is a cloudy date — Sentinel-2 flew over, but
 *     every pixel on the plot was masked. `scenes === null` (Catalog down) leaves
 *     `cloudyDates` null: unknown, not "none".
 */
export function mergeSeries(args: {
  window: SeriesWindow;
  points: readonly NdviSeriesPoint[];
  scenes: readonly CatalogPass[] | null;
  fetchedAt: string;
}): NdviSeriesPayload {
  const { window, scenes, fetchedAt } = args;
  const cover = new Map<string, number | null>((scenes ?? []).map((s) => [s.date, s.cloudCoverPct]));
  const points = args.points.map((p) => {
    const known = cover.get(p.date);
    return { ...p, cloudCoverPct: typeof known === "number" ? roundTo(known, 1) : null };
  });
  const observed = new Set(points.map((p) => p.date));
  const cloudyDates =
    scenes === null
      ? null
      : scenes
          .filter((s) => !observed.has(s.date) && s.date >= window.from && s.date <= window.to)
          .map((s) => ({ date: s.date, cloudCoverPct: s.cloudCoverPct === null ? null : roundTo(s.cloudCoverPct, 1) }))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { from: window.from, to: window.to, points, cloudyDates, fetchedAt };
}

/** Sentinel Hub / CDSE HTTP status → the reason the UI copy is keyed on (same mapping as the Process API client). */
export function reasonForHttpStatus(status: number): "auth" | "quota" | "timeout" | "http" {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 408 || status === 504) return "timeout";
  return "http";
}

/**
 * `trace.ts` knows the Process API's steps and is shared with the field-data
 * route, so it is not edited. The Statistical API call is traced under its own
 * name with the identical log line; `TraceStep` is only a compile-time union —
 * nothing at runtime switches on it.
 */
export const STATISTICS_STEP = "sh-statistics" as unknown as TraceStep;

/* ================================================================== */
/*  Client side                                                        */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/*  Response → view                                                    */
/* ------------------------------------------------------------------ */

/** Every failure but `empty-series`, which is its own view (an honest answer, not a fault). */
export type NdviSeriesErrorReason = Exclude<NdviSeriesFailureReason, "empty-series">;

export type SeriesView =
  | { kind: "ready"; series: NdviSeriesPayload; cached: boolean }
  | { kind: "empty"; from: string | null; to: string | null; cloudyDates: NdviCloudyDate[]; technical: string }
  | { kind: "error"; reason: NdviSeriesErrorReason; status: number | null; technical: string };

function readPoints(raw: unknown): NdviSeriesPoint[] | null {
  if (!Array.isArray(raw)) return null;
  const out: NdviSeriesPoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const p = item as Record<string, unknown>;
    const mean = finite(p.mean);
    const min = finite(p.min);
    const max = finite(p.max);
    const count = finite(p.sampleCount);
    if (typeof p.date !== "string" || !ISO_DAY.test(p.date) || mean === null || min === null || max === null || count === null) {
      return null;
    }
    const cover = finite(p.cloudCoverPct);
    out.push({ date: p.date, mean, min, max, sampleCount: count, cloudCoverPct: cover });
  }
  // Oldest → newest, one per date: the chart's x order depends on it.
  for (let i = 1; i < out.length; i += 1) if (out[i].date <= out[i - 1].date) return null;
  return out;
}

function readCloudy(raw: unknown): NdviCloudyDate[] | null {
  if (!Array.isArray(raw)) return null;
  const out: NdviCloudyDate[] = [];
  for (const item of raw) {
    const p = item as { date?: unknown; cloudCoverPct?: unknown } | null;
    if (!p || typeof p.date !== "string" || !ISO_DAY.test(p.date)) return null;
    out.push({ date: p.date, cloudCoverPct: finite(p.cloudCoverPct) });
  }
  return out;
}

/**
 * What the card does with `/api/ndvi-series`' answer. Strict on purpose: a body
 * that is not exactly the documented shape is `malformed`, never a half-drawn
 * chart. Points are passed through untouched — no sorting-by-guessing, no
 * filling, no clamping.
 */
export function interpretSeriesResponse(httpStatus: number, body: unknown): SeriesView {
  const bad = (technical: string): SeriesView => ({ kind: "error", reason: "malformed", status: httpStatus, technical });
  if (!body || typeof body !== "object") return bad(`ndvi-series · HTTP ${httpStatus} · the answer was not JSON`);
  const b = body as Record<string, unknown>;

  if (b.ok === true) {
    const points = readPoints(b.points);
    if (!points || points.length === 0 || typeof b.from !== "string" || typeof b.to !== "string") {
      return bad(`ndvi-series · HTTP ${httpStatus} · the series in the answer was unreadable`);
    }
    return {
      kind: "ready",
      cached: b.cached === true,
      series: {
        from: b.from,
        to: b.to,
        points,
        cloudyDates: readCloudy(b.cloudyDates),
        fetchedAt: typeof b.fetchedAt === "string" ? b.fetchedAt : "",
      },
    };
  }

  const reason = SERIES_FAILURE_REASONS.find((r) => r === b.reason) ?? "http";
  const technical =
    typeof b.technical === "string" && b.technical.trim() ? b.technical.trim().slice(0, 150) : `ndvi-series · HTTP ${httpStatus}`;
  if (reason === "empty-series") {
    const window = (b.window ?? {}) as { from?: unknown; to?: unknown };
    return {
      kind: "empty",
      from: typeof window.from === "string" ? window.from : null,
      to: typeof window.to === "string" ? window.to : null,
      cloudyDates: readCloudy(b.cloudyDates) ?? [],
      technical,
    };
  }
  return { kind: "error", reason, status: typeof b.status === "number" ? b.status : httpStatus, technical };
}

/** A request that never produced an HTTP answer (offline, DNS, our own timeout). */
export function networkFailureView(error: unknown, timedOut: boolean): SeriesView {
  const detail = timedOut ? "timed out" : error instanceof Error ? `${error.name}: ${error.message}` : "request failed";
  return {
    kind: "error",
    reason: timedOut ? "timeout" : "network",
    status: null,
    technical: `ndvi-series · no response · ${detail}`.slice(0, 150),
  };
}

/* ------------------------------------------------------------------ */
/*  Status + change                                                    */
/* ------------------------------------------------------------------ */

export type NdviBand = ReturnType<typeof ndviBand>;

/** Chip tone per band — the same mapping the previous card used. */
export const NDVI_BAND_TONE: Readonly<Record<NdviBand, "amber" | "emerald">> = {
  poor: "amber",
  fair: "amber",
  good: "emerald",
  excellent: "emerald",
};

/** The status chip: the app's EXISTING NDVI bands (`ndviBand`) — no thresholds of its own. */
export function ndviStatus(value: number): { band: NdviBand; tone: "amber" | "emerald" } {
  const band = ndviBand(value);
  return { band, tone: NDVI_BAND_TONE[band] };
}

export interface SeriesChange {
  /** Relative change of the latest real mean against the first real mean, in %. */
  pct: number;
  /** Direction at display precision (whole %), so "0%" is never an arrow. */
  direction: "up" | "down" | "flat";
}

/**
 * Latest real mean vs the first real mean of the window. `null` — and the card
 * hides the badge — with fewer than two real points, or when the first mean is
 * not positive (a relative change from 0 or below is undefined, not huge).
 */
export function seriesChange(points: readonly { mean: number }[]): SeriesChange | null {
  if (points.length < 2) return null;
  const first = points[0].mean;
  const last = points[points.length - 1].mean;
  if (!(first > 0)) return null;
  const pct = ((last - first) / first) * 100;
  const shown = Math.round(pct);
  return { pct, direction: shown > 0 ? "up" : shown < 0 ? "down" : "flat" };
}

/** `+12%` / `−8%` / `0%` — whole percent, a real minus sign. */
export function formatChangePct(change: SeriesChange): string {
  const shown = Math.round(change.pct);
  return `${shown > 0 ? "+" : shown < 0 ? "−" : ""}${Math.abs(shown)}%`;
}

/** `12%`; a cloud cover between 0 and 1 reads `<1%` — never a rounded `0%` that claims a perfectly clear scene. */
export function formatCloudPct(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/* ------------------------------------------------------------------ */
/*  Monotone cubic path                                                */
/* ------------------------------------------------------------------ */

export interface XY {
  x: number;
  y: number;
}

export interface BezierSegment {
  c1: XY;
  c2: XY;
  to: XY;
}

/**
 * Monotone cubic interpolation (Fritsch–Carlson family, Steffen's tangents —
 * the construction d3's `curveMonotoneX` uses) through `pts`, given in drawing
 * order with strictly monotone `x` (either direction, so the RTL axis works).
 *
 * Why this and not Catmull-Rom or a plain spline: those overshoot, drawing NDVI
 * values no satellite measured above a peak or below a trough. Here each
 * tangent is limited so that on every segment the curve stays inside the range
 * of its two end points, and a local extremum gets a flat tangent. Result: the
 * curve never leaves [min, max] of the data, and `y` is monotone between any
 * two neighbours.
 */
export function monotoneSegments(pts: readonly XY[]): BezierSegment[] {
  const n = pts.length;
  if (n < 2) return [];
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(pts[i + 1].x - pts[i].x);
    slope.push(dx[i] !== 0 ? (pts[i + 1].y - pts[i].y) / dx[i] : 0);
  }
  const tangent: number[] = new Array<number>(n).fill(0);
  if (n === 2) {
    tangent[0] = slope[0];
    tangent[1] = slope[0];
  } else {
    for (let i = 1; i < n - 1; i += 1) {
      const s0 = slope[i - 1];
      const s1 = slope[i];
      // Slope of the parabola through the three points: the limit that keeps it monotone.
      const parabola = (s0 * dx[i] + s1 * dx[i - 1]) / (dx[i - 1] + dx[i]);
      // Opposite signs (an extremum) or a flat neighbour → 0, i.e. a flat tangent.
      tangent[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(parabola)) || 0;
    }
    // One-sided end tangents; with the interior limit above they stay inside the
    // monotone region (≤ 1.5× the end slope).
    tangent[0] = (3 * slope[0] - tangent[1]) / 2;
    tangent[n - 1] = (3 * slope[n - 2] - tangent[n - 2]) / 2;
  }
  const out: BezierSegment[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const third = dx[i] / 3;
    out.push({
      c1: { x: a.x + third, y: a.y + tangent[i] * third },
      c2: { x: b.x - third, y: b.y - tangent[i + 1] * third },
      to: { x: b.x, y: b.y },
    });
  }
  return out;
}

const px = (n: number) => String(Math.round(n * 100) / 100);

/** SVG path of the monotone curve through the real points (`M` only for one point). */
export function monotonePath(pts: readonly XY[]): string {
  if (pts.length === 0) return "";
  let d = `M${px(pts[0].x)} ${px(pts[0].y)}`;
  for (const s of monotoneSegments(pts)) {
    d += `C${px(s.c1.x)} ${px(s.c1.y)} ${px(s.c2.x)} ${px(s.c2.y)} ${px(s.to.x)} ${px(s.to.y)}`;
  }
  return d;
}

/** Straight segments between the real points — used when there are too few to smooth honestly. */
export function linearPath(pts: readonly XY[]): string {
  if (pts.length === 0) return "";
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.x)} ${px(p.y)}`).join("");
}

/** The curve closed down to the baseline, for the gradient area. */
export function areaPathFrom(line: string, first: XY, last: XY, baselineY: number): string {
  return line === "" ? "" : `${line}L${px(last.x)} ${px(baselineY)}L${px(first.x)} ${px(baselineY)}Z`;
}

/* ------------------------------------------------------------------ */
/*  Snapping                                                           */
/* ------------------------------------------------------------------ */

/** Index of the real point whose `x` is nearest to `x` (ties → the lower index); `-1` when empty. */
export function nearestPointIndex(xs: readonly number[], x: number): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    const distance = Math.abs(xs[i] - x);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/** The neighbour of point `from` that is next on screen to the left (`-1`) or right (`+1`); `from` at the edge stays put. */
export function neighborByX(xs: readonly number[], from: number, direction: -1 | 1): number {
  if (from < 0 || from >= xs.length) return from;
  let best = from;
  let bestDistance = Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    const delta = (xs[i] - xs[from]) * direction;
    if (i !== from && delta > 0 && delta < bestDistance) {
      best = i;
      bestDistance = delta;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/*  Scales, ticks, palette                                             */
/* ------------------------------------------------------------------ */

/** The narrowest y-range drawn: a flat series is not zoomed until its noise looks dramatic. */
const MIN_Y_SPAN = 0.2;

/**
 * y-range from the REAL min/max of the plotted means, padded by 20 % (at least
 * 0.05) and kept inside the physical NDVI range −1…1.
 */
export function yDomainFor(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const lo0 = Math.min(...values);
  const hi0 = Math.max(...values);
  const pad = Math.max((hi0 - lo0) * 0.2, 0.05);
  let lo = lo0 - pad;
  let hi = hi0 + pad;
  if (hi - lo < MIN_Y_SPAN) {
    const middle = (lo + hi) / 2;
    lo = middle - MIN_Y_SPAN / 2;
    hi = middle + MIN_Y_SPAN / 2;
  }
  if (lo < -1) {
    hi += -1 - lo;
    lo = -1;
  }
  if (hi > 1) {
    lo = Math.max(-1, lo - (hi - 1));
    hi = 1;
  }
  return [roundTo(lo, 3), roundTo(hi, 3)];
}

/** Round gridline values inside `[lo, hi]`: the finest of 0.05/0.1/0.2/0.25/0.5 steps that gives at most `maxTicks`. */
export function niceTicks(lo: number, hi: number, maxTicks = 4): number[] {
  for (const step of [0.05, 0.1, 0.2, 0.25, 0.5, 1]) {
    const ticks: number[] = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) ticks.push(roundTo(v, 4));
    if (ticks.length >= 1 && ticks.length <= maxTicks) return ticks;
  }
  return [roundTo((lo + hi) / 2, 2)];
}

/** `rgb()` of the FIXED NDVI palette at an absolute NDVI value (0–1) — dots and area, never a per-field stretch. */
export function ndviPaletteCss(value: number): string {
  const [r, g, b] = ndviColorAt(value);
  return `rgb(${r}, ${g}, ${b})`;
}

export interface GradientStop {
  /** 0 = top of the plot (highest NDVI) … 1 = baseline (lowest). */
  offset: number;
  color: string;
  opacity: number;
}

/**
 * Vertical stops for the area under the line: the colour at each height is the
 * fixed NDVI palette's colour for the NDVI value at that height (the palette's
 * own stops that fall inside the y-range, plus the two ends), fading toward the
 * baseline so the area reads as a soft wash under the line.
 */
export function areaGradientStops(domain: readonly [number, number]): GradientStop[] {
  const [lo, hi] = domain;
  const span = hi - lo;
  if (!(span > 0)) return [];
  const inside = NDVI_COLOR_STOPS.map((s) => s.at)
    .filter((at) => at > lo && at < hi)
    .sort((a, b) => b - a);
  return [hi, ...inside, lo].map((value) => {
    const offset = clamp((hi - value) / span, 0, 1);
    return { offset: roundTo(offset, 4), color: ndviPaletteCss(value), opacity: roundTo(0.55 - 0.47 * offset, 3) };
  });
}

/* ------------------------------------------------------------------ */
/*  Chart geometry                                                     */
/* ------------------------------------------------------------------ */

export interface ChartInput {
  points: readonly NdviSeriesPoint[];
  cloudyDates: readonly NdviCloudyDate[];
  /** The window, as the server returned it. */
  from: string;
  to: string;
  width: number;
  height: number;
  /** Right-to-left layout: time runs from the right (oldest) to the left (newest). */
  rtl: boolean;
}

export interface ChartPoint {
  index: number;
  date: string;
  value: number;
  min: number;
  max: number;
  sampleCount: number;
  cloudCoverPct: number | null;
  x: number;
  y: number;
}

export interface ChartModel {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  yDomain: [number, number];
  yTicks: { value: number; y: number }[];
  /** Weekly date ticks counted back from the last day of the window. */
  xTicks: { date: string; x: number }[];
  points: ChartPoint[];
  /** Hollow markers on the axis, one per pass with no usable pixel. */
  cloudy: { date: string; x: number; cloudCoverPct: number | null }[];
  /** Fewer than `SMOOTH_MIN_POINTS` real points: straight segments, no smoothing. */
  sparse: boolean;
  linePath: string;
  areaPath: string;
  /** The y of the axis row the cloudy markers sit on. */
  markerY: number;
}

/** Room for the y labels on the start side, and for a dot's ring on the other. */
const GUTTER = 36;
const EDGE = 12;
const PAD_TOP = 14;
const PAD_BOTTOM = 22;

/**
 * Pixel geometry of the chart from the real points. x is the CALENDAR position
 * inside the 30-day window (so a gap on screen is a real gap in the
 * observations, not compressed away); y is the plotted mean on the padded
 * range. Every point maps to exactly one dot — nothing is added between them.
 */
export function buildChartModel(input: ChartInput): ChartModel {
  const { points, cloudyDates, from, to, width, height, rtl } = input;
  const plot = {
    left: rtl ? EDGE : GUTTER,
    right: width - (rtl ? GUTTER : EDGE),
    top: PAD_TOP,
    bottom: height - PAD_BOTTOM,
  };
  const span = Math.max(1, dayDiff(from, to));
  const innerWidth = Math.max(1, plot.right - plot.left);
  const xForDate = (date: string) => {
    const f = clamp(dayDiff(from, date), 0, span) / span;
    return roundTo(rtl ? plot.right - f * innerWidth : plot.left + f * innerWidth, 2);
  };

  const yDomain = yDomainFor(points.map((p) => p.mean));
  const [lo, hi] = yDomain;
  const innerHeight = Math.max(1, plot.bottom - plot.top);
  const yFor = (value: number) => roundTo(plot.bottom - ((value - lo) / (hi - lo)) * innerHeight, 2);

  const chartPoints: ChartPoint[] = points.map((p, index) => ({
    index,
    date: p.date,
    value: p.mean,
    min: p.min,
    max: p.max,
    sampleCount: p.sampleCount,
    cloudCoverPct: p.cloudCoverPct,
    x: xForDate(p.date),
    y: yFor(p.mean),
  }));

  const sparse = chartPoints.length < SMOOTH_MIN_POINTS;
  const line = sparse ? linearPath(chartPoints) : monotonePath(chartPoints);
  const first = chartPoints[0];
  const last = chartPoints[chartPoints.length - 1];

  const xTicks: { date: string; x: number }[] = [];
  for (let back = 0; back * 7 <= span; back += 1) {
    const date = shiftDay(to, -back * 7);
    xTicks.push({ date, x: xForDate(date) });
  }

  return {
    width,
    height,
    plot,
    yDomain,
    yTicks: points.length === 0 ? [] : niceTicks(lo, hi).map((value) => ({ value, y: yFor(value) })),
    xTicks,
    points: chartPoints,
    cloudy: cloudyDates.map((c) => ({ date: c.date, x: xForDate(c.date), cloudCoverPct: c.cloudCoverPct })),
    sparse,
    linePath: line,
    areaPath: first && last ? areaPathFrom(line, first, last, plot.bottom) : "",
    markerY: plot.bottom + 9,
  };
}

/* ------------------------------------------------------------------ */
/*  Tooltip placement                                                  */
/* ------------------------------------------------------------------ */

/**
 * Where the floating tooltip goes: centred over the active point and clamped
 * inside the chart box; above the point unless there is no room, then below.
 */
export function placeTooltip(o: {
  x: number;
  y: number;
  tipWidth: number;
  tipHeight: number;
  boxWidth: number;
  boxHeight: number;
  gap?: number;
}): { left: number; top: number; placement: "above" | "below" } {
  const gap = o.gap ?? 12;
  const left = clamp(o.x - o.tipWidth / 2, 2, Math.max(2, o.boxWidth - o.tipWidth - 2));
  const above = o.y - gap - o.tipHeight >= 2;
  const top = above ? o.y - gap - o.tipHeight : Math.min(o.y + gap, Math.max(2, o.boxHeight - o.tipHeight - 2));
  return { left: roundTo(left, 2), top: roundTo(top, 2), placement: above ? "above" : "below" };
}
