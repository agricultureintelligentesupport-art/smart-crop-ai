"use client";

/**
 * Lazy satellite layers for the plot analysis — the CLIENT half.
 *
 * The plot's NDVI rides on the main field-data observation; every other real
 * layer (NDMI, NDRE, true colour) is its own Process API read, sent ONLY when
 * the farmer selects the layer chip the first time. The answer is cached in
 * memory per plot + scene + layer, so switching layers back and forth is
 * instant and free, and a new NDVI scene (a new `sceneDate`) starts fresh
 * keys — a stale layer can never be painted over a newer scene.
 *
 * Failures are returned typed (never thrown) and are NEVER cached, so the
 * chip's retry button simply asks again.
 */

import type { FieldDataReason, FieldLayerId, FieldLayerResponse, LayerRaster } from "@/lib/field-data/types";

/** One lazy layer's settled answer. */
export interface LayerFetchSuccess {
  ok: true;
  raster: LayerRaster;
}
export interface LayerFetchFailure {
  ok: false;
  reason: FieldDataReason;
  technical: string | null;
}
export type LayerFetchResult = LayerFetchSuccess | LayerFetchFailure;

/** The analysis screen's per-layer state machine (one per lazy layer). */
export interface LazyLayerState {
  fetchId: FieldLayerId;
  status: "idle" | "loading" | "ready" | "error";
  raster: LayerRaster | null;
  reason: FieldDataReason | null;
  technical: string | null;
}

/**
 * The per-layer cache key: plot + scene + layer. Two readings can only share
 * a key when they are the same parcel, the same Sentinel-2 scene and the same
 * layer — everything else is a miss, by construction. The plot id is
 * length-prefixed so a separator inside an id can never bleed two components
 * into a neighbour's key.
 */
export function layerCacheKey(plotId: string, sceneDate: string, layer: FieldLayerId): string {
  return `${plotKeyPrefix(plotId)}${sceneDate}·${layer}`;
}

/** The key prefix shared by every layer of one plot's one scene-set. */
function plotKeyPrefix(plotId: string): string {
  return `${plotId.length}:${plotId}·`;
}

interface CacheEntry {
  raster: LayerRaster;
  fetchedAt: number;
}

/** In-memory layer cache — dies with the page, like the observation memo. */
const layerCache = new Map<string, CacheEntry>();

/** Only one layer request in flight per cache key at a time. */
const inFlight = new Map<string, Promise<LayerFetchResult>>();

/** Same round-trip ceiling the observation request uses. */
const LAYER_TIMEOUT_MS = 45_000;

export interface PlotLayerRequestInput {
  uid: string;
  plotId: string;
  ring: [number, number][];
  layer: FieldLayerId;
  /** The NDVI scene's date — the layer must be read from that same scene. */
  sceneDate: string;
}

export interface PlotLayerRequestOptions {
  /** Bypass the memo (the chip's retry). */
  force?: boolean;
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
}

/** Test/diagnostic seam: the cached raster for a key, when one exists. */
export function cachedPlotLayer(plotId: string, sceneDate: string, layer: FieldLayerId): LayerRaster | null {
  return layerCache.get(layerCacheKey(plotId, sceneDate, layer))?.raster ?? null;
}

/** Test seam: drop everything (or one plot's entries). */
export function resetPlotLayerCache(plotId?: string): void {
  if (plotId === undefined) {
    layerCache.clear();
    return;
  }
  const prefix = plotKeyPrefix(plotId);
  for (const key of layerCache.keys()) {
    if (key.startsWith(prefix)) layerCache.delete(key);
  }
}

/**
 * Asks `/api/field-data/layer` for ONE layer of the NDVI scene, memoised per
 * plot + scene + layer with one in-flight request per key. Never throws: a
 * network failure resolves to `{ ok: false, reason }` like every other
 * satellite read in this app.
 */
export function requestPlotLayer(
  input: PlotLayerRequestInput,
  options?: PlotLayerRequestOptions,
): Promise<LayerFetchResult> {
  const key = layerCacheKey(input.plotId, input.sceneDate, input.layer);
  if (!options?.force) {
    const hit = layerCache.get(key);
    if (hit) return Promise.resolve({ ok: true, raster: hit.raster });
  }
  const existing = inFlight.get(key);
  if (existing) return existing;

  const doFetch = options?.fetchImpl ?? fetch;
  const job = (async (): Promise<LayerFetchResult> => {
    const abort = new AbortController();
    const cancel = setTimeout(() => abort.abort(), LAYER_TIMEOUT_MS);
    try {
      const res = await doFetch("/api/field-data/layer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: input.uid,
          plotId: input.plotId,
          ring: input.ring,
          layer: input.layer,
          sceneDate: input.sceneDate,
        }),
        signal: abort.signal,
      });
      const payload = (await res.json().catch(() => null)) as FieldLayerResponse | null;
      if (!payload || payload.layer !== input.layer || !payload.ok || !payload.raster) {
        return {
          ok: false,
          reason: payload?.reason ?? "malformed",
          technical: payload?.technical ?? null,
        };
      }
      // A newer scene for this plot supersedes the older scene's layers.
      const prefix = plotKeyPrefix(input.plotId);
      for (const cachedKey of layerCache.keys()) {
        if (cachedKey.startsWith(prefix) && cachedKey !== key) layerCache.delete(cachedKey);
      }
      layerCache.set(key, { raster: payload.raster, fetchedAt: Date.now() });
      return { ok: true, raster: payload.raster };
    } catch {
      // A network error to our OWN route is still "no layer", never a number.
      return { ok: false, reason: abort.signal.aborted ? "timeout" : "network", technical: null };
    } finally {
      clearTimeout(cancel);
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, job);
  return job;
}
