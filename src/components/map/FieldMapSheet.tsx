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
 * THE «تم» REVIEW (stage 1)
 * -------------------------
 * Tapping «تم» stays in this sheet and enters the review state: the boundary is
 * saved through the same `onSave` pipeline as before, the map glides to a
 * fitBounds framing of the polygon, and the plot is isolated — everything
 * outside it dimmed and frosted by `plotIsolate.ts`, the boundary itself crisp
 * with a clean emerald outline — with the real area in hectares. The drawing
 * controls are replaced by exactly two actions: «تحليل القطعة» (disabled until
 * stage 2 wires the satellite pipeline to it) and «إعادة الرسم» (back to
 * drawing; the saved boundary stays on the map as the reference to correct,
 * and the next «تم» replaces it in place).
 *
 * Coordinates: Leaflet works in `[lat, lng]`, GeoJSON in `[lng, lat]`. The
 * conversion happens at this boundary and nowhere else.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { CheckCircle2, Loader2, LocateFixed, Map as MapIcon, RotateCcw, Sparkles, Trash2, Undo2 } from "lucide-react";
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
  /** Status chip while the boundary is being persisted (auto-saved on «تم»). */
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
  /** Review state after «تم»: caption above the isolated plot's area. */
  isolatedAreaLabel: string;
  /** The stage-2 action — disabled until the satellite pipeline is wired to it. */
  analyze: string;
  /** Tooltip / accessible explanation of why the action is disabled for now. */
  analyzeSoon: string;
  /** Leave the review and draw the boundary again. */
  redraw: string;
  /** Confirmation that the boundary was saved. */
  saved: string;
}

/** Zoom after choosing a search result — single-field drawing scale. */
const SEARCH_RESULT_ZOOM = 16;

/**
 * The plot's real area, in hectares, with precision matched to its size:
 * a 0.05 ha minimum needs three decimals to be readable; a 400 ha
 * operation does not.
 */
const formatHa = (ha: number | null): string => {
  if (ha === null) return "—";
  if (ha >= 100) return ha.toFixed(1);
  if (ha >= 10) return ha.toFixed(2);
  return ha.toFixed(3);
};

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
}: {
  onClose: () => void;
  plots: Plot[];
  activeId: string | null;
  loading: boolean;
  onSave: (name: string, ring: Ring) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (plotId: string) => Promise<void>;
  onActivate: (plotId: string | null) => void;
  copy: FieldMapSheetCopy;
  lang: Lang;
  busy?: boolean;
  /** Wilaya-capital fallback for the opening view, `[lat, lng]`. */
  fallbackCenter?: [number, number];
}) {
  const [draft, setDraft] = useState<Ring | null>(null);
  // Pre-filled with the active plot's name, so "edit boundary" opens on the
  // existing one. The sheet is mounted per session, so this cannot go stale.
  const [name, setName] = useState(() => plots.find((p) => p.id === activeId)?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  /**
   * The post-«تم» review: true while the drawn plot is spotlighted on the map
   * with the two stage-1 actions. `draft` holds the reviewed ring.
   */
  const [isolated, setIsolated] = useState(false);
  /** Where the automatic save behind «تم» stands — drives the review chip. */
  const [saveState, setSaveState] = useState<"idle" | "busy" | "saved" | "error">("idle");
  /** Why the boundary could not be saved, in the farmer's language. */
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Live area (ha) of the in-progress boundary — the farmer draws to a size. */
  const [drawingArea, setDrawingArea] = useState<number | null>(null);
  /** True while a GPS fix is being requested by the toolbar button. */
  const [locating, setLocating] = useState(false);
  /** The Leaflet canvas reports itself ready; drawing is impossible before that. */
  const [mapReady, setMapReady] = useState(false);
  const handleRef = useRef<MapHandle | null>(null);

  const draftAreaHa = useMemo(() => (draft ? ringAreaHa(draft) : null), [draft]);
  const reduceMotion = useReducedMotion();

  // The dashboard mounts this sheet only while the map is open, so every
  // session starts with clean state and a canvas that has not mounted yet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  /* «تم» = confirm and save, through the exact pipeline «حفظ» used. One
     attempt per drawn boundary: the ring's object identity marks the commit,
     so a redraw of the same shape or a plots refresh never saves twice — and
     the guard doubles as the staleness check when the promise lands. */
  const committedRef = useRef<Ring | null>(null);

  /** Save the boundary the farmer just confirmed with «تم». */
  const commitDraft = useCallback(
    (ring: Ring) => {
      if (committedRef.current === ring) return;
      committedRef.current = ring;

      if (!validatePlot(ring).ok) {
        // Below the minimum or unusable: say why, keep the review open —
        // «إعادة الرسم» is the way out.
        setSaveState("error");
        setSaveError(copy.errorTooSmall);
        return;
      }
      setSaveState("busy");
      setSaveError(null);
      onSave(name, ring).then((result) => {
        // A newer boundary may already own the review; its result wins.
        if (committedRef.current !== ring) return;
        if (result.ok) {
          setSaveState("saved");
          setSaveError(null);
        } else {
          setSaveState("error");
          setSaveError(result.error ?? copy.errorGeneric);
        }
      });
    },
    [onSave, name, copy],
  );

  /** «إعادة الرسم»: leave the review and draw again. The saved boundary stays
      on the map as the reference to correct; the next «تم» replaces it. */
  const beginDrawing = useCallback(() => {
    setIsolated(false);
    setSaveState("idle");
    setSaveError(null);
    void startDraw();
  }, [startDraw]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      className="fixed inset-0 z-50 flex items-end justify-center bg-emerald-950/45 sm:items-center sm:p-6"
    >
      <div className="flex h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-[1.5rem] bg-[#f6fbf8] sm:h-[88dvh] sm:rounded-[1.5rem]">
        <header className="flex items-start justify-between gap-3 border-b border-emerald-900/10 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-black text-emerald-950">{copy.title}</h2>
            <p className="mt-0.5 text-[11.5px] font-semibold leading-5 text-emerald-900/60">{copy.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={copy.cancel}
            className="flex h-11 min-w-11 items-center justify-center rounded-full text-[13px] font-extrabold text-emerald-900/70 hover:bg-emerald-900/5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
          >
            ✕
          </button>
        </header>

        <div className="relative min-h-0 flex-1">
          <FieldMapCanvas
            plots={plots}
            activeId={activeId}
            fallbackCenter={fallbackCenter}
            isolateRing={isolated ? draft : null}
            onDraftChange={(ring) => {
              setDraft(ring);
              if (ring) {
                // «تم» closed a usable shape: save it and review it in place.
                setDrawing(false);
                setDrawingArea(null);
                setIsolated(true);
                commitDraft(ring);
              } else {
                // Redraw / clear: the review (if any) is over.
                setIsolated(false);
                setSaveState("idle");
                setSaveError(null);
              }
            }}
            onDrawingArea={setDrawingArea}
            onPick={(plot) => onActivate(plot.id)}
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
              and the zoom buttons (top-start). Hidden while drawing or during
              the «تم» review — the review bar owns the bottom strip. */}
          {!drawing && !isolated && mapReady && (
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

          {/* While drawing: live area so the farmer can stop at the right size,
              plus undo / finish / cancel within thumb reach. All ≥ 44 px. */}
          {drawing && (
            <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-center gap-2 rounded-[1.1rem] bg-white/95 p-2.5 shadow-[0_18px_40px_-22px_rgba(6,78,59,0.7)]">
              <span className="text-[11.5px] font-black leading-5 text-emerald-950">
                {drawingArea === null
                  ? copy.drawing
                  : copy.liveArea.replace("{area}", drawingArea.toFixed(3))}
              </span>
              <div className="ms-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={undoVertex}
                  aria-label={copy.undo}
                  className="flex min-h-[2.75rem] items-center gap-1 rounded-full bg-emerald-900/5 px-3 text-[11px] font-extrabold text-emerald-900/80 hover:bg-emerald-900/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
                >
                  <Undo2 size={14} strokeWidth={2.6} aria-hidden />
                  {copy.undo}
                </button>
                <button
                  type="button"
                  onClick={clearDraft}
                  className="flex min-h-[2.75rem] items-center rounded-full bg-emerald-900/5 px-3 text-[11px] font-extrabold text-emerald-900/80 hover:bg-emerald-900/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
                >
                  {copy.clear}
                </button>
                <button
                  type="button"
                  onClick={() => handleRef.current?.finishDraw()}
                  className="flex min-h-[2.75rem] items-center rounded-full bg-emerald-600 px-4 text-[11px] font-extrabold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
                >
                  {copy.finish}
                </button>
              </div>
            </div>
          )}

          {/* Post-«تم» review: the plot, isolated. The drawing controls are
              gone; in their place the real area and exactly two actions —
              «تحليل القطعة» (stage 2 wires it up) and «إعادة الرسم». */}
          {draft && isolated && (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 32 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              className="absolute inset-x-3 bottom-8 z-[600]"
            >
              <div className="rounded-[1.35rem] border border-white/70 bg-white/95 p-3 shadow-[0_24px_48px_-22px_rgba(6,78,59,0.55)] backdrop-blur-xl">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10.5px] font-bold text-emerald-900/55">{copy.isolatedAreaLabel}</p>
                    <p className="truncate text-[19px] font-black leading-6 tabular-nums text-emerald-950">
                      {formatHa(draftAreaHa)}{" "}
                      <span className="text-[12px] font-extrabold text-emerald-700">{copy.areaLabel}</span>
                    </p>
                  </div>
                  {(saveState === "busy" || busy) && (
                    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-900/[0.06] px-2.5 py-1 text-[10.5px] font-extrabold text-emerald-900/70">
                      <Loader2 size={12} className="animate-spin" aria-hidden />
                      {copy.saving}
                    </span>
                  )}
                  {saveState === "saved" && (
                    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10.5px] font-extrabold text-emerald-700 ring-1 ring-emerald-600/20">
                      <CheckCircle2 size={12} strokeWidth={2.8} aria-hidden />
                      {copy.saved}
                    </span>
                  )}
                </div>

                {saveError && (
                  <p
                    role="alert"
                    className="mt-2 rounded-[0.9rem] bg-amber-50 px-3 py-2 text-[11px] font-bold leading-5 text-amber-900 ring-1 ring-amber-200/70"
                  >
                    {saveError}
                  </p>
                )}

                <div className="mt-3 flex gap-2">
                  {/* Stage 2 wires the satellite pipeline to this action; until
                      then it stays visibly disabled instead of pretending. */}
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title={copy.analyzeSoon}
                    aria-label={`${copy.analyze} — ${copy.analyzeSoon}`}
                    className="flex h-12 flex-1 cursor-not-allowed items-center justify-center gap-1.5 rounded-full bg-emerald-600 text-[12.5px] font-extrabold text-white opacity-45 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
                  >
                    <Sparkles size={15} strokeWidth={2.6} aria-hidden />
                    {copy.analyze}
                  </button>
                  <button
                    type="button"
                    onClick={beginDrawing}
                    className="flex h-12 items-center justify-center gap-1.5 rounded-full bg-emerald-900/[0.07] px-4 text-[12.5px] font-extrabold text-emerald-900 hover:bg-emerald-900/[0.12] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
                  >
                    <RotateCcw size={15} strokeWidth={2.6} aria-hidden />
                    {copy.redraw}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </div>

        <footer className="flex flex-col gap-2 border-t border-emerald-900/10 px-4 py-3">
          {error && (
            <p
              role="alert"
              className="rounded-[0.9rem] bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-900 ring-1 ring-amber-200/70"
            >
              {error}
            </p>
          )}

          {plots.length > 0 && (
            <label className="flex items-center gap-2">
              <span className="sr-only">{copy.namePlaceholder}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={copy.namePlaceholder}
                maxLength={60}
                className="min-h-[2.75rem] flex-1 rounded-[0.9rem] border border-emerald-900/15 bg-white px-3 text-[12.5px] font-bold text-emerald-950 placeholder:text-emerald-900/35 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
              />
            </label>
          )}

          {plots.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {plots.map((plot) => (
                <li key={plot.id}>
                  <button
                    type="button"
                    onClick={() => onActivate(plot.id)}
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

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={drawing ? () => handleRef.current?.finishDraw() : isolated ? beginDrawing : startDraw}
              disabled={!mapReady}
              className="flex min-h-[2.75rem] flex-1 items-center justify-center gap-1.5 rounded-[0.9rem] bg-emerald-600 px-4 text-[12px] font-extrabold text-white hover:bg-emerald-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
            >
              {drawing ? copy.finish : copy.draw}
            </button>
            {activeId && (
              <button
                type="button"
                onClick={() => onDelete(activeId)}
                aria-label={copy.delete}
                className="flex h-11 w-11 items-center justify-center rounded-[0.9rem] bg-red-50 text-red-700 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-300/50"
              >
                <Trash2 size={15} strokeWidth={2.6} aria-hidden />
              </button>
            )}
          </div>

          {plots.length === 0 && !loading && (
            <p className="text-[11px] font-semibold leading-5 text-emerald-900/55">
              {copy.noPlots} {copy.noPlotsHint}
            </p>
          )}

          <p className="text-[9.5px] font-semibold leading-4 text-emerald-900/40">{copy.attribution}</p>
        </footer>
      </div>
    </div>
  );
}
