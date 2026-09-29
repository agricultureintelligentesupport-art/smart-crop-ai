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
 * `leaflet-control-geocoder` with its Nominatim backend: free, keyless, and it
 * answers Arabic and French place names (wilaya / commune / city) in Algeria.
 * Usage-policy compliance is the geocoder's own: identical responses are
 * cached, requests are queued at least one second apart, and client-side
 * auto-complete is refused outright because Nominatim forbids it. The browser
 * sends an identifying `Referer` automatically and does not allow scripts to
 * override `User-Agent`, which satisfies the policy's "Referer or User-Agent"
 * requirement. Queries are restricted to Algeria (`countrycodes=dz`) and asked
 * for in the app's current language.
 */

import { useEffect, useRef } from "react";
// Type-only: erased at build time, so importing them does not pull in the
// `window`-touching Leaflet runtime. The runtime itself is dynamically imported
// inside the effect below.
import type { FeatureGroup, LatLngBounds, LayerGroup, Map as LeafletMap, Polygon as LeafletPolygon } from "leaflet";
import type { MapHandle } from "./FieldMapSheet";
import type { Plot } from "@/lib/field-data/types";
import { isSimpleRing, ringAreaHa, type Ring } from "@/lib/geo/polygon";
// The plugin's stylesheet is NOT imported by its JS bundle (the built dist
// strips it), so the app loads it explicitly — before map.css, whose rules
// override it.
import "leaflet-control-geocoder/dist/Control.Geocoder.css";
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
/** Zoom bounds applied to a search result (never a whole-country frame). */
const SEARCH_ZOOM_MIN = 15;
const SEARCH_ZOOM_MAX = 17;
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

interface GeocoderLike {
  options?: { geocodingQueryParams?: Record<string, unknown> };
}

/**
 * The plugin's control as this file uses it. `_input` is private on the class
 * (there is no public handle on the input), so the few internals needed here
 * are read through this structural view instead of intersecting the class.
 */
interface GeocoderControlInternals {
  on: (type: string, fn: (event: unknown) => void) => unknown;
  _input?: HTMLInputElement;
  geocoder?: GeocoderLike;
}

/** Push the app language into the geocoder (query params + input chrome). */
function syncGeocoderLanguage(
  control: GeocoderControlInternals | null,
  lang: "ar" | "fr",
  copy: { placeholder: string; iconLabel: string },
): void {
  if (!control) return;
  const params = control.geocoder?.options?.geocodingQueryParams;
  if (params) params["accept-language"] = lang;
  const input = control._input;
  if (input) {
    input.placeholder = copy.placeholder;
    input.setAttribute("aria-label", copy.iconLabel);
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
  lang,
  ariaLabel,
  geocoderCopy,
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
  lang: "ar" | "fr";
  ariaLabel: string;
  geocoderCopy: { placeholder: string; errorMessage: string; iconLabel: string };
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MapHandle | null>(null);
  const geocoderRef = useRef<GeocoderControlInternals | null>(null);
  // Callbacks are read through a ref so the map — created once — is never torn
  // down just because a parent callback identity changed on a re-render.
  // Map events fire long after render, so they must read the newest callbacks.
  // Assigning in an effect (not during render) keeps the ref write out of the
  // render path while still being current by the time any event can fire.
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
    geocoderCopy,
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
      geocoderCopy,
    };
  });

  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;

    (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      await import("leaflet-draw");
      await import("leaflet-draw/dist/leaflet.draw.css");
      const { default: GeocoderControl, geocoders } = await import("leaflet-control-geocoder");
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

      /* ---- location search (Nominatim via leaflet-control-geocoder) ---- */

      const geocoder = geocoders.nominatim({
        geocodingQueryParams: {
          // Algeria only: a farmer searching "Biskra" must get Biskra, DZ.
          countrycodes: "dz",
          addressdetails: 0,
          limit: 5,
          "accept-language": latest.current.lang,
        },
      });
      const geocoderControl = new GeocoderControl({
        position: "topright",
        geocoder,
        // The jump is ours to make: pin nothing, frame the result at a zoom
        // that is close enough to draw a field at.
        defaultMarkGeocode: false,
        collapsed: false,
        expand: "touch",
        placeholder: latest.current.geocoderCopy.placeholder,
        errorMessage: latest.current.geocoderCopy.errorMessage,
        iconLabel: latest.current.geocoderCopy.iconLabel,
        queryMinLength: 2,
        suggestMinLength: 3,
        suggestTimeout: 1000,
        showResultIcons: false,
      }).addTo(map) as unknown as GeocoderControlInternals;
      geocoderControl.on("markgeocode", (event: unknown) => {
        const { center, bbox } = (event as { geocode: { center: { lat: number; lng: number }; bbox: LatLngBounds } }).geocode;
        const zoom = Math.min(SEARCH_ZOOM_MAX, Math.max(SEARCH_ZOOM_MIN, map.getBoundsZoom(bbox)));
        map.setView([center.lat, center.lng], zoom);
      });
      // Arabic place names read best right-to-left even inside the LTR map.
      const geocoderInput = geocoderControl._input;
      if (geocoderInput) {
        geocoderInput.dir = "auto";
        geocoderInput.setAttribute("aria-label", latest.current.geocoderCopy.iconLabel);
      }
      geocoderRef.current = geocoderControl;

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
        syncPlots(list: Plot[], active: string | null, fit = false) {
          savedGroup.clearLayers();
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
          // Framing is an explicit act — the opening chain asked for it, or the
          // farmer picked a plot. A data refresh must never yank the view away
          // from where the farmer is looking.
          if (fit && activeLayer) {
            map.fitBounds(activeLayer.getBounds(), { padding: [32, 32] });
          }
        },
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
        handleRef.current = null;
        geocoderRef.current = null;
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

  /* The sheet language can change while the map is up: keep the search
     speaking it (the geocoder asks Nominatim in the right language and the
     input placeholder follows). */
  useEffect(() => {
    syncGeocoderLanguage(geocoderRef.current, lang, geocoderCopy);
  }, [lang, geocoderCopy]);

  return <div ref={hostRef} className="h-full w-full" dir="ltr" role="region" aria-label={ariaLabel} />;
}
