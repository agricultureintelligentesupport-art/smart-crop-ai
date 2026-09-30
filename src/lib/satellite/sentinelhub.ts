/**
 * Sentinel-2 NDVI through the Sentinel Hub **Process API** on the Copernicus
 * Data Space Ecosystem — the default satellite source of `/api/field-data`.
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
 *  3. Locally      — the pixels are averaged inside each grid cell (cells come
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
  const midLat = (bbox.north + bbox.south) / 2;
  const widthM = (bbox.east - bbox.west) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (bbox.north - bbox.south) * 110_574;
  const side = (m: number) => Math.min(MAX_SIDE_PX, Math.max(1, Math.round(m / PIXEL_SIZE_M)));
  return { width: side(widthM), height: side(heightM) };
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
}

export function buildProcessRequest(options: ProcessRequestOptions): Record<string, unknown> {
  const { bbox, ring, from, to, order, maxCloudCoverage } = options;
  const { width, height } = rasterSize(bbox);
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

/** Sentinel Hub / CDSE status → the reason the UI copy is keyed on. */
function reasonForStatus(status: number): NdviFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 408 || status === 504) return "timeout";
  return "http";
}

/* ------------------------------------------------------------------ */
/*  The call                                                           */
/* ------------------------------------------------------------------ */

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
  if (!box || options.targets.length === 0) return { ...empty, reason: "malformed" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const auth = await getAccessToken(config, doFetch, controller.signal, trace);
    if (!auth.ok) return { ...empty, reason: auth.reason };
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${auth.token}`,
    };

    /* ---- 1. Catalog: which passes exist, and how cloudy are they? ------ */
    let candidates: SceneCandidate[] | null = null;
    {
      const startedAt = Date.now();
      try {
        const res = await doFetch(config.catalogUrl, {
          method: "POST",
          signal: controller.signal,
          headers: { ...headers, accept: "application/geo+json, application/json" },
          body: JSON.stringify(buildCatalogRequest(box, options.from, options.to)),
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
    if (candidates && candidates.length === 0) return { ...empty, reason: "noScenes" };
    const usable = candidates?.filter((c) => c.cloudCoverPct === null || c.cloudCoverPct <= MAX_SCENE_CLOUD_PCT) ?? null;
    if (usable && usable.length === 0) return { ...empty, reason: "noScenes" };

    /* ---- 2. Process API: NDVI for the newest pass(es) ------------------- */
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

    let best: NdviResult | null = null;
    let lastFailure: NdviResult | null = null;
    for (const attempt of attempts) {
      const startedAt = Date.now();
      const requestBody = buildProcessRequest({
        bbox: box,
        ring: options.ring,
        from: attempt.from,
        to: attempt.to,
        order: attempt.order,
        ...(attempt.date === null ? { maxCloudCoverage: MAX_SCENE_CLOUD_PCT } : {}),
      });
      let res;
      try {
        res = await doFetch(config.processUrl, {
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
        lastFailure = { ...empty, reason: "network" };
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
        lastFailure = { ...empty, reason: reasonForStatus(res.status), status: res.status };
        break; // auth/quota/bad-request will not improve with an older date
      }

      let cells: NdviCellValue[];
      try {
        if (!res.arrayBuffer) throw new TiffError("response body is not readable as binary");
        const tiff = decodeFloatTiff(new Uint8Array(await res.arrayBuffer()));
        if (tiff.bands.length < 1) throw new TiffError("raster has no bands");
        cells = cellMeansFromRaster(tiff, box, options.targets);
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
        lastFailure = { ...empty, reason: "malformed", status: res.status };
        break;
      }

      const masked = cells.filter((c) => c.ndvi === null).length;
      const candidate: NdviResult = {
        ok: masked < cells.length,
        reason: masked < cells.length ? undefined : "noScenes",
        cells,
        // Without a catalog the acquisition date is genuinely unknown.
        sceneDate: attempt.date,
        maskedCells: masked,
        cloudCoverPct: attempt.cloud,
      };
      if (!best || masked < best.maskedCells) best = candidate;
      // Good enough: at least half of the cells are measured.
      if (masked <= Math.floor(cells.length / 2)) break;
    }

    if (best && best.ok) return best;
    if (lastFailure) return lastFailure;
    return best ?? { ...empty, reason: "noScenes" };
  } catch (error) {
    trace?.record({
      step: "sh-process",
      url: config.processUrl,
      status: null,
      ok: false,
      note: controller.signal.aborted ? "timed out" : error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
      startedAt: Date.now(),
    });
    return { ...empty, reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
