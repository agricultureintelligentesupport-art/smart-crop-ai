"use client";

/**
 * The Leaflet half of the field map, loaded with `ssr: false` by
 * `FieldMapSheet`. It owns the map instance and exposes an imperative
 * `MapHandle` to the toolbar — every Leaflet import and type stays in this file.
 *
 * `leaflet` touches `window` at module scope, so it is imported dynamically
 * here rather than at the top of the file. `leaflet-draw` augments the Leaflet
 * namespace at runtime (it has no ESM entry), hence the side-effect import.
 *
 * The map is created exactly once. Everything that changes afterwards — the
 * saved-plot layer, the active plot — is pushed through `handle.syncPlots`, so
 * switching plots never tears down and rebuilds the map.
 *
 * WHERE THE MAP OPENS
 * -------------------
 * The farmer should land next to their own field, not on a country-level view:
 *
 *   1. the device's GPS location (zoom 17, single-field drawing scale), when
 *      the browser grants it;
 *   2. otherwise the active saved boundary ("last saved location");
 *   3. otherwise the last map centre the farmer used on this device;
 *   4. otherwise the wilaya capital the dashboard passes in;
 *   5. otherwise the middle of Algeria's cropland — but always at a zoom close
 *      enough to draw, never a whole-country frame.
 *
 * LOCATION SEARCH
 * ---------------
 * Not here any more. `leaflet-control-geocoder` fetched Nominatim from the
 * browser, could not identify the app to it (no script-settable User-Agent),
 * and — the bug that actually broke "خنشلة" — crashed while mapping the
 * `addressdetails=0` responses this app requested: its default template reads
 * `result.address.road`, the field was missing, and the thrown TypeError was
 * an unhandled rejection inside the control, so its throbber spun forever and
 * neither results nor an error ever appeared. Search now lives in the
 * `MapSearch` React component (owned by `FieldMapSheet`) and talks to Nominatim
 * through `/api/geocode`. This canvas exposes one command for it,
 * `MapHandle.flyTo`: move the view, draw nothing.
 */

import { useEffect, useRef } from "react";
// Type-only: erased at build time, so importing them does not pull in the
// `window`-touching Leaflet runtime. The runtime itself is dynamically imported
// inside the effect below.
import type { FeatureGroup, LayerGroup, Map as LeafletMap, Polygon as LeafletPolygon } from "leaflet";
import type { MapHandle } from "./FieldMapSheet";
import type { Plot } from "@/lib/field-data/types";
import { isSimpleRing, ringAreaHa, type Ring } from "@/lib/geo/polygon";
import { createPlotIsolator } from "./plotIsolate";
import "./map.css";

const TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTRIBUTION =
  'Imagery &copy; <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a>, Maxar, Earthstar Geographics';

/** Fallback centre: the middle of Algeria's cropland. */
const DEFAULT_CENTER: [number, number] = [36.4, 3.2];
/** Opening zoom on a fallback centre — close enough to draw a small field. */
const FALLBACK_ZOOM = 15;
/** Zoom after a GPS fix — single-field drawing scale. */
const GPS_ZOOM = 17;
/** Last map centre, so reopening lands where the farmer last worked. */
const LAST_VIEW_KEY = "smart-crop.map.v1";
/** GPS fix budget: after this the fallback view simply stays. */
const GPS_TIMEOUT_MS = 8000;

const DRAFT_STYLE = { color: "#047857", weight: 3, fillColor: "#10b981", fillOpacity: 0.22 };
const ACTIVE_STYLE = { color: "#022c22", weight: 3, fillColor: "#047857", fillOpacity: 0.2 };
const IDLE_STYLE = { color: "#0f766e", weight: 2, fillColor: "#5eead4", fillOpacity: 0.16 };

/** GeoJSON `[lon, lat]` → Leaflet `[lat, lng]`. */
const toLatLngs = (ring: Ring): [number, number][] => ring.map(([lon, lat]) => [lat, lon]);

/** The ring of a single drawn polygon layer, as GeoJSON. */
const readLayerRing = (layer: LeafletPolygon): Ring =>
  ((layer.getLatLngs()[0] as { lat: number; lng: number }[]) ?? []).map((p) => [p.lng, p.lat]);

/** Arabic and French strings for Leaflet.draw's vertex tooltips. */
const DRAW_STRINGS = {
  ar: {
    start: "انقر على الخريطة لبدء الرسم.",
    cont: "انقر لإضافة نقطة.",
    end: "انقر على زر «تم» لإغلاق الشكل.",
    error: "تعذّر قبول هذا الشكل: حدوده تتقاطع.",
  },
  fr: {
    start: "Cliquez sur la carte pour commencer le tracé.",
    cont: "Cliquez pour ajouter un point.",
    end: "Cliquez sur « Terminer » pour fermer la forme.",
    error: "Forme refusée : les limites se croisent.",
  },
} as const;

/**
 * Leaflet.draw has no i18n hook of its own — it reads `L.drawLocal` at the
 * moment each tooltip is built — so the two strings it actually shows while a
 * farmer is drawing are replaced here.
 */
function applyDrawLocale(L: unknown, lang: "ar" | "fr"): void {
  const strings = DRAW_STRINGS[lang];
  const local = (L as { drawLocal?: { draw?: { handlers?: { polygon?: { tooltip: Record<string, string>; error?: string } } } } })
    .drawLocal;
  const polygon = local?.draw?.handlers?.polygon;
  if (!polygon) return;
  polygon.tooltip.start = strings.start;
  polygon.tooltip.cont = strings.cont;
  polygon.tooltip.end = strings.end;
  // `addVertex` and `_finishShape` read this one for the refusal message.
  if (local?.draw?.handlers) {
    (local.draw.handlers as { polyline?: { error?: string } }).polyline ??= {};
    (local.draw.handlers as { polyline: { error: string } }).polyline.error = strings.error;
  }
}

interface LastView {
  lat: number;
  lng: number;
  zoom: number;
}

function readLastView(): LastView | null {
  try {
    const raw = window.localStorage.getItem(LAST_VIEW_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const v = parsed as Partial<LastView>;
    if (typeof v.lat !== "number" || typeof v.lng !== "number") return null;
    return {
      lat: v.lat,
      lng: v.lng,
      zoom: typeof v.zoom === "number" ? Math.min(19, Math.max(12, v.zoom)) : FALLBACK_ZOOM,
    };
  } catch {
    return null;
  }
}

function writeLastView(map: LeafletMap): void {
  try {
    const center = map.getCenter();
    window.localStorage.setItem(
      LAST_VIEW_KEY,
      JSON.stringify({ lat: center.lat, lng: center.lng, zoom: map.getZoom() } satisfies LastView),
    );
  } catch {
    /* private mode or quota — the fallback chain still has the wilaya centre */
  }
}

export default function FieldMapCanvas({
  plots,
  activeId,
  fallbackCenter,
  onDraftChange,
  onDrawingArea,
  onPick,
  onReady,
  onDrawingChange,
  onInvalid,
  onLocateResult,
  isolateRing,
  lang,
  ariaLabel,
}: {
  plots: Plot[];
  activeId: string | null;
  /** Wilaya-capital fallback, `[lat, lng]`, used when GPS and storage have no view. */
  fallbackCenter?: [number, number];
  /** Fires on create, edit and delete of the in-progress polygon. */
  onDraftChange: (ring: Ring | null) => void;
  /** Live area (hectares) of the boundary being drawn, `null` under 3 vertices. */
  onDrawingArea: (areaHa: number | null) => void;
  onPick: (plot: Plot) => void;
  onReady: (handle: MapHandle) => void;
  onDrawingChange: (drawing: boolean) => void;
  /** The shape the farmer drew cannot be used; say so in their language. */
  onInvalid: () => void;
  /** GPS result after an explicit locate: `false` means denied/unavailable. */
  onLocateResult: (ok: boolean) => void;
  /**
   * The ring to spotlight (the post-«تم» review), or `null`. While set, the
   * isolation overlay owns the viewport: saved plots step aside, and the
   * automatic "frame the active plot" refits are suppressed so nothing can
   * yank the view away from the plot being reviewed.
   */
  isolateRing: Ring | null;
  lang: "ar" | "fr";
  ariaLabel: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MapHandle | null>(null);
  /** Set by the one-shot effect below; the isolate effect drives it. */
  const applyIsolateRef = useRef<((ring: Ring | null) => void) | null>(null);
  // Callbacks are read through a ref so the map — created once — is never torn
  // down just because a parent callback identity changed on a re-render.
  // Map events fire long after render, so they must read the newest callbacks.
  // Assigning in an effect (not during render) keeps the ref write out of the
  // render path while still being current by the time any event can fire.
  // `plots`/`activeId` ride along so the saved-plot layer can be repainted the
  // moment isolation ends, without wiring another prop through the handle.
  const latest = useRef({
    onDraftChange,
    onDrawingArea,
    onPick,
    onReady,
    onDrawingChange,
    onInvalid,
    onLocateResult,
    fallbackCenter,
    lang,
    plots,
    activeId,
  });
  useEffect(() => {
    latest.current = {
      onDraftChange,
      onDrawingArea,
      onPick,
      onReady,
      onDrawingChange,
      onInvalid,
      onLocateResult,
      fallbackCenter,
      lang,
      plots,
      activeId,
    };
  });

  /* Drive the isolation overlay from the prop. The map applies it through the
     one-shot effect's closure — the only place the Leaflet instance lives. */
  useEffect(() => {
    applyIsolateRef.current?.(isolateRing);
  }, [isolateRing]);

  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;

    (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      await import("leaflet-draw");
      await import("leaflet-draw/dist/leaflet.draw.css");
      if (disposed || !hostRef.current) return;

      /* The opening view resolves along the documented fallback chain. The
         provisional centre is painted synchronously (last-used view, else the
         wilaya capital) so the sheet never flashes a distant default; a GPS
         fix, when granted, simply takes over from there. */
      const lastView = readLastView();
      const map: LeafletMap = L.map(hostRef.current, {
        center: lastView ? [lastView.lat, lastView.lng] : (latest.current.fallbackCenter ?? DEFAULT_CENTER),
        zoom: lastView?.zoom ?? FALLBACK_ZOOM,
        zoomControl: true,
      });
      // Leaflet.draw ships English-only guidance. An Algerian farmer drawing a
      // boundary must not be told "Click first point to close this shape" — or,
      // worse, shown a raw error tooltip when the shape is refused.
      applyDrawLocale(L, latest.current.lang);

      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
      L.control.attribution({ prefix: false }).addTo(map);

      const draftGroup: FeatureGroup = new L.FeatureGroup();
      map.addLayer(draftGroup);
      const savedGroup: LayerGroup = new L.LayerGroup();
      map.addLayer(savedGroup);

      /* ---- isolation (post-«تم» review) ---- */

      // While the spotlight is up it owns the viewport: saved plots step aside
      // and the automatic refits stay off, so a background data refresh cannot
      // yank the view away from the plot being reviewed.
      let isolateActive = false;
      const isolator = createPlotIsolator(map, L);

      /**
       * Repaint the saved-plot layer; `fit` frames the active plot. Framing is
       * an explicit act — the opening chain asks for it, or the farmer picked a
       * plot — and a background re-sync of the same plot must never move the
       * view away from where the farmer is looking.
       */
      const syncPlots = (list: Plot[], active: string | null, fit = false) => {
        savedGroup.clearLayers();
        if (isolateActive) return; // the spotlight overlay owns the map
        let activeLayer: LeafletPolygon | null = null;
        for (const plot of list) {
          const isActive = plot.id === active;
          const polygon = L.polygon(toLatLngs(plot.ring), isActive ? ACTIVE_STYLE : IDLE_STYLE);
          polygon.on("click", () => latest.current.onPick(plot));
          polygon.bindTooltip(`${plot.name} · ${plot.areaHa.toFixed(2)} ha`, {
            direction: "top",
            sticky: true,
          });
          polygon.addTo(savedGroup);
          if (isActive) activeLayer = polygon;
        }
        if (fit && activeLayer) {
          map.fitBounds(activeLayer.getBounds(), { padding: [32, 32] });
        }
      };

      applyIsolateRef.current = (next: Ring | null) => {
        isolator.set(next);
        isolateActive = next !== null;
        if (next) {
          // The spotlight replaces every other geometry: the draft layer (whose
          // ring it is painting) and the saved plots all step aside until the
          // review ends.
          draftGroup.clearLayers();
          savedGroup.clearLayers();
          // Smoothly frame the plot (fitBounds with padding), leaving room for
          // the search pill above and the review bar below. Under reduced
          // motion the frame is a jump cut, not a glide.
          const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          map.fitBounds(
            L.latLngBounds(next.map(([lon, lat]) => [lat, lon] as [number, number])),
            { paddingTopLeft: [40, 76], paddingBottomRight: [40, 176], animate: !reduce },
          );
        } else {
          // Restore the saved-plot layer with the newest data. Framing is
          // deliberately off — leaving isolation must not move the camera.
          const { plots: current, activeId: currentActive } = latest.current;
          syncPlots(current, currentActive, false);
        }
      };

      /* ---- drawing ---- */

      type DrawPolygonInstance = {
        enable: () => void;
        disable: () => void;
        enabled: () => boolean;
        completeShape: () => void;
        deleteLastVertex?: () => void;
      };
      const DrawPolygon = (
        L as unknown as {
          Draw: { Polygon: new (map: unknown, options: unknown) => DrawPolygonInstance };
        }
      ).Draw.Polygon;
      // 24 px visible vertex + a 48 px invisible hit area (see map.css): a
      // finger must be able to see and hit the point it just placed.
      const vertexIcon = new L.DivIcon({ iconSize: new L.Point(24, 24), className: "field-map-vertex" });
      const handler = new DrawPolygon(map, {
        allowIntersection: false,
        showArea: false,
        shapeOptions: DRAFT_STYLE,
        guidelineDistance: 16,
        icon: vertexIcon,
        touchIcon: vertexIcon,
      });

      const currentDraftRing = (): Ring | null => {
        const layers = draftGroup.getLayers();
        if (layers.length === 0) return null;
        const polygon = layers[0] as LeafletPolygon;
        const latlngs = polygon.getLatLngs()[0] as import("leaflet").LatLng[];
        if (latlngs.length < 2) return null;
        return latlngs.map((p) => [p.lng, p.lat] as [number, number]);
      };
      const publish = () => latest.current.onDraftChange(currentDraftRing());

      /**
       * Live area of the in-progress boundary. Leaflet.draw keeps the open
       * polyline on the handler (`_poly`); the area shown is the polygon the
       * farmer is about to close, so they can stop at the right size.
       */
      const publishProgress = () => {
        const poly = (handler as unknown as { _poly?: { getLatLngs(): unknown } })._poly;
        const raw = poly?.getLatLngs?.();
        // A polygon returns `LatLng[][]`, the in-progress polyline `LatLng[]`.
        const first = Array.isArray(raw) && Array.isArray((raw as unknown[])[0])
          ? (raw as { lat: number; lng: number }[][])[0]
          : (raw as { lat: number; lng: number }[] | undefined);
        if (!first || first.length < 3) {
          latest.current.onDrawingArea(null);
          return;
        }
        const ring: Ring = first.map((p) => [p.lng, p.lat]);
        latest.current.onDrawingArea(ringAreaHa(ring));
      };

      map.on(L.Draw.Event.CREATED, (event: unknown) => {
        const layer = (event as { layer: LeafletPolygon }).layer;
        draftGroup.clearLayers();
        latest.current.onDrawingArea(null);
        // A boundary that crosses itself has no single area and no single mean
        // NDVI, so it is refused here rather than saved and queried.
        if (!isSimpleRing(readLayerRing(layer))) {
          latest.current.onDrawingChange(false);
          latest.current.onDraftChange(null);
          latest.current.onInvalid();
          return;
        }
        draftGroup.addLayer(layer);
        latest.current.onDrawingChange(false);
        publish();
      });
      map.on(L.Draw.Event.EDITED, publish);
      map.on(L.Draw.Event.DELETED, () => latest.current.onDraftChange(null));
      map.on("draw:drawstop", () => latest.current.onDrawingChange(false));
      map.on(L.Draw.Event.DRAWVERTEX, publishProgress);

      /* ---- GPS ---- */

      /**
       * Resolve the device position, or `null` when it is denied or absent.
       * Never throws; the caller decides what the fallback view should be.
       */
      const requestPosition = (): Promise<{ lat: number; lng: number } | null> =>
        new Promise((resolve) => {
          if (typeof navigator === "undefined" || !navigator.geolocation) {
            resolve(null);
            return;
          }
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 60_000 },
          );
        });

      const handle: MapHandle = {
        async startDraw() {
          draftGroup.clearLayers();
          latest.current.onDraftChange(null);
          latest.current.onDrawingArea(null);
          handler.enable();
          latest.current.onDrawingChange(true);
          return true;
        },
        finishDraw() {
          // Leaflet.draw's own way to close a polygon is to click the first
          // vertex exactly, which `addVertex` then rejects as a crossing. This
          // is the reliable way to say "that is the boundary".
          if (handler.enabled()) handler.completeShape();
        },
        undoDraw() {
          if (!handler.enabled()) return;
          handler.deleteLastVertex?.();
          publishProgress();
        },
        clear() {
          draftGroup.clearLayers();
          handler.disable();
          latest.current.onDraftChange(null);
          latest.current.onDrawingArea(null);
          latest.current.onDrawingChange(false);
        },
        isDrawing: () => handler.enabled(),
        async locate() {
          const position = await requestPosition();
          if (disposed) return false;
          if (!position) {
            latest.current.onLocateResult(false);
            return false;
          }
          map.setView([position.lat, position.lng], GPS_ZOOM);
          latest.current.onLocateResult(true);
          return true;
        },
        flyTo(lat, lng, zoom = 16) {
          // The search's whole contract: move the view, draw nothing. 16 is
          // single-field drawing scale — never a whole-country frame.
          map.flyTo([lat, lng], zoom);
        },
        syncPlots,
      };
      handleRef.current = handle;
      latest.current.onReady(handle);
      handle.syncPlots(plots, activeId);

      // Opening chain: GPS wins; without it the provisional view (last-used,
      // else wilaya) stays, unless saved boundaries exist — those are the
      // farmer's "last saved location" and take the frame.
      void requestPosition().then((position) => {
        if (disposed) return;
        if (position) {
          map.setView([position.lat, position.lng], GPS_ZOOM);
          return;
        }
        if (plots.length > 0) handle.syncPlots(plots, activeId, true);
      });

      map.on("moveend", () => writeLastView(map));

      // The sheet animates in; Leaflet needs one tick to measure its container.
      const raf = requestAnimationFrame(() => map?.invalidateSize());
      const onWindowResize = () => map?.invalidateSize();
      window.addEventListener("resize", onWindowResize);

      teardown = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", onWindowResize);
        applyIsolateRef.current = null;
        handleRef.current = null;
        map.remove();
      };
    })();

    return () => {
      disposed = true;
      teardown?.();
    };
    // One-shot by design: the map instance is created once and thereafter
    // driven through the handle. Plot changes use the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Saved plots changed (added, renamed, deleted, activated): repaint them and
     frame the map only when the farmer picked a different plot — a background
     re-sync of the same plot must not move the map. */
  const prevActiveId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevActiveId.current;
    prevActiveId.current = activeId;
    const handle = handleRef.current;
    if (!handle) return;
    handle.syncPlots(plots, activeId, prev !== undefined && prev !== activeId);
  }, [plots, activeId]);

  return <div ref={hostRef} className="h-full w-full" dir="ltr" role="region" aria-label={ariaLabel} />;
}
