/**
 * Minimal openEO client for the Copernicus Data Space Ecosystem.
 *
 * WHY openEO AND NOT "DOWNLOAD A .SAFE FILE"
 * ------------------------------------------
 * A Sentinel-2 L2A product is a ~1 GB SAFE archive of JP2 rasters. A farmer's
 * plot is ~0.02 km² — roughly 200 pixels of the 10 m grid. Downloading a whole
 * tile to average 200 pixels is absurd, so the computation has to happen
 * where the data already lives. openEO is the standard API for that: send a
 * process graph, the back-end runs it and returns only the small aggregate.
 *
 * The single graph this app needs is "mean NDVI inside each of these N
 * polygons", which `aggregate_spatial` answers in ONE call: its specification
 * states that *"For a FeatureCollection multiple values will be computed, one
 * value per contained Feature."* That is what turns one satellite pass into
 * the 16 values behind the heatmap cells.
 *
 * STATUS: LEGACY, BEHIND A FLAG
 * ------------------------------
 * This path runs only when `CDSE_USE_OPENEO=1`. The default NDVI source is the
 * Sentinel Hub Process API (`./sentinelhub.ts`), which accepts the `sh-…` OAuth
 * clients created in the Sentinel Hub dashboard; openEO answered those with a
 * 401/403 ("Copernicus rejected credentials"). Both share the token code below.
 *
 * AUTHENTICATION (verified against the CDSE docs)
 * ----------------------------------------------
 * `client_credentials` against the CDSE realm, then `Authorization: Bearer`.
 * HTTP Basic is *not* used: the openEO spec allows it, but CDSE's own guide
 * documents the token flow, and a token is cached and refreshed here instead of
 * re-sending the secret on every request.
 *
 * Credentials are read from `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET`, which
 * have **no `NEXT_PUBLIC_` prefix** so Next.js never inlines them into the
 * browser bundle. When they are absent the app reports "not configured" and
 * shows no NDVI at all — it never substitutes a simulated value.
 *
 * This module never throws. Every failure resolves to a typed result so the
 * API route can answer with an explicit "no data yet" state.
 */

import { closeRing, type Ring } from "../geo/polygon";
import type { SatelliteTrace } from "./trace";

const DEFAULT_OPENEO_URL = "https://openeo.dataspace.copernicus.eu/openeo/1.2";
const DEFAULT_TOKEN_URL =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const DEFAULT_COLLECTION = "SENTINEL2_L2A";
export const DEFAULT_PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process";
export const DEFAULT_CATALOG_URL = "https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search";

/**
 * Network contract, kept structural so the whole module is unit-testable.
 * `arrayBuffer` is optional because only the Sentinel Hub Process API (binary
 * GeoTIFF answer) needs it; the openEO path reads JSON.
 */
export type OpeneoFetch = (
  input: string,
  init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers: { get(name: string): string | null };
}>;

export interface OpeneoConfig {
  clientId: string | null;
  clientSecret: string | null;
  openEoUrl: string;
  tokenUrl: string;
  collection: string;
  timeoutMs: number;
  /**
   * Sentinel Hub Process API endpoint (default provider). The Catalog API lives
   * on the same host and is derived from it.
   */
  processUrl: string;
  catalogUrl: string;
  /**
   * `CDSE_USE_OPENEO=1` routes NDVI through the legacy openEO graph instead of
   * the Sentinel Hub Process API. OFF by default: an `sh-…` OAuth client
   * (created in the Sentinel Hub dashboard) is accepted by the token endpoint
   * but rejected by openEO.
   */
  useOpeneo: boolean;
}

export function readOpeneoConfig(env: NodeJS.ProcessEnv = process.env): OpeneoConfig {
  const clean = (v: string | undefined) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    clientId: clean(env.CDSE_CLIENT_ID),
    clientSecret: clean(env.CDSE_CLIENT_SECRET),
    openEoUrl: clean(env.CDSE_OPENEO_URL) ?? DEFAULT_OPENEO_URL,
    tokenUrl: clean(env.CDSE_TOKEN_URL) ?? DEFAULT_TOKEN_URL,
    collection: clean(env.CDSE_COLLECTION) ?? DEFAULT_COLLECTION,
    timeoutMs: Number(env.CDSE_TIMEOUT_MS) > 0 ? Number(env.CDSE_TIMEOUT_MS) : 45_000,
    processUrl: clean(env.CDSE_PROCESS_URL) ?? DEFAULT_PROCESS_URL,
    catalogUrl: clean(env.CDSE_CATALOG_URL) ?? DEFAULT_CATALOG_URL,
    useOpeneo: /^(1|true|on|yes)$/i.test(clean(env.CDSE_USE_OPENEO) ?? ""),
  };
}

/** True when a real NDVI query can be attempted at all. */
export function isConfigured(config: OpeneoConfig): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

/* ------------------------------------------------------------------ */
/*  Access token (cached in module scope; server-only)                 */
/* ------------------------------------------------------------------ */

let cachedToken: { value: string; expiresAt: number } | null = null;
let inFlightToken: Promise<TokenResult> | null = null;

/** Refresh a little before expiry so a long graph never races the clock. */
const TOKEN_SAFETY_MS = 60_000;

/**
 * A rejected token and an unreachable token endpoint are different problems
 * and must not be conflated: telling a farmer to "check your credentials" when
 * their connection is down sends them to fix the wrong thing.
 */
export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "auth" | "network" | "timeout" };

async function requestToken(
  config: OpeneoConfig,
  fetchImpl: OpeneoFetch,
  signal: AbortSignal,
  trace?: SatelliteTrace,
): Promise<TokenResult> {
  const startedAt = Date.now();
  try {
    // Credentials go in the form body only — the style every CDSE example uses.
    // (The previous version also sent an `Authorization: Basic` header; RFC 6749
    // §2.3 forbids using more than one client-authentication method at once.)
    const res = await fetchImpl(config.tokenUrl, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId as string,
        client_secret: config.clientSecret as string,
      }).toString(),
    });
    // 400/401/403 from the realm is it rejecting the client (Keycloak answers
    // `invalid_client` with 401 and `unauthorized_client` with 400); anything
    // else is a server or network-side problem, not a credential problem.
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      trace?.record({ step: "cdse-token", url: config.tokenUrl, status: res.status, ok: false, body, startedAt });
      return { ok: false, reason: [400, 401, 403].includes(res.status) ? "auth" : "network" };
    }
    const payload = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    const token = typeof payload.access_token === "string" ? payload.access_token : null;
    if (!token) {
      trace?.record({
        step: "cdse-token",
        url: config.tokenUrl,
        status: res.status,
        ok: false,
        note: "token endpoint answered without an access_token",
        startedAt,
      });
      return { ok: false, reason: "auth" };
    }
    trace?.record({ step: "cdse-token", url: config.tokenUrl, status: res.status, ok: true, startedAt });
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 600;
    cachedToken = { value: token, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 - TOKEN_SAFETY_MS };
    return { ok: true, token };
  } catch (error) {
    trace?.record({
      step: "cdse-token",
      url: config.tokenUrl,
      status: null,
      ok: false,
      note: signal.aborted ? "timed out" : error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
      startedAt,
    });
    return { ok: false, reason: signal.aborted ? "timeout" : "network" };
  }
}

/** Returns a valid access token, reusing the cached one when it is still fresh. */
export async function getAccessToken(
  config: OpeneoConfig,
  fetchImpl: OpeneoFetch,
  signal: AbortSignal,
  trace?: SatelliteTrace,
): Promise<TokenResult> {
  if (!isConfigured(config)) return { ok: false, reason: "auth" };
  if (cachedToken && cachedToken.expiresAt > Date.now()) return { ok: true, token: cachedToken.value };
  if (inFlightToken) return inFlightToken;
  const job = requestToken(config, fetchImpl, signal, trace).finally(() => {
    inFlightToken = null;
  });
  inFlightToken = job;
  return job;
}

/** Test seam: drops the cached token so a suite can re-authenticate. */
export function resetTokenCache(): void {
  cachedToken = null;
  inFlightToken = null;
}

/* ------------------------------------------------------------------ */
/*  Process graph                                                      */
/* ------------------------------------------------------------------ */

/** One polygon to average over, plus the id the result must map back to. */
export interface NdviTarget {
  id: string;
  ring: Ring;
}

export interface NdviGraphOptions {
  collection: string;
  /** "YYYY-MM-DD" inclusive. */
  from: string;
  /** "YYYY-MM-DD" inclusive. */
  to: string;
  /**
   * Search rectangle. The parcel's own bbox: filtering to the tight box keeps
   * the back-end from reading whole tiles before `aggregate_spatial` trims to
   * the real cell polygons.
   */
  bbox: { west: number; south: number; east: number; north: number };
  targets: NdviTarget[];
}

/**
 * Builds the openEO graph: load L2A → clip to the parcel → drop cloud, cloud
 * shadow, cirrus and snow via the SCL band → NDVI from B04/B08 → one mean per
 * cell polygon.
 */
export function buildNdviGraph(options: NdviGraphOptions): Record<string, unknown> {
  const { collection, from, to, bbox, targets } = options;
  const featureCollection = {
    type: "FeatureCollection",
    features: targets.map((target) => ({
      type: "Feature",
      id: target.id,
      properties: { id: target.id },
      geometry: { type: "Polygon", coordinates: [closeRing(target.ring)] },
    })),
  };

  return {
    // B04 = red, B08 = near-infrared, SCL = scene classification (cloud mask).
    load1: {
      process_id: "load_collection",
      arguments: {
        id: collection,
        spatial_extent: { west: bbox.west, east: bbox.east, south: bbox.south, north: bbox.north },
        temporal_extent: [from, to],
        bands: ["B04", "B08", "SCL"],
      },
    },
    scl1: { process_id: "band", arguments: { data: { from_node: "load1" }, name: "SCL" } },
    // 3 cloud · 8 cloud medium probability · 9 cloud high probability
    // 10 thin cirrus · 11 snow. Everything else (vegetation, bare soil, water,
    // shadow) stays — a wheat field is not a cloud.
    mask1: {
      process_id: "filter",
      arguments: {
        data: { from_node: "load1" },
        conditions: {
          process_id: "not",
          arguments: {
            x: {
              process_id: "in",
              arguments: { x: { from_node: "scl1" }, values: [3, 8, 9, 10, 11] },
            },
          },
        },
      },
    },
    ndvi1: {
      process_id: "ndvi",
      arguments: { data: { from_node: "mask1" }, red: "B04", nir: "B08" },
    },
    agg1: {
      process_id: "aggregate_spatial",
      arguments: {
        data: { from_node: "ndvi1" },
        geometries: featureCollection,
        reducer: { process_id: "mean" },
      },
      result: true,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Result mapping                                                     */
/* ------------------------------------------------------------------ */

export interface NdviCellValue {
  id: string;
  /** Mean NDVI in the cell, or `null` when the cell was fully masked (cloud). */
  ndvi: number | null;
}

export type NdviFailure =
  | "notConfigured"
  | "auth"
  | "network"
  | "timeout"
  | "http"
  | "quota"
  | "noScenes"
  | "malformed";

export interface NdviResult {
  ok: boolean;
  reason?: NdviFailure;
  /** `YYYY-MM-DD` of the Sentinel-2 scene that produced the values. */
  sceneDate: string | null;
  cells: NdviCellValue[];
  /** Cells that came back without a usable value. */
  maskedCells: number;
  /** HTTP status, for diagnostics only — never surfaced as agronomic data. */
  status?: number;
  /** Scene-level cloud cover (%) of the pass the values came from, when known. */
  cloudCoverPct?: number | null;
}

const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * openEO back-ends may answer a synchronous aggregation as a GeoJSON
 * `FeatureCollection`, a bare array, a `{ data: [...] }` envelope, or a
 * `features` list with the value in a property. This reads all of them and
 * falls back to positional mapping, which is safe because
 * `aggregate_spatial` is specified to return one value per input Feature *in
 * order*.
 */
export function parseNdviResponse(payload: unknown, targets: NdviTarget[]): { cells: NdviCellValue[]; sceneDate: string | null } {
  const cells: NdviCellValue[] = targets.map((t) => ({ id: t.id, ndvi: null }));
  let sceneDate: string | null = null;

  const noteScene = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return;
    if (sceneDate === null || value > sceneDate) sceneDate = value.slice(0, 10);
  };

  const assign = (index: number, value: unknown) => {
    if (index < 0 || index >= cells.length) return;
    const n = asNumber(value);
    // NDVI is bounded by construction; a wildly out-of-range number means the
    // back-end returned something else (a status code, a string id).
    if (n !== null && n >= -1.2 && n <= 1.2) cells[index].ndvi = n;
  };

  const visitFeature = (feature: unknown, index: number) => {
    // A back-end may answer with a bare array of numbers (or of nulls) in
    // input-feature order. Handle the primitive before assuming an object.
    if (feature === null || typeof feature !== "object") {
      assign(index, feature);
      return;
    }
    const f = feature as { properties?: Record<string, unknown>; id?: unknown; geometry?: { coordinates?: unknown } };
    const props = f.properties ?? {};
    noteScene(props.datetime ?? props.date ?? props["start_datetime"]);
    // Prefer an explicit id match, then fall back to input order.
    const named = typeof props.id === "string" ? cells.findIndex((c) => c.id === props.id) : -1;
    if (named >= 0) {
      assign(named, props.mean ?? props.value ?? props.ndvi);
      return;
    }
    if (typeof f.id === "string") {
      const byId = cells.findIndex((c) => c.id === f.id);
      if (byId >= 0) {
        assign(byId, props.mean ?? props.value ?? props.ndvi);
        return;
      }
    }
    assign(index, props.mean ?? props.value ?? props.ndvi);
  };

  if (Array.isArray(payload)) {
    payload.forEach((item, index) => visitFeature(item, index));
  } else if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.features)) {
      p.features.forEach((feature, index) => visitFeature(feature, index));
    } else if (Array.isArray(p.data)) {
      p.data.forEach((item, index) => {
        if (Array.isArray(item)) {
          // openEO temporal aggregation: [date, value] pairs per geometry.
          noteScene(item[0]);
          assign(index, item[1]);
        } else {
          assign(index, item);
        }
      });
    } else if (p.properties && typeof p.properties === "object") {
      visitFeature(p, 0);
    }
  }
  return { cells, sceneDate };
}

/** Classifies an HTTP status into the reason the UI should show. */
function reasonForStatus(status: number): NdviFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 408 || status === 504) return "timeout";
  if (status === 404) return "noScenes";
  return "http";
}

/**
 * Runs the graph synchronously and maps the answer. If the back-end decides the
 * job is too big and returns `202 Accepted`, the job is polled a bounded
 * number of times — aggregation over a handful of polygons is small, so this is
 * a safety net rather than the normal path.
 */
export async function fetchNdvi(
  config: OpeneoConfig,
  options: NdviGraphOptions,
  fetchImpl?: OpeneoFetch,
  trace?: SatelliteTrace,
): Promise<NdviResult> {
  const targets = options.targets;
  const empty: NdviResult = { ok: false, cells: [], sceneDate: null, maskedCells: 0 };
  if (!isConfigured(config)) return { ...empty, reason: "notConfigured" };
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? (fetch as unknown as OpeneoFetch) : undefined);
  if (!doFetch) return { ...empty, reason: "network" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const auth = await getAccessToken(config, doFetch, controller.signal, trace);
    if (!auth.ok) return { ...empty, reason: auth.reason };
    const token = auth.token;

    const resultUrl = `${config.openEoUrl.replace(/\/+$/, "")}/result`;
    let startedAt = Date.now();
    let res = await doFetch(resultUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ process_graph: buildNdviGraph({ ...options, collection: config.collection }) }),
    });

    // Bounded batch fallback: follow `Location` for a small number of polls.
    let polls = 0;
    let lastUrl = resultUrl;
    while (res.status === 202 && polls < 8) {
      const location = res.headers.get("location");
      if (!location) break;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (polls + 1)));
      startedAt = Date.now();
      lastUrl = location;
      res = await doFetch(location, {
        signal: controller.signal,
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      });
      polls += 1;
    }

    const step = polls > 0 ? "openeo-poll" : "openeo-result";
    if (!res.ok) {
      trace?.record({ step, url: lastUrl, status: res.status, ok: false, body: await res.text().catch(() => ""), startedAt });
      return { ...empty, reason: reasonForStatus(res.status), status: res.status };
    }
    trace?.record({ step, url: lastUrl, status: res.status, ok: true, startedAt });

    const payload = (await res.json()) as unknown;
    const { cells, sceneDate } = parseNdviResponse(payload, targets);
    const maskedCells = cells.filter((c) => c.ndvi === null).length;
    if (maskedCells === cells.length) return { ok: false, reason: "noScenes", cells, sceneDate, maskedCells };
    return { ok: true, cells, sceneDate, maskedCells };
  } catch (error) {
    trace?.record({
      step: "openeo-result",
      url: config.openEoUrl,
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
