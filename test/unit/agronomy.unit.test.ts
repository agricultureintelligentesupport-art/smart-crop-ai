/**
 * Unit tests for the agronomy layer (run in plain Node — no browser needed).
 *
 *   npm run test:unit
 *
 * These pin the *real* decision math the dashboard shows: the ET0 formula's
 * intermediate terms, the computeIrrigation chain (net → gross → volumes),
 * the exported advisory thresholds, and the deterministic weather series
 * shape the UI charts from. If the formula changes, these fail — which is
 * exactly when the irrigation-window detail sheet's explanation would stop
 * telling the truth.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY_KEYS,
  ET0_ADVISE_MM_DAY,
  HEAT_THRESHOLD_C,
  HOUR_LABELS,
  SYSTEM_EFFICIENCY,
  WIND_THRESHOLD_KPH,
  computeIrrigation,
  referenceEt0,
  referenceEt0Detail,
  weatherFor,
} from "../../src/lib/agronomy";
import { WILAYA_BY_CODE } from "../../src/lib/wilayas";

const round1 = (n: number) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ */
/*  ET0 — formula intermediates match the historical single value      */
/* ------------------------------------------------------------------ */

test("referenceEt0Detail exposes the real terms of the ET0 formula", () => {
  // Wilaya 07 (Biskra): tempC 34, humidity 28, windKph 14.
  const biskra = WILAYA_BY_CODE["07"].climate;
  const { humidityDamping, windBoost, raw, final, clamped } = referenceEt0Detail(biskra);

  assert.equal(humidityDamping, 0.72 + (28 / 100) * 0.42); // 0.8376
  assert.equal(windBoost, 1 + (14 - 12) * 0.012); // 1.024
  assert.ok(Math.abs(raw - 0.155 * 34 * 0.8376 * 1.024) < 1e-9);
  assert.equal(final, 4.5);
  assert.equal(clamped, false);
  // The public scalar is unchanged by the refactor.
  assert.equal(referenceEt0(biskra), final);
});

test("referenceEt0Detail clamps to [1.4, 9.5] and flags it", () => {
  const extremeHot = referenceEt0Detail({ tempC: 65, humidity: 5, windKph: 40, rainMm: 0 });
  assert.equal(extremeHot.final, 9.5);
  assert.equal(extremeHot.clamped, true);

  const extremeCool = referenceEt0Detail({ tempC: 5, humidity: 95, windKph: 5, rainMm: 2000 });
  assert.equal(extremeCool.final, 1.4);
  assert.equal(extremeCool.clamped, true);
});

/* ------------------------------------------------------------------ */
/*  Irrigation — the full chain, pinned to hand-computed values        */
/* ------------------------------------------------------------------ */

test("computeIrrigation chain: Biskra · dates · sandy · drip · 2 ha", () => {
  const r = computeIrrigation({
    wilayaCode: "07",
    crop: "dates",
    areaHa: 2,
    soil: "sandy",
    system: "drip",
  });

  const et0 = 4.5; // from the test above
  const kc = 0.95; // KC.dates
  const soilFactor = 1.16; // SOIL_FACTOR.sandy
  const efficiency = 0.9; // SYSTEM_EFFICIENCY.drip

  // The newly exposed intermediates agree with the formula.
  assert.equal(r.et0, et0);
  assert.equal(r.kc, kc);
  assert.equal(r.soilFactor, soilFactor);
  assert.equal(r.efficiency, efficiency);
  assert.equal(r.efficiency, SYSTEM_EFFICIENCY.drip);

  const net = et0 * kc * soilFactor; // 4.959
  const gross = net / efficiency; // 5.51
  assert.equal(round1(net), r.netMmDay); // 5.0
  assert.equal(round1(gross), r.grossMmDay); // 5.5

  // Volumes come from the un-rounded gross (as before).
  assert.equal(Math.round(gross * 10000), r.litresPerHaDay); // 55100
  assert.equal(Math.round(gross * 2 * 10), r.dailyM3); // 110
  assert.equal(Math.round(gross * 7 * 2 * 10), r.weeklyM3); // 771

  // Furrow comparison.
  const furrow = net / 0.55;
  assert.equal(round1(furrow), r.furrowMmDay);
  assert.equal(Math.round((furrow - gross) * 2 * 10000), r.savedLitresPerDay);
  assert.equal(Math.max(0, Math.round(((furrow - gross) / furrow) * 100)), r.savedPct);
});

test("computeIrrigation reacts to the real inputs", () => {
  const base = computeIrrigation({ wilayaCode: "07", crop: "dates", areaHa: 2, soil: "sandy", system: "drip" });
  // More area → proportionally more water.
  const bigger = computeIrrigation({ wilayaCode: "07", crop: "dates", areaHa: 4, soil: "sandy", system: "drip" });
  assert.equal(bigger.litresPerHaDay, base.litresPerHaDay);
  assert.equal(bigger.dailyM3, base.dailyM3 * 2);
  // Less efficient system → more gross water for the same need.
  const furrow = computeIrrigation({ wilayaCode: "07", crop: "dates", areaHa: 2, soil: "sandy", system: "furrow" });
  assert.equal(furrow.netMmDay, base.netMmDay);
  assert.ok(furrow.litresPerHaDay > base.litresPerHaDay);
});

/* ------------------------------------------------------------------ */
/*  Weather series — the exact shape the detail-sheet charts consume   */
/* ------------------------------------------------------------------ */

test("weatherFor is deterministic and exposes 6 hourly + 7 daily points", () => {
  const a = weatherFor("07");
  const b = weatherFor("07");
  assert.deepEqual(a, b); // stable per wilaya, every render

  assert.equal(a.tempC, WILAYA_BY_CODE["07"].climate.tempC);
  assert.equal(a.humidity, WILAYA_BY_CODE["07"].climate.humidity);
  assert.equal(a.windKph, WILAYA_BY_CODE["07"].climate.windKph);
  assert.equal(a.rainMmYear, WILAYA_BY_CODE["07"].climate.rainMm);
  assert.equal(a.et0, referenceEt0(WILAYA_BY_CODE["07"].climate));

  assert.equal(a.hours.length, HOUR_LABELS.length); // 6 hourly readings
  assert.deepEqual(a.hours.map((h) => h.label), [...HOUR_LABELS]);
  for (const h of a.hours) {
    assert.ok(Number.isFinite(h.tempC) && h.tempC > -50 && h.tempC < 80);
    // The reference series always carries a rain probability.
    assert.ok(typeof h.rainPct === "number" && h.rainPct >= 0 && h.rainPct <= 100);
  }

  assert.equal(a.days.length, DAY_KEYS.length); // 7-day series
  assert.deepEqual(a.days.map((d) => d.labelKey), [...DAY_KEYS]);
  for (const d of a.days) {
    assert.ok(d.minC < d.maxC);
    assert.ok(typeof d.rainPct === "number" && d.rainPct >= 0 && d.rainPct <= 100);
  }
});

/* ------------------------------------------------------------------ */
/*  Advisory thresholds — the real values the window rationale uses    */
/* ------------------------------------------------------------------ */

test("advisory thresholds match the dashboard's rule values", () => {
  assert.equal(HEAT_THRESHOLD_C, 33);
  assert.equal(WIND_THRESHOLD_KPH, 20);
  assert.equal(ET0_ADVISE_MM_DAY, 5);
});
