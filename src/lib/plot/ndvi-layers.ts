/**
 * NDVI raster display for the plot-details view: everything between the
 * per-pixel raster the server returns (`FieldObservation.raster`) and what the
 * farmer sees — the colour scale, the clipping to the REAL boundary, the
 * display-only smoothing, the legend, the stats and the tap probe.
 *
 * THE ONE RULE THIS MODULE ENFORCES
 * ---------------------------------
 * A pixel the satellite did not measure is never shown as a colour and never
 * enters a statistic: `dataMask` is 0 → fully transparent → the satellite
 * imagery underneath shows through. The bilinear pass runs on **premultiplied
 * colours for display only**, so it can soften an edge but never invent a
 * value — every number the UI ever prints comes from the raw raster.
 */

import { pointInRing, type Ring } from "@/lib/geo/polygon";
import type { NdviRaster } from "@/lib/field-data/types";

/* ------------------------------------------------------------------ */
/*  Layer configuration                                                */
/* ------------------------------------------------------------------ */

/** One switchable layer of the plot-details analysis. */
export interface PlotLayerConfig {
  id: string;
  /** Arabic label of the chip (the app's primary language). */
  labelAr: string;
  /** French label, for the fr locale. */
  labelFr: string;
  /** Unit shown next to values, e.g. "NDVI" (index) or "لتر/هكتار". */
  unit: string;
  /** Where the numbers come from — printed under the legend. */
  source: string;
  /**
   * False while the layer is listed but not yet wired to real data. Only NDVI
   * is wired today; adding a layer = one config entry + its data path.
   */
  available: boolean;
}

/**
 * The layer switcher's source of truth. Rendered as RTL chips; unavailable
 * layers stay visible but disabled, so the switcher is already extensible.
 */
export const PLOT_LAYERS: readonly PlotLayerConfig[] = [
  {
    id: "ndvi",
    labelAr: "الغطاء النباتي (NDVI)",
    labelFr: "Végétation (NDVI)",
    unit: "NDVI",
    source: "Sentinel-2 L2A · Copernicus",
    available: true,
  },
  {
    id: "moisture",
    labelAr: "الاحتياج المائي",
    labelFr: "Besoin en eau",
    unit: "لتر/هكتار",
    source: "—",
    available: false,
  },
  {
    id: "thermal",
    labelAr: "الإجهاد الحراري",
    labelFr: "Stress thermique",
    unit: "٪",
    source: "—",
    available: false,
  },
];

/** The layer config an observation can actually paint today. */
export function activePlotLayer(observation: { raster?: NdviRaster } | null): PlotLayerConfig | null {
  const ndvi = PLOT_LAYERS.find((layer) => layer.id === "ndvi");
  return ndvi && observation?.raster ? ndvi : null;
}

/* ------------------------------------------------------------------ */
/*  Colour scale                                                       */
/* ------------------------------------------------------------------ */

/** RGB stops of the NDVI ramp, at `at` positions in the 0–1 domain space. */
export const NDVI_COLOR_STOPS: readonly { at: number; rgb: readonly [number, number, number] }[] = [
  { at: 0, rgb: [154, 103, 60] }, // bare / dry soil
  { at: 0.3, rgb: [201, 172, 90] }, // sparse or senescent canopy
  { at: 0.55, rgb: [125, 168, 96] }, // developing canopy
  { at: 0.8, rgb: [48, 125, 82] }, // closed canopy
  { at: 1, rgb: [11, 78, 52] }, // dense, vigorous canopy
];

/**
 * The smallest NDVI spread the scale will stretch. Below it a parcel is
 * effectively uniform, and stretching its noise to the full ramp would paint
 * dramatic colours for a difference nobody can measure — the domain is
 * centred on the mean and kept this wide instead.
 */
export const MIN_DOMAIN_SPREAD = 0.02;

/**
 * Colour-domain endpoints from the raster's REAL measured pixels: the legend
 * and the scale always quote the field's own minimum and maximum. `null` when
 * nothing was measured (the layer is not painted at all).
 */
export function ndviColorDomain(raster: NdviRaster): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raster.ndvi.length; i += 1) {
    if (!raster.dataMask[i]) continue;
    const value = raster.ndvi[i];
    if (value === null) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max - min < MIN_DOMAIN_SPREAD) {
    const middle = (min + max) / 2;
    return [middle - MIN_DOMAIN_SPREAD / 2, middle + MIN_DOMAIN_SPREAD / 2];
  }
  return [min, max];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Linear interpolation of the ramp at `t` ∈ [0, 1] (clamped). */
export function ndviColorAt(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  let lo = NDVI_COLOR_STOPS[0];
  let hi = NDVI_COLOR_STOPS[NDVI_COLOR_STOPS.length - 1];
  for (let i = 0; i < NDVI_COLOR_STOPS.length - 1; i += 1) {
    if (clamped >= NDVI_COLOR_STOPS[i].at && clamped <= NDVI_COLOR_STOPS[i + 1].at) {
      lo = NDVI_COLOR_STOPS[i];
      hi = NDVI_COLOR_STOPS[i + 1];
      break;
    }
  }
  const span = hi.at - lo.at;
  const local = span > 0 ? (clamped - lo.at) / span : 0;
  return [
    Math.round(lerp(lo.rgb[0], hi.rgb[0], local)),
    Math.round(lerp(lo.rgb[1], hi.rgb[1], local)),
    Math.round(lerp(lo.rgb[2], hi.rgb[2], local)),
  ];
}

/**
 * Pixel → colour, in the field's own real [min, max] domain. Returns the ramp
 * colour for measured values; masked pixels are the CALLER's job and are
 * always fully transparent (see `composeNdviLayer`).
 */
export function ndviColorFor(value: number, domain: readonly [number, number]): [number, number, number] {
  const [min, max] = domain;
  const t = max > min ? (value - min) / (max - min) : 0.5;
  return ndviColorAt(t);
}

/** `rgb(r, g, b)` for a measured value — labels, markers, the probe sheet. */
export function ndviCssColor(value: number, domain: readonly [number, number]): string {
  const [r, g, b] = ndviColorFor(value, domain);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * A CSS gradient across the SAME scale the canvas paints. The legend bar it
 * fills spans exactly the colour domain (its ends are labelled with the
 * domain's real min/max), so the ramp over t ∈ [0, 1] IS the gradient — no
 * extra parameters, no way for the bar and the pixels to disagree.
 */
export function ndviLegendGradientCss(): string {
  const stops = Array.from({ length: 9 }, (_, i) => {
    const t = i / 8;
    const [r, g, b] = ndviColorAt(t);
    return `rgb(${r}, ${g}, ${b}) ${(t * 100).toFixed(0)}%`;
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** Opacity of a measured pixel over the satellite imagery (display choice). */
export const NDVI_LAYER_ALPHA = 0.85;

/* ------------------------------------------------------------------ */
/*  Polygon clipping mask                                              */
/* ------------------------------------------------------------------ */

/**
 * The raster re-clipped to the REAL drawn boundary: 1 when the pixel centre
 * is inside the farmer's polygon, 0 otherwise. Sentinel Hub already masks
 * outside-geometry pixels in `dataMask`; this is the client's own guarantee
 * that only pixels of the actual parcel are ever painted, counted or probed —
 * whatever the provider's rasterisation did at the edges.
 */
export function polygonClipMask(ring: Ring, raster: NdviRaster): Uint8Array {
  const { width, height, bbox } = raster;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const lat = bbox.north - ((y + 0.5) / height) * (bbox.north - bbox.south);
    for (let x = 0; x < width; x += 1) {
      const lon = bbox.west + ((x + 0.5) / width) * (bbox.east - bbox.west);
      mask[y * width + x] = pointInRing(ring, [lon, lat]) ? 1 : 0;
    }
  }
  return mask;
}

/**
 * The pixels that carry a REAL measurement inside the parcel:
 * `dataMask` (the provider measured) ∧ `polygonClipMask` (it is the farmer's
 * ground). This one mask drives display, stats and the tap probe alike.
 */
export function measuredPixelMask(ring: Ring, raster: NdviRaster): Uint8Array {
  const clip = polygonClipMask(ring, raster);
  const mask = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < mask.length; i += 1) mask[i] = raster.dataMask[i] === 1 && clip[i] === 1 ? 1 : 0;
  return mask;
}

/* ------------------------------------------------------------------ */
/*  Stats — real pixels only                                           */
/* ------------------------------------------------------------------ */

export interface RasterStats {
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
}

/** Mean/min/max over measured pixels only; every field is `null` when none. */
export function rasterStats(raster: NdviRaster, mask?: Uint8Array): RasterStats {
  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raster.ndvi.length; i += 1) {
    if (mask ? mask[i] !== 1 : raster.dataMask[i] !== 1) continue;
    const value = raster.ndvi[i];
    if (value === null) continue;
    count += 1;
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    count,
    mean: count > 0 ? sum / count : null,
    min: count > 0 ? min : null,
    max: count > 0 ? max : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Display composition (bilinear, display-only)                       */
/* ------------------------------------------------------------------ */

export interface ComposedLayer {
  width: number;
  height: number;
  /** RGBA, `width × height × 4`, premultiplied-correct bilinear output. */
  data: Uint8ClampedArray;
}

/** Output is upscaled to roughly this many pixels on its longer side. */
const DISPLAY_TARGET_PX = 512;

/**
 * Renders the raster as an RGBA image the SVG stretches over the plot's
 * satellite texture: measured pixels get their ramp colour at
 * `NDVI_LAYER_ALPHA`, everything else stays fully transparent (the imagery
 * shows through — never an estimate).
 *
 * Smoothing is bilinear over PREMULTIPLIED colours, so a display pixel near a
 * masked edge blends towards transparency rather than pulling a colour into
 * the hole: the layer's outline follows the real cloud/boundary edge softly,
 * and no masked pixel is ever filled with a value. The scale factor only
 * feeds the browser's own smooth upscaling — the data resolution stays what
 * the satellite measured.
 */
export function composeNdviLayer(
  raster: NdviRaster,
  mask: Uint8Array,
  domain: readonly [number, number],
): ComposedLayer {
  const longest = Math.max(raster.width, raster.height);
  const scale = Math.max(1, Math.min(6, Math.round(DISPLAY_TARGET_PX / Math.max(1, longest))));
  const outW = Math.min(1024, raster.width * scale);
  const outH = Math.min(1024, raster.height * scale);
  const data = new Uint8ClampedArray(outW * outH * 4);
  const baseAlpha = NDVI_LAYER_ALPHA * 255;

  for (let oy = 0; oy < outH; oy += 1) {
    // Display pixel → raster coordinates: the +0.5 centres align pixel grids.
    const fy = (oy + 0.5) / scale - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let ox = 0; ox < outW; ox += 1) {
      const fx = (ox + 0.5) / scale - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy <= 1; dy += 1) {
        const wy = dy === 0 ? 1 - ty : ty;
        if (wy <= 0) continue;
        const y = y0 + dy;
        if (y < 0 || y >= raster.height) continue;
        for (let dx = 0; dx <= 1; dx += 1) {
          const wx = dx === 0 ? 1 - tx : tx;
          if (wx <= 0) continue;
          const x = x0 + dx;
          if (x < 0 || x >= raster.width) continue;
          const i = y * raster.width + x;
          if (mask[i] !== 1) continue;
          const value = raster.ndvi[i];
          if (value === null) continue;
          const [cr, cg, cb] = ndviColorFor(value, domain);
          const weight = wx * wy;
          const ca = baseAlpha * weight;
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const o = (oy * outW + ox) * 4;
      if (a <= 0) continue; // stays fully transparent
      data[o] = r / a;
      data[o + 1] = g / a;
      data[o + 2] = b / a;
      data[o + 3] = a;
    }
  }
  return { width: outW, height: outH, data };
}

/* ------------------------------------------------------------------ */
/*  Tap probe — the nearest REAL pixel                                 */
/* ------------------------------------------------------------------ */

export interface PixelProbe {
  /** Raster column/row of the nearest measured pixel. */
  x: number;
  y: number;
  ndvi: number;
  /** Centre of that pixel, WGS84. */
  lon: number;
  lat: number;
  /** Metres from the tapped point to that centre. */
  distanceM: number;
}

/** Pixel-centre coordinates (WGS84) of raster column `x`, row `y`. */
export function pixelCenter(raster: NdviRaster, x: number, y: number): { lon: number; lat: number } {
  const lon = raster.bbox.west + ((x + 0.5) / raster.width) * (raster.bbox.east - raster.bbox.west);
  const lat = raster.bbox.north - ((y + 0.5) / raster.height) * (raster.bbox.north - raster.bbox.south);
  return { lon, lat };
}

/**
 * The nearest pixel with a REAL measurement to a tapped lon/lat — a full scan
 * is exact and cheap at these sizes (≤ 65 536 pixels). Masked pixels are
 * skipped, so a tap on a cloud hole reports the closest pixel the satellite
 * actually saw, never an interpolated value.
 */
export function nearestMeasuredPixel(
  raster: NdviRaster,
  mask: Uint8Array,
  lon: number,
  lat: number,
): PixelProbe | null {
  let best: { x: number; y: number; ndvi: number; d2: number } | null = null;
  // Degrees are weighted by cos(lat): at parcel scale this is a faithful local
  // metric without a full haversine per pixel.
  const kx = Math.cos((lat * Math.PI) / 180);
  for (let y = 0; y < raster.height; y += 1) {
    const pixelLat = raster.bbox.north - ((y + 0.5) / raster.height) * (raster.bbox.north - raster.bbox.south);
    const dLat = pixelLat - lat;
    for (let x = 0; x < raster.width; x += 1) {
      const i = y * raster.width + x;
      if (mask[i] !== 1) continue;
      const value = raster.ndvi[i];
      if (value === null) continue;
      const pixelLon = raster.bbox.west + ((x + 0.5) / raster.width) * (raster.bbox.east - raster.bbox.west);
      const dLon = (pixelLon - lon) * kx;
      const d2 = dLon * dLon + dLat * dLat;
      if (!best || d2 < best.d2) best = { x, y, ndvi: value, d2 };
    }
  }
  if (!best) return null;
  const center = pixelCenter(raster, best.x, best.y);
  const dx = (center.lon - lon) * 111_320 * kx;
  const dy = (center.lat - lat) * 110_574;
  return { x: best.x, y: best.y, ndvi: best.ndvi, lon: center.lon, lat: center.lat, distanceM: Math.hypot(dx, dy) };
}

/** Was the exact raster pixel under a lon/lat measured? (for the probe copy) */
export function pixelAtIsMeasured(raster: NdviRaster, mask: Uint8Array, lon: number, lat: number): boolean {
  const x = Math.floor(((lon - raster.bbox.west) / (raster.bbox.east - raster.bbox.west)) * raster.width);
  const y = Math.floor(((raster.bbox.north - lat) / (raster.bbox.north - raster.bbox.south)) * raster.height);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return false;
  return mask[y * raster.width + x] === 1;
}
