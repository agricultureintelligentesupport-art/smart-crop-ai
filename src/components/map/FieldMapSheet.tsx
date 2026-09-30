"use client";

/**
 * The field map: Leaflet over free Esri World Imagery, with Leaflet.draw for
 * the boundary itself.
 *
 * WHY THE MAP IS SPLIT AND DYNAMICALLY IMPORTED
 * ---------------------------------------------
 * Leaflet touches `window` at import time and injects its own stylesheet, so it
 * cannot run during SSR. `FieldMapSheet` (this file) owns everything that can
 * render on the server — sheet chrome, toolbar, plot list, error and empty
 * states — and delegates only the canvas to `FieldMapCanvas`, which
 * `next/dynamic` loads with `ssr: false`.
 *
 * The two talk through a small imperative handle (`MapHandle`) instead of
 * sharing a Leaflet instance through module-level state: the canvas owns the
 * map, and the toolbar calls `startDraw` / `clear` on it. That keeps every
 * Leaflet type inside the canvas file and makes the commands testable.
 *
 * TILE LAYER
 * ----------
 * Esri World Imagery is free to display with attribution and needs no API key
 * or account. It is the only basemap: a keyed provider (Mapbox, Google) would
 * contradict the "free, no credentials" constraint of the rest of this feature.
 * Attribution is rendered in Leaflet's own control and must stay on screen.
 *
 * DRAWING
 * -------
 * A standard `L.Draw.Polygon` handler: tap to drop vertices, tap the first
 * vertex to close. The resulting ring is normalised and validated in
 * `lib/geo/polygon` before the caller ever sees it, so the UI can state a real
 * reason ("encloses 0.004 ha, under the 0.05 ha minimum") instead of a
 * generic failure.
 *
 * Coordinates: Leaflet works in `[lat, lng]`, GeoJSON in `[lng, lat]`. The
 * conversion happens at this boundary and nowhere else.
 */

import dynamic from "next/dynamic";
import { AnimatePresence } from "framer-motion";
import PlotView from "@/components/plot/PlotView";
import StepHeader from "@/components/plot/StepHeader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, LocateFixed, Map as MapIcon, Undo2, X } from "lucide-react";
import type { Lang } from "@/lib/wilayas";
import type { Plot } from "@/lib/field-data/types";
import { ringAreaHa, validatePlot, type Ring } from "@/lib/geo/polygon";
import type { Place } from "@/lib/geo/places";
import MapSearch from "./MapSearch";

export interface FieldMapSheetCopy {
  title: string;
  subtitle: string;
  draw: string;
  drawing: string;
  clear: string;
  cancel: string;
  save: string;
  saving: string;
  delete: string;
  namePlaceholder: string;
  noPlots: string;
  noPlotsHint: string;
  loading: string;
  areaLabel: string;
  errorTooSmall: string;
  errorGeneric: string;
  /** The drawn boundary crosses itself, so it has no area and cannot be used. */
  errorCrossing: string;
  /** Close the polygon being drawn. */
  finish: string;
  attribution: string;
  openMaps: string;
  mapTitle: string;
  use: string;
  /** Location search (/api/geocode → Nominatim) input placeholder — Arabic or French place names. */
  searchPlaceholder: string;
  /** Network/geocoder failure — retryable, shown with the retry action. */
  searchError: string;
  /** Search answered with zero results. */
  searchNoResults: string;
  /** Retry action after a search failure. */
  searchRetry: string;
  /** Clear the search input (✕ button). */
  searchClear: string;
  /** Accessible name of the search input. */
  searchLabel: string;
  /** Remove the last vertex placed while drawing. */
  undo: string;
  /** Fly the map to the device's current location. */
  locate: string;
  /** Shown while the GPS fix is being taken. */
  locating: string;
  /** GPS permission denied or unavailable; the map kept its fallback view. */
  locateDenied: string;
  /** `{area}` — live area of the boundary being drawn. */
  liveArea: string;
}

/** Zoom after choosing a search result — single-field drawing scale. */
const SEARCH_RESULT_ZOOM = 16;

/** Imperative commands the toolbar can issue to the map. */
export interface MapHandle {
  /** Begin a new polygon. Resolves false when the map is not ready yet. */
  startDraw: () => Promise<boolean>;
  /** Close the polygon the farmer has drawn, if it is a usable shape. */
  finishDraw: () => void;
  /** Remove the last vertex placed while drawing. */
  undoDraw: () => void;
  /** Discard the in-progress polygon. */
  clear: () => void;
  /** True while a polygon is being drawn. */
  isDrawing: () => boolean;
  /** Fly the map to the device's current location. Resolves false when denied. */
  locate: () => Promise<boolean>;
  /** Fly the map to a searched place. Draws nothing — the jump is the feature. */
  flyTo: (lat: number, lng: number, zoom?: number) => void;
  /** Repaint the saved-plot layer and optionally frame the active plot. */
  syncPlots: (plots: Plot[], activeId: string | null, fit?: boolean) => void;
}

const FieldMapCanvas = dynamic(() => import("./FieldMapCanvas"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center bg-emerald-50/60">
      <Loader2 size={22} className="animate-spin text-emerald-600" aria-hidden />
    </div>
  ),
});

export default function FieldMapSheet({
  onClose,
  plots,
  activeId,
  loading,
  onSave,
  onDelete,
  onActivate,
  copy,
  lang,
  busy = false,
  fallbackCenter,
  initialPlot = null,
}: {
  onClose: () => void;
  plots: Plot[];
  activeId: string | null;
  loading: boolean;
  onSave: (name: string, ring: Ring) => Promise<{ ok: boolean; error?: string; plot?: Plot }>;
  onDelete: (plotId: string) => Promise<void>;
  onActivate: (plotId: string | null) => void;
  copy: FieldMapSheetCopy;
  lang: Lang;
  busy?: boolean;
  /** Wilaya-capital fallback for the opening view, `[lat, lng]`. */
  fallbackCenter?: [number, number];
  /**
   * Opens straight on this plot's confirm screen instead of the map — the
   * «عرض القطعة» action on Home. Presentation only: the plot itself, the
   * drawing commands and every save are untouched.
   */
  initialPlot?: Plot | null;
}) {
  const [viewPlot, setViewPlot] = useState<Plot | null>(initialPlot);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [draft, setDraft] = useState<Ring | null>(null);
  // Pre-filled with the active plot's name, so "edit boundary" opens on the
  // existing one. The sheet is mounted per session, so this cannot go stale.
  const [name, setName] = useState(() => plots.find((p) => p.id === activeId)?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  /** Live area (ha) of the in-progress boundary — the farmer draws to a size. */
  const [drawingArea, setDrawingArea] = useState<number | null>(null);
  /** True while a GPS fix is being requested by the toolbar button. */
  const [locating, setLocating] = useState(false);
  /** The Leaflet canvas reports itself ready; drawing is impossible before that. */
  const [mapReady, setMapReady] = useState(false);
  const handleRef = useRef<MapHandle | null>(null);
  const drawButtonRef = useRef<HTMLButtonElement>(null);

  const draftAreaHa = useMemo(() => (draft ? ringAreaHa(draft) : null), [draft]);
  const valid = useMemo(() => (draft ? validatePlot(draft).ok : false), [draft]);

  // The dashboard mounts this sheet only while the map is open, so every
  // session starts with clean state and a canvas that has not mounted yet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !viewPlot) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewPlot]);

  const startDraw = useCallback(async () => {
    // `startDraw` can only fail if the canvas has not mounted yet, and the
    // button is disabled until it has — so this is a guard, not a normal path.
    const started = (await handleRef.current?.startDraw()) ?? false;
    setDrawing(started);
    setError(started ? null : copy.errorGeneric);
  }, [copy.errorGeneric]);

  const clearDraft = useCallback(() => {
    handleRef.current?.clear();
    setDraft(null);
    setDrawingArea(null);
    setDrawing(false);
  }, []);

  const undoVertex = useCallback(() => {
    handleRef.current?.undoDraw();
  }, []);

  const locateMe = useCallback(async () => {
    setLocating(true);
    setError(null);
    const ok = await (handleRef.current?.locate() ?? Promise.resolve(false));
    setLocating(false);
    if (!ok) setError(copy.locateDenied);
  }, [copy.locateDenied]);

  /** Search result chosen: fly there at single-field drawing scale. */
  const flyToPlace = useCallback((place: Place) => {
    handleRef.current?.flyTo(place.lat, place.lng, SEARCH_RESULT_ZOOM);
  }, []);

  const saveDraft = useCallback(async (ring: Ring) => {
    if (savingRef.current || busy) return;
    if (!validatePlot(ring).ok) { setError(copy.errorTooSmall); return; }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      // Same onSave pipeline. Its returned persisted record gives us the real
      // ID/date immediately, without racing the subscribed plot-list render.
      const result = await onSave(name.trim() || (lang === "ar" ? "قطعتي" : "Ma parcelle"), ring);
      if (!mountedRef.current) return;
      if (!result.ok || !result.plot) { setError(result.error ?? copy.errorGeneric); return; }
      setName(result.plot.name);
      setViewPlot(result.plot);
      clearDraft();
    } catch { if (mountedRef.current) setError(copy.errorGeneric); }
    finally { savingRef.current = false; if (mountedRef.current) setSaving(false); }
  }, [busy, name, lang, onSave, clearDraft, copy]);

  const handleSave = useCallback(() => {
    if (draft) void saveDraft(draft);
  }, [draft, saveDraft]);

  return (
    <>
    <div
      inert={!!viewPlot}
      aria-hidden={!!viewPlot}
      style={viewPlot ? { visibility: "hidden" } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      className="fixed inset-0 z-50 flex bg-emerald-950/45 sm:items-center sm:justify-center sm:p-6"
    >
      <div className="flex h-full w-full max-w-2xl flex-col overflow-hidden bg-[#f6fbf8] sm:h-[88dvh] sm:rounded-[1.5rem] sm:shadow-[0_30px_70px_-40px_rgba(6,78,59,0.8)]">
        {/* Step 1 of the flow, the search bar under it, the map, one bar. */}
        <header className="shrink-0 border-b border-emerald-900/10 bg-[#f6fbf8] px-4 pb-2.5 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label={copy.cancel}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white text-emerald-900/70 ring-1 ring-emerald-900/10 transition-colors hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
            >
              <X size={19} strokeWidth={2.6} aria-hidden />
            </button>
            <h2 className="min-w-0 flex-1 truncate text-[15px] font-black leading-tight text-emerald-950">
              {copy.title}
            </h2>
          </div>
          {/* Full width: beside the close button the three step labels no longer
              fit side by side, and a truncated step is worse than a taller row. */}
          <div className="mt-1.5">
            <StepHeader current={1} lang={lang} />
          </div>
          <p className="mt-1.5 text-[11.5px] font-semibold leading-5 text-emerald-900/55">{copy.subtitle}</p>
        </header>

        <div className="relative min-h-0 flex-1" inert={saving}>
          <FieldMapCanvas
            plots={plots}
            activeId={activeId}
            fallbackCenter={fallbackCenter}
            onDraftChange={(ring) => {
              setDraft(ring);
              if (ring) {
                setDrawing(false);
                setDrawingArea(null);
                void saveDraft(ring);
              }
            }}
            onDrawingArea={setDrawingArea}
            onPick={(plot) => { onActivate(plot.id); setName(plot.name); setViewPlot(plot); }}
            onReady={(handle) => {
              handleRef.current = handle;
              setMapReady(true);
            }}
            onDrawingChange={setDrawing}
            onInvalid={() => {
              setDrawing(false);
              setDrawingArea(null);
              setError(copy.errorCrossing);
            }}
            onLocateResult={(ok) => {
              if (!ok) setError(copy.locateDenied);
            }}
            lang={lang}
            ariaLabel={copy.mapTitle}
          />

          {/* Place search: floats over the canvas, top-centre (opposite corner
              from the zoom buttons), and only ever flies the map — it draws
              nothing. Hidden while drawing, whose toolbar owns the sheet. */}
          {!drawing && (
            <MapSearch
              copy={{
                placeholder: copy.searchPlaceholder,
                label: copy.searchLabel,
                noResults: copy.searchNoResults,
                error: copy.searchError,
                retry: copy.searchRetry,
                clear: copy.searchClear,
              }}
              lang={lang}
              onSelect={flyToPlace}
            />
          )}

          {loading && (
            <div
              className={`absolute inset-x-0 mx-auto w-max rounded-full bg-emerald-950/85 px-3 py-1.5 text-[11px] font-bold text-white ${
                drawing ? "top-3" : "top-[4.6rem]"
              }`}
            >
              {copy.loading}
            </div>
          )}

          {/* GPS jump: thumb-reachable, away from the search control (top-end)
              and the zoom buttons (top-start). */}
          {!drawing && mapReady && (
            <button
              type="button"
              onClick={locateMe}
              disabled={locating}
              aria-label={locating ? copy.locating : copy.locate}
              className="absolute bottom-3 end-3 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-600 text-white shadow-[0_14px_28px_-12px_rgba(6,78,59,0.8)] hover:bg-emerald-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
            >
              {locating ? (
                <Loader2 size={18} className="animate-spin" aria-hidden />
              ) : (
                <LocateFixed size={18} strokeWidth={2.6} aria-hidden />
              )}
            </button>
          )}

          {/* While drawing, the live area and the undo / finish actions live in
              the bottom bar below — one place for every action, nothing on top
              of the map the farmer is tracing on. */}
        </div>

        {/* ---------- the one bar: live area, two icon tools, one button ---------- */}
        <footer
          inert={saving}
          className="shrink-0 border-t border-emerald-900/10 bg-[#f6fbf8] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5"
        >
          {error && (
            <p
              role="alert"
              className="mb-2 rounded-[0.9rem] bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-900 ring-1 ring-amber-200/70"
            >
              {error}
            </p>
          )}

          {saving && (
            <p role="status" className="mb-2 text-center text-[11.5px] font-bold text-emerald-900">
              {copy.saving}
            </p>
          )}

          {/* Saved boundaries: the way back into a plot already drawn. */}
          {plots.length > 0 && (
            <ul className="no-scrollbar mb-2 flex gap-1.5 overflow-x-auto">
              {plots.map((plot) => (
                <li key={plot.id} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => { onActivate(plot.id); setName(plot.name); setViewPlot(plot); }}
                    aria-pressed={plot.id === activeId}
                    className={`flex min-h-[2.5rem] items-center gap-1.5 rounded-full px-3 text-[11px] font-extrabold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45 ${
                      plot.id === activeId
                        ? "bg-emerald-600 text-white"
                        : "bg-white text-emerald-900/70 ring-1 ring-emerald-900/10"
                    }`}
                  >
                    <MapIcon size={11} strokeWidth={2.8} aria-hidden />
                    {plot.name} · {plot.areaHa.toFixed(2)} ha
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Live area: the farmer draws to a size, so the size gets its own
              line at full width — never truncated next to the tools. */}
          {(drawing || draft) && (
            <p
              role="status"
              className="mb-2 flex min-h-[2.5rem] items-center gap-2 rounded-[0.9rem] bg-white px-3 text-[12.5px] font-black text-emerald-950 ring-1 ring-emerald-900/10"
            >
              <span className="truncate">
                {drawing
                  ? drawingArea === null
                    ? copy.drawing
                    : copy.liveArea.replace("{area}", drawingArea.toFixed(3))
                  : draftAreaHa === null
                    ? copy.drawing
                    : `${draftAreaHa.toFixed(3)} ${copy.areaLabel}`}
              </span>
            </p>
          )}

          <div className="flex items-center gap-2">
            {drawing && (
              <button
                type="button"
                onClick={undoVertex}
                aria-label={copy.undo}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-[0.9rem] bg-white text-emerald-900/80 ring-1 ring-emerald-900/10 transition-colors hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
              >
                <Undo2 size={17} strokeWidth={2.6} aria-hidden />
              </button>
            )}

            {(drawing || draft) && (
              <button
                type="button"
                onClick={clearDraft}
                disabled={saving || busy}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-[0.9rem] bg-white text-[11px] font-extrabold text-emerald-900/80 ring-1 ring-emerald-900/10 transition-colors hover:bg-emerald-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
              >
                {copy.clear}
              </button>
            )}

            {/* The single primary action of the draw screen: start, close the
                shape, or save it. */}
            <button
              type="button"
              ref={drawButtonRef}
              onClick={draft && !drawing ? handleSave : drawing ? () => handleRef.current?.finishDraw() : startDraw}
              disabled={!mapReady || saving || busy || Boolean(draft) && !valid}
              className="flex min-h-[2.75rem] flex-1 items-center justify-center gap-1.5 rounded-[0.9rem] bg-emerald-600 px-5 text-[12.5px] font-extrabold text-white transition-colors hover:bg-emerald-700 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
            >
              {busy || saving
                ? copy.saving
                : drawing
                  ? copy.finish
                  : draft
                    ? copy.save
                    : copy.draw}
            </button>
          </div>

          {plots.length === 0 && !loading && (
            <p className="mt-2 text-[11px] font-semibold leading-5 text-emerald-900/55">
              {copy.noPlots} {copy.noPlotsHint}
            </p>
          )}

          <p className="mt-1.5 text-[9.5px] font-semibold leading-4 text-emerald-900/40">{copy.attribution}</p>
        </footer>
      </div>
    </div>
    <AnimatePresence onExitComplete={() => drawButtonRef.current?.focus({ preventScroll: true })}>
      {viewPlot && <PlotView
        key={viewPlot.id}
        plot={viewPlot}
        lang={lang}
        onBack={() => setViewPlot(null)}
        onRedraw={() => { setViewPlot(null); void startDraw(); }}
        onDelete={onDelete}
        onRename={(updated) => { setViewPlot(updated); setName(updated.name); }}
      />}
    </AnimatePresence>
    </>
  );
}
