/**
 * Turns one drawn plot into a `FieldObservation`: real Sentinel-2 NDVI per
 * grid cell (Copernicus Data Space Ecosystem via openEO) plus the field's real
 * NASA POWER day, with FAO-56 ET₀ derived from it.
 *
 * WHAT IS SPATIAL AND WHAT IS NOT
 * -------------------------------
 * Only NDVI is genuinely spatial. NASA POWER answers from a ~0.5° MERRA-2
 * reanalysis cell — tens of thousands of km² — so its meteorology is applied
 * **uniformly to the whole parcel**, which is the physically correct thing to
 * do at that scale. The old `heatmap.ts` faked a ±12 % seeded per-cell spread
 * on the weather; that is gone. Every per-cell difference in an observed map
 * now traces back to a real satellite mean.
 *
 * HOW NDVI DRIVES EACH LAYER
 * --------------------------
 *  • thermal       — a field-wide baseline from the real T2M_MAX and ET₀,
 *                    raised in cells whose canopy is measurably weaker.
 *  • moisture      — the app's canonical L/ha/day stays the exact field mean;
 *                    cells with lower NDVI get a larger share of it, because a
 *                    thinner canopy both transpires less and is the part of the
 *                    parcel that needs water soonest.
 *  • transpiration — the real humidity and ET₀ set the baseline; real NDVI
 *                    sets how much green surface is actually transpiring.
 *
 * The two invariants the existing UI depends on are preserved: the moisture
 * layer still averages *exactly* back to `litresPerHaDay`, and every value is
 * reproducible from cached inputs.
 */

import { computeIrrigation, type IrrigationSystem } from "../agronomy";
import { bboxOf, centroidOf, gridCells, type GridCell, type Ring } from "../geo/polygon";
import { fetchNdvi, isConfigured, readOpeneoConfig, type OpeneoFetch, type OpeneoConfig } from "../satellite/openeo";
import { fetchPower, fetchPowerClimatology, toClimate, POWER_TIMEOUT_MS } from "../weather/power";
import type { FetchLike } from "../weather/live";
import type { CropKey } from "../wilayas";
import {
  SENTINEL_PIXEL_HA,
  type CellObservation,
  type ClimateObservation,
  type FieldDataReason,
  type FieldObservation,
  type Plot,
} from "./types";

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * Endpoints of the absolute canopy-vigour scale, read off a crop NDVI range:
 * ~0.20 is sparse or bare ground, ~0.65 is a dense closed canopy. Used to
 * convert the parcel's *measured mean* NDVI into a 0–1 condition, so a uniformly
 * stressed field is never scored the same as a uniformly healthy one.
 */
const NDVI_SPARSE = 0.2;
const NDVI_DENSE = 0.65;

/** How far back to look for a usable Sentinel-2 pass. */
const SCENE_LOOKBACK_DAYS = 20;

/** "YYYY-MM-DD" in the app's timezone (Algeria is UTC+1 all year). */
export function todayIso(now: Date = new Date()): string {
  try {
    const s = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Africa/Algiers",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    return s;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1) + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/**
 * Fallback English copy for each failure, used only when a caller has no
 * localised copy to hand (the dashboard's own reason strings live in
 * `lib/dashboard/copy.ts` so they can be translated). Every one of them says
 * the same thing: no number is shown, because none was measured.
 */
export const REASON_TEXT: Record<FieldDataReason, string> = {
  noPlot: "No field boundary saved yet. Draw one on the map to switch the heatmap to real data.",
  notConfigured:
    "Satellite data is not configured for this deployment. Add CDSE_CLIENT_ID and CDSE_CLIENT_SECRET to the server environment.",
  auth: "The Copernicus Data Space rejected the credentials. Check CDSE_CLIENT_ID / CDSE_CLIENT_SECRET.",
  network: "Could not reach the satellite service. Showing no data rather than an estimate.",
  timeout: "The satellite service took too long to answer. Showing no data rather than an estimate.",
  http: "The satellite service returned an error. Showing no data rather than an estimate.",
  quota: "The Copernicus Data Space monthly processing quota is exhausted. Showing no data rather than an estimate.",
  noScenes:
    "No cloud-free Sentinel-2 pass over this field in the last three weeks. Showing no data rather than an estimate.",
  malformed: "The satellite service returned an unreadable answer. Showing no data rather than an estimate.",
  tooSmall: "This field is too small for a reliable satellite mean. Draw a boundary of at least 0.05 ha.",
};

export interface BuildObservationInput {
  plot: Plot;
  rows: number;
  cols: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  powerFetch?: FetchLike;
  openeoFetch?: OpeneoFetch;
  /** Injected for tests. */
  openeoConfig?: OpeneoConfig;
}

export interface BuildObservationResult {
  ok: boolean;
  reason?: FieldDataReason;
  observation: FieldObservation | null;
  /** Field-wide NDVI, used as the reference for per-cell deficits. */
  meanNdvi: number | null;
  cells: GridCell[];
}

/**
 * The single entry point: one plot in, one day's real observation out.
 * Resolves the two upstreams concurrently — they are independent, and running
 * them in parallel keeps a cold cache at the slower of the two, not the sum.
 */
export async function buildObservation(input: BuildObservationInput): Promise<BuildObservationResult> {
  const { plot, rows, cols } = input;
  const now = input.now ?? new Date();
  const date = todayIso(now);
  const cells = gridCells(plot.ring, rows, cols);
  const centroid = centroidOf(plot.ring) ?? plot.centroid;
  const bbox = bboxOf(plot.ring);
  const empty: BuildObservationResult = { ok: false, observation: null, meanNdvi: null, cells };
  if (!bbox) return { ...empty, reason: "tooSmall" };

  const config = input.openeoConfig ?? readOpeneoConfig(input.env);

  /* POWER daily supplies the day's meteorology; POWER climatology supplies a
     realistic Tmax−Tmin for the location and month, which MERRA-2's smoothed
     daily extremes do not. Both are keyless and cheap; the climatology is
     memoised for the process lifetime. */
  const powerOpts = {
    now,
    ...(input.powerFetch ? { fetchImpl: input.powerFetch } : {}),
    timeoutMs: POWER_TIMEOUT_MS,
  };
  const climatePromise = Promise.all([
    fetchPower(centroid[1], centroid[0], powerOpts),
    fetchPowerClimatology(centroid[1], centroid[0], powerOpts),
  ]).then(([daily, climatology]) => toClimate(daily, climatology));

  const ndviPromise = isConfigured(config)
    ? fetchNdvi(
        config,
        {
          collection: config.collection,
          from: shiftIso(date, -SCENE_LOOKBACK_DAYS),
          to: date,
          bbox,
          targets: cells.map((cell) => ({ id: cell.id, ring: cell.ring })),
        },
        input.openeoFetch,
      )
    : Promise.resolve(null);

  const [climate, ndvi] = await Promise.all([climatePromise, ndviPromise]);

  if (!ndvi) return { ...empty, reason: "notConfigured" };
  if (!ndvi.ok) {
    return { ...empty, reason: (ndvi.reason ?? "network") as FieldDataReason, cells };
  }

  const byId = new Map(ndvi.cells.map((cell) => [cell.id, cell.ndvi]));
  const cellReadings: CellObservation[] = cells.map((cell) => ({
    id: `z-${cell.row}-${cell.col}`,
    row: cell.row,
    col: cell.col,
    ndvi: byId.get(cell.id) ?? null,
    areaHa: Math.round(cell.areaHa * 10000) / 10000,
    pixels: Math.max(0, Math.round(cell.areaHa / SENTINEL_PIXEL_HA)),
  }));

  const values = cellReadings.map((c) => c.ndvi).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return { ...empty, reason: "noScenes", cells };
  }
  const meanNdvi = values.reduce((sum, v) => sum + v, 0) / values.length;

  const climateObservation: ClimateObservation | null = climate
    ? {
        source: "nasa-power",
        date: climate.date,
        et0: climate.et0,
        et0Method: climate.et0Method ?? "hargreaves",
        et0Hargreaves: climate.et0Hargreaves,
        tempC: climate.tempC,
        tempMaxC: climate.tempMaxC,
        tempMinC: climate.tempMinC,
        humidityPct: climate.humidityPct,
        windMs: climate.windMs,
        rainMm: climate.rainMm,
        soilWetness: climate.soilWetness,
        radiationMj: climate.radiationMj,
        elevationM: climate.elevationM,
        gridDeg: climate.gridDeg,
        latitude: centroid[1],
        longitude: centroid[0],
      }
    : null;

  const observation: FieldObservation = {
    plotId: plot.id,
    date,
    sceneDate: ndvi.sceneDate,
    cells: cellReadings,
    climate: climateObservation,
    partial: values.length < cellReadings.length || climateObservation === null,
    fetchedAt: now.toISOString(),
  };

  return { ok: true, observation, meanNdvi, cells };
}

/* ------------------------------------------------------------------ */
/*  Observation → the three heatmap layers                             */
/* ------------------------------------------------------------------ */

export interface LayerValues {
  thermal: (number | null)[];
  moisture: (number | null)[];
  transpiration: (number | null)[];
  /** Real per-cell NDVI, aligned to the same indices. */
  ndvi: (number | null)[];
  pixels: (number | null)[];
  /** Layers the real data cannot support today, by name. */
  unavailable: HeatmapLayerName[];
}

export type HeatmapLayerName = "thermal" | "moisture" | "transpiration";

/**
 * Integer values that keep their exact total (largest-remainder method) —
 * the same trick the original model used, so the moisture layer still sums to
 * the canonical per-hectare figure to the litre.
 */
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

export interface LayerInput {
  observation: FieldObservation;
  /** Field mean NDVI, the reference every per-cell deficit is measured from. */
  meanNdvi: number;
  /** The app's canonical per-hectare requirement, L/ha/day. */
  litresPerHaDay: number;
}

/**
 * Projects a real observation onto the three layers.
 *
 * Returns `null` for any cell the satellite could not measure: a masked cell
 * is a missing measurement, and rendering a plausible number there is exactly
 * the kind of fiction the brief rules out. A layer whose *field-wide* driver
 * is missing (no POWER, so no real temperature baseline) reports itself in
 * `unavailable` and every cell is `null`.
 */
export function observationLayers({ observation, meanNdvi, litresPerHaDay }: LayerInput): LayerValues {
  const { cells, climate } = observation;
  const count = cells.length;
  const ndvi = cells.map((c) => c.ndvi);
  const pixels = cells.map((c) => (c.pixels > 0 ? c.pixels : null));
  const unavailable: HeatmapLayerName[] = [];

  /* TWO DIFFERENT QUESTIONS, TWO DIFFERENT NORMALISATIONS
     ---------------------------------------------------
     `contrast` answers "where inside this parcel is the canopy weakest?" — it
     is relative, scaled against the parcel's own spread.

     `vigour` answers "how healthy is this canopy at all?" — it is absolute,
     read off the measured field mean on a crop NDVI scale (0.20 sparse/bare →
     0, 0.65 dense canopy → 1).

     Both are needed. Normalising NDVI only against the parcel's own min/max
     would score a uniformly stressed field (NDVI 0.2) exactly the same as a
     uniformly healthy one (NDVI 0.9), which is agronomically wrong: the second
     transpires far more and stays far cooler. */
  const measured = ndvi.filter((v): v is number => v !== null);
  const minNdvi = measured.length ? Math.min(...measured) : 0;
  const maxNdvi = measured.length ? Math.max(...measured) : 0;
  const spread = maxNdvi - minNdvi;
  const contrast = ndvi.map((v) => {
    if (v === null) return null;
    // Below ~0.02 of real spread there is nothing honest to contrast.
    if (spread < 0.02) return 0.5;
    return clamp((v - minNdvi) / spread, 0, 1);
  });
  /** How much *worse* than the parcel mean this cell is, 0–1 (0 = at/above). */
  const deficit = contrast.map((v) => (v === null ? null : clamp(0.5 - v, 0, 1) * 2));
  /** Absolute canopy condition of the parcel, 0–1, from the measured mean. */
  const vigour = clamp((meanNdvi - NDVI_SPARSE) / (NDVI_DENSE - NDVI_SPARSE), 0, 1);

  /* --- thermal stress: real heat baseline, raised by canopy weakness ------- */
  let thermal: (number | null)[] = new Array(count).fill(null);
  if (climate && climate.tempMaxC !== null && climate.et0 > 0) {
    // 28 °C is the "no stress" floor and 43 °C the ceiling for the scale.
    const heatNorm = clamp((climate.tempMaxC - 28) / 15, 0, 1);
    const et0Norm = clamp(climate.et0 / 7, 0, 1);
    thermal = cells.map((_, i) => {
      const d = deficit[i];
      const c = contrast[i];
      if (d === null || c === null) return null;
      // Two contributions: where inside the parcel is weak (spatial), and how
      // weak the whole canopy is (absolute).
      return Math.round(
        clamp(100 * (0.05 + 0.3 * heatNorm + 0.12 * et0Norm + 0.23 * d + 0.3 * (1 - vigour)), 0, 100),
      );
    });
  } else {
    unavailable.push("thermal");
  }

  /* --- water requirement: the exact field mean, shared out by real NDVI ---- */
  let moisture: (number | null)[] = new Array(count).fill(null);
  if (litresPerHaDay > 0 && contrast.some((v) => v !== null)) {
    // Relative only: the ABSOLUTE level is the decision card's own per-hectare
    // figure, which already accounts for crop, stage and soil. NDVI's job here
    // is only to say which part of the parcel needs it soonest. A uniformly
    // weak parcel therefore has a uniform (not a fabricated) spread.
    const weights = contrast.map((v) => (v === null ? null : 1 + 0.5 * (0.5 - v)));
    const present = weights.filter((w): w is number => w !== null);
    const meanWeight = present.reduce((s, w) => s + w, 0) / (present.length || 1);
    // Build the integer split only over the measured cells, then place it back
    // so the measured cells still sum to `litresPerHaDay * measuredCount`.
    const total = Math.round(litresPerHaDay * present.length);
    const raw = present.map((w) => (w / meanWeight) * litresPerHaDay);
    const split = largestRemainder(raw, total);
    let cursor = 0;
    moisture = weights.map((w) => {
      if (w === null) return null;
      const value = split[cursor];
      cursor += 1;
      return value;
    });
  } else {
    unavailable.push("moisture");
  }

  /* --- transpiration: real humidity + ET₀ baseline, real NDVI for the green -- */
  let transpiration: (number | null)[] = new Array(count).fill(null);
  if (climate && climate.humidityPct !== null) {
    const humidityNorm = clamp(climate.humidityPct / 100, 0, 1);
    const et0Norm = climate.et0 > 0 ? clamp(climate.et0 / 7, 0, 1) : 0.5;
    transpiration = cells.map((_, i) => {
      const c = contrast[i];
      if (c === null) return null;
      // Blended: a dense parcel transpires more than a sparse one (vigour),
      // and within a parcel the greenest corner transpires most (contrast).
      return Math.round(
        clamp(100 * (0.1 + 0.3 * humidityNorm + 0.18 * et0Norm + 0.42 * (0.6 * vigour + 0.4 * c)), 0, 100),
      );
    });
  } else {
    unavailable.push("transpiration");
  }

  return { thermal, moisture, transpiration, ndvi, pixels, unavailable };
}

/**
 * Water need for the whole parcel, in m³/day, from the real POWER day. Used by
 * the map sheet's own summary; the dashboard's hero card keeps its existing
 * canonical figure so the two never silently disagree.
 */
export function parcelWaterNeedM3(areaHa: number, litresPerHaDay: number): number {
  return (areaHa * litresPerHaDay) / 1000;
}

/** Re-exported so the API route can size a plot without importing the map. */
export { computeIrrigation };
export type { CropKey, IrrigationSystem, Ring };
