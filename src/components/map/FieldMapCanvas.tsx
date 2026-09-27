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
 */

import { useEffect, useRef } from "react";
// Type-only: erased at build time, so importing them does not pull in the
// `window`-touching Leaflet runtime. The runtime itself is dynamically imported
// inside the effect below.
import type { FeatureGroup, LayerGroup, Map as LeafletMap, Polygon as LeafletPolygon } from "leaflet";
import type { MapHandle } from "./FieldMapSheet";
import type { Plot } from "@/lib/field-data/types";
import { isSimpleRing, type Ring } from "@/lib/geo/polygon";

const TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTRIBUTION =
  'Imagery &copy; <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a>, Maxar, Earthstar Geographics';

/** Fallback centre: the middle of Algeria's cropland. */
const DEFAULT_CENTER: [number, number] = [36.4, 3.2];

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

export default function FieldMapCanvas({
  plots,
  activeId,
  onDraftChange,
  onPick,
  onReady,
  onDrawingChange,
  onInvalid,
  lang,
  ariaLabel,
}: {
  plots: Plot[];
  activeId: string | null;
  /** Fires on create, edit and delete of the in-progress polygon. */
  onDraftChange: (ring: Ring | null) => void;
  onPick: (plot: Plot) => void;
  onReady: (handle: MapHandle) => void;
  onDrawingChange: (drawing: boolean) => void;
  /** The shape the farmer drew cannot be used; say so in their language. */
  onInvalid: () => void;
  lang: "ar" | "fr";
  ariaLabel: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MapHandle | null>(null);
  // Callbacks are read through a ref so the map — created once — is never torn
  // down just because a parent callback identity changed on a re-render.
  // Map events fire long after render, so they must read the newest callbacks.
  // Assigning in an effect (not during render) keeps the ref write out of the
  // render path while still being current by the time any event can fire.
  const latest = useRef({ onDraftChange, onPick, onReady, onDrawingChange, onInvalid });
  useEffect(() => {
    latest.current = { onDraftChange, onPick, onReady, onDrawingChange, onInvalid };
  });

  useEffect(() => {
    let disposed = false;
    let teardown: (() => void) | undefined;

    (async () => {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      await import("leaflet-draw");
      await import("leaflet-draw/dist/leaflet.draw.css");
      if (disposed || !hostRef.current) return;

      const map: LeafletMap = L.map(hostRef.current, {
        center: DEFAULT_CENTER,
        zoom: 11,
        zoomControl: true,
      });
      // Leaflet.draw ships English-only guidance. An Algerian farmer drawing a
      // boundary must not be told "Click first point to close this shape" — or,
      // worse, shown a raw error tooltip when the shape is refused.
      applyDrawLocale(L, lang);

      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
      L.control.attribution({ prefix: false }).addTo(map);

      const draftGroup: FeatureGroup = new L.FeatureGroup();
      map.addLayer(draftGroup);
      const savedGroup: LayerGroup = new L.LayerGroup();
      map.addLayer(savedGroup);

      /** The current draft as a GeoJSON ring, or `null`. */
      const readDraft = (): Ring | null => {
        const layers = draftGroup.getLayers();
        if (layers.length === 0) return null;
        const polygon = layers[0] as LeafletPolygon;
        const latlngs = polygon.getLatLngs()[0] as import("leaflet").LatLng[];
        if (latlngs.length < 2) return null;
        return latlngs.map((p) => [p.lng, p.lat] as [number, number]);
      };
      const publish = () => latest.current.onDraftChange(readDraft());

      map.on(L.Draw.Event.CREATED, (event: unknown) => {
        const layer = (event as { layer: LeafletPolygon }).layer;
        draftGroup.clearLayers();
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

      const DrawPolygon = (
        L as unknown as {
          Draw: {
            Polygon: new (map: unknown, options: unknown) => {
              enable: () => void;
              disable: () => void;
              enabled: () => boolean;
              completeShape: () => void;
            };
          };
        }
      ).Draw.Polygon;
      const handler = new DrawPolygon(map, {
        allowIntersection: false,
        showArea: false,
        shapeOptions: DRAFT_STYLE,
        guidelineDistance: 16,
        icon: new L.DivIcon({ iconSize: new L.Point(14, 14), className: "field-map-vertex" }),
      });

      const handle: MapHandle = {
        async startDraw() {
          draftGroup.clearLayers();
          latest.current.onDraftChange(null);
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
        clear() {
          draftGroup.clearLayers();
          handler.disable();
          latest.current.onDraftChange(null);
          latest.current.onDrawingChange(false);
        },
        isDrawing: () => handler.enabled(),
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
          if (fit && activeLayer) {
            map.fitBounds(activeLayer.getBounds(), { padding: [32, 32] });
          }
        },
      };
      handleRef.current = handle;
      latest.current.onReady(handle);
      handle.syncPlots(plots, activeId);

      // The sheet animates in; Leaflet needs one tick to measure its container.
      const raf = requestAnimationFrame(() => map?.invalidateSize());
      const onWindowResize = () => map?.invalidateSize();
      window.addEventListener("resize", onWindowResize);

      teardown = () => {
        cancelAnimationFrame(raf);
        window.removeEventListener("resize", onWindowResize);
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
     re-frame the map once the map exists. */
  useEffect(() => {
    handleRef.current?.syncPlots(plots, activeId, true);
  }, [plots, activeId]);

  return <div ref={hostRef} className="h-full w-full" dir="ltr" role="region" aria-label={ariaLabel} />;
}
