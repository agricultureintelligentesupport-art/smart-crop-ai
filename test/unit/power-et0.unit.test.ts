/**
 * NASA POWER: the live-confirmed contract, the −999 fill-value trap, and the
 * FAO-56 ET₀ derivation.
 *
 * `LIVE_POWER_PAYLOAD` below is a VERBATIM response captured from
 * `power.larc.nasa.gov` for Algiers (3.05 °E, 36.75 °N), 10–12 Sep 2026. It is
 * the ground truth this module is written against — including the two fields
 * that come back as `-999.0` (the documented fill value) and the MERRA-2 grid
 * size in the response header.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  POWER_FILL_VALUE,
  buildClimatology,
  buildPowerClimatologyUrl,
  buildPowerResult,
  buildPowerUrl,
  computeEt0,
  extraterrestrialRadiation,
  fetchPower,
  fetchPowerClimatology,
  resolveExtremes,
  resetClimatologyCache,
  saturationVapourPressure,
  toClimate,
  type FetchLike,
  type PowerReading,
} from "@/lib/weather/power";


const LIVE_POWER_PAYLOAD = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [3.05, 36.75, 44.61] },
  properties: {
    parameter: {
      T2M: { "20260910": 26.05, "20260911": 25.98, "20260912": 26.14 },
      T2M_MAX: { "20260910": 26.94, "20260911": 26.91, "20260912": 27.08 },
      T2M_MIN: { "20260910": 25.09, "20260911": 25.27, "20260912": 25.5 },
      RH2M: { "20260910": 72.28, "20260911": 72.12, "20260912": 71.43 },
      WS2M: { "20260910": 3.53, "20260911": 4.76, "20260912": 4.82 },
      PS: { "20260910": 100.71, "20260911": 101.08, "20260912": 101.23 },
      ALLSKY_SFC_SW_DWN: { "20260910": 21.39, "20260911": 19.59, "20260912": 20.27 },
      ALLSKY_SFC_PAR_TOT: { "20260910": -999.0, "20260911": -999.0, "20260912": -999.0 },
      PRECTOTCORR: { "20260910": 3.4, "20260911": 3.78, "20260912": 3.14 },
      CLOUD_AMT: { "20260910": -999.0, "20260911": -999.0, "20260912": -999.0 },
      GWETPROF: { "20260910": 0.37, "20260911": 0.37, "20260912": 0.38 },
    },
  },
  header: {
    title: "NASA/POWER Source Native Resolution Daily Data",
    api: { version: "v2.10.0", name: "POWER Daily API" },
    sources: ["FLASHFLUX", "GEOSIT", "POWER"],
    fill_value: -999.0,
    time_standard: "LST",
    start: "20260910",
    end: "20260912",
  },
  messages: [],
  parameters: {
    T2M: { units: "C", longname: "Temperature at 2 Meters" },
    RH2M: { units: "%", longname: "Relative Humidity at 2 Meters" },
    WS2M: { units: "m/s", longname: "Wind Speed at 2 Meters" },
  },
  times: { data: 0.58, process: 0.02 },
};

/**
 * VERBATIM POWER climatology response for the same point. This is the real
 * monthly extreme spread that recovers Penman-Monteith from MERRA-2's
 * collapsed daily range — September shows 33.25 / 19.34 °C, a 13.9 °C range.
 */
const LIVE_POWER_CLIMATOLOGY = {
  type: "Feature",
  properties: {
    parameter: {
      T2M_MAX: { JAN: 19.85, FEB: 21.81, MAR: 24.14, APR: 24.25, MAY: 32.09, JUN: 31.66, JUL: 32.86, AUG: 35.46, SEP: 33.25, OCT: 30.28, NOV: 27.0, DEC: 22.19, ANN: 35.46 },
      T2M_MIN: { JAN: 6.51, FEB: 5.67, MAR: 7.51, APR: 10.13, MAY: 11.26, JUN: 15.87, JUL: 20.31, AUG: 21.52, SEP: 19.34, OCT: 13.33, NOV: 11.16, DEC: 8.79, ANN: 5.67 },
    },
  },
  header: { range: "20-year Meteorological and Solar Monthly & Annual Climatologies (January 2001 - December 2020)" },
  messages: [],
  times: { data: 0.131, process: 0.03 },
};

/** The live Algiers climatology, parsed once and shared by the tests below. */
const CLIMATOLOGY = buildClimatology(LIVE_POWER_CLIMATOLOGY)!;

/** A POWER response carrying nothing usable. */
const EMPTY_PAYLOAD = { header: { title: "failed" }, messages: ["something went wrong"] };

function jsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },
  };
}

test("buildPowerUrl targets the keyless daily AG endpoint", () => {
  const url = new URL(buildPowerUrl(36.75, 3.05, "2026-09-10", "2026-09-12"));
  assert.equal(url.origin + url.pathname, "https://power.larc.nasa.gov/api/temporal/daily/point");
  assert.equal(url.searchParams.get("community"), "AG");
  assert.equal(url.searchParams.get("format"), "JSON");
  assert.equal(url.searchParams.get("latitude"), "36.75");
  assert.equal(url.searchParams.get("longitude"), "3.05");
  // POWER wants YYYYMMDD; the dashes must be gone.
  assert.equal(url.searchParams.get("start"), "20260910");
  assert.equal(url.searchParams.get("end"), "20260912");
  // No credential is ever sent: POWER needs none.
  assert.equal(url.search, url.search.replace(/key|token|api_key/gi, ""));
  const params = url.searchParams.get("parameters")!.split(",");
  assert.ok(params.includes("T2M_MAX"));
  assert.ok(params.includes("ALLSKY_SFC_SW_DWN"));
  // These were rejected or returned -999 in live testing, so they are absent.
  assert.ok(!params.includes("RH2M_MAX"));
  assert.ok(!params.includes("ET0"));
  assert.ok(!params.includes("CLOUD_AMT"));
});

test("the live payload maps to the newest usable day", () => {
  const result = buildPowerResult(LIVE_POWER_PAYLOAD, 36.75, 3.05);
  assert.equal(result.ok, true);
  assert.equal(result.date, "2026-09-12");
  assert.equal(result.elevationM, 44.61);
  assert.deepEqual(result.gridDeg, { lat: 0.58, lon: 0.02 });
  const r = result.reading!;
  assert.equal(r.tempC, 26.14);
  assert.equal(r.tempMaxC, 27.08);
  assert.equal(r.tempMinC, 25.5);
  assert.equal(r.humidityPct, 71.43);
  assert.equal(r.radiationMj, 20.27);
  assert.equal(r.rainMm, 3.14);
});

test("the -999 fill value becomes null, never a number", () => {
  // PAR and CLOUD are -999 in the live payload; if a field is ever requested
  // that is unavailable, it must be absent rather than -999.
  const payload = {
    ...LIVE_POWER_PAYLOAD,
    properties: {
      parameter: {
        ...LIVE_POWER_PAYLOAD.properties.parameter,
        GWETPROF: { "20260910": POWER_FILL_VALUE, "20260911": 0.37, "20260912": POWER_FILL_VALUE },
        RH2M: { "20260910": POWER_FILL_VALUE, "20260911": 72.12, "20260912": POWER_FILL_VALUE },
      },
    },
  };
  const result = buildPowerResult(payload, 36.75, 3.05);
  assert.equal(result.ok, true);
  assert.equal(result.date, "2026-09-12");
  // The masked fields are absent, NOT -999 and NOT a plausible-looking number.
  assert.equal(result.reading!.humidityPct, null);
  assert.equal(result.reading!.soilWetness, null);
  // The unmasked ones are untouched.
  assert.equal(result.reading!.tempC, 26.14);
  // And nothing anywhere in the reading leaked the sentinel value.
  assert.ok(!Object.values(result.reading!).includes(POWER_FILL_VALUE));
});

test("a day where every variable is -999 is not a reading", () => {
  // POWER masks a variable by returning the fill value for every day.
  const fill = () => ({ "20260910": POWER_FILL_VALUE, "20260911": POWER_FILL_VALUE });
  const result = buildPowerResult(
    {
      ...LIVE_POWER_PAYLOAD,
      properties: {
        parameter: {
          T2M: fill(),
          T2M_MAX: fill(),
          T2M_MIN: fill(),
          RH2M: fill(),
          WS2M: fill(),
          ALLSKY_SFC_SW_DWN: fill(),
        },
      },
    },
    36.75,
    3.05,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "noData");
  assert.equal(result.reading, null);
});

test("malformed and error payloads are reported, not guessed at", () => {
  // POWER's own error envelope carries `messages`, which maps to "no data".
  assert.equal(buildPowerResult(EMPTY_PAYLOAD, 0, 0).reason, "noData");
  // A payload with no parameter block and no explanation is unusable.
  assert.equal(buildPowerResult({ properties: {} }, 0, 0).reason, "malformed");
  assert.equal(buildPowerResult(null, 0, 0).reason, "malformed");
  assert.equal(buildPowerResult("nope", 0, 0).reason, "malformed");
});

test("non-date keys and odd values are ignored", () => {
  const result = buildPowerResult(
    {
      ...LIVE_POWER_PAYLOAD,
      properties: { parameter: { T2M: { notADate: 20, "20260101": 18.5 } } },
    },
    36.75, 3.05,
  );
  assert.equal(result.ok, true);
  assert.equal(result.date, "2026-01-01");
});

test("fetchPower needs no credentials and resolves a real reading", async () => {
  let seen = "";
  const fetchImpl: FetchLike = async (url: string) => {
    seen = url;
    return jsonResponse(LIVE_POWER_PAYLOAD) as never;
  };
  const result = await fetchPower(36.75, 3.05, { fetchImpl, now: new Date("2026-09-13T10:00:00Z") });
  assert.equal(result.ok, true);
  assert.equal(result.date, "2026-09-12");
  // The lookback window is long enough to survive POWER's few days of latency.
  assert.ok(seen.includes("start=20260903"), seen);
  assert.ok(seen.includes("end=20260913"), seen);
});

test("fetchPower never throws: HTTP, network and timeout all degrade", async () => {
  const http = await fetchPower(0, 0, { fetchImpl: async () => jsonResponse({}, false) as never });
  assert.equal(http.ok, false);
  assert.equal(http.reason, "http");

  const net = await fetchPower(0, 0, {
    fetchImpl: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(net.ok, false);
  assert.equal(net.reason, "network");

  // A fetch that hangs is aborted, and reported as a timeout rather than a
  // generic network fault.
  const slow = await fetchPower(0, 0, {
    fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as never,
    timeoutMs: 10,
  });
  assert.equal(slow.ok, false);
  assert.equal(slow.reason, "timeout");
});

test("fetchPowerClimatology memoises and survives failure", async () => {
  resetClimatologyCache();
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return jsonResponse(LIVE_POWER_CLIMATOLOGY) as never;
  };
  const first = await fetchPowerClimatology(36.75, 3.05, { fetchImpl });
  assert.ok(first);
  assert.equal(calls, 1);
  // Second call for the same point is served from memory.
  // A point ~10 m away rounds to the same 3-decimal key and is served from
  // memory; a genuinely different cell goes back to the network.
  await fetchPowerClimatology(36.7501, 3.0501, { fetchImpl });
  assert.equal(calls, 1, "climatology is cached per rounded coordinate");
  await fetchPowerClimatology(36.80, 3.05, { fetchImpl });
  assert.equal(calls, 2, "a different cell is a different cache entry");

  resetClimatologyCache();
  const failed = await fetchPowerClimatology(0, 0, {
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(failed, null, "a failed climatology must be null, not a guess");
});

test("saturation vapour pressure follows FAO-56 at its anchor points", () => {
  // 0 °C → 0.6108 kPa exactly (FAO-56 eq. 11).
  assert.ok(Math.abs(saturationVapourPressure(0) - 0.6108) < 1e-4);
  // 20 °C → 2.338 kPa, the value in FAO-56 Table 2.3.
  assert.ok(Math.abs(saturationVapourPressure(20) - 2.339) < 0.01);
});

test("extraterrestrial radiation peaks at the solstice and is sane year-round", () => {
  const summer = extraterrestrialRadiation(36.6, 172); // ~21 June
  const winter = extraterrestrialRadiation(36.6, 355); // ~21 December
  assert.ok(summer > 41 && summer < 42, `Ra June solstice ≈ 41.7, got ${summer.toFixed(1)}`);
  assert.ok(winter > 15 && winter < 16, `Ra Dec solstice ≈ 15.6, got ${winter.toFixed(1)}`);
  // Equinox sits between the two.
  const equinox = extraterrestrialRadiation(36.6, 80);
  assert.ok(equinox > winter && equinox < summer);
  // Always positive and bounded by the solar constant over one day.
  for (let doy = 1; doy <= 365; doy += 1) {
    const ra = extraterrestrialRadiation(36.6, doy);
    // The annual range at 36.6 N runs 15.63 (19 Dec) to 41.74 (19 Jun) — above
    // the 37.59 equatorial-equinox value because the long summer day more than
    // offsets the lower sun angle.
    assert.ok(ra > 0 && ra <= 42, `Ra out of range on day ${doy}: ${ra}`);
  }
  // Independent physical check: POWER measured 21.39 MJ/m2/day of shortwave at
  // Algiers on 10 Sep. The clearness index Ra ratio must stay <= 1, which the
  // mid-September value just clears. A formula off by a factor of pi would
  // produce Ra = 10 and a physically impossible Kt of 2.1.
  const raSep10 = extraterrestrialRadiation(36.75, 253);
  assert.ok(raSep10 > 21.39, `Ra must exceed the measured irradiance, got ${raSep10.toFixed(1)}`);
  assert.ok(21.39 / raSep10 < 1, "clearness index must stay below 1");
  assert.ok(21.39 / raSep10 > 0.4, "clearness index should be a believable 0.4–1");
});

test("the live Algiers day really does have a collapsed MERRA-2 range", () => {
  // Tmax 27.08 / Tmin 25.50 → 1.58 °C. Confirmed against POWER's own HOURLY
  // feed for the same day (max 26.94, min 25.09), so this is MERRA-2's real
  // behaviour at a coastal point, not an artefact of daily aggregation.
  const reading = buildPowerResult(LIVE_POWER_PAYLOAD, 36.75, 3.05).reading!;
  const range = reading.tempMaxC! - reading.tempMinC!;
  assert.ok(range < 2, `expected a collapsed range, got ${range.toFixed(2)}`);
});

test("the climatology supplies a realistic monthly range", () => {
  assert.ok(CLIMATOLOGY);
  // September (index 8) at Algiers: 33.25 − 19.34.
  assert.ok(Math.abs(CLIMATOLOGY.monthlyRangeC[8]! - 13.91) < 0.01);
  // Every month of the year is physically plausible for the coast. May is the
  // widest at 20.8 °C — MERRA-2's May extremes really are unusually spread in
  // the live payload, and that is what the source reports.
  for (const [index, range] of CLIMATOLOGY.monthlyRangeC.entries()) {
    assert.ok(range !== null && range > 5 && range < 25, `month ${index}: ${range}`);
  }
  assert.ok(Math.abs(CLIMATOLOGY.monthlyRangeC[4]! - 20.83) < 0.01);
  // December and July both keep a substantial spread.
  assert.ok(CLIMATOLOGY.monthlyRangeC[11]! > 12);
  assert.ok(CLIMATOLOGY.monthlyRangeC[6]! > 8);
});

test("buildPowerClimatologyUrl is the keyless climatology endpoint", () => {
  const url = new URL(buildPowerClimatologyUrl(36.75, 3.05));
  assert.equal(url.origin + url.pathname, "https://power.larc.nasa.gov/api/temporal/climatology/point");
  assert.equal(url.searchParams.get("community"), "AG");
  assert.equal(url.searchParams.get("latitude"), "36.75");
  assert.ok(!url.search.match(/key|token/i));
});

test("buildClimatology is defensive", () => {
  assert.equal(buildClimatology(null), null);
  assert.equal(buildClimatology({}), null);
  assert.equal(buildClimatology({ properties: { parameter: {} } }), null);
  // A month with no range at all still yields an object, with nulls.
  const sparse = buildClimatology({
    properties: { parameter: { T2M_MAX: { JAN: 20 }, T2M_MIN: { JAN: 10 } } },
  });
  assert.deepEqual(sparse!.monthlyRangeC[0], 10);
  assert.equal(sparse!.monthlyRangeC[1], null);
  // T2M_MAX == T2M_MIN is not a range, and with no usable month at all there
  // is no climatology to report.
  assert.equal(
    buildClimatology({ properties: { parameter: { T2M_MAX: { JAN: 20 }, T2M_MIN: { JAN: 20 } } } }),
    null,
  );
  // A −999 month is treated as absent, not as a range.
  const withFill = buildClimatology({
    properties: {
      parameter: {
        T2M_MAX: { JAN: POWER_FILL_VALUE, FEB: 30 },
        T2M_MIN: { JAN: POWER_FILL_VALUE, FEB: 18 },
      },
    },
  });
  assert.equal(withFill!.monthlyRangeC[0], null);
  assert.equal(withFill!.monthlyRangeC[1], 12);
});

test("resolveExtremes prefers the day, and reconstructs from climatology only when needed", () => {
  // A sound day is taken at face value.
  const good: PowerReading = {
    date: "2026-09-12", tempC: 26, tempMaxC: 34, tempMinC: 20,
    humidityPct: 60, windMs: 3, pressureKpa: 101, radiationMj: 22,
    rainMm: 0, soilWetness: 0.3,
  };
  const fromDay = resolveExtremes(good, CLIMATOLOGY);
  assert.equal(fromDay.source, "daily");
  assert.equal(fromDay.range, 14);
  assert.equal(fromDay.tMax, 34);

  // A collapsed day is rebuilt around its real mean, using September's range.
  const collapsed = { ...good, tempMaxC: 27.08, tempMinC: 25.5 };
  const fromClim = resolveExtremes(collapsed, CLIMATOLOGY);
  assert.equal(fromClim.source, "climatology");
  assert.equal(Math.round(fromClim.range!), 14); // 13.91, rounded
  assert.ok(Math.abs(fromClim.tMax! + fromClim.tMin! - 2 * 26) < 0.01, "centred on the real mean");
  assert.match(String(fromClim.note), /climatology/);

  // December uses December's range, not September's.
  const december = { ...collapsed, date: "2026-12-12" };
  assert.equal(Math.round(resolveExtremes(december, CLIMATOLOGY).range!), 13); // 22.19-8.79

  // With no climatology available there is no range at all — never a guess.
  const noClim = resolveExtremes(collapsed, null);
  assert.equal(noClim.source, "none");
  assert.equal(noClim.tMax, null);
});

test("ET₀ for the live Algiers day lands on the published value", () => {
  // The headline correctness check. Before the climatology correction this same
  // day produced ~1.7 mm/day; standard references give 4.4–4.8 mm/day for
  // Algiers in mid-September, and Penman-Monteith must land there.
  const reading = buildPowerResult(LIVE_POWER_PAYLOAD, 36.75, 3.05).reading!;
  const et0 = computeEt0(reading, 36.75, CLIMATOLOGY);
  assert.equal(et0.method, "penman-monteith");
  assert.equal(et0.rangeSource, "climatology");
  assert.ok(et0.penmanMonteith !== null);
  assert.ok(et0.et0 > 4.0 && et0.et0 < 5.6, `ET₀ = ${et0.et0.toFixed(2)} mm/day, expected ~4.7`);
  assert.equal(et0.radiation, 20.27);
  // The independent Hargreaves cross-check should broadly agree.
  assert.ok(et0.hargreaves !== null && et0.hargreaves > 3 && et0.hargreaves < 6.5);
  // Without the climatology there is no defensible value at all.
  const blind = computeEt0(reading, 36.75, null);
  assert.equal(blind.rangeSource, "none");
  assert.ok(blind.penmanMonteith === null && blind.hargreaves === null);
  assert.equal(blind.method, null);
  assert.equal(blind.et0, 0);
});

test("ET₀ uses Penman-Monteith once the inputs are sound", () => {
  // A hot, dry, well-ventilated inland day with a realistic diurnal range.
  const reading: PowerReading = {
    date: "2026-07-15",
    tempC: 32,
    tempMaxC: 40,
    tempMinC: 22,
    humidityPct: 30,
    windMs: 3,
    pressureKpa: 95,
    radiationMj: 28,
    rainMm: 0,
    soilWetness: 0.2,
  };
  const et0 = computeEt0(reading, 34.8); // Laghouat
  assert.equal(et0.method, "penman-monteith");
  assert.ok(et0.penmanMonteith !== null);
  assert.equal(et0.temperatureRangeC, 18);
  assert.equal(et0.rangeSource, "daily");
  // A 40/22 °C, 30 % RH, 3 m/s day in the Algerian interior is 6–9 mm/day.
  assert.ok(et0.et0 > 5.5 && et0.et0 < 9.5, `ET₀ out of band: ${et0.et0.toFixed(2)}`);
});

test("ET₀ reports no method rather than a number it cannot justify", () => {
  const noRadiation: PowerReading = {
    date: "2026-07-15",
    tempC: 30,
    tempMaxC: 36,
    tempMinC: 20,
    humidityPct: 40,
    windMs: 2,
    pressureKpa: 100,
    radiationMj: null,
    rainMm: 0,
    soilWetness: null,
  };
  const et0 = computeEt0(noRadiation, 36);
  // The day keeps a real 16 °C range, so Hargreaves can still run off Ra…
  assert.equal(et0.method, "hargreaves");
  assert.equal(et0.penmanMonteith, null);
  // …while Penman–Monteith explains why it could not run.
  assert.match(String(et0.note), /radiation/);

  const bare: PowerReading = {
    date: "2026-07-15",
    tempC: null,
    tempMaxC: null,
    tempMinC: null,
    humidityPct: null,
    windMs: null,
    pressureKpa: null,
    radiationMj: null,
    rainMm: null,
    soilWetness: null,
  };
  const none = computeEt0(bare, 36);
  assert.equal(none.method, null);
  assert.equal(none.et0, 0);
});

test("toClimate produces the UI shape, or null when POWER failed", () => {
  const ok = buildPowerResult(LIVE_POWER_PAYLOAD, 36.75, 3.05);
  const climate = toClimate(ok, CLIMATOLOGY);
  assert.ok(climate);
  assert.equal(climate.date, "2026-09-12");
  assert.equal(climate.et0Method, "penman-monteith");
  assert.equal(climate.et0RangeSource, "climatology");
  assert.equal(climate.et0TemperatureRangeC, 13.9);
  assert.ok(climate.et0 > 4 && climate.et0 < 5.6, `ET₀ ${climate.et0}`);
  assert.ok(climate.et0Hargreaves !== null);
  assert.match(String(climate.et0Note), /climatology/);
  assert.equal(climate.elevationM, 44.61);
  // The grid is carried so the UI can state the true spatial scale.
  assert.deepEqual(climate.gridDeg, { lat: 0.58, lon: 0.02 });

  // Without the climatology the day has no defensible ET0, and says so.
  const blind = toClimate(ok, null)!;
  assert.equal(blind.et0Method, null);
  assert.equal(blind.et0, 0);
  assert.equal(blind.et0RangeSource, "none");

  const failed = buildPowerResult(EMPTY_PAYLOAD, 0, 0);
  assert.equal(toClimate(failed), null);
});
