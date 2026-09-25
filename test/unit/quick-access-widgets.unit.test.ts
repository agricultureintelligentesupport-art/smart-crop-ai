/**
 * Unit tests for the dashboard's quick-access widgets (run in plain Node):
 *
 *   npm run test:unit
 *
 * The widgets under the hero decision card are shortcuts, not a second source
 * of truth. These tests pin the two contracts that keep them honest:
 *
 *   - every figure a widget advertises is the *same object value* the hero
 *     decision card renders (`computeIrrigation`'s own result) — not a
 *     re-derived approximation, so the badge can never contradict the card; and
 *   - the weather widget's condition follows the app's single advisory cascade
 *     (heat → wind → ET₀ → calm), the same one the weather card prints and the
 *     irrigation-window sheet lists, in Arabic and in French.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ET0_ADVISE_MM_DAY,
  HEAT_THRESHOLD_C,
  WIND_THRESHOLD_KPH,
  computeIrrigation,
  weatherFor,
  type WeatherSnapshot,
} from "../../src/lib/agronomy";
import { DASHBOARD } from "../../src/lib/dashboard/copy";
import { fmt } from "../../src/lib/dashboard/format";
import { quickAccessFigures, weatherAdvice, weatherCondition } from "../../src/lib/dashboard/widgets";
import { CROPS, getWilaya, WILAYAS } from "../../src/lib/wilayas";

/** A snapshot with only the three advisory inputs changed. */
const withClimate = (tempC: number, windKph: number, et0: number): WeatherSnapshot => ({
  ...weatherFor("07"),
  tempC,
  windKph,
  et0,
});

/* ------------------------------------------------------------------ */
/*  The advisory cascade                                              */
/* ------------------------------------------------------------------ */

test("the condition cascade is heat → wind → ET₀ → calm, in that order", () => {
  // Each threshold fires at exactly its documented value…
  assert.equal(weatherCondition(withClimate(HEAT_THRESHOLD_C, 0, 0)), "heat");
  assert.equal(weatherCondition(withClimate(HEAT_THRESHOLD_C - 0.1, WIND_THRESHOLD_KPH, 0)), "wind");
  assert.equal(
    weatherCondition(withClimate(HEAT_THRESHOLD_C - 0.1, WIND_THRESHOLD_KPH - 0.1, ET0_ADVISE_MM_DAY)),
    "et0",
  );
  assert.equal(
    weatherCondition(withClimate(HEAT_THRESHOLD_C - 0.1, WIND_THRESHOLD_KPH - 0.1, ET0_ADVISE_MM_DAY - 0.1)),
    "calm",
  );

  // …and priority is strict: a hot, windy, dry day is one heat day, not three.
  assert.equal(weatherCondition(withClimate(40, 60, 9)), "heat");
  assert.equal(weatherCondition(withClimate(25, 60, 9)), "wind");

  // The reference climate of the demo wilaya is a heat day (34 °C in Biskra).
  assert.equal(weatherCondition(weatherFor("07")), "heat");
});

test("each condition maps to the sentence of its own rule, in both languages", () => {
  for (const lang of ["ar", "fr"] as const) {
    const copy = DASHBOARD[lang].weather;
    assert.equal(weatherAdvice("heat", copy), copy.adviceHeat);
    assert.equal(weatherAdvice("wind", copy), copy.adviceWind);
    assert.equal(weatherAdvice("et0", copy), copy.adviceIrrigate);
    assert.equal(weatherAdvice("calm", copy), copy.adviceCalm);
  }
});

/* ------------------------------------------------------------------ */
/*  Widget figures = the decision card's own numbers                   */
/* ------------------------------------------------------------------ */

test("the calculator widget reprints the hero's figures, digit for digit", () => {
  const areas = [0.5, 2, 9.5, 20];
  let checked = 0;

  for (const wilaya of WILAYAS) {
    const weather = weatherFor(wilaya.code);
    const wilayaCrop = wilaya.crops[0];
    for (const system of ["drip", "sprinkler", "furrow"] as const) {
      for (const areaHa of areas) {
        const irrigation = computeIrrigation({
          wilayaCode: wilaya.code,
          crop: wilayaCrop,
          areaHa,
          soil: wilaya.soil,
          system,
          weather,
        });
        const figures = quickAccessFigures({
          weather,
          irrigation,
          copy: DASHBOARD.ar,
          cropLabel: CROPS[wilayaCrop].ar,
          areaHa,
        });

        // Same values the card prints — no rounding step in between.
        assert.equal(figures.calculator.litresPerHaDay, irrigation.litresPerHaDay);
        assert.equal(figures.calculator.dailyM3, irrigation.dailyM3);
        assert.equal(figures.calculator.weeklyM3, irrigation.weeklyM3);
        assert.equal(figures.calculator.savedPct, irrigation.savedPct);
        // …and the display strings are the app's own formatter on those values.
        assert.equal(figures.calculator.volumeText, `${fmt(irrigation.dailyM3, 1)} m³`);
        assert.equal(figures.calculator.areaText, `${fmt(areaHa, 1)} ${DASHBOARD.ar.irrigation.areaUnit}`);
        checked += 1;
      }
    }
  }

  assert.ok(checked > 500, `expected a broad sweep, checked ${checked}`);
});

test("the weather widget formats the snapshot's own readings", () => {
  const weather = weatherFor("07");
  const irrigation = computeIrrigation({
    wilayaCode: "07",
    crop: getWilaya("07").crops[0],
    areaHa: 2,
    soil: getWilaya("07").soil,
    system: "drip",
    weather,
  });
  const figures = quickAccessFigures({
    weather,
    irrigation,
    copy: DASHBOARD.ar,
    cropLabel: CROPS[getWilaya("07").crops[0]].ar,
    areaHa: 2,
  });

  assert.equal(figures.weather.tempC, weather.tempC);
  assert.equal(figures.weather.tempText, `${fmt(weather.tempC, 1)}°C`);
  assert.equal(figures.weather.humidityText, `${fmt(weather.humidity)}%`);
  assert.equal(figures.weather.windText, `${fmt(weather.windKph)} km/h`);
  assert.equal(figures.weather.advice, DASHBOARD.ar.weather.adviceHeat);
  // Biskra's reference figures, verbatim: 34.0°C, 28%, 14 km/h, 110.0 m³ / 2 ha.
  assert.equal(figures.weather.tempText, "34.0°C");
  assert.equal(figures.weather.humidityText, "28%");
  assert.equal(figures.weather.windText, "14 km/h");
  assert.equal(figures.calculator.volumeText, "110.0 m³");
});

test("widget aria labels are complete sentences with every token filled", () => {
  const weather = weatherFor("16");
  const irrigation = computeIrrigation({
    wilayaCode: "16",
    crop: "tomato",
    areaHa: 2.5,
    soil: "loamy",
    system: "sprinkler",
    weather,
  });

  for (const lang of ["ar", "fr"] as const) {
    const copy = DASHBOARD[lang];
    const cropLabel = CROPS.tomato[lang];
    const figures = quickAccessFigures({ weather, irrigation, copy, cropLabel, areaHa: 2.5 });

    for (const aria of [figures.weather.aria, figures.calculator.aria]) {
      assert.equal(aria.includes("{"), false, `${lang}: ${aria}`);
      assert.equal(aria.trim().length > 0, true);
    }
    assert.equal(figures.weather.aria.includes(figures.weather.tempText), true);
    assert.equal(figures.weather.aria.includes(figures.weather.humidityText), true);
    assert.equal(figures.weather.aria.includes(figures.weather.windText), true);
    assert.equal(figures.calculator.aria.includes(cropLabel), true);
    assert.equal(figures.calculator.aria.includes(figures.calculator.areaText), true);
    assert.equal(figures.calculator.aria.includes(figures.calculator.volumeText), true);
  }
});
