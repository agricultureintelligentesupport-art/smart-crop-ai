/**
 * Unit tests for the two new dashboard visuals (run in plain Node):
 *
 *   npm run test:unit
 *
 * They pin the contracts that keep the UI honest:
 *   - `perHectareFlow` reprints the intermediates of the *existing*
 *     `computeIrrigation` chain, and that chain must round back to the exact
 *     figures the hero card shows (`litresPerHaDay`, `dailyM3`).
 *   - `buildFieldHeatmap` splits the parcel deterministically, and the moisture
 *     layer must average back to `litresPerHaDay` to the litre, so the heatmap
 *     can never contradict the decision card.
 *
 * If the formula or the spatial model changes, these fail — which is exactly
 * when the flow diagram and the heatmap stop telling the truth.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { computeIrrigation, referenceEt0, weatherFor } from "../../src/lib/agronomy";
import { perHectareFlow, verifyFlow } from "../../src/lib/dashboard/flow";
import {
  buildFieldHeatmap,
  heatmapGrid,
  layerAverage,
  layerReadings,
  zoneReading,
  zoneStatus,
  type HeatmapLayer,
} from "../../src/lib/dashboard/heatmap";
import { CROPS, SOILS, WILAYAS } from "../../src/lib/wilayas";

const LAYERS: HeatmapLayer[] = ["thermal", "moisture", "transpiration"];

/* ------------------------------------------------------------------ */
/*  Per-hectare flow — the printed chain must land on the card numbers */
/* ------------------------------------------------------------------ */

test("perHectareFlow reproduces the card's per-hectare figure exactly", () => {
  const weather = weatherFor("07");
  const irrigation = computeIrrigation({
    wilayaCode: "07",
    crop: "dates",
    areaHa: 2,
    soil: "sandy",
    system: "drip",
    weather,
  });
  const flow = perHectareFlow({ irrigation, weather, areaHa: 2 });

  // Same ET0 intermediates the formula used (live or reference inputs).
  assert.equal(flow.et0.final, weather.et0);
  assert.equal(flow.et0.final, irrigation.et0);

  // net × Kc × soil ÷ efficiency → back to the litre the card shows.
  assert.equal(Math.round(flow.netMm * 10000 * (1 / irrigation.kc / irrigation.soilFactor)), 45000);
  assert.equal(Math.round(flow.grossMm * 10000), irrigation.litresPerHaDay);

  const check = verifyFlow(flow);
  assert.equal(check.litresMatch, true);
  assert.equal(flow.litresPerHa, irrigation.litresPerHaDay);
  assert.equal(flow.parcelM3, irrigation.dailyM3);
  assert.equal(flow.weeklyM3, irrigation.weeklyM3);
});

test("the flow chain holds for every wilaya, crop and parcel size", () => {
  const crops = Object.keys(CROPS) as (keyof typeof CROPS)[];
  const soils = Object.keys(SOILS) as (keyof typeof SOILS)[];
  const areas = [0.5, 1, 2, 2.5, 7.5, 12, 20];
  let checked = 0;

  for (const wilaya of WILAYAS) {
    const weather = weatherFor(wilaya.code);
    for (const crop of crops) {
      for (const soil of soils) {
        for (const areaHa of areas) {
          const irrigation = computeIrrigation({
            wilayaCode: wilaya.code,
            crop,
            areaHa,
            soil,
            system: "drip",
            weather,
          });
          const flow = perHectareFlow({ irrigation, weather, areaHa });
          const check = verifyFlow(flow);
          checked += 1;

          // The litres line is exact by construction: gross × 10 000.
          assert.equal(check.litresMatch, true, `${wilaya.code}/${crop}/${soil}/${areaHa}`);
          assert.equal(flow.litresPerHa, irrigation.litresPerHaDay);
          // The parcel line is the app's own rounded figure, so the printed
          // "≈" can never be off by more than one cubic metre.
          assert.equal(flow.parcelM3, irrigation.dailyM3);
          assert.ok(Math.abs(check.parcelDeltaM3) <= 1, `${wilaya.code}/${crop}/${soil}/${areaHa}`);
          // And the chain is monotone: gross ≥ net ≥ 0 for any real efficiency.
          assert.ok(flow.grossMm >= flow.netMm - 1e-9);
          assert.ok(flow.netMm >= 0);
        }
      }
    }
  }

  assert.ok(checked > 10_000, `expected a broad sweep, checked ${checked}`);
});

test("a live snapshot's own values feed the flow, not the wilaya baseline", () => {
  // A live snapshot whose climate differs from Biskra's baseline.
  const weather = weatherFor("07");
  const live = {
    ...weather,
    tempC: 21,
    humidity: 78,
    windKph: 24,
    et0: 0, // recomputed below like `buildLiveSnapshot` does
  };
  live.et0 = referenceEt0({ tempC: live.tempC, humidity: live.humidity, windKph: live.windKph, rainMm: live.rainMmYear });

  const irrigation = computeIrrigation({
    wilayaCode: "07",
    crop: "tomato",
    areaHa: 2,
    soil: "sandy",
    system: "drip",
    weather: live,
  });
  const flow = perHectareFlow({ irrigation, weather: live, areaHa: 2 });

  assert.equal(flow.et0.final, live.et0);
  assert.equal(Math.round(flow.grossMm * 10000), irrigation.litresPerHaDay);
  assert.equal(irrigation.et0, live.et0);
});

/* ------------------------------------------------------------------ */
/*  Field heatmap — deterministic, bounded, average-preserving         */
/* ------------------------------------------------------------------ */

test("the heatmap grid follows the parcel size", () => {
  assert.deepEqual(heatmapGrid(2), { rows: 4, cols: 4 });
  assert.deepEqual(heatmapGrid(20), { rows: 6, cols: 4 });
  assert.deepEqual(heatmapGrid(0.5), { rows: 3, cols: 4 });
  // Never square-metre sized: a tiny parcel keeps a readable grid.
  assert.equal(heatmapGrid(0.5).rows * heatmapGrid(0.5).cols, 12);
});

test("the moisture layer averages back to the card's L/ha, to the litre", () => {
  for (const areaHa of [0.5, 2, 5.5, 20]) {
    const irrigation = computeIrrigation({
      wilayaCode: "07",
      crop: "dates",
      areaHa,
      soil: "sandy",
      system: "drip",
    });
    const map = buildFieldHeatmap({
      wilayaCode: "07",
      crop: "dates",
      areaHa,
      litresPerHaDay: irrigation.litresPerHaDay,
      et0: irrigation.et0,
      tempC: 34,
      humidity: 28,
    });

    const values = map.values.moisture;
    assert.equal(values.length, map.zones.length);
    assert.equal(
      values.reduce((sum, v) => sum + v, 0),
      irrigation.litresPerHaDay * map.zones.length,
    );
    assert.equal(Math.round(layerAverage(map, "moisture")), irrigation.litresPerHaDay);
    // Real spatial spread, not a flat fill: some zones differ from the mean.
    assert.ok(values.some((v) => v !== irrigation.litresPerHaDay));
    // Each zone covers exactly one slice of the parcel.
    assert.equal(Math.round(map.zoneAreaHa * map.zones.length * 1000) / 1000, areaHa);
  }
});

test("the map is deterministic and every layer stays in range", () => {
  const build = () =>
    buildFieldHeatmap({
      wilayaCode: "16",
      crop: "tomato",
      areaHa: 2,
      litresPerHaDay: 52651,
      et0: 4.7,
      tempC: 30,
      humidity: 62,
    });

  const a = build();
  const b = build();
  assert.deepEqual(a.values, b.values);
  assert.deepEqual(a.zones, b.zones);

  for (const layer of LAYERS) {
    for (const reading of layerReadings(a, layer)) {
      assert.ok(reading.intensity >= 0 && reading.intensity <= 1, `${layer} intensity`);
      if (layer === "moisture") {
        assert.ok(reading.value > 0);
      } else {
        assert.ok(reading.value >= 0 && reading.value <= 100, `${layer} value`);
      }
    }
  }

  // The thermal layer scales with the real temperature input.
  const hot = buildFieldHeatmap({
    wilayaCode: "16",
    crop: "tomato",
    areaHa: 2,
    litresPerHaDay: 52651,
    et0: 4.7,
    tempC: 44,
    humidity: 62,
  });
  assert.ok(layerAverage(hot, "thermal") > layerAverage(a, "thermal"));
});

test("zone readings move with the layer and carry a verdict", () => {
  const map = buildFieldHeatmap({
    wilayaCode: "07",
    crop: "dates",
    areaHa: 2,
    litresPerHaDay: 55100,
    et0: 4.5,
    tempC: 34,
    humidity: 28,
  });

  const zone = map.zones[0];
  const moisture = zoneReading(map, zone, "moisture");
  const thermal = zoneReading(map, zone, "thermal");
  const transpiration = zoneReading(map, zone, "transpiration");

  // Same parcel spot, three different readings.
  assert.equal(moisture.value, map.values.moisture[0]);
  assert.equal(thermal.value, map.values.thermal[0]);
  assert.equal(transpiration.value, map.values.transpiration[0]);
  assert.equal(moisture.zone.id, thermal.zone.id);

  // Statuses are the ones the card renders as chips.
  assert.ok(["wet", "balanced", "mildDry", "dry"].includes(moisture.status));
  assert.ok(["low", "moderate", "high", "severe"].includes(thermal.status));
  assert.ok(["low", "moderate", "good", "high"].includes(transpiration.status));

  // The driest zone of the parcel really is the one asking for the most water.
  const readings = layerReadings(map, "moisture");
  const driest = readings.reduce((max, r) => (r.value > max.value ? r : max), readings[0]);
  assert.equal(driest.status, "dry");
  assert.equal(driest.value, Math.max(...map.values.moisture));
});

test("zone verdicts follow the documented thresholds", () => {
  assert.equal(zoneStatus("moisture", 0, 9), "dry");
  assert.equal(zoneStatus("moisture", 0, 3), "mildDry");
  assert.equal(zoneStatus("moisture", 0, 0), "balanced");
  assert.equal(zoneStatus("moisture", 0, -5), "wet");
  assert.equal(zoneStatus("thermal", 80, 0), "severe");
  assert.equal(zoneStatus("thermal", 62, 0), "high");
  assert.equal(zoneStatus("thermal", 41, 0), "moderate");
  assert.equal(zoneStatus("thermal", 12, 0), "low");
  assert.equal(zoneStatus("transpiration", 71, 0), "high");
  assert.equal(zoneStatus("transpiration", 56, 0), "good");
  assert.equal(zoneStatus("transpiration", 44, 0), "moderate");
  assert.equal(zoneStatus("transpiration", 20, 0), "low");
});
