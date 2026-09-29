/**
 * The isolation overlay: what the farmer sees right after tapping «تم».
 *
 * The drawn boundary is spotlighted — everything outside it is dimmed and
 * frosted, the boundary itself stays crisp with a clean emerald outline —
 * while the map zooms to frame the plot. This module owns every Leaflet
 * primitive that paints that state, so `FieldMapCanvas` only calls
 * `isolator.set(ring)` / `isolator.set(null)`.
 *
 * HOW THE MASK IS BUILT
 * ---------------------
 * Three custom panes between the overlay pane (400) and the marker pane (600),
 * so every other piece of map geometry is masked while tooltips and controls
 * stay crisp:
 *
 *   dim   (405)  even-odd polygons: a viewport-sized rectangle with the plot
 *                ring punched out (`L.polygon([[rect], [ring]])` — Leaflet
 *                sets `fill-rule: evenodd` by default), in a dark emerald,
 *                plus a near-transparent white twin that adds the frost so a
 *                browser without `backdrop-filter` still reads a separation.
 *   blur  (455)  an empty pane with `backdrop-filter: blur()` clipped by
 *                `clip-path: path(evenodd, …)` to the same rect-with-hole —
 *                the blur physically applies only outside the plot. Created
 *                only when the browser supports both halves; otherwise the
 *                dim+frost pair carries the mask on its own (the same
 *                graceful fallback the app-wide `.glass` rules use).
 *   line  (465)  a white casing + the emerald outline, painted ABOVE the blur
 *                so the boundary reads crisp along its whole width — not just
 *                inside the hole.
 *
 * STAYING GLUED TO THE PLOT
 * -------------------------
 * All mask geometry lives in Leaflet's layer space, which is drag-invariant:
 * panning translates `mapPane`, so dim, hole and blur follow the plot with
 * zero JavaScript per frame. Only a zoom changes layer space itself, and for
 * that the blur pane gets an explicit `translate3d + scale` transform that
 * carries the clip from the zoom it was built at to the view being shown
 * (derivation below); the polygons are plain Leaflet layers and ride every
 * zoom animation by themselves. On `moveend` / `viewreset` / `resize` the
 * geometry is rebuilt against the fresh layer space.
 *
 * The blur transform, with the pane box top-left at layer-space `b`, content
 * coordinates `q` (pane-local px), map-pane translation `t`, and a view at
 * `(center, zoom)`: the pane paints `q` at `t + b + a + s·q`, and the same
 * geographic point belongs at `project(g, zoom) − project(center, zoom) +
 * viewHalf − panePos`. Substituting `q + b = project(g, clipZoom) −
 * project(clipCenter, clipZoom) + viewHalf` and `s = 2^(zoom − clipZoom)`
 * (Web-Mercator pixels scale linearly) gives
 *
 *     a = (s − 1)·(b − viewHalf) + project(clipCenter, zoom)
 *                                       − project(center, zoom)
 *
 * which is the identity at rest (s = 1) and keeps the hole pixel-glued to
 * the plot through animated zooms, pinch zooms and flyTo alike.
 *
 * Reduced motion is honoured by the caller (`FieldMapCanvas`), which passes
 * `animate: false` to the fitBounds zoom.
 */

import { DomUtil, type LatLng, type Map as LeafletMap, type Point, type Polygon as LeafletPolygon } from "leaflet";
import type { Ring } from "@/lib/geo/polygon";

/** Runtime Leaflet namespace, handed over by the canvas after its dynamic import. */
type LeafletNS = typeof import("leaflet");

/** Emerald scale, matching the dashboard tokens. */
const DIM_COLOR = "#022c22";
const DIM_OPACITY = 0.52;
const FROST_COLOR = "#e7f6ee";
const FROST_OPACITY = 0.12;
const FILL_COLOR = "#10b981";
const FILL_OPACITY = 0.14;
const OUTLINE_COLOR = "#10b981";
const CASING_COLOR = "#ffffff";

/** Above overlayPane (400) so other plot geometry is masked too. */
const DIM_PANE_Z = 405;
const BLUR_PANE_Z = 455;
const LINE_PANE_Z = 465;

/** Custom pane names, namespaced to avoid collisions with Leaflet's own. */
const DIM_PANE = "fieldMapIsolateDim";
const BLUR_PANE = "fieldMapIsolateBlur";
const LINE_PANE = "fieldMapIsolateLine";

/** CSS classes from `map.css` — the fade-in and the blur recipe. */
const PANE_CLASS = "field-map-isolate-pane";
const BLUR_CLASS = "field-map-isolate-blur";
const ON_CLASS = "field-map-isolate-on";

/**
 * The blur needs two things at once: `backdrop-filter` (blur what is painted
 * beneath) and a `clip-path: path(evenodd, …)` hole (keep the plot crisp).
 * Both are probed separately — if either is missing, the blur pane is skipped
 * and the dim+frost pair carries the mask on its own, mirroring the app's
 * `@supports` glass fallbacks.
 */
function supportsBlurPane(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
  const backdrop =
    CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)");
  const clip = CSS.supports("clip-path", 'path(evenodd, "M 0 0 L 4 4 L 0 4 Z")');
  return backdrop && clip;
}

/** `[lon, lat]` GeoJSON ring → Leaflet `[lat, lng]` latlngs. */
const toLatLngs = (ring: Ring): [number, number][] => ring.map(([lon, lat]) => [lat, lon]);

export interface PlotIsolator {
  /** Spotlight `ring`, or tear the overlay down with `null`. */
  set(ring: Ring | null): void;
}

export function createPlotIsolator(map: LeafletMap, L: LeafletNS): PlotIsolator {
  /** Leaflet's projection internals, used by the blur transform derivation. */
  const internals = map as unknown as {
    getZoomScale(to: number, from: number): number;
    project(latlng: LatLng, zoom?: number): Point;
  };

  let ring: Ring | null = null;
  /** The view the blur clip was built against (its layer-space snapshot). */
  let clipCenter: LatLng | null = null;
  let clipZoom = 0;

  let fillLayer: LeafletPolygon | null = null;
  let dimLayer: LeafletPolygon | null = null;
  let frostLayer: LeafletPolygon | null = null;
  let casingLayer: LeafletPolygon | null = null;
  let lineLayer: LeafletPolygon | null = null;

  let blurPane: HTMLElement | null = null;
  let clipPath: SVGPathElement | null = null;
  const blurEnabled = supportsBlurPane();

  /* ---- geometry ---- */

  /**
   * How far beyond the viewport the mask reaches, in layer pixels. Generous on
   * purpose: between two rebuilds the farmer can pan freely and the mask must
   * never expose an edge — geometry only goes stale through a zoom, and every
   * zoom ends in a `moveend` rebuild.
   */
  const margin = (): number => Math.max(map.getSize().x, map.getSize().y) * 2;

  /** The current view, grown on every side, as a `[lat, lng]` ring. */
  const boundsRing = (): [number, number][] => {
    const b = map.getBounds().pad(3);
    return [
      [b.getNorth(), b.getWest()],
      [b.getNorth(), b.getEast()],
      [b.getSouth(), b.getEast()],
      [b.getSouth(), b.getWest()],
    ];
  };

  /**
   * The blur pane's clip: an oversize rectangle with the plot punched out.
   * Coordinates are pane-local pixels; the pane box's top-left sits at layer
   * `(-pad, -pad)`, so a layer point `p` is pane-local `p + pad`.
   */
  const clipD = (): string => {
    const pad = margin();
    const size = map.getSize();
    const n = (v: number) => Math.round(v * 100) / 100;
    let d = `M ${n(-pad)} ${n(-pad)} H ${n(size.x + pad)} V ${n(size.y + pad)} H ${n(-pad)} Z`;
    for (const [lon, lat] of ring ?? []) {
      const p = map.latLngToLayerPoint([lat, lon]);
      d += ` L ${n(p.x + pad)} ${n(p.y + pad)}`;
    }
    return `${d} Z`;
  };

  /**
   * See the module doc for the derivation. `b − viewHalf = (−pad − w/2,
   * −pad − h/2)` because the box's top-left sits at layer `(−pad, −pad)`.
   */
  const syncBlurTransform = (center: LatLng, zoom: number): void => {
    if (!blurPane || !clipCenter) return;
    const s = internals.getZoomScale(zoom, clipZoom);
    const size = map.getSize();
    const pad = margin();
    const bx = -pad - size.x / 2;
    const by = -pad - size.y / 2;
    const pc = internals.project(clipCenter, zoom);
    const pv = internals.project(center, zoom);
    DomUtil.setTransform(blurPane, L.point((s - 1) * bx + pc.x - pv.x, (s - 1) * by + pc.y - pv.y), s);
  };

  /** Rebuild every mask geometry against the current layer space. */
  const rebuild = (): void => {
    if (!ring) return;
    clipCenter = map.getCenter();
    clipZoom = map.getZoom();

    const outer = boundsRing();
    const hole = toLatLngs(ring);
    dimLayer?.setLatLngs([outer, hole]);
    frostLayer?.setLatLngs([outer, hole]);

    if (blurPane) {
      const pad = margin();
      const size = map.getSize();
      blurPane.style.left = `${-pad}px`;
      blurPane.style.top = `${-pad}px`;
      blurPane.style.width = `${size.x + pad * 2}px`;
      blurPane.style.height = `${size.y + pad * 2}px`;
      clipPath?.setAttribute("d", clipD());
      syncBlurTransform(clipCenter, clipZoom);
    }
  };

  /* ---- events ---- */

  // CSS/pinch zooms announce the target (and, for pinch, every intermediate
  // frame) through `zoomanim`; flyTo moves the live view per frame and says so
  // through `zoom`. Both carry the same clip through the moving view.
  const onZoomAnim = (event: { center: LatLng; zoom: number }): void => {
    syncBlurTransform(event.center, event.zoom);
  };
  const onZoom = (): void => {
    syncBlurTransform(map.getCenter(), map.getZoom());
  };
  // Layer space is final again: rebuild against it. Also fires after pans,
  // where the rebuild is a cheap no-op for the blur and simply re-grows the
  // dim rectangles around the new view.
  const onRefresh = (): void => {
    rebuild();
  };

  const attach = (): void => {
    map.on("zoomanim", onZoomAnim);
    map.on("zoom", onZoom);
    map.on("moveend viewreset resize", onRefresh);
  };

  const detach = (): void => {
    map.off("zoomanim", onZoomAnim);
    map.off("zoom", onZoom);
    map.off("moveend viewreset resize", onRefresh);
  };

  /* ---- panes ---- */

  /**
   * Created once per map and kept for its lifetime: empty panes paint
   * nothing, and keeping them means Leaflet's per-pane renderer cache never
   * outlives its container.
   */
  const ensurePanes = (): void => {
    if (!map.getPane(DIM_PANE)) {
      const dim = map.createPane(DIM_PANE);
      dim.style.zIndex = String(DIM_PANE_Z);
      dim.classList.add(PANE_CLASS);
      const line = map.createPane(LINE_PANE);
      line.style.zIndex = String(LINE_PANE_Z);
      line.classList.add(PANE_CLASS);
    }
    if (blurEnabled && !map.getPane(BLUR_PANE)) {
      const blur = map.createPane(BLUR_PANE);
      blur.style.zIndex = String(BLUR_PANE_Z);
      blur.classList.add(PANE_CLASS, BLUR_CLASS);
      blur.style.setProperty("-webkit-backdrop-filter", "blur(5px) saturate(108%)");
      blur.style.backdropFilter = "blur(5px) saturate(108%)";
      blurPane = blur;

      // A zero-size defs SVG in the map container holds the clip shape; the
      // pane references it with `clip-path: url(#…)`.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.style.position = "absolute";
      const clip = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
      clip.setAttribute("id", "field-map-isolate-clip");
      clip.setAttribute("clipPathUnits", "userSpaceOnUse");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("clip-rule", "evenodd");
      clip.appendChild(path);
      svg.appendChild(clip);
      map.getContainer().appendChild(svg);
      clipPath = path;
      blur.style.clipPath = "url(#field-map-isolate-clip)";
      blur.style.setProperty("-webkit-clip-path", "url(#field-map-isolate-clip)");
    } else if (!blurEnabled) {
      blurPane = null;
    }
  };

  /* ---- public ---- */

  const set = (next: Ring | null): void => {
    if (next && next.length >= 3) {
      if (ring) set(null);
      ring = next;
      ensurePanes();
      fillLayer = L.polygon(toLatLngs(ring), {
        stroke: false,
        fillColor: FILL_COLOR,
        fillOpacity: FILL_OPACITY,
        interactive: false,
      }).addTo(map);
      dimLayer = L.polygon([boundsRing(), toLatLngs(ring)], {
        stroke: false,
        fillColor: DIM_COLOR,
        fillOpacity: DIM_OPACITY,
        interactive: false,
        pane: DIM_PANE,
      }).addTo(map);
      frostLayer = L.polygon([boundsRing(), toLatLngs(ring)], {
        stroke: false,
        fillColor: FROST_COLOR,
        fillOpacity: FROST_OPACITY,
        interactive: false,
        pane: DIM_PANE,
      }).addTo(map);
      casingLayer = L.polygon(toLatLngs(ring), {
        stroke: true,
        color: CASING_COLOR,
        opacity: 0.92,
        weight: 8,
        fill: false,
        interactive: false,
        lineJoin: "round",
        pane: LINE_PANE,
      }).addTo(map);
      lineLayer = L.polygon(toLatLngs(ring), {
        stroke: true,
        color: OUTLINE_COLOR,
        weight: 3.5,
        fill: false,
        interactive: false,
        lineJoin: "round",
        lineCap: "round",
        pane: LINE_PANE,
      }).addTo(map);
      rebuild();
      attach();
      // Fade the overlay in over the zoom animation: the panes exist at
      // opacity 0 for one frame first, then the transition runs.
      requestAnimationFrame(() => {
        for (const name of [DIM_PANE, BLUR_PANE, LINE_PANE]) {
          map.getPane(name)?.classList.add(ON_CLASS);
        }
      });
      return;
    }

    if (!ring) return;
    ring = null;
    clipCenter = null;
    detach();
    for (const layer of [fillLayer, dimLayer, frostLayer, casingLayer, lineLayer]) layer?.remove();
    fillLayer = dimLayer = frostLayer = casingLayer = lineLayer = null;
    for (const name of [DIM_PANE, BLUR_PANE, LINE_PANE]) {
      map.getPane(name)?.classList.remove(ON_CLASS);
    }
  };

  return { set };
}
