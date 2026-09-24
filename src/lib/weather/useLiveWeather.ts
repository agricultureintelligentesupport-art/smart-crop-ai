"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { weatherFor, type WeatherSnapshot } from "@/lib/agronomy";
import { getWilaya } from "@/lib/wilayas";
import { fetchLiveSnapshot, isFresh, readLiveCache, subscribeToWeatherCache } from "./live";

/** Where the current snapshot's numbers come from. */
export type WeatherSource = "live" | "reference";

export interface LiveWeatherState {
  /** Live snapshot when available, otherwise the static reference one. */
  snapshot: WeatherSnapshot;
  source: WeatherSource;
  /** Epoch ms of the successful live fetch backing `snapshot` (null in reference mode). */
  fetchedAt: number | null;
}

/**
 * Live weather for a wilaya with a safe fallback chain:
 *
 *   fresh cache (≤1 h) ──────────────→ shown immediately
 *   stale cache         ─────────────→ shown (its fetch time stays visible)
 *                                      while a background refresh runs
 *   no cache            ─────────────→ reference values shown while fetching
 *   fetch fails         ─────────────→ whatever is showing stays (never breaks)
 *
 * SSR-safe: the external store reads `null` on the server (and during
 * hydration), so SSR markup always uses the deterministic reference
 * snapshot — no hydration mismatch. After hydration, React picks up a
 * cached/fetched live entry through the store subscription (the fetch writes
 * into the cache, and cache writes notify subscribers) — no setState in an
 * effect.
 */
export function useLiveWeather(wilayaCode: string | null | undefined): LiveWeatherState {
  // Deterministic reference — identical on server and client.
  const reference = useMemo(() => weatherFor(wilayaCode), [wilayaCode]);
  // getWilaya's default-wilaya semantics give us a stable cache key.
  const code = getWilaya(wilayaCode).code;

  const subscribe = useCallback((onStoreChange: () => void) => subscribeToWeatherCache(onStoreChange), []);
  const cached = useSyncExternalStore(subscribe, () => readLiveCache(code), () => null);

  // Revalidate in the background when nothing fresh is showing. A failed
  // fetch writes nothing to the cache, so the UI keeps whatever it shows.
  useEffect(() => {
    if (cached && isFresh(cached.fetchedAt)) return;
    void fetchLiveSnapshot(getWilaya(code));
  }, [code, cached]);

  if (cached) {
    return { snapshot: cached.snapshot, source: "live", fetchedAt: cached.fetchedAt };
  }
  return { snapshot: reference, source: "reference", fetchedAt: null };
}
