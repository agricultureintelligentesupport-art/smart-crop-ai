/**
 * `/api/ndvi-series` — the REAL Sentinel-2 NDVI time series of one plot.
 *
 *   POST `{ ring }`  (a bare `[[lon, lat], …]` array is accepted too)
 *     → one mean / min / max NDVI per UTC day over the last 30 days (today
 *       included) for the pixels inside the boundary, one entry per day that
 *       Sentinel-2 actually measured.
 *
 * WHAT THIS ROUTE NEVER DOES
 * --------------------------
 * It never fills, estimates or interpolates. A day on which every pixel over
 * the plot was masked (cloud, shadow, cirrus, snow, no pass) has no entry, full
 * stop. Passes that were masked are reported separately as `cloudyDates`, so
 * the card can say WHY a stretch of the axis is empty instead of bridging it.
 *
 * UPSTREAM
 * --------
 * Sentinel Hub Statistical API on the Copernicus Data Space (`P1D`
 * aggregation), with the same `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET`, the
 * same token helper (`getAccessToken`) and the same trace format
 * (`step=… ok=… ms=…`) as `/api/field-data`. The evalscript is the existing
 * NDVI logic (`B08/B04`, SCL cloud/shadow exclusion, `dataMask`). The Catalog
 * API (same `buildCatalogRequest`/`parseCatalog`) runs in parallel and adds the
 * scene cloud cover and the list of masked passes; if it fails the series is
 * still returned, with `cloudyDates: null` ("unknown").
 *
 * CACHING
 * -------
 * 12 h per (geometry hash, day), in memory — see `NdviSeriesCache`. A geometry
 * keys identically drawn clockwise or counter-clockwise. FAILURES ARE NEVER
 * CACHED (an empty series included), and identical concurrent requests share
 * one upstream job.
 *
 * FAILURE
 * -------
 * No HTTP 500s. A bad body answers `400 { reason: "invalid-input" }`; every
 * other failure answers `200 { ok: false, reason, technical }` with one of
 * notConfigured | auth | quota | network | timeout | http (+ `status`) |
 * malformed | empty-series, plus `diagnostics` (host, status, code — no
 * secrets) and a short `technical` line for the error card.
 */

import { NextRequest, NextResponse } from "next/server";
import { bboxOf, type Ring } from "@/lib/geo/polygon";
import {
  getAccessToken,
  isConfigured,
  readOpeneoConfig,
  resetTokenCache,
  type OpeneoConfig,
  type OpeneoFetch,
} from "@/lib/satellite/openeo";
import {
  buildCatalogRequest,
  parseCatalog,
  PIXEL_SIZE_M,
  rasterSizeFor,
} from "@/lib/satellite/sentinelhub";
import { describeStep, SatelliteTrace, type StepLog, type TraceStep } from "@/lib/satellite/trace";
import {
  buildStatisticsRequest,
  coalesce,
  geometryHash,
  mergeSeries,
  parseSeriesRequest,
  parseStatistics,
  reasonForHttpStatus,
  seriesWindow,
  sharedSeriesCache,
  statisticsUrlFrom,
  STATISTICS_STEP,
  type CatalogPass,
  type NdviCloudyDate,
  type NdviSeriesFailure,
  type NdviSeriesPayload,
  type SeriesWindow,
} from "@/lib/satellite/ndvi-series";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* One token, then the Statistical and Catalog calls in parallel: seconds when
   healthy. The budget below stays well inside this ceiling. */
export const maxDuration = 30;

/** Time for token + statistics + catalog together, capped by `CDSE_TIMEOUT_MS` when that is lower. */
const SERIES_BUDGET_MS = 25_000;

/** A boundary of the largest accepted size (500 points) is ~15 KB; anything above this is not a plot. */
const MAX_BODY_BYTES = 64 * 1024;

type Outcome = { ok: true; payload: NdviSeriesPayload } | { ok: false; failure: NdviSeriesFailure };

/** What the Statistical API call resolves to (it never rejects — every failure is a value). */
type StatisticsResult =
  | { ok: true; parsed: Extract<ReturnType<typeof parseStatistics>, { ok: true }> }
  | { ok: false; reason: NdviSeriesFailure["reason"]; status?: number };

/** Concurrent identical requests share one upstream job (entries leave the map when the job settles). */
const inFlight = new Map<string, Promise<Outcome>>();

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** A local rejection: `invalid-input` + the exact condition, never "malformed". */
function invalidInput(detail: string) {
  console.log(`[field-data] route=ndvi-series step=validate ok=false detail=${JSON.stringify(detail)}`);
  const failure: NdviSeriesFailure = {
    ok: false,
    reason: "invalid-input",
    technical: `validate · invalid-input: ${detail}`.slice(0, 150),
    message: detail,
  };
  return NextResponse.json(failure, { status: 400, headers: NO_STORE });
}

/** The first failed step among `preferred` (in that order), described for the error card. */
function technicalFor(trace: SatelliteTrace, preferred: readonly TraceStep[]): { technical: string; steps: StepLog[] } {
  const failed = preferred.map((step) => trace.steps.find((s) => s.step === step && !s.ok)).find(Boolean);
  return { technical: failed ? describeStep(failed) : (trace.technical() ?? "ndvi-series · failed"), steps: trace.steps };
}

interface JobInput {
  ring: Ring;
  window: SeriesWindow;
  config: OpeneoConfig;
  tag: string;
}

/** Token → (Statistical ∥ Catalog) → merge. Never throws. */
async function loadSeries({ ring, window, config, tag }: JobInput): Promise<Outcome> {
  const trace = new SatelliteTrace({ secrets: [config.clientId, config.clientSecret], tag });
  // `fetch` is resolved per call, so the global can be replaced (tests) and nothing is captured at import.
  const fetchImpl: OpeneoFetch = (input, init) => globalThis.fetch(input, init) as ReturnType<OpeneoFetch>;
  const fail = (
    reason: NdviSeriesFailure["reason"],
    preferred: readonly TraceStep[],
    extra: Partial<NdviSeriesFailure> = {},
  ): Outcome => {
    const { technical, steps } = technicalFor(trace, preferred);
    return { ok: false, failure: { ok: false, reason, technical, diagnostics: steps, ...extra } };
  };

  const bbox = bboxOf(ring);
  if (!bbox) return fail("invalid-input", [], { technical: "validate · invalid-input: the boundary has no extent" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, SERIES_BUDGET_MS));
  try {
    const auth = await getAccessToken(config, fetchImpl, controller.signal, trace);
    if (!auth.ok) return fail(auth.reason, ["cdse-token"]);
    const headers = { "content-type": "application/json", authorization: `Bearer ${auth.token}` };

    const statisticsUrl = statisticsUrlFrom(config.processUrl);
    const { width, height } = rasterSizeFor(bbox, PIXEL_SIZE_M);
    const statisticsBody = buildStatisticsRequest({ ring, bbox, width, height, window });

    /* ---- Statistical API: one aggregate per UTC day ------------------- */
    const statistics = (async (): Promise<StatisticsResult> => {
      const startedAt = Date.now();
      let res;
      try {
        res = await fetchImpl(statisticsUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { ...headers, accept: "application/json" },
          body: JSON.stringify(statisticsBody),
        });
      } catch (error) {
        trace.record({
          step: STATISTICS_STEP,
          url: statisticsUrl,
          status: null,
          ok: false,
          note: controller.signal.aborted ? "timed out" : error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
          startedAt,
        });
        return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
      }
      if (!res.ok) {
        if (res.status === 401) resetTokenCache();
        trace.record({
          step: STATISTICS_STEP,
          url: statisticsUrl,
          status: res.status,
          ok: false,
          body: await res.text().catch(() => ""),
          startedAt,
        });
        return { ok: false, reason: reasonForHttpStatus(res.status), status: res.status };
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        trace.record({
          step: STATISTICS_STEP,
          url: statisticsUrl,
          status: res.status,
          ok: false,
          note: controller.signal.aborted ? "timed out" : "the Statistical API answer was not JSON",
          startedAt,
        });
        return { ok: false, reason: controller.signal.aborted ? "timeout" : "malformed", status: res.status };
      }
      const parsed = parseStatistics(json);
      if (!parsed.ok) {
        trace.record({
          step: STATISTICS_STEP,
          url: statisticsUrl,
          status: res.status,
          ok: false,
          note: `the Statistical API answer was unreadable: ${parsed.detail}`,
          startedAt,
        });
        return { ok: false, reason: "malformed", status: res.status };
      }
      trace.record({
        step: STATISTICS_STEP,
        url: statisticsUrl,
        status: res.status,
        ok: true,
        note: `${parsed.intervals} day(s), ${parsed.points.length} with usable pixels, ${parsed.withoutUsablePixels} without`,
        startedAt,
      });
      return { ok: true, parsed };
    })();

    /* ---- Catalog: which passes happened, how cloudy (best effort) ------ */
    const catalog = (async (): Promise<CatalogPass[] | null> => {
      const startedAt = Date.now();
      try {
        const res = await fetchImpl(config.catalogUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { ...headers, accept: "application/geo+json, application/json" },
          body: JSON.stringify(buildCatalogRequest(bbox, window.from, window.to)),
        });
        if (!res.ok) {
          if (res.status === 401) resetTokenCache();
          trace.record({ step: "sh-catalog", url: config.catalogUrl, status: res.status, ok: false, body: await res.text().catch(() => ""), startedAt });
          return null;
        }
        const passes = parseCatalog(await res.json());
        trace.record({
          step: "sh-catalog",
          url: config.catalogUrl,
          status: res.status,
          ok: true,
          note: `${passes.length} pass(es) in ${window.from}..${window.to}`,
          startedAt,
        });
        return passes;
      } catch (error) {
        trace.record({
          step: "sh-catalog",
          url: config.catalogUrl,
          status: null,
          ok: false,
          note: controller.signal.aborted ? "timed out" : error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
          startedAt,
        });
        return null;
      }
    })();

    const [stats, scenes] = await Promise.all([statistics, catalog]);
    if (!stats.ok) {
      return fail(stats.reason, [STATISTICS_STEP], stats.status === undefined ? {} : { status: stats.status });
    }

    const payload = mergeSeries({ window, points: stats.parsed.points, scenes, fetchedAt: new Date().toISOString() });
    if (payload.points.length === 0) {
      const cloudy: NdviCloudyDate[] | null = payload.cloudyDates;
      return {
        ok: false,
        failure: {
          ok: false,
          reason: "empty-series",
          technical:
            `empty-series · ${window.from}..${window.to} · ${stats.parsed.intervals} day(s), none with a usable pixel` +
            (cloudy === null ? "" : `, ${cloudy.length} masked pass(es)`),
          window: { from: window.from, to: window.to },
          cloudyDates: cloudy,
          diagnostics: trace.steps,
        },
      };
    }
    return { ok: true, payload };
  } catch (error) {
    // Defensive: every call above handles its own errors, so this is a bug, not an outage.
    trace.record({
      step: STATISTICS_STEP,
      url: config.processUrl,
      status: null,
      ok: false,
      note: controller.signal.aborted ? "timed out" : error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
      startedAt: Date.now(),
    });
    return fail(controller.signal.aborted ? "timeout" : "network", [STATISTICS_STEP]);
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  // Refuse an oversized body before reading it (the point-count check below only runs after parsing).
  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  if (declaredBytes > MAX_BODY_BYTES) return invalidInput(`request body is larger than ${MAX_BODY_BYTES / 1024} KB`);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidInput("request body is not valid JSON");
  }
  const parsed = parseSeriesRequest(body);
  if (!parsed.ok) return invalidInput(parsed.detail);
  const { ring } = parsed;

  const window = seriesWindow();
  const hash = await geometryHash(ring);
  const key = `${hash}:${window.to}`;
  const tag = `route=ndvi-series geo=${hash.slice(0, 8)}`;

  const cache = sharedSeriesCache();
  const hit = cache.get(key);
  if (hit) {
    console.log(`[field-data] ${tag} step=cache ok=true note="hit" points=${hit.points.length} ms=${Date.now() - startedAt}`);
    return NextResponse.json({ ok: true, cached: true, ...hit }, { headers: NO_STORE });
  }

  const config = readOpeneoConfig();
  if (!isConfigured(config)) {
    const failure: NdviSeriesFailure = {
      ok: false,
      reason: "notConfigured",
      technical: "ndvi-series · CDSE_CLIENT_ID / CDSE_CLIENT_SECRET are not set",
    };
    console.log(`[field-data] ${tag} step=result ok=false reason=notConfigured ms=${Date.now() - startedAt}`);
    return NextResponse.json(failure, { headers: NO_STORE });
  }

  const outcome = await coalesce(inFlight, key, async () => {
    const result = await loadSeries({ ring, window, config, tag });
    if (result.ok) cache.set(key, result.payload); // successes only — a failure is never cached
    return result;
  });

  if (outcome.ok) {
    console.log(
      `[field-data] ${tag} step=result ok=true points=${outcome.payload.points.length} ` +
        `cloudy=${outcome.payload.cloudyDates?.length ?? "unknown"} cached=false ms=${Date.now() - startedAt}`,
    );
    return NextResponse.json({ ok: true, cached: false, ...outcome.payload }, { headers: NO_STORE });
  }
  console.log(
    `[field-data] ${tag} step=result ok=false reason=${outcome.failure.reason}` +
      `${outcome.failure.status !== undefined ? ` status=${outcome.failure.status}` : ""} ms=${Date.now() - startedAt}`,
  );
  return NextResponse.json(outcome.failure, { headers: NO_STORE });
}
