"use client";

/**
 * Owns the saved plot list and its one-per-day real observation, and is the
 * single place the dashboard asks "is there measured data for this parcel yet?".
 *
 * Flow:
 *   1. `listPlots(uid)` on mount (Firestore + localStorage, see `plots.ts`).
 *   2. The active plot is the most recent one unless the user picks another.
 *   3. When the active plot changes — and only then — `POST /api/field-data`
 *      runs. The route answers from its once-a-day cache, so opening the
 *      dashboard repeatedly costs no satellite or weather calls at all.
 *   4. A failed request sets `reason`; the card then explains the failure and
 *      keeps showing no numbers for the affected layers. It never substitutes
 *      a value that was not measured.
 *
 * The response is cached in module state as well, so switching plots back and
 * forth inside a session is instant and free.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { deletePlot, listPlots, readLocalPlots, savePlot, subscribeToPlots } from "./plots";
import type { FieldDataReason, FieldObservation, Plot } from "./types";
import type { Ring } from "@/lib/geo/polygon";

export type FieldDataState = "idle" | "loading" | "ready" | "error";

export interface UseFieldDataResult {
  plots: Plot[];
  activePlot: Plot | null;
  activeId: string | null;
  observation: FieldObservation | null;
  reason: FieldDataReason | null;
  /** Short technical reason of the failing upstream step, for the error card. */
  technical: string | null;
  state: FieldDataState;
  /** True when the observation is a cached reading for an earlier day. */
  stale: boolean;
  loadingPlots: boolean;
  savingPlot: boolean;
  setActivePlot: (plotId: string | null) => void;
  addPlot: (name: string, ring: Ring) => Promise<{ ok: boolean; error?: string; plot?: Plot }>;
  removePlot: (plotId: string) => Promise<void>;
  /** Re-asks the route, bypassing the daily cache. */
  refresh: () => void;
}

interface CachedResponse {
  observation: FieldObservation | null;
  reason: FieldDataReason | null;
  technical: string | null;
  stale: boolean;
  fetchedAt: number;
}

/** Stable empty list, so `useSyncExternalStore` never re-renders for nothing. */
const EMPTY_PLOTS: Plot[] = [];

/** In-memory memo, keyed by plot id — survives tab switches, dies with the page. */
const responseCache = new Map<string, CachedResponse>();

/** Only one request in flight per plot at a time. */
const inFlight = new Map<string, Promise<CachedResponse>>();

/**
 * Ceiling on our own route. The route already bounds its upstreams; this
 * bounds the round trip, so a stalled connection reports "timeout" (a real
 * `FieldDataReason`) instead of pinning the card on a spinner forever.
 */
const OBSERVATION_TIMEOUT_MS = 45_000;

async function requestObservation(plot: Plot, areaHa: number, force: boolean): Promise<CachedResponse> {
  const cached = responseCache.get(plot.id);
  if (!force && cached) return cached;
  const existing = inFlight.get(plot.id);
  if (existing) return existing;

  const job = (async (): Promise<CachedResponse> => {
    const abort = new AbortController();
    const cancel = setTimeout(() => abort.abort(), OBSERVATION_TIMEOUT_MS);
    try {
      const res = await fetch("/api/field-data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid: plot.uid,
          plotId: plot.id,
          ring: plot.ring,
          areaHa,
          force,
        }),
        signal: abort.signal,
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        observation?: FieldObservation | null;
        reason?: FieldDataReason;
        stale?: boolean;
        technical?: string;
      };
      const result: CachedResponse = {
        observation: payload.observation ?? null,
        reason: payload.observation ? null : (payload.reason ?? "network"),
        technical: payload.observation ? null : (payload.technical ?? null),
        stale: Boolean(payload.stale),
        fetchedAt: Date.now(),
      };
      if (result.observation) responseCache.set(plot.id, result);
      return result;
    } catch {
      // A network error to our OWN route is still "no data", never a number.
      return {
        observation: null,
        reason: abort.signal.aborted ? "timeout" : "network",
        technical: null,
        stale: false,
        fetchedAt: Date.now(),
      };
    } finally {
      clearTimeout(cancel);
      inFlight.delete(plot.id);
    }
  })();

  inFlight.set(plot.id, job);
  return job;
}

export function useFieldData(uid: string | null, areaHa: number): UseFieldDataResult {
  /* 1. The plot list is the device store, read through `useSyncExternalStore`.

     This is the same contract as `lib/weather/live.ts`: the store is the one
     source of truth, and React re-renders when it changes. The payoff is that a
     farmer who drew a boundary on a plane, or on a connection too slow for
     Firestore, sees their parcel on the first render — the card never has to
     wait on a network round trip to say "draw your field". */
  const plots = useSyncExternalStore(
    subscribeToPlots,
    () => (uid ? readLocalPlots(uid) : EMPTY_PLOTS),
    () => EMPTY_PLOTS,
  );

  /* 2. The active plot is *derived*: the farmer's explicit pick when it still
        exists, otherwise the most recent boundary. Holding a chosen id rather
        than a resolved one means deleting a plot needs no cleanup effect. */
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [savingPlot, setSavingPlot] = useState(false);
  const [nonce, setNonce] = useState(0);

  const activeId = useMemo(
    () => (chosenId && plots.some((p) => p.id === chosenId) ? chosenId : (plots[0]?.id ?? null)),
    [chosenId, plots],
  );
  const activePlot = useMemo(
    () => plots.find((plot) => plot.id === activeId) ?? null,
    [plots, activeId],
  );

  // Readable from callbacks without re-binding them on every active-plot change.
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /* 3. Pull the account's plots. The store this writes into is what the list
        above is read from, so the map simply updates when it lands. */
  const [accountSynced, setAccountSynced] = useState(false);
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    // Resolving asynchronously keeps this out of the synchronous setState-in-
    // effect path, and the flag only ever means "the first account read is
    // done" — not "there are plots", which is what the map's spinner means.
    listPlots(uid)
      .catch(() => {
        /* the device copy is already on screen; nothing to report */
      })
      .finally(() => {
        if (!cancelled) setAccountSynced(true);
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  /* 4. The observation, tagged with the plot it belongs to. Tagging it lets the
        rest of the hook *derive* the visible value instead of clearing it with
        another setState every time the farmer switches parcels. */
  const [result, setResult] = useState<{ plotId: string; value: CachedResponse } | null>(null);

  useEffect(() => {
    if (!activePlot) return;
    let cancelled = false;
    const force = nonce > 0;
    requestObservation(activePlot, areaHa, force).then((value) => {
      if (!cancelled) setResult({ plotId: activePlot.id, value });
    });
    return () => {
      cancelled = true;
    };
  }, [activePlot, areaHa, nonce]);

  const current = result && activePlot && result.plotId === activePlot.id ? result.value : null;
  const observation = current?.observation ?? null;
  const reason = observation ? null : (current?.reason ?? null);
  const technical = observation ? null : (current?.technical ?? null);
  const stale = current?.stale ?? false;
  const state: FieldDataState = !activePlot
    ? "idle"
    : !current
      ? "loading"
      : current.observation
        ? "ready"
        : "error";

  const addPlot = useCallback(
    async (name: string, ring: Ring): Promise<{ ok: boolean; error?: string; plot?: Plot }> => {
      if (!uid) return { ok: false, error: "no session" };
      setSavingPlot(true);
      try {
        // Editing replaces the boundary of the active plot when there is one,
        // so redrawing is "correct the boundary", not "add a second field".
        const saved = await savePlot(uid, name, ring, activeIdRef.current);
        if (!saved.ok || !saved.plot) return { ok: false, error: saved.error };
        setChosenId(saved.plot.id);
        // The geometry changed: drop the memoised observation for it.
        responseCache.delete(saved.plot.id);
        setNonce((n) => n + 1);
        return { ok: true, plot: saved.plot };
      } finally {
        setSavingPlot(false);
      }
    },
    [uid],
  );

  const removePlot = useCallback(
    async (plotId: string) => {
      if (!uid) return;
      await deletePlot(uid, plotId);
      responseCache.delete(plotId);
      if (activeIdRef.current === plotId) activeIdRef.current = null;
    },
    [uid],
  );

  const setActivePlot = useCallback((plotId: string | null) => {
    activeIdRef.current = plotId;
    setChosenId(plotId);
  }, []);

  const refresh = useCallback(() => {
    if (activeIdRef.current) responseCache.delete(activeIdRef.current);
    setNonce((n) => n + 1);
  }, []);

  return {
    plots,
    activePlot,
    activeId,
    observation,
    reason,
    technical,
    state,
    stale,
    // The spinner means "still checking the account", never "you have no
    // fields" — otherwise a first-time farmer could never open the draw tool.
    loadingPlots: uid !== null && !accountSynced,
    savingPlot,
    setActivePlot,
    addPlot,
    removePlot,
    refresh,
  };
}
