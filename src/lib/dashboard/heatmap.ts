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
  | "good";

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
  /** L/ha for the moisture layer, 0–100 index for the other two. */
  value: number;
  /** Normalised position on the layer's own scale, 0–1 (drives the colour ramp). */
  intensity: number;
  /** Signed distance from the layer's field average, %. */
  deltaPct: number;
  status: ZoneStatus;
}

export interface FieldHeatmap {
  rows: number;
  cols: number;
  zones: HeatZone[];
  /** The values of every layer, in reading order (moisture = L/ha/day). */
  values: Record<HeatmapLayer, number[]>;
  /** Per-layer min/max, for the ramp and the legend. */
  scale: Record<HeatmapLayer, { min: number; max: number }>;
  /** Canonical per-hectare figure the moisture layer averages to (L/ha/day). */
  averagePerHa: number;
  /** Parcel area covered by one zone, hectares. */
  zoneAreaHa: number;
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

export function zoneStatus(layer: HeatmapLayer, value: number, deltaPct: number): ZoneStatus {
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

/** Mean of one layer across the parcel (moisture → the canonical L/ha figure). */
export function layerAverage(map: FieldHeatmap, layer: HeatmapLayer): number {
  const list = map.values[layer];
  return list.reduce((sum, v) => sum + v, 0) / list.length;
}

/**
 * Projects one zone onto the active layer: same parcel, three readings. This is
 * the only place the layer switches, so value, colour, unit and status always
 * move together.
 */
export function zoneReading(map: FieldHeatmap, zone: HeatZone, layer: HeatmapLayer): ZoneReading {
  const value = map.values[layer][zone.index];
  const { min, max } = map.scale[layer];
  const average = layerAverage(map, layer);
  const deltaPct = average > 0 ? Math.round(((value - average) / average) * 100) : 0;
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
