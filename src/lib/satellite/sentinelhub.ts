/**
 * Sentinel-2 NDVI through the Sentinel Hub **Process API** on the Copernicus
 * Data Space Ecosystem — the default satellite source of `/api/field-data`.
 *
 * TWO CONSUMERS, ONE FLOW
 * -----------------------
 * `fetchNdviRaster` (the default) keeps the whole per-pixel raster so the
 * plot-details view paints NDVI in the parcel's REAL shape at 10 m; the grid
 * cells the dashboard heatmap needs are then derived from that same raster.
 * `fetchNdviProcessApi` (the legacy rows/cols request) averages the raster
 * into per-cell means and is kept as the fallback behind `CDSE_USE_GRID=1`.
 * Both share `fetchSceneRaster`, so token, catalog, scene choice, retries,
 * traces and failure reasons are byte-for-byte the same code.
 *
 * WHY NOT openEO (any more)
 * -------------------------
 * The OAuth client in this deployment was created in the Sentinel Hub
 * dashboard (its id starts with `sh-`). Such a client gets a token from the
 * CDSE realm just fine, but openEO answers that token with 401/403, which the
 * app surfaced as "Copernicus rejected credentials". Sentinel Hub clients are
 * meant for `sh.dataspace.copernicus.eu`, so that is where NDVI is read now,
 * with the SAME token flow and the SAME `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET`.
 * The openEO code is still in `./openeo.ts` behind `CDSE_USE_OPENEO=1`.
 *
 * WHAT IS REQUESTED
 * -----------------
 *  1. Catalog API  — which Sentinel-2 L2A passes cover the parcel in the last
 *     30 days, with their acquisition date and tile cloud cover
 *     (`eo:cloud_cover`). Newest first.
 *  2. Process API  — for the newest pass(es): one request, bbox = the parcel's
 *     bbox, geometry = the drawn polygon (so pixels outside it are masked),
 *     ~10 m pixels, and an evalscript that masks cloud/shadow/cirrus/snow with
 *     the SCL band, honours `dataMask`, and computes NDVI = (B08−B04)/(B08+B04).
 *     The answer is a 2-band FLOAT32 GeoTIFF: band 1 = NDVI, band 2 = valid (0/1).
 *  3. Locally     — the raster path keeps every pixel (`NdviRaster`: values +
 *     dataMask + bbox + width/height) and derives the grid-cell means from it;
 *     the legacy grid path averages the pixels inside each cell (cells come
 *     from the plot's real geometry and area, clipped to the polygon), giving
 *     one mean NDVI per heatmap cell.
 *
 * If the Catalog call fails the module falls back to ONE Process request over
 * the whole window with `mostRecent` mosaicking (date and cloud cover are then
 * unknown and reported as `null`) rather than losing NDVI over a metadata call.
 *
 * Never throws; every failure resolves to a typed `NdviResult` and a trace step.
 */

import { bboxOf, closeRing, pointInRing, type Bbox, type Ring } from "../geo/polygon";
import type { NdviRaster } from "../field-data/types";
import {
  getAccessToken,
  isConfigured,
  resetTokenCache,
  type NdviCellValue,
  type NdviFailure,
  type NdviResult,
  type NdviTarget,
  type OpeneoConfig,
  type OpeneoFetch,
} from "./openeo";
import { decodeFloatTiff, TiffError, type DecodedTiff } from "./tiff";
import type { SatelliteTrace } from "./trace";

/** Target ground sampling distance, metres. */
export const PIXEL_SIZE_M = 10;
/** Sentinel Hub rejects rasters above 2500 px on a side. */
const MAX_SIDE_PX = 2500;
/**
 * Transport budget for the per-pixel raster (`width × height`). The raster
 * travels as JSON (`ndvi` + `dataMask` arrays) in the API response and inside
 * one Firestore cache document (1 MiB limit); 65 536 px at 10 m covers a
 * 2.56 km square — far beyond any real farm boundary — while keeping the
 * document comfortably under the limit.
 */
export const MAX_RASTER_PIXELS = 65_536;
/** NDVI precision kept in the transported raster; Sentinel-2 L2A reflectances are quantised to 1/10 000. */
const RASTER_DECIMALS = 3;
/** Scenes whose whole *tile* is more than this cloudy are not worth a request. */
export const MAX_SCENE_CLOUD_PCT = 90;
/** Process requests to spend on one field-data call (each costs quota). */
const MAX_PROCESS_ATTEMPTS = 3;
/** A cell needs this share of its pixels to be cloud-free to get a number. */
const MIN_VALID_SHARE = 0.25;

const TIFF_ERROR_TEXT = "the Process API answer was not a readable float GeoTIFF";

/* ------------------------------------------------------------------ */
/*  Request building                                                   */
/* ------------------------------------------------------------------ */

/**
 * SCL classes treated as unusable: 1 saturated/defective, 3 cloud shadow,
 * 8 cloud medium probability, 9 cloud high probability, 10 thin cirrus, 11 snow.
 * (0 no-data is already excluded by `dataMask`.) Vegetation, bare soil and
 * water stay — a wheat field is not a cloud.
 */
export const EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],
    output: { bands: 2, sampleType: "FLOAT32" },
    mosaicking: "SIMPLE"
  };
}
function evaluatePixel(s) {
  var bad = [1, 3, 8, 9, 10, 11];
  var sum = s.B08 + s.B04;
  var valid = s.dataMask === 1 && bad.indexOf(s.SCL) === -1 && sum > 0 ? 1 : 0;
  // Band 1: NDVI (NaN where unusable). Band 2: 1 when the pixel is usable.
  return [valid ? (s.B08 - s.B04) / sum : NaN, valid];
}`;

/** Pixel grid that gives ≈ `PIXEL_SIZE_M` pixels over the bbox. */
export function rasterSize(bbox: Bbox): { width: number; height: number } {
  return rasterSizeFor(bbox, PIXEL_SIZE_M);
}

/** Pixel grid for an explicit ground sampling distance, in metres per pixel. */
export function rasterSizeFor(bbox: Bbox, resolutionM: number): { width: number; height: number } {
  const midLat = (bbox.north + bbox.south) / 2;
  const widthM = (bbox.east - bbox.west) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (bbox.north - bbox.south) * 110_574;
  const side = (m: number) => Math.min(MAX_SIDE_PX, Math.max(1, Math.round(m / resolutionM)));
  return { width: side(widthM), height: side(heightM) };
}

/**
 * The ground sampling distance the raster request actually uses: 10 m (one
 * Sentinel-2 pixel) unless the 10 m grid would exceed `MAX_RASTER_PIXELS`, in
 * which case it is coarsened just enough to fit both the pixel budget and
 * Sentinel Hub's per-side limit. The value travels on the raster
 * (`resolutionM`) so the UI states what was really measured.
 */
export function rasterResolutionM(bbox: Bbox): number {
  const base = rasterSize(bbox);
  if (base.width * base.height <= MAX_RASTER_PIXELS) return PIXEL_SIZE_M;
  const midLat = (bbox.north + bbox.south) / 2;
  const widthM = (bbox.east - bbox.west) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (bbox.north - bbox.south) * 110_574;
  const byBudget = Math.sqrt((widthM * heightM) / MAX_RASTER_PIXELS);
  const bySide = Math.max(widthM, heightM) / MAX_SIDE_PX;
  // A 2 % head start, then step until the ROUNDED grid really fits — the
  // closed form only estimates, the loop is the guarantee.
  let resolution = Math.max(PIXEL_SIZE_M, Math.ceil(Math.max(byBudget, bySide) * 1.02));
  for (;;) {
    const { width, height } = rasterSizeFor(bbox, resolution);
    if (width * height <= MAX_RASTER_PIXELS) return resolution;
    resolution += 1;
  }
}

export interface ProcessRequestOptions {
  bbox: Bbox;
  /** The drawn plot polygon (unclosed `[lon, lat]`) — pixels outside are masked. */
  ring: Ring;
  /** ISO timestamps. */
  from: string;
  to: string;
  order: "leastCC" | "mostRecent";
  maxCloudCoverage?: number;
  /**
   * Ground sampling distance in metres per pixel. Defaults to 10 m; the raster
   * path passes `rasterResolutionM(bbox)` so an enormous boundary still fits
   * the transport budget.
   */
  resolutionM?: number;
}

export function buildProcessRequest(options: ProcessRequestOptions): Record<string, unknown> {
  const { bbox, ring, from, to, order, maxCloudCoverage, resolutionM } = options;
  const { width, height } = rasterSizeFor(bbox, resolutionM ?? PIXEL_SIZE_M);
  return {
    input: {
      bounds: {
        bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
        geometry: { type: "Polygon", coordinates: [closeRing(ring)] },
        properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" },
      },
      data: [
        {
          type: "sentinel-2-l2a",
          dataFilter: {
            timeRange: { from, to },
            mosaickingOrder: order,
            ...(maxCloudCoverage !== undefined ? { maxCloudCoverage } : {}),
          },
        },
      ],
    },
    output: {
      width,
      height,
      responses: [{ identifier: "default", format: { type: "image/tiff" } }],
    },
    evalscript: EVALSCRIPT,
  };
}

export function buildCatalogRequest(bbox: Bbox, fromDate: string, toDate: string): Record<string, unknown> {
  return {
    collections: ["sentinel-2-l2a"],
    datetime: `${fromDate}T00:00:00Z/${toDate}T23:59:59Z`,
    bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
    limit: 100,
    fields: { include: ["id", "properties.datetime", "properties.eo:cloud_cover"], exclude: [] },
  };
}

/* ------------------------------------------------------------------ */
/*  Response mapping                                                   */
/* ------------------------------------------------------------------ */

export interface SceneCandidate {
  /** `YYYY-MM-DD` (UTC) of the acquisition. */
  date: string;
  /** Lowest tile cloud cover among that day's tiles, or `null` if unreported. */
  cloudCoverPct: number | null;
}

/** Catalog FeatureCollection → one candidate per day, newest first. */
export function parseCatalog(payload: unknown): SceneCandidate[] {
  const features = payload && typeof payload === "object" ? (payload as { features?: unknown }).features : null;
  if (!Array.isArray(features)) return [];
  const byDate = new Map<string, number | null>();
  for (const feature of features) {
    const props = (feature as { properties?: Record<string, unknown> } | null)?.properties;
    const datetime = props?.datetime;
    if (typeof datetime !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(datetime)) continue;
    const date = datetime.slice(0, 10);
    const raw = props?.["eo:cloud_cover"];
    const cloud = typeof raw === "number" && Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : null;
    const known = byDate.get(date);
    if (known === undefined) byDate.set(date, cloud);
    else if (cloud !== null && (known === null || cloud < known)) byDate.set(date, cloud);
  }
  return [...byDate.entries()]
    .map(([date, cloudCoverPct]) => ({ date, cloudCoverPct }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Averages the raster's usable pixels inside every cell polygon.
 *
 * A cell with no usable pixel — or fewer than `MIN_VALID_SHARE` of the pixels
 * that fall inside it — is reported as `null`, never as a number: two clear
 * pixels of fifty are not a measurement of the cell.
 */
export function cellMeansFromRaster(tiff: DecodedTiff, bbox: Bbox, targets: NdviTarget[]): NdviCellValue[] {
  const [ndviBand, validBand] = tiff.bands;
  const sums = targets.map(() => ({ total: 0, valid: 0, sum: 0 }));
  const { width, height } = tiff;
  for (let y = 0; y < height; y += 1) {
    const lat = bbox.north - ((y + 0.5) / height) * (bbox.north - bbox.south);
    for (let x = 0; x < width; x += 1) {
      const lon = bbox.west + ((x + 0.5) / width) * (bbox.east - bbox.west);
      const i = y * width + x;
      const value = ndviBand[i];
      const usable = (validBand ? validBand[i] >= 0.5 : true) && Number.isFinite(value) && value >= -1.2 && value <= 1.2;
      for (let t = 0; t < targets.length; t += 1) {
        if (!pointInRing(targets[t].ring, [lon, lat])) continue;
        sums[t].total += 1;
        if (usable) {
          sums[t].valid += 1;
          sums[t].sum += value;
        }
        break; // cells tile the parcel; a pixel centre belongs to one of them
      }
    }
  }
  return targets.map((target, t) => {
    const s = sums[t];
    const measured = s.valid > 0 && s.valid / s.total >= MIN_VALID_SHARE;
    return { id: target.id, ndvi: measured ? s.sum / s.valid : null };
  });
}

/**
 * A decoded raster re-expressed as the transportable `NdviRaster` the client
 * paints: one NDVI value and one mask flag per pixel, row-major.
 *
 * `dataMask` keeps only pixels the provider really measured (its own `valid`
 * band, re-checked for a sane finite NDVI); everywhere else is `null`/0 and
 * the client renders it fully transparent. Values are rounded to
 * `RASTER_DECIMALS` — the grid cells the dashboard heatmap shows are derived
 * from these same rounded values, so the two views can never disagree.
 */
export function tiffToNdviRaster(tiff: DecodedTiff, bbox: Bbox, resolutionM: number): NdviRaster {
  const [ndviBand, validBand] = tiff.bands;
  const count = tiff.width * tiff.height;
  const ndvi: (number | null)[] = new Array(count);
  const dataMask: number[] = new Array(count);
  const scale = 10 ** RASTER_DECIMALS;
  for (let i = 0; i < count; i += 1) {
    const value = ndviBand[i];
    const measured =
      (validBand ? validBand[i] >= 0.5 : true) && Number.isFinite(value) && value >= -1.2 && value <= 1.2;
    dataMask[i] = measured ? 1 : 0;
    ndvi[i] = measured ? Math.round(value * scale) / scale : null;
  }
  return {
    bbox: { west: bbox.west, south: bbox.south, east: bbox.east, north: bbox.north },
    width: tiff.width,
    height: tiff.height,
    resolutionM,
    ndvi,
    dataMask,
  };
}

/** Pixels of a decoded raster the provider actually measured (its band 2). */
function measuredPixels(tiff: DecodedTiff): number {
  const [, validBand] = tiff.bands;
  if (!validBand) return tiff.width * tiff.height;
  let count = 0;
  for (let i = 0; i < validBand.length; i += 1) if (validBand[i] >= 0.5) count += 1;
  return count;
}

/** Sentinel Hub / CDSE status → the reason the UI copy is keyed on. */
function reasonForStatus(status: number): NdviFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 408 || status === 504) return "timeout";
  return "http";
}

/* ------------------------------------------------------------------ */
/*  The calls                                                          */
/* ------------------------------------------------------------------ */

/**
 * How a caller judges one decoded scene. The shared flow below needs exactly
 * these three answers, which keeps the grid path and the raster path
 * identical in everything except what they do with the pixels.
 */
export interface SceneScore<T> {
  /** Higher is better; the attempt with the best score wins (first wins ties). */
  quality: number;
  /** True when the scene measured at least something worth returning. */
  ok: boolean;
  /** True when trying an older pass cannot improve the answer. */
  goodEnough: boolean;
  /** Whatever the caller wants back for the winning scene. */
  value: T;
}

/** One scene the shared flow settled on — or why none could be fetched. */
export type SceneOutcome<T> =
  | { ok: true; tiff: DecodedTiff; sceneDate: string | null; cloudCoverPct: number | null; value: T }
  | { ok: false; reason: NdviFailure; status?: number };

interface SceneFetchOptions<T> {
  bbox: Bbox;
  ring: Ring;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  /** Metres per pixel of the Process request (default 10 m). */
  resolutionM?: number;
  /** Evaluates one decoded scene; called once per attempt, newest first. */
  score: (tiff: DecodedTiff) => SceneScore<T>;
}

/**
 * The shared satellite step behind both NDVI consumers: CDSE token → Catalog
 * (passes of the window, newest first, with tile cloud cover) → up to
 * `MAX_PROCESS_ATTEMPTS` Process requests, newest pass first, keeping the
 * attempt the caller's `score` likes best and stopping as soon as one is
 * `goodEnough`. A catalog failure degrades to ONE windowed request
 * (`mostRecent` mosaicking, date and cloud cover unknown) rather than losing
 * NDVI over a metadata call. Never throws; every failure resolves to a typed
 * outcome plus a trace step.
 */
async function fetchSceneRaster<T>(
  config: OpeneoConfig,
  options: SceneFetchOptions<T>,
  fetchImpl: OpeneoFetch,
  trace?: SatelliteTrace,
): Promise<SceneOutcome<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const auth = await getAccessToken(config, fetchImpl, controller.signal, trace);
    if (!auth.ok) return { ok: false, reason: auth.reason };
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${auth.token}`,
    };

    /* ---- 1. Catalog: which passes exist, and how cloudy are they? ------ */
    let candidates: SceneCandidate[] | null = null;
    {
      const startedAt = Date.now();
      try {
        const res = await fetchImpl(config.catalogUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { ...headers, accept: "application/geo+json, application/json" },
          body: JSON.stringify(buildCatalogRequest(options.bbox, options.from, options.to)),
        });
        if (res.ok) {
          candidates = parseCatalog(await res.json());
          trace?.record({
            step: "sh-catalog",
            url: config.catalogUrl,
            status: res.status,
            ok: true,
            note: `${candidates.length} pass(es) in ${options.from}..${options.to}`,
            startedAt,
          });
        } else {
          if (res.status === 401) resetTokenCache();
          trace?.record({
            step: "sh-catalog",
            url: config.catalogUrl,
            status: res.status,
            ok: false,
            body: await res.text().catch(() => ""),
            startedAt,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        trace?.record({
          step: "sh-catalog",
          url: config.catalogUrl,
          status: null,
          ok: false,
          note: error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
          startedAt,
        });
      }
    }

    // A catalog that answered but listed nothing is a real "no scenes".
    if (candidates && candidates.length === 0) return { ok: false, reason: "noScenes" };
    const usable = candidates?.filter((c) => c.cloudCoverPct === null || c.cloudCoverPct <= MAX_SCENE_CLOUD_PCT) ?? null;
    if (usable && usable.length === 0) return { ok: false, reason: "noScenes" };

    /* ---- 2. Process API: the raster for the newest pass(es) ------------ */
    // With no catalog, one windowed request (newest usable pixel wins).
    const attempts: { date: string | null; cloud: number | null; from: string; to: string; order: "leastCC" | "mostRecent" }[] =
      usable
        ? usable.slice(0, MAX_PROCESS_ATTEMPTS).map((c) => ({
            date: c.date,
            cloud: c.cloudCoverPct,
            from: `${c.date}T00:00:00Z`,
            to: `${c.date}T23:59:59Z`,
            order: "leastCC" as const,
          }))
        : [{ date: null, cloud: null, from: `${options.from}T00:00:00Z`, to: `${options.to}T23:59:59Z`, order: "mostRecent" as const }];

    let best: { tiff: DecodedTiff; attempt: (typeof attempts)[number]; score: SceneScore<T> } | null = null;
    let lastFailure: { reason: NdviFailure; status?: number } | null = null;
    for (const attempt of attempts) {
      const startedAt = Date.now();
      const requestBody = buildProcessRequest({
        bbox: options.bbox,
        ring: options.ring,
        from: attempt.from,
        to: attempt.to,
        order: attempt.order,
        ...(options.resolutionM !== undefined ? { resolutionM: options.resolutionM } : {}),
        ...(attempt.date === null ? { maxCloudCoverage: MAX_SCENE_CLOUD_PCT } : {}),
      });
      let res;
      try {
        res = await fetchImpl(config.processUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { ...headers, accept: "image/tiff" },
          body: JSON.stringify(requestBody),
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        trace?.record({
          step: "sh-process",
          url: config.processUrl,
          status: null,
          ok: false,
          note: error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
          startedAt,
        });
        lastFailure = { reason: "network" };
        break;
      }

      if (!res.ok) {
        if (res.status === 401) resetTokenCache();
        trace?.record({
          step: "sh-process",
          url: config.processUrl,
          status: res.status,
          ok: false,
          body: await res.text().catch(() => ""),
          startedAt,
        });
        lastFailure = { reason: reasonForStatus(res.status), status: res.status };
        break; // auth/quota/bad-request will not improve with an older date
      }

      let tiff: DecodedTiff;
      let score: SceneScore<T>;
      try {
        if (!res.arrayBuffer) throw new TiffError("response body is not readable as binary");
        tiff = decodeFloatTiff(new Uint8Array(await res.arrayBuffer()));
        if (tiff.bands.length < 1) throw new TiffError("raster has no bands");
        score = options.score(tiff);
        trace?.record({
          step: "sh-process",
          url: config.processUrl,
          status: res.status,
          ok: true,
          note: `${tiff.width}x${tiff.height}px${attempt.date ? ` scene=${attempt.date}` : " window"}`,
          startedAt,
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        trace?.record({
          step: "sh-process",
          url: config.processUrl,
          status: res.status,
          ok: false,
          note: error instanceof TiffError ? `${TIFF_ERROR_TEXT}: ${error.message}` : TIFF_ERROR_TEXT,
          startedAt,
        });
        lastFailure = { reason: "malformed", status: res.status };
        break;
      }

      if (!best || score.quality > best.score.quality) best = { tiff, attempt, score };
      // Good enough: half of what the caller wanted is measured — an older
      // pass is unlikely to beat it.
      if (score.goodEnough) break;
    }

    if (best) {
      return {
        ok: true,
        tiff: best.tiff,
        sceneDate: best.attempt.date,
        cloudCoverPct: best.attempt.cloud,
        value: best.score.value,
      };
    }
    if (lastFailure) return { ok: false, ...lastFailure };
    return { ok: false, reason: "noScenes" };
  } catch (error) {
    trace?.record({
      step: "sh-process",
      url: config.processUrl,
      status: null,
      ok: false,
      note: controller.signal.aborted ? "timed out" : error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
      startedAt: Date.now(),
    });
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

export interface ProcessNdviOptions {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  bbox: Bbox;
  /** The plot polygon the raster is clipped to. */
  ring: Ring;
  /** Grid cells (already clipped to the plot, built from its real geometry). */
  targets: NdviTarget[];
}

/**
 * The legacy rows/cols path — one mean NDVI per grid cell — kept as the
 * documented fallback behind `CDSE_USE_GRID=1` (and used by nothing else: on
 * the default raster path the cells are derived from the same raster, so both
 * paths read the identical measurement).
 */
export async function fetchNdviProcessApi(
  config: OpeneoConfig,
  options: ProcessNdviOptions,
  fetchImpl?: OpeneoFetch,
  trace?: SatelliteTrace,
): Promise<NdviResult> {
  const empty: NdviResult = { ok: false, cells: [], sceneDate: null, maskedCells: 0, cloudCoverPct: null };
  if (!isConfigured(config)) return { ...empty, reason: "notConfigured" };
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? (fetch as unknown as OpeneoFetch) : undefined);
  if (!doFetch) return { ...empty, reason: "network" };
  const box = options.bbox ?? bboxOf(options.ring);
  // Local pre-flight (already checked upstream by `validateAnalysisInput`); this is
  // NOT a provider answer, so it must never be reported as "malformed".
  if (!box || options.targets.length === 0) return { ...empty, reason: "invalid-input" };

  const outcome = await fetchSceneRaster(
    config,
    {
      bbox: box,
      ring: options.ring,
      from: options.from,
      to: options.to,
      score: (tiff) => {
        const cells = cellMeansFromRaster(tiff, box, options.targets);
        const masked = cells.filter((c) => c.ndvi === null).length;
        const ok = masked < cells.length;
        return {
          quality: -masked,
          ok,
          goodEnough: masked <= Math.floor(cells.length / 2),
          value: { ok, cells, masked },
        };
      },
    },
    doFetch,
    trace,
  );
  if (!outcome.ok) {
    return { ...empty, reason: outcome.reason, ...(outcome.status !== undefined ? { status: outcome.status } : {}) };
  }
  return {
    ok: outcome.value.ok,
    reason: outcome.value.ok ? undefined : "noScenes",
    cells: outcome.value.cells,
    sceneDate: outcome.sceneDate,
    maskedCells: outcome.value.masked,
    cloudCoverPct: outcome.cloudCoverPct,
  };
}

export interface RasterNdviOptions {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  bbox: Bbox;
  /** The plot polygon the raster is clipped to. */
  ring: Ring;
}

export interface NdviRasterResult {
  ok: boolean;
  reason?: NdviFailure;
  raster: NdviRaster | null;
  /** `YYYY-MM-DD` of the Sentinel-2 scene that produced the raster. */
  sceneDate: string | null;
  /** Scene-level cloud cover (%) of that pass, when the catalog reported it. */
  cloudCoverPct: number | null;
  /** Pixels with a real measurement (the transport mask, counted). */
  validPixels: number;
  /** HTTP status, for diagnostics only — never surfaced as agronomic data. */
  status?: number;
}

/**
 * The default satellite step of `/api/field-data`: ONE Process request for
 * the whole plot polygon at 10 m, kept as pixels. The answer is the same
 * 2-band FLOAT32 GeoTIFF the grid path always asked for (NDVI + valid), but
 * nothing is averaged away: the client receives every measured pixel plus
 * `dataMask`, so the NDVI layer can be painted in the parcel's REAL shape.
 * Pixels the provider did not measure stay `null`/0 — never an estimate.
 */
export async function fetchNdviRaster(
  config: OpeneoConfig,
  options: RasterNdviOptions,
  fetchImpl?: OpeneoFetch,
  trace?: SatelliteTrace,
): Promise<NdviRasterResult> {
  const empty: NdviRasterResult = { ok: false, raster: null, sceneDate: null, cloudCoverPct: null, validPixels: 0 };
  if (!isConfigured(config)) return { ...empty, reason: "notConfigured" };
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? (fetch as unknown as OpeneoFetch) : undefined);
  if (!doFetch) return { ...empty, reason: "network" };
  const box = options.bbox ?? bboxOf(options.ring);
  // Local pre-flight; NOT a provider answer, so it is never "malformed".
  if (!box || options.ring.length < 3) return { ...empty, reason: "invalid-input" };
  const resolutionM = rasterResolutionM(box);

  /* How many of the raster's pixel centres fall inside the drawn boundary —
     the denominator that decides whether a half-cloudy pass is good enough or
     an older one is worth a request. Sentinel Hub masks outside-geometry
     pixels itself, so the provider's valid count and this count describe the
     same set of pixels up to edge rounding. */
  const { width, height } = rasterSizeFor(box, resolutionM);
  let polygonPixels = 0;
  for (let y = 0; y < height; y += 1) {
    const lat = box.north - ((y + 0.5) / height) * (box.north - box.south);
    for (let x = 0; x < width; x += 1) {
      const lon = box.west + ((x + 0.5) / width) * (box.east - box.west);
      if (pointInRing(options.ring, [lon, lat])) polygonPixels += 1;
    }
  }

  const outcome = await fetchSceneRaster(
    config,
    {
      bbox: box,
      ring: options.ring,
      from: options.from,
      to: options.to,
      resolutionM,
      score: (tiff) => {
        const valid = measuredPixels(tiff);
        return {
          quality: valid,
          ok: valid > 0,
          goodEnough: valid > 0 && (polygonPixels === 0 || valid >= polygonPixels / 2),
          value: null,
        };
      },
    },
    doFetch,
    trace,
  );
  if (!outcome.ok) {
    return { ...empty, reason: outcome.reason, ...(outcome.status !== undefined ? { status: outcome.status } : {}) };
  }
  const raster = tiffToNdviRaster(outcome.tiff, box, resolutionM);
  let validPixels = 0;
  for (const measured of raster.dataMask) validPixels += measured;
  return {
    ok: validPixels > 0,
    reason: validPixels > 0 ? undefined : "noScenes",
    raster,
    sceneDate: outcome.sceneDate,
    cloudCoverPct: outcome.cloudCoverPct,
    validPixels,
  };
}
