/**
 * The bridge from real measurements to the existing heatmap grid.
 *
 * Two guarantees matter more than anything else here, because they are the
 * promises the card already makes to the user:
 *
 *   1. The moisture layer still averages **exactly** back to the canonical
 *      `litresPerHaDay`, so the map can never contradict the decision card.
 *   2. A cell the satellite could not read is `null` — never interpolated,
 *      never zero, never a seeded stand-in.
 *
 * Everything else here pins how real NDVI and real POWER weather combine.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildObservedHeatmap,
  layerAverage,
  layerReadings,
  zoneReading,
  zoneStatus,
} from "@/lib/dashboard/heatmap";
import { observationLayers, parcelWaterNeedM3, todayIso } from "@/lib/field-data/observation";
import type { CellObservation, ClimateObservation, FieldObservation } from "@/lib/field-data/types";

const CLIMATE: ClimateObservation = {
  source: "nasa-power",
  date: "2026-09-12",
  et0: 4.7,
  et0Method: "penman-monteith",
  et0Hargreaves: 3.9,
  tempC: 26.14,
  tempMaxC: 27.08,
  tempMinC: 25.5,
  humidityPct: 71.43,
  windMs: 3.53,
  rainMm: 3.14,
  soilWetness: 0.37,
  radiationMj: 20.27,
  elevationM: 44.61,
  gridDeg: { lat: 0.58, lon: 0.02 },
  latitude: 36.75,
  longitude: 3.05,
};

/** 16 cells, NDVI rising west→east, cell 7 cloud-masked. */
function makeObservation(ndvi: (number | null)[], climate: ClimateObservation | null = CLIMATE): FieldObservation {
  const cells: CellObservation[] = ndvi.map((value, i) => ({
    id: `z-${Math.floor(i / 4)}-${i % 4}`,
    row: Math.floor(i / 4),
    col: i % 4,
    ndvi: value,
    areaHa: 0.125,
    pixels: 12,
  }));
  return {
    plotId: "p1",
    date: "2026-09-12",
    sceneDate: "2026-09-10",
    cells,
    climate,
    partial: cells.some((c) => c.ndvi === null) || climate === null,
    fetchedAt: "2026-09-12T08:00:00.000Z",
  };
}

/** 16 distinct NDVI values so "max" and "min" cells are unambiguous. */
const SPREAD = [0.15, 0.22, 0.3, 0.38, 0.44, 0.5, 0.55, null, 0.61, 0.66, 0.7, 0.74, 0.78, 0.82, 0.86, 0.9];
const LITRES = 52651;

test("the moisture layer still averages back to the canonical per-hectare figure", () => {
  const observation = makeObservation(SPREAD);
  const measured = SPREAD.filter((v): v is number => v !== null);
  const meanNdvi = measured.reduce((s, v) => s + v, 0) / measured.length;
  const layers = observationLayers({ observation, meanNdvi, litresPerHaDay: LITRES });

  const values = layers.moisture.filter((v): v is number => v !== null);
  assert.equal(values.length, measured.length, "only the measured cells carry a value");
  // The total is preserved exactly over the MEASURED cells, and the mean is the
  // canonical figure to within the rounding of an integer litre.
  const total = values.reduce((s, v) => s + v, 0);
  assert.equal(total, Math.round(LITRES * measured.length));
  assert.ok(Math.abs(total / measured.length - LITRES) < 1);
  // Every value is a whole number of litres.
  assert.ok(values.every((v) => Number.isInteger(v)));
});

test("a masked cell is null, and its litres are shared among the measured ones", () => {
  const observation = makeObservation(SPREAD);
  const meanNdvi = SPREAD.filter((v): v is number => v !== null).reduce((s, v) => s + v, 0) / 15;
  const layers = observationLayers({ observation, meanNdvi, litresPerHaDay: LITRES });
  assert.equal(layers.moisture[7], null, "the cloud-covered cell has no water figure");
  assert.equal(layers.ndvi[7], null);
  assert.equal(layers.thermal[7], null, "and no thermal figure either");
  assert.equal(layers.transpiration[7], null);
  // The rest still sums to the same total, so the field mean is unchanged.
  const total = layers.moisture.filter((v): v is number => v !== null).reduce((s, v) => s + v, 0);
  assert.equal(total, Math.round(LITRES * 15));
});

test("lower NDVI gets a larger share of the water requirement", () => {
  const observation = makeObservation(SPREAD);
  const measured = SPREAD.filter((v): v is number => v !== null);
  const meanNdvi = measured.reduce((s, v) => s + v, 0) / measured.length;
  const layers = observationLayers({ observation, meanNdvi, litresPerHaDay: LITRES });
  // Cell 0 is the weakest canopy, cell 15 the strongest.
  const weakest = layers.moisture[0] as number;
  const strongest = layers.moisture[15] as number;
  assert.ok(weakest > strongest, `${weakest} should exceed ${strongest}`);
  // And the spread is bounded, so the pattern stays the measured one.
  assert.ok(weakest < LITRES * 1.3 && strongest > LITRES * 0.7);
});

test("the thermal layer follows the real temperature and ET₀", () => {
  const ndvi = SPREAD.map(() => 0.5);
  const meanNdvi = 0.5;
  const hot = observationLayers({ observation: makeObservation(ndvi), meanNdvi, litresPerHaDay: LITRES });
  const mild = observationLayers({
    observation: makeObservation(ndvi, { ...CLIMATE, tempMaxC: 21, et0: 2.0 }),
    meanNdvi,
    litresPerHaDay: LITRES,
  });
  const hotAvg = hot.thermal.reduce((s: number, v) => s + (v ?? 0), 0) / 16;
  const mildAvg = mild.thermal.reduce((s: number, v) => s + (v ?? 0), 0) / 16;
  assert.ok(hotAvg > mildAvg, `${hotAvg} should exceed ${mildAvg}`);
  assert.ok(hot.thermal.every((v) => v !== null && v >= 0 && v <= 100));
});

test("the thermal layer rises where the canopy is measurably weaker", () => {
  // Same weather, two canopies: a uniform weak one and a uniform strong one.
  const weak = observationLayers({ observation: makeObservation(SPREAD.map(() => 0.2)), meanNdvi: 0.2, litresPerHaDay: LITRES });
  const strong = observationLayers({ observation: makeObservation(SPREAD.map(() => 0.9)), meanNdvi: 0.9, litresPerHaDay: LITRES });
  const avg = (list: (number | null)[]): number => {
    const measured = list.filter((v): v is number => v !== null);
    return measured.reduce((sum, v) => sum + v, 0) / (measured.length || 1);
  };
  assert.ok(avg(weak.thermal) > avg(strong.thermal), "a thinner canopy is more heat-stressed");
});

test("absolute canopy vigour is scored independently of within-parcel contrast", () => {
  // A uniform weak field, a uniform strong field, and a high-contrast field all
  // have zero usable internal spread — but they are NOT the same crop, and
  // normalising only against the parcel's own min/max would score them alike.
  const uniform = (v: number) => Array(16).fill(v) as (number | null)[];
  const sparse = observationLayers({ observation: makeObservation(uniform(0.2)), meanNdvi: 0.2, litresPerHaDay: LITRES });
  const dense = observationLayers({ observation: makeObservation(uniform(0.9)), meanNdvi: 0.9, litresPerHaDay: LITRES });
  const avg = (list: (number | null)[]): number => {
    const measured = list.filter((v): v is number => v !== null);
    return measured.reduce((sum, v) => sum + v, 0) / (measured.length || 1);
  };

  // A sparse canopy transpires less than a dense one, on identical weather.
  assert.ok(avg(sparse.transpiration) < avg(dense.transpiration));
  // And a sparse canopy carries more heat stress than a dense one.
  assert.ok(avg(sparse.thermal) > avg(dense.thermal));

  // Meanwhile the moisture layer stays tied to the decision card in both cases:
  // the absolute level is the card's per-hectare figure, not something NDVI
  // is allowed to invent, and a uniform parcel therefore has a uniform spread.
  for (const layers of [sparse, dense]) {
    const values = layers.moisture.filter((v): v is number => v !== null);
    assert.equal(values.reduce((s, v) => s + v, 0), Math.round(LITRES * 16));
    // Every cell within 1 % of the mean — no fabricated spatial pattern.
    assert.ok(Math.max(...values) - Math.min(...values) <= Math.ceil(LITRES * 0.01));
  }
});

test("layers whose field-wide driver is missing report themselves unavailable", () => {
  const observation = makeObservation(SPREAD, null); // POWER unreachable
  const meanNdvi = 15 > 0 ? SPREAD.filter((v): v is number => v !== null).reduce((s, v) => s + v, 0) / 15 : 0;
  const layers = observationLayers({ observation, meanNdvi, litresPerHaDay: LITRES });
  // Without POWER there is no real temperature or humidity baseline, so those
  // layers go dark rather than falling back to a modelled value.
  assert.ok(layers.unavailable.includes("thermal"));
  assert.ok(layers.unavailable.includes("transpiration"));
  assert.ok(layers.thermal.every((v) => v === null));
  assert.ok(layers.transpiration.every((v) => v === null));
  // The moisture layer only needs NDVI plus the decision card's own figure.
  assert.ok(!layers.unavailable.includes("moisture"));
  assert.ok(layers.moisture.some((v) => v !== null));
  // NDVI itself is still real and still reported.
  assert.equal(layers.ndvi[0], 0.15);
});

test("a parcel with no usable NDVI at all yields no values, not zeros", () => {
  const observation = makeObservation(SPREAD.map(() => null));
  const layers = observationLayers({ observation, meanNdvi: 0, litresPerHaDay: LITRES });
  assert.ok(layers.moisture.every((v) => v === null));
  assert.ok(layers.thermal.every((v) => v === null));
  assert.ok(layers.transpiration.every((v) => v === null));
  assert.ok(layers.unavailable.includes("moisture"));
});

test("an NDVI string would never reach the layer maths", () => {
  // Type-level guarantee, asserted at runtime too because the payload comes
  // off the network.
  const observation = makeObservation(SPREAD);
  const dirty = observation.cells[3] as unknown as { ndvi: unknown };
  dirty.ndvi = "0.9";
  const meanNdvi = SPREAD.filter((v): v is number => v !== null).reduce((s, v) => s + v, 0) / 15;
  const layers = observationLayers({ observation, meanNdvi, litresPerHaDay: LITRES });
  assert.equal(layers.ndvi[3], "0.9" as never, "the raw value is passed through untouched");
  // …and the arithmetic below it must not produce NaN anywhere.
  for (const layer of [layers.moisture, layers.thermal, layers.transpiration]) {
    for (const v of layer) {
      assert.ok(v === null || Number.isFinite(v), `non-finite value ${v}`);
    }
  }
});

test("buildObservedHeatmap keeps the grid, zones and units the card expects", () => {
  const observation = makeObservation(SPREAD);
  const meanNdvi = SPREAD.filter((v): v is number => v !== null).reduce((s, v) => s + v, 0) / 15;
  const layers = observationLayers({ observation, meanNdvi, litresPerHaDay: LITRES });
  const map = buildObservedHeatmap({
    rows: 4,
    cols: 4,
    layers,
    areaHa: 2,
    litresPerHaDay: LITRES,
    meanNdvi,
  });

  assert.equal(map.rows, 4);
  assert.equal(map.cols, 4);
  assert.equal(map.zones.length, 16);
  assert.equal(map.observed, true);
  assert.equal(map.zones[0].id, "z-0-0");
  assert.equal(map.zones[15].id, "z-3-3");
  assert.equal(map.averagePerHa, LITRES);
  assert.ok(Math.abs(map.zoneAreaHa * 16 - 2) < 1e-9);
  // The provenance arrays line up with the zones.
  assert.equal(map.ndvi?.length, 16);
  assert.equal(map.pixels?.length, 16);
  assert.equal(map.pixels?.[0], 12);
  assert.ok(Math.abs(map.meanNdvi! - meanNdvi) < 1e-9);
  // The ramp is built from the measured values only.
  const scale = map.scale.moisture;
  const measured = layers.moisture.filter((v): v is number => v !== null);
  assert.equal(scale.min, Math.min(...measured));
  assert.equal(scale.max, Math.max(...measured));
  // A layer with nothing to show has a zero-width scale, not a NaN.
  const blind = buildObservedHeatmap({
    rows: 4, cols: 4, layers: { ...layers, thermal: Array(16).fill(null) },
    areaHa: 2, litresPerHaDay: LITRES, meanNdvi,
  });
  assert.deepEqual(blind.scale.thermal, { min: 0, max: 0 });
});

test("an unmeasured zone gets no verdict and no delta", () => {
  const observation = makeObservation(SPREAD);
  const meanNdvi = SPREAD.filter((v): v is number => v !== null).reduce((s, v) => s + v, 0) / 15;
  const map = buildObservedHeatmap({
    rows: 4, cols: 4,
    layers: observationLayers({ observation, meanNdvi, litresPerHaDay: LITRES }),
    areaHa: 2, litresPerHaDay: LITRES, meanNdvi,
  });

  const masked = zoneReading(map, map.zones[7], "moisture");
  assert.equal(masked.value, null);
  assert.equal(masked.deltaPct, null);
  assert.equal(masked.status, "unknown");
  // The intensity is a neutral 0.5 so the cell renders grey, not as an extreme.
  assert.equal(masked.intensity, 0.5);

  const measured = zoneReading(map, map.zones[0], "moisture");
  assert.ok(measured.value !== null);
  assert.ok(measured.deltaPct !== null);
  assert.notEqual(measured.status, "unknown");
});

test("layerAverage ignores unmeasured cells and returns null when there are none", () => {
  const observation = makeObservation(SPREAD);
  const meanNdvi = SPREAD.filter((v): v is number => v !== null).reduce((s, v) => s + v, 0) / 15;
  const map = buildObservedHeatmap({
    rows: 4, cols: 4,
    layers: observationLayers({ observation, meanNdvi, litresPerHaDay: LITRES }),
    areaHa: 2, litresPerHaDay: LITRES, meanNdvi,
  });
  const average = layerAverage(map, "moisture");
  assert.ok(average !== null);
  assert.ok(Math.abs(average! - LITRES) < 1, `mean ${average} should tie to ${LITRES}`);

  const empty = buildObservedHeatmap({
    rows: 4, cols: 4,
    layers: {
      thermal: Array(16).fill(null), moisture: Array(16).fill(null), transpiration: Array(16).fill(null),
      ndvi: Array(16).fill(null), pixels: Array(16).fill(12), unavailable: ["thermal", "moisture", "transpiration"],
    },
    areaHa: 2, litresPerHaDay: LITRES, meanNdvi: null,
  });
  assert.equal(layerAverage(empty, "moisture"), null);
  // The card shows the "no data" label in that case rather than a NaN.
  assert.ok(layerReadings(empty, "moisture").every((r) => r.status === "unknown"));
});

test("zoneStatus refuses to classify a missing value", () => {
  assert.equal(zoneStatus("moisture", null, null), "unknown");
  assert.equal(zoneStatus("thermal", null, 10), "unknown");
  assert.equal(zoneStatus("moisture", 100, null), "unknown");
  // The documented thresholds still hold for real values.
  assert.equal(zoneStatus("moisture", 100, 9), "dry");
  assert.equal(zoneStatus("thermal", 80, 0), "severe");
  assert.equal(zoneStatus("transpiration", 60, 0), "good");
});

test("a short cell array is padded with nulls, never with zeros", () => {
  const map = buildObservedHeatmap({
    rows: 2, cols: 2,
    layers: {
      thermal: [10, 20], moisture: [100, 200], transpiration: [5, 6],
      ndvi: [0.3, 0.4], pixels: [10, 10], unavailable: [],
    },
    areaHa: 1, litresPerHaDay: 150, meanNdvi: 0.35,
  });
  assert.equal(map.values.moisture.length, 4);
  assert.equal(map.values.moisture[2], null, "missing cells are absent, not zero");
  assert.equal(map.values.moisture[3], null);
  assert.equal(map.ndvi?.[2], null);
  // The scale ignores the padding.
  assert.deepEqual(map.scale.moisture, { min: 100, max: 200 });
});

test("parcel water need is litres per hectare times hectares", () => {
  assert.equal(parcelWaterNeedM3(2, 50000), 100);
  assert.equal(parcelWaterNeedM3(0.5, 40000), 20);
  assert.equal(parcelWaterNeedM3(0, 50000), 0);
});

test("todayIso is a plain calendar date", () => {
  assert.match(todayIso(new Date("2026-09-12T23:30:00Z")), /^\d{4}-\d{2}-\d{2}$/);
  // 23:30 UTC is already the 13th in Algiers (UTC+1), and the cache key must
  // agree with the user's calendar, not the server's.
  assert.equal(todayIso(new Date("2026-09-12T23:30:00Z")), "2026-09-13");
  assert.equal(todayIso(new Date("2026-09-12T10:00:00Z")), "2026-09-12");
});
