/**
 * Unit tests for the live Open-Meteo data layer (run in plain Node).
 *
 *   npm run test:unit
 *
 * Covers the pure parts of the live-weather integration: the payload →
 * snapshot mapping (including null/invalid handling), the hour selection,
 * weekday labels, the per-wilaya cache + TTL, the fetch wrapper (success,
 * every failure mode, in-flight dedupe), and the guarantee that
 * computeIrrigation's formula is unchanged — only its climate inputs can
 * differ (live vs reference). No network and no browser are needed: the
 * fetch implementation and clock are injected, and the fixtures mirror the
 * real Open-Meteo forecast response shape.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { computeIrrigation, referenceEt0, weatherFor } from "../../src/lib/agronomy";
import { DEFAULT_WILAYA_CODE, WILAYAS, WILAYA_BY_CODE } from "../../src/lib/wilayas";
import {
  LIVE_TTL_MS,
  buildLiveSnapshot,
  fetchLiveSnapshot,
  isFresh,
  openMeteoUrl,
  readLiveCache,
  selectNextHourIndexes,
  weekdayIndex,
  wilayaLocalNowIso,
  writeLiveCache,
  type FetchLike,
} from "../../src/lib/weather/live";

const round1 = (n: number) => Math.round(n * 10) / 10;
const NOW_ISO = "2026-09-24T12:15"; // a Thursday afternoon (Africa/Algiers local)
const NOW_MS = Date.parse("2026-09-24T11:15:00Z"); // same instant in UTC (UTC+1)

/* ------------------------------------------------------------------ */
/*  fixtures — mirrors the real Open-Meteo forecast response shape     */
/* ------------------------------------------------------------------ */

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function makePayload(overrides: Record<string, unknown> = {}): unknown {
  const start = new Date(2026, 8, 24); // 2026-09-24 (Thursday)
  const times: string[] = [];
  const temp: number[] = [];
  const hum: number[] = [];
  const wind: number[] = [];
  const rain: (number | null)[] = [];
  const dTimes: string[] = [];
  const dMin: number[] = [];
  const dMax: number[] = [];
  const dRain: (number | null)[] = [];

  for (let day = 0; day < 7; day += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + day);
    dTimes.push(isoDate(d));
    dMin.push(20 + day * 0.333);
    dMax.push(32 + day * 0.555);
    dRain.push(day === 3 ? null : 10 + day);
    for (let h = 0; h < 24; h += 1) {
      const t = new Date(d);
      t.setHours(h, 0, 0, 0);
      times.push(`${isoDate(t)}T${String(h).padStart(2, "0")}:00`);
      temp.push(22 + h * 0.4 + day * 0.2);
      hum.push(40 + h);
      wind.push(8 + h * 0.3);
      rain.push(h === 13 && day === 0 ? null : 15 + (h % 5));
    }
  }

  return {
    timezone: "Africa/Algiers",
    current: { time: NOW_ISO, temperature_2m: 28.44, relative_humidity_2m: 23.6, wind_speed_10m: 14.3 },
    hourly: {
      time: times,
      temperature_2m: temp,
      relative_humidity_2m: hum,
      wind_speed_10m: wind,
      precipitation_probability: rain,
    },
    daily: {
      time: dTimes,
      temperature_2m_min: dMin,
      temperature_2m_max: dMax,
      precipitation_probability_max: dRain,
    },
    ...overrides,
  };
}

const okJson = (payload: unknown): { ok: boolean; json: () => Promise<unknown> } => ({
  ok: true,
  json: async () => payload,
});

/* ------------------------------------------------------------------ */
/*  URL + time helpers                                                 */
/* ------------------------------------------------------------------ */

test("openMeteoUrl targets the forecast endpoint with the needed fields", () => {
  const url = openMeteoUrl(34.85, 5.73);
  assert.ok(url.startsWith("https://api.open-meteo.com/v1/forecast?"));
  for (const part of [
    "latitude=34.85",
    "longitude=5.73",
    "current=temperature_2m%2Crelative_humidity_2m%2Cwind_speed_10m",
    "hourly=",
    "precipitation_probability",
    "daily=temperature_2m_min%2Ctemperature_2m_max%2Cprecipitation_probability_max",
    "forecast_days=7",
    "timezone=auto",
    "wind_speed_unit=kmh",
  ]) {
    assert.ok(url.includes(part), `missing ${part}`);
  }
});

test("wilayaLocalNowIso renders Africa/Algiers local time (UTC+1)", () => {
  assert.match(wilayaLocalNowIso(NOW_MS), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  // 11:15 UTC + 1 h (Algiers has no DST) = 12:15 local.
  assert.equal(wilayaLocalNowIso(NOW_MS), "2026-09-24T12:15");
});

test("weekdayIndex matches the app's dayLabels order (0 = Sunday)", () => {
  assert.equal(weekdayIndex("2026-09-24"), 4); // Thursday
  assert.equal(weekdayIndex("2026-09-27"), 0); // Sunday
  assert.equal(weekdayIndex("2026-09-28"), 1); // Monday
});

test("selectNextHourIndexes picks the next N strictly-future slots", () => {
  const times = ["2026-09-24T11:00", "2026-09-24T12:00", "2026-09-24T13:00", "2026-09-24T14:00"];
  // Strictly after 12:15 → 13:00, 14:00
  assert.deepEqual(selectNextHourIndexes(times, "2026-09-24T12:15", 6), [2, 3]);
  // Exactly at 12:00 → the 12:00 slot is not "future"
  assert.deepEqual(selectNextHourIndexes(times, "2026-09-24T12:00", 2), [2, 3]);
  // Fewer available than requested → all of them (10:00 itself is not a slot)
  assert.deepEqual(selectNextHourIndexes(times, "2026-09-24T10:00", 9), [0, 1, 2, 3]);
  assert.deepEqual(selectNextHourIndexes([], NOW_ISO, 6), []);
});

/* ------------------------------------------------------------------ */
/*  payload → snapshot mapping                                         */
/* ------------------------------------------------------------------ */

test("buildLiveSnapshot maps a real-shape payload to a WeatherSnapshot", () => {
  const biskra = WILAYA_BY_CODE["07"];
  const snap = buildLiveSnapshot(biskra, makePayload(), NOW_ISO);
  assert.ok(snap);

  // Current conditions — the inputs that feed ET0 — rounded like the reference.
  assert.equal(snap.tempC, 28.4);
  assert.equal(snap.humidity, 24);
  assert.equal(snap.windKph, 14);
  assert.equal(snap.wilaya, biskra);
  assert.equal(snap.rainMmYear, biskra.climate.rainMm); // climatology kept
  // Same ET0 formula, live inputs.
  assert.equal(
    snap.et0,
    referenceEt0({ tempC: snap.tempC, humidity: snap.humidity, windKph: snap.windKph, rainMm: biskra.climate.rainMm }),
  );

  // Next 6 hourly slots: real clock labels starting 13:00.
  assert.equal(snap.hours.length, 6);
  assert.deepEqual(snap.hours.map((h) => h.label), ["13", "14", "15", "16", "17", "18"]);
  assert.equal(snap.hours[0].tempC, round1(22 + 13 * 0.4));
  assert.equal(snap.hours[0].humidity, 53);
  assert.equal(snap.hours[0].windKph, round1(8 + 13 * 0.3));
  // Null rain probability stays null (never invented).
  assert.equal(snap.hours[0].rainPct, null);
  assert.equal(snap.hours[1].rainPct, 19); // 15 + (14 % 5)

  // 7 daily ranges with REAL weekday labels.
  assert.equal(snap.days.length, 7);
  assert.deepEqual(snap.days.map((d) => d.labelKey), [4, 5, 6, 0, 1, 2, 3]);
  assert.equal(snap.days[0].minC, 20);
  assert.equal(snap.days[0].maxC, 32);
  assert.equal(snap.days[1].minC, round1(20.333));
  assert.equal(snap.days[3].rainPct, null); // day with null probability
  assert.equal(snap.days[1].rainPct, 11);
});

test("buildLiveSnapshot rejects unusable payloads (fallback, no invention)", () => {
  const biskra = WILAYA_BY_CODE["07"];
  assert.equal(buildLiveSnapshot(biskra, null, NOW_ISO), null);
  assert.equal(buildLiveSnapshot(biskra, "hello", NOW_ISO), null);
  assert.equal(buildLiveSnapshot(biskra, { current: {} }, NOW_ISO), null);
  assert.equal(
    buildLiveSnapshot(biskra, makePayload({ current: { temperature_2m: null } }), NOW_ISO),
    null,
  );
  // Current block with missing humidity/wind.
  assert.equal(buildLiveSnapshot(biskra, { current: { temperature_2m: 28 } }, NOW_ISO), null);
  // Hourly array too short to provide 6 future slots.
  assert.equal(buildLiveSnapshot(biskra, makePayload({ hourly: { time: ["2026-09-24T00:00"] } }), NOW_ISO), null);
  // Now too late in the forecast window.
  assert.equal(buildLiveSnapshot(biskra, makePayload(), "2026-09-30T20:00"), null);
  // A missing daily core value.
  const p = makePayload() as { daily: Record<string, unknown> };
  p.daily.temperature_2m_min = [null, 21, 22, 23, 24, 25, 26];
  assert.equal(buildLiveSnapshot(biskra, p, NOW_ISO), null);
});

/* ------------------------------------------------------------------ */
/*  cache: TTL + per-wilaya entries (in-memory, no browser needed)     */
/* ------------------------------------------------------------------ */

test("cache round-trip and 1-hour TTL", () => {
  const snap = buildLiveSnapshot(WILAYA_BY_CODE["08"], makePayload(), NOW_ISO)!;
  const entry = { fetchedAt: NOW_MS, snapshot: snap };
  writeLiveCache("08", entry);

  const read = readLiveCache("08");
  assert.ok(read);
  assert.equal(read.fetchedAt, NOW_MS);
  assert.equal(read.snapshot.tempC, snap.tempC);

  assert.equal(isFresh(NOW_MS + LIVE_TTL_MS - 1, NOW_MS + LIVE_TTL_MS - 1 + 0), true);
  assert.equal(isFresh(NOW_MS, NOW_MS + LIVE_TTL_MS - 1), true);
  assert.equal(isFresh(NOW_MS, NOW_MS + LIVE_TTL_MS + 1), false);
  assert.equal(readLiveCache("unknown-code"), null);
});

test("cache validates stored JSON (malformed → null, never throws)", () => {
  const memStorage = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => memStorage.get(k) ?? null,
      setItem: (k: string, v: string) => void memStorage.set(k, v),
      removeItem: (k: string) => void memStorage.delete(k),
    },
  };
  try {
    // Unknown code, malformed stored JSON → null.
    memStorage.set("smart-crop.live-weather.v1.99", "{not json");
    assert.equal(readLiveCache("99"), null);
    // Unknown code, wrong shape → null.
    memStorage.set("smart-crop.live-weather.v1.98", JSON.stringify({ fetchedAt: NOW_MS }));
    assert.equal(readLiveCache("98"), null);
    // Unknown code, well-formed → returned.
    const snap = buildLiveSnapshot(WILAYA_BY_CODE["30"], makePayload(), NOW_ISO)!;
    memStorage.set("smart-crop.live-weather.v1.30", JSON.stringify({ fetchedAt: NOW_MS, snapshot: snap }));
    const read = readLiveCache("30");
    assert.ok(read);
    assert.equal(read.snapshot.tempC, snap.tempC);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

/* ------------------------------------------------------------------ */
/*  fetch wrapper: success, every failure mode, dedupe                 */
/* ------------------------------------------------------------------ */

test("fetchLiveSnapshot resolves a cache entry on success", async () => {
  const oran = WILAYA_BY_CODE["31"];
  const stub: FetchLike = async (url) => {
    assert.ok(url.includes("latitude=35.71"));
    return okJson(makePayload());
  };
  const entry = await fetchLiveSnapshot(oran, { fetchImpl: stub, now: () => NOW_MS });
  assert.ok(entry);
  assert.equal(entry.fetchedAt, NOW_MS);
  assert.equal(entry.snapshot.tempC, 28.4);
  const cached = readLiveCache("31");
  assert.ok(cached);
  assert.equal(cached.fetchedAt, NOW_MS);
});

test("fetchLiveSnapshot resolves null on every failure mode (never rejects)", async () => {
  const bechar = WILAYA_BY_CODE["08"];
  const rejecter: FetchLike = async () => {
    throw new Error("network down");
  };
  const notOk: FetchLike = async () => ({ ok: false, json: async () => ({}) });
  const badPayload: FetchLike = async () => okJson({ surprise: true });

  assert.equal(await fetchLiveSnapshot(bechar, { fetchImpl: rejecter, now: () => NOW_MS }), null);
  assert.equal(await fetchLiveSnapshot(bechar, { fetchImpl: notOk, now: () => NOW_MS }), null);
  assert.equal(await fetchLiveSnapshot(bechar, { fetchImpl: badPayload, now: () => NOW_MS }), null);
});

test("fetchLiveSnapshot dedupes concurrent calls for the same wilaya", async () => {
  const algiers = WILAYA_BY_CODE["16"];
  let calls = 0;
  const stub: FetchLike = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return okJson(makePayload());
  };
  const [a, b] = await Promise.all([
    fetchLiveSnapshot(algiers, { fetchImpl: stub, now: () => NOW_MS }),
    fetchLiveSnapshot(algiers, { fetchImpl: stub, now: () => NOW_MS }),
  ]);
  assert.equal(calls, 1);
  assert.ok(a);
  assert.equal(a, b);
});

/* ------------------------------------------------------------------ */
/*  formula invariance: same math, swappable climate inputs            */
/* ------------------------------------------------------------------ */

test("computeIrrigation is identical with the reference snapshot override", () => {
  const input = { wilayaCode: "07", crop: "dates" as const, areaHa: 2, soil: "sandy" as const, system: "drip" as const };
  assert.deepEqual(computeIrrigation({ ...input, weather: weatherFor("07") }), computeIrrigation(input));
});

test("computeIrrigation with a live snapshot uses the same formula on live inputs", () => {
  const biskra = WILAYA_BY_CODE["07"];
  const live = buildLiveSnapshot(biskra, makePayload(), NOW_ISO)!;
  const r = computeIrrigation({
    wilayaCode: "07",
    crop: "dates",
    areaHa: 2,
    soil: "sandy",
    system: "drip",
    weather: live,
  });

  const expectedEt0 = referenceEt0({
    tempC: live.tempC,
    humidity: live.humidity,
    windKph: live.windKph,
    rainMm: biskra.climate.rainMm,
  });
  const kc = 0.95; // KC.dates
  const soilFactor = 1.16; // SOIL_FACTOR.sandy
  const net = expectedEt0 * kc * soilFactor;
  const gross = net / 0.9; // drip

  assert.equal(r.et0, expectedEt0);
  assert.equal(r.netMmDay, round1(net));
  assert.equal(r.grossMmDay, round1(gross));
  assert.equal(r.litresPerHaDay, Math.round(gross * 10000));
  assert.equal(r.dailyM3, Math.round(gross * 2 * 10));
  // And it actually differs from the reference-based result (live inputs ≠ baseline).
  assert.notEqual(r.et0, computeIrrigation({ wilayaCode: "07", crop: "dates", areaHa: 2, soil: "sandy", system: "drip" }).et0);
});

/* ------------------------------------------------------------------ */
/*  wilaya coordinates — every wilaya can be fetched live              */
/* ------------------------------------------------------------------ */

test("all 58 wilayas carry coordinates inside Algeria's bounds", () => {
  assert.equal(WILAYAS.length, 58);
  assert.equal(new Set(WILAYAS.map((w) => w.code)).size, 58);
  for (const w of WILAYAS) {
    assert.ok(Number.isFinite(w.lat) && Number.isFinite(w.lon), `${w.code} has finite coords`);
    assert.ok(w.lat >= 18 && w.lat <= 38, `${w.code} lat in range: ${w.lat}`);
    assert.ok(w.lon >= -9 && w.lon <= 11, `${w.code} lon in range: ${w.lon}`);
  }
  assert.ok(WILAYA_BY_CODE[DEFAULT_WILAYA_CODE].lat > 0);
});
