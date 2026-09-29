/**
 * Field heatmap model — a *deterministic* spatial split of the parcel.
 *
 * Nothing here is a new agronomic claim: the model takes the day's canonical
 * per-hectare requirement (`IrrigationResult.litresPerHaDay`) and the real
 * climate inputs already on screen, then distributes them over the zones with
 * a seeded, smooth variation field. Two hard guarantees:
 *
 *   1. The moisture layer averages **exactly** back to `litresPerHaDay`, so the
 *      heatmap can never disagree with the hero decision card.
 *   2. Everything is seeded on the wilaya + crop, so the same parcel renders
 *      identically on every device and on every render (no hydration mismatch,
 *      no "flapping" cells).
 *
 * The spatial pattern is a model estimate (see the card's honest footnote), not
 * a satellite or sensor reading.
 */

import { seededSeries } from "@/lib/agronomy";

export type HeatmapLayer = "thermal" | "moisture" | "transpiration";

/** Zone verdicts, mapped to copy in the card. */
export type ZoneStatus =
  | "wet"
  | "balanced"
  | "mildDry"
  | "dry"
  | "low"
  | "moderate"
  | "high"
  | "severe"
  | "good"
  /** No measurement for this cell (cloud, sliver, or a layer with no data). */
  | "unknown";

export interface HeatZone {
  /** Stable identity: `z-<row>-<col>`. */
  id: string;
  /** Reading-order index (0-based) — also picks the zone letter. */
  index: number;
  row: number;
  col: number;
  /** Smooth field value in [-1, 1]: negative = wetter/cooler, positive = drier/hotter. */
  offset: number;
}

/** A zone projected onto the active layer — what the card renders and inspects. */
export interface ZoneReading {
  zone: HeatZone;
  /** L/ha for the moisture layer, 0–100 index for the other two; `null` = unmeasured. */
  value: number | null;
  /** Normalised position on the layer's own scale, 0–1 (drives the colour ramp). */
  intensity: number;
  /** Signed distance from the layer's field average, %; `null` when unmeasured. */
  deltaPct: number | null;
  status: ZoneStatus;
}

export interface FieldHeatmap {
  rows: number;
  cols: number;
  zones: HeatZone[];
  /**
   * The values of every layer, in reading order (moisture = L/ha/day).
   * `null` marks a cell the active source could not measure; it is only ever
   * populated in observed mode, and the card renders it as "no data".
   */
  values: Record<HeatmapLayer, (number | null)[]>;
  /** Per-layer min/max over the measured cells, for the ramp and the legend. */
  scale: Record<HeatmapLayer, { min: number; max: number }>;
  /** Canonical per-hectare figure the moisture layer averages to (L/ha/day). */
  averagePerHa: number;
  /** Parcel area covered by one zone, hectares. */
  zoneAreaHa: number;

  /* ---- observed mode (a real plot + real satellite/weather data) ---- */

  /** True when these values came from measurements rather than the model. */
  observed?: boolean;
  /** Real mean NDVI per zone, or `null` where masked. */
  ndvi?: (number | null)[];
  /** Approximate Sentinel-2 pixels averaged per zone. */
  pixels?: (number | null)[];
  /** Layers the real data could not support today. */
  unavailableLayers?: HeatmapLayer[];
  /** Field mean of the measured NDVI, the reference for per-cell deficits. */
  meanNdvi?: number | null;
}

export interface FieldHeatmapInput {
  wilayaCode: string;
  crop: string;
  /** Parcel size, hectares. */
  areaHa: number;
  /** Canonical per-hectare requirement from `computeIrrigation`, L/ha/day. */
  litresPerHaDay: number;
  /** Reference ET0 for the day, mm/day. */
  et0: number;
  tempC: number;
  humidity: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Zones laid out on a 4-column grid; rows follow the parcel size (3 to 6). */
export function heatmapGrid(areaHa: number): { rows: number; cols: number } {
  return { rows: clamp(Math.round(areaHa * 2), 3, 6), cols: 4 };
}

/**
 * Smooth control field: a 3×3 seeded lattice, bilinearly sampled at each zone
 * centre, so neighbouring cells differ slightly instead of flickering
 * independently. Values land in [-1, 1] and are centred on 0.
 */
function offsetsFor(wilayaCode: string, crop: string, rows: number, cols: number): number[] {
  const control = seededSeries(`heatmap-${wilayaCode}-${crop}`, 9, -1, 1);
  const mean = control.reduce((sum, v) => sum + v, 0) / control.length;
  const lattice = control.map((v) => v - mean);
  const span = Math.max(...lattice.map(Math.abs)) || 1;
  const norm = lattice.map((v) => v / span);

  const at = (r: number, c: number) => norm[r * 3 + c];
  const sample = (u: number, v: number) => {
    // u, v in [0, 2] across the 3×3 lattice.
    const r0 = Math.min(Math.floor(v), 1);
    const c0 = Math.min(Math.floor(u), 1);
    const fr = v - r0;
    const fc = u - c0;
    const top = at(r0, c0) * (1 - fc) + at(r0, c0 + 1) * fc;
    const bottom = at(r0 + 1, c0) * (1 - fc) + at(r0 + 1, c0 + 1) * fc;
    return top * (1 - fr) + bottom * fr;
  };

  const out: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const u = cols === 1 ? 1 : (col / (cols - 1)) * 2;
      const v = rows === 1 ? 1 : (row / (rows - 1)) * 2;
      out.push(clamp(sample(u, v), -1, 1));
    }
  }
  return out;
}

/** Integer values that keep their exact total (largest-remainder method). */
function largestRemainder(values: number[], total: number): number[] {
  const floors = values.map((v) => Math.floor(v));
  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  let rest = total - floors.reduce((sum, v) => sum + v, 0);
  let cursor = 0;
  while (rest > 0 && order.length > 0) {
    out[order[cursor % order.length].i] += 1;
    cursor += 1;
    rest -= 1;
  }
  return out;
}

export function zoneStatus(layer: HeatmapLayer, value: number | null, deltaPct: number | null): ZoneStatus {
  // No measurement → no verdict. Never classify a cell we could not read.
  if (value === null || deltaPct === null) return "unknown";
  if (layer === "moisture") {
    if (deltaPct >= 8) return "dry";
    if (deltaPct >= 2) return "mildDry";
    if (deltaPct > -2) return "balanced";
    return "wet";
  }
  if (layer === "thermal") {
    if (value >= 75) return "severe";
    if (value >= 60) return "high";
    if (value >= 40) return "moderate";
    return "low";
  }
  if (value >= 70) return "high";
  if (value >= 55) return "good";
  if (value >= 40) return "moderate";
  return "low";
}

export function buildFieldHeatmap({
  wilayaCode,
  crop,
  areaHa,
  litresPerHaDay,
  et0,
  tempC,
  humidity,
}: FieldHeatmapInput): FieldHeatmap {
  const { rows, cols } = heatmapGrid(areaHa);
  const count = rows * cols;
  const offsets = offsetsFor(wilayaCode, crop, rows, cols);

  /* The zones must average back to the canonical per-hectare figure: build the
     multipliers, remove their own mean, then round with the remainder trick so
     the total is preserved to the litre. */
  const spread = 0.12; // ±12 % of spatial variation inside one parcel
  const rawMultipliers = offsets.map((o) => clamp(1 + spread * o, 0.6, 1.4));
  const meanMultiplier = rawMultipliers.reduce((sum, v) => sum + v, 0) / count;
  const moistureValues = largestRemainder(
    rawMultipliers.map((v) => (v / meanMultiplier) * litresPerHaDay),
    litresPerHaDay * count,
  );

  /* Thermal stress: hot wilayas sit higher on the scale, the field adds ±20. */
  const heatNorm = clamp((tempC - 24) / 14, 0, 1);
  const thermalValues = offsets.map((o) =>
    Math.round(clamp(100 * (0.16 + 0.62 * heatNorm + 0.2 * o), 0, 100)),
  );

  /* Transpiration index: humidity + crop demand as the base, field as ±18. */
  const humidityNorm = clamp(humidity / 100, 0, 1);
  const cropDemand = clamp((et0 / 6) * 0.12, 0, 0.12);
  const transpirationValues = offsets.map((o) =>
    Math.round(clamp(100 * (0.3 + 0.5 * humidityNorm + cropDemand + 0.18 * o), 0, 100)),
  );

  const values: FieldHeatmap["values"] = {
    moisture: moistureValues,
    thermal: thermalValues,
    transpiration: transpirationValues,
  };

  const scale: FieldHeatmap["scale"] = {
    thermal: { min: Math.min(...thermalValues), max: Math.max(...thermalValues) },
    moisture: { min: Math.min(...moistureValues), max: Math.max(...moistureValues) },
    transpiration: { min: Math.min(...transpirationValues), max: Math.max(...transpirationValues) },
  };

  const zones: HeatZone[] = offsets.map((offset, index) => ({
    id: `z-${Math.floor(index / cols)}-${index % cols}`,
    index,
    row: Math.floor(index / cols),
    col: index % cols,
    offset,
  }));

  return { rows, cols, zones, values, scale, averagePerHa: litresPerHaDay, zoneAreaHa: areaHa / count };
}

/** Mean of one layer across the parcel, ignoring unmeasured cells. */
export function layerAverage(map: FieldHeatmap, layer: HeatmapLayer): number | null {
  const list = map.values[layer].filter((v): v is number => v !== null);
  if (list.length === 0) return null;
  return list.reduce((sum, v) => sum + v, 0) / list.length;
}

/** Min/max over the measured cells of a layer, for the colour ramp. */
function scaleOf(values: (number | null)[]): { min: number; max: number } {
  const measured = values.filter((v): v is number => v !== null);
  if (measured.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...measured), max: Math.max(...measured) };
}

/**
 * Projects one zone onto the active layer: same parcel, three readings. This is
 * the only place the layer switches, so value, colour, unit and status always
 * move together.
 */
export function zoneReading(map: FieldHeatmap, zone: HeatZone, layer: HeatmapLayer): ZoneReading {
  const value = map.values[layer][zone.index] ?? null;
  const { min, max } = map.scale[layer];
  const average = layerAverage(map, layer);
  if (value === null) {
    // Unmeasured cells get no verdict and no delta; the card renders the
    // "no data" treatment instead of a number.
    return { zone, value: null, intensity: 0.5, deltaPct: null, status: "unknown" };
  }
  const deltaPct = average !== null && average > 0 ? Math.round(((value - average) / average) * 100) : 0;
  return {
    zone,
    value,
    intensity: max === min ? 0.5 : (value - min) / (max - min),
    deltaPct,
    status: zoneStatus(layer, value, deltaPct),
  };
}

/** Every zone of a layer, in reading order. */
export function layerReadings(map: FieldHeatmap, layer: HeatmapLayer): ZoneReading[] {
  return map.zones.map((zone) => zoneReading(map, zone, layer));
}

/**
 * The observed twin of `buildFieldHeatmap`: same grid, same zones, same colour
 * ramp, same units — but every number comes from a measurement instead of the
 * seeded model.
 *
 * Two invariants survive unchanged, because the UI around them must keep
 * working exactly as before:
 *   1. the moisture layer still averages back to `litresPerHaDay`,
 *   2. cells the satellite could not read are `null`, not interpolated.
 */
export function buildObservedHeatmap(input: {
  rows: number;
  cols: number;
  layers: {
    thermal: (number | null)[];
    moisture: (number | null)[];
    transpiration: (number | null)[];
    ndvi: (number | null)[];
    pixels: (number | null)[];
    unavailable: HeatmapLayer[];
  };
  areaHa: number;
  litresPerHaDay: number;
  meanNdvi: number | null;
}): FieldHeatmap {
  const { rows, cols, layers, areaHa, litresPerHaDay } = input;
  const count = rows * cols;
  const zones: HeatZone[] = Array.from({ length: count }, (_, index) => ({
    id: `z-${Math.floor(index / cols)}-${index % cols}`,
    index,
    row: Math.floor(index / cols),
    col: index % cols,
    offset: 0,
  }));

  // Pad a short array (a cell can vanish when it is thinner than a pixel) out
  // to the full grid with `null`, which the card reads as "no data".
  const fit = (list: (number | null)[]): (number | null)[] =>
    Array.from({ length: count }, (_, i) => (i < list.length ? list[i] : null));

  const values: FieldHeatmap["values"] = {
    thermal: fit(layers.thermal),
    moisture: fit(layers.moisture),
    transpiration: fit(layers.transpiration),
  };

  return {
    rows,
    cols,
    zones,
    values,
    scale: {
      thermal: scaleOf(values.thermal),
      moisture: scaleOf(values.moisture),
      transpiration: scaleOf(values.transpiration),
    },
    averagePerHa: litresPerHaDay,
    zoneAreaHa: areaHa / count,
    observed: true,
    ndvi: fit(layers.ndvi),
    pixels: fit(layers.pixels),
    unavailableLayers: layers.unavailable,
    meanNdvi: input.meanNdvi,
  };
}
