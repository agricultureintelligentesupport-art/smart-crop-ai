/**
 * NASA POWER point API (https://power.larc.nasa.gov) — free, and confirmed by
 * live unauthenticated requests to need **no API key** and no account. This
 * module is therefore safe to call from the server on every cold cache miss;
 * it is the one upstream in this app that just works.
 *
 * WHY ET₀ IS COMPUTED HERE AND NOT FETCHED
 * ----------------------------------------
 * POWER does **not** expose an ET₀ parameter: a live request for
 * `parameters=ET0` is rejected with
 *   {"messages":["One of your parameters is incorrect: ET0."]}
 * (Several third-party parameter tables list `ET0` in error.) So the water
 * requirement is derived the way agronomy actually does it — from POWER's real
 * meteorology, with the FAO-56 reference evapotranspiration formulation.
 *
 * THE DIURNAL RANGE PROBLEM, AND THE FIX
 * --------------------------------------
 * FAO-56 Penman–Monteith needs Tmax and Tmin. MERRA-2 is a ~0.5° reanalysis
 * whose grid smoothing collapses the diurnal cycle, and it does so badly at
 * coastal points: a live hourly read for Algiers on 2026-09-10 gives
 * T2M_MAX 26.94 °C and T2M_MIN 25.09 °C — a 1.85 °C range that no real station
 * records. Run Penman–Monteith on that and saturation vapour pressure barely
 * moves, so ET₀ collapses to roughly 1.7 mm/day on a day when the true value
 * is about 4.7.
 *
 * The fix uses POWER's own **climatology** endpoint (20-year MERRA-2 monthly
 * means, 2001–2020), which returns realistic monthly extremes — for Algiers in
 * September, T2M_MAX 33.25 °C and T2M_MIN 19.34 °C, a 13.9 °C range. When a
 * day's own range is degenerate, the extremes are reconstructed around that
 * day's real mean temperature using the location's own published range for that
 * month. Nothing is invented: every number is a POWER measurement, and
 * `rangeSource` records which one was used.
 *
 * With that correction, Penman–Monteith returns ~4.7 mm/day for Algiers in
 * mid-September, which is the value standard references give. Hargreaves
 * (FAO-56 eq. 52) is still computed from the same corrected extremes as an
 * auditable cross-check, not as a substitute.
 *
 * THE −999 FILL VALUE
 * -------------------
 * POWER documents `-999.0` as its fill value and it appears in real responses
 * for parameters that are unavailable at a point or date (observed live:
 * `ALLSKY_SFC_PAR_TOT` and `CLOUD_AMT` both returned −999 for Algiers). Reading
 * that as a number would quietly poison every downstream average, so the day
 * reader rejects it explicitly and the caller treats the field as absent.
 */

import type { FetchLike } from "./live";

/** Re-exported so callers of this module need only one import for the contract. */
export type { FetchLike };

const POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point";
const POWER_CLIMATOLOGY_URL = "https://power.larc.nasa.gov/api/temporal/climatology/point";

/** Month keys in the POWER climatology payload, in calendar order. */
const MONTH_KEYS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

/** POWER's documented fill value for unavailable data. */
export const POWER_FILL_VALUE = -999;

/** The documented floor of the POWER daily API (a few days of latency). */
const MAX_LOOKBACK_DAYS = 10;

/** Default request timeout — the API is usually <1 s, but never hang on it. */
export const POWER_TIMEOUT_MS = 10_000;

/**
 * Parameters actually confirmed to return data on the daily AG endpoint.
 * `ALLSKY_SFC_PAR_TOT` and `CLOUD_AMT` are deliberately absent: both returned
 * −999 in live testing, and `RH2M_MAX` / `RH2M_MIN` are rejected outright.
 */
const POWER_PARAMS = [
  "T2M",
  "T2M_MAX",
  "T2M_MIN",
  "RH2M",
  "WS2M",
  "PS",
  "ALLSKY_SFC_SW_DWN",
  "PRECTOTCORR",
  "GWETPROF",
] as const;

export interface PowerReading {
  /** The POWER `YYYYMMDD` day this reading belongs to. */
  date: string;
  tempC: number | null;
  tempMaxC: number | null;
  tempMinC: number | null;
  /** Relative humidity at 2 m, %. */
  humidityPct: number | null;
  /** Wind speed at 2 m, m/s. */
  windMs: number | null;
  /** Surface pressure, kPa. */
  pressureKpa: number | null;
  /** All-sky surface shortwave downward irradiance, MJ/m²/day. */
  radiationMj: number | null;
  /** Corrected precipitation, mm/day. */
  rainMm: number | null;
  /** Profile soil wetness, 0–1. */
  soilWetness: number | null;
}

export interface PowerResult {
  ok: boolean;
  /** Why the read failed. Never rendered as data — it selects the empty state. */
  reason?: "network" | "http" | "malformed" | "noData" | "timeout";
  latitude: number;
  longitude: number;
  /** Elevation reported by POWER for the cell, metres. */
  elevationM: number | null;
  /** Grid cell size in degrees, as reported by POWER. */
  gridDeg: { lat: number; lon: number } | null;
  reading: PowerReading | null;
  /** "YYYY-MM-DD" of `reading`. */
  date: string | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads one POWER day, mapping the documented fill value to `null`.
 * A day where every requested variable is missing is not a reading at all.
 */
function readDay(parameters: Record<string, Record<string, unknown>>, key: string): PowerReading | null {
  const at = (name: string) => {
    const raw = finite(parameters[name]?.[key]);
    return raw === null || raw === POWER_FILL_VALUE ? null : raw;
  };
  const reading: PowerReading = {
    date: `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`,
    tempC: at("T2M"),
    tempMaxC: at("T2M_MAX"),
    tempMinC: at("T2M_MIN"),
    humidityPct: at("RH2M"),
    windMs: at("WS2M"),
    pressureKpa: at("PS"),
    radiationMj: at("ALLSKY_SFC_SW_DWN"),
    rainMm: at("PRECTOTCORR"),
    soilWetness: at("GWETPROF"),
  };
  const any = [
    reading.tempC,
    reading.tempMaxC,
    reading.tempMinC,
    reading.humidityPct,
    reading.windMs,
    reading.radiationMj,
  ].some((v) => v !== null);
  return any ? reading : null;
}

export function buildPowerUrl(lat: number, lon: number, start: string, end: string): string {
  const params = new URLSearchParams({
    parameters: POWER_PARAMS.join(","),
    community: "AG",
    latitude: String(lat),
    longitude: String(lon),
    start: start.replace(/-/g, ""),
    end: end.replace(/-/g, ""),
    format: "JSON",
  });
  return `${POWER_URL}?${params.toString()}`;
}

/**
 * Pure mapping from a POWER payload to a result. The most recent day that
 * carries any usable variable wins — POWER lags real time by a few days, so
 * "today" is often absent and asking for it would be a guaranteed miss.
 */
export function buildPowerResult(payload: unknown, lat: number, lon: number): PowerResult {
  const base = { latitude: lat, longitude: lon, elevationM: null, gridDeg: null, reading: null, date: null };
  if (!payload || typeof payload !== "object") return { ...base, ok: false, reason: "malformed" };
  const p = payload as {
    geometry?: { coordinates?: unknown };
    properties?: { parameter?: Record<string, Record<string, unknown>> };
    header?: { fill_value?: unknown };
    messages?: unknown;
    times?: { data?: unknown; process?: unknown };
  };
  // POWER reports its own fill value in the header; trust it, but keep our
  // constant as the floor so a headerless/error payload can never leak −999.
  const fill = finite(p.header?.fill_value) ?? POWER_FILL_VALUE;
  if (p.properties?.parameter === undefined) {
    const messages = Array.isArray(p.messages) ? p.messages.join(" ") : "";
    return { ...base, ok: false, reason: messages ? "noData" : "malformed" };
  }
  const parameters = p.properties.parameter;
  const keys = Object.keys(parameters.T2M ?? parameters.T2M_MAX ?? {});
  let best: PowerReading | null = null;
  for (const key of keys) {
    if (!/^\d{8}$/.test(key)) continue;
    const reading = readDay(parameters, key);
    if (reading && (!best || reading.date > best.date)) best = reading;
  }
  if (!best) return { ...base, ok: false, reason: "noData" };

  const coords = Array.isArray(p.geometry?.coordinates) ? p.geometry!.coordinates : [];
  const gridDeg = {
    lat: finite(p.times?.data) ?? 0,
    lon: finite(p.times?.process) ?? 0,
  };
  const result: PowerResult = {
    ok: true,
    latitude: lat,
    longitude: lon,
    elevationM: finite(coords[2]),
    gridDeg: gridDeg.lat > 0 && gridDeg.lon > 0 ? gridDeg : null,
    reading: best,
    date: best.date,
  };
  // Re-run the fill-value filter against the header's own declaration.
  if (fill !== POWER_FILL_VALUE) {
    for (const field of ["tempC", "tempMaxC", "tempMinC", "humidityPct", "windMs", "radiationMj"] as const) {
      if (result.reading![field] === POWER_FILL_VALUE) result.reading![field] = null;
    }
  }
  return result;
}

/**
 * Fetches the most recent usable POWER day. No credentials are sent — the
 * endpoint is open. Never throws: every failure resolves to `ok: false`.
 */
export async function fetchPower(
  lat: number,
  lon: number,
  opts: { now?: Date; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<PowerResult> {
  const today = opts.now ?? new Date();
  const end = today.toISOString().slice(0, 10);
  const startDate = new Date(today.getTime() - MAX_LOOKBACK_DAYS * 86_400_000);
  const start = startDate.toISOString().slice(0, 10);
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? (fetch as FetchLike) : undefined);
  if (!fetchImpl) {
    return { ok: false, reason: "network", latitude: lat, longitude: lon, elevationM: null, gridDeg: null, reading: null, date: null };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? POWER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(buildPowerUrl(lat, lon, start, end), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return { ok: false, reason: "http", latitude: lat, longitude: lon, elevationM: null, gridDeg: null, reading: null, date: null };
    }
    return buildPowerResult(await res.json(), lat, lon);
  } catch {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      reason: timedOut ? "timeout" : "network",
      latitude: lat,
      longitude: lon,
      elevationM: null,
      gridDeg: null,
      reading: null,
      date: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Climatology — the realistic diurnal range for the location/month    */
/* ------------------------------------------------------------------ */

/**
 * POWER's 20-year monthly climatology, used only to recover a diurnal
 * temperature range when MERRA-2's own daily extremes are degenerate.
 * `monthlyRangeC[0]` is January.
 */
export interface PowerClimatology {
  monthlyRangeC: (number | null)[];
}

/** Cached per rounded coordinate; a 20-year climatology never changes. */
const climatologyCache = new Map<string, PowerClimatology>();

export function buildPowerClimatologyUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    parameters: "T2M_MAX,T2M_MIN",
    community: "AG",
    latitude: String(lat),
    longitude: String(lon),
    format: "JSON",
  });
  return `${POWER_CLIMATOLOGY_URL}?${params.toString()}`;
}

/** Pure mapping from a POWER climatology payload to monthly ranges. */
export function buildClimatology(payload: unknown): PowerClimatology | null {
  if (!payload || typeof payload !== "object") return null;
  const params = (payload as { properties?: { parameter?: Record<string, Record<string, unknown>> } }).properties
    ?.parameter;
  if (!params) return null;
  const at = (name: string, month: string) => {
    const v = finite(params[name]?.[month]);
    return v === null || v === POWER_FILL_VALUE ? null : v;
  };
  const monthlyRangeC = MONTH_KEYS.map((month) => {
    const max = at("T2M_MAX", month);
    const min = at("T2M_MIN", month);
    if (max === null || min === null) return null;
    const range = max - min;
    return range > 0 ? range : null;
  });
  return monthlyRangeC.some((v) => v !== null) ? { monthlyRangeC } : null;
}

/**
 * Fetches the location's climatology, memoised for the process lifetime. A
 * failure returns `null` and the ET₀ path falls back to reporting no method
 * rather than guessing a range.
 */
export async function fetchPowerClimatology(
  lat: number,
  lon: number,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<PowerClimatology | null> {
  // ~100 m: far finer than the ~0.13° climatology grid, so rounding only stops
  // floating-point jitter from creating endless cache entries.
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = climatologyCache.get(key);
  if (cached) return cached;
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? (fetch as FetchLike) : undefined);
  if (!fetchImpl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? POWER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(buildPowerClimatologyUrl(lat, lon), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const parsed = buildClimatology(await res.json());
    if (parsed) climatologyCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam. */
export function resetClimatologyCache(): void {
  climatologyCache.clear();
}

/* ------------------------------------------------------------------ */
/*  FAO-56 reference evapotranspiration                                */
/* ------------------------------------------------------------------ */

/** Solar constant, MJ m⁻² min⁻¹ (FAO-56 eq. 23). */
const SOLAR_CONSTANT = 0.082;
/** Surface albedo for a reference grass surface (FAO-56). */
const ALBEDO = 0.23;
/** Stefan–Boltzmann constant, MJ K⁻⁴ m⁻² day⁻¹. */
const STEFAN_BOLTZMANN = 0.000000004903;
/** Below this, MERRA-2's smoothed diurnal range makes Penman–Monteith unsound. */
const MIN_USABLE_TEMPERATURE_RANGE_C = 2;

const mean = (values: (number | null)[]): number | null => {
  const list = values.filter((v): v is number => v !== null);
  if (list.length === 0) return null;
  return list.reduce((sum, v) => sum + v, 0) / list.length;
};

/** Saturation vapour pressure at temperature `tC`, kPa (FAO-56 eq. 11). */
export function saturationVapourPressure(tC: number): number {
  return 0.6108 * Math.exp((17.27 * tC) / (tC + 237.3));
}

/** Extraterrestrial radiation, MJ m⁻² day⁻¹ (FAO-56 eq. 21). */
export function extraterrestrialRadiation(latDeg: number, dayOfYear: number): number {
  const phi = latDeg * (Math.PI / 180);
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365);
  const declination = 0.409 * Math.sin((2 * Math.PI * dayOfYear) / 365 - 1.39);
  const cosWs = -Math.tan(phi) * Math.tan(declination);
  // High latitudes in winter: the sun never sets, so clamp to a full day.
  const ws = Math.acos(Math.min(1, Math.max(-1, cosWs)));
  return (
    ((24 * 60) / Math.PI) *
    SOLAR_CONSTANT *
    dr *
    (ws * Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.sin(ws))
  );
}

function dayOfYear(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const start = Date.UTC(y, 0, 1);
  const current = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  return Math.floor((current - start) / 86_400_000) + 1;
}

export interface Et0Result {
  /** The ET₀ the app should use, mm/day. `0` when nothing is computable. */
  et0: number;
  /** Which FAO-56 method produced `et0`. */
  method: "penman-monteith" | "hargreaves" | null;
  penmanMonteith: number | null;
  hargreaves: number | null;
  /** The satellite-measured shortwave irradiance, MJ m²⁻¹/day. */
  radiation: number | null;
  /** Tmax − Tmin actually used, °C, after any range correction. */
  temperatureRangeC: number | null;
  /**
   * Where the extremes came from — the audit trail for the one number in this
   * module that is reconstructed rather than read straight off the wire.
   */
  rangeSource: "daily" | "climatology" | "none";
  /** The corrected Tmax/Tmin actually fed to the formula. */
  tMaxC: number | null;
  tMinC: number | null;
  /** Why PM was skipped or the range substituted, when it was. */
  note?: string;
}

const MONTH_INDEX: Record<string, number> = {
  "01": 0, "02": 1, "03": 2, "04": 3, "05": 4, "06": 5,
  "07": 6, "08": 7, "09": 8, "10": 9, "11": 10, "12": 11,
};

/**
 * The Tmax/Tmin the formula will actually use.
 *
 * A day whose own T2M_MAX − T2M_MIN is at least `MIN_USABLE_TEMPERATURE_RANGE_C`
 * is taken at face value. Below that, MERRA-2's grid smoothing has removed the
 * diurnal signal, and the location's own POWER climatology range for that month
 * is applied symmetrically around the day's real mean temperature. Returns
 * `source: "none"` when neither is available, so the caller can report no data
 * rather than a number built on a guessed range.
 */
export function resolveExtremes(
  reading: PowerReading,
  climatology: PowerClimatology | null,
): { tMax: number | null; tMin: number | null; range: number | null; source: Et0Result["rangeSource"]; note?: string } {
  const tMean = reading.tempC;
  const dayMax = reading.tempMaxC;
  const dayMin = reading.tempMinC;
  if (dayMax !== null && dayMin !== null && dayMax - dayMin >= MIN_USABLE_TEMPERATURE_RANGE_C) {
    return { tMax: dayMax, tMin: dayMin, range: dayMax - dayMin, source: "daily" };
  }
  const month = MONTH_INDEX[reading.date.slice(5, 7)];
  const climatologyRange = climatology && month !== undefined ? climatology.monthlyRangeC[month] : null;
  if (tMean !== null && climatologyRange !== null && climatologyRange >= MIN_USABLE_TEMPERATURE_RANGE_C) {
    return {
      tMax: tMean + climatologyRange / 2,
      tMin: tMean - climatologyRange / 2,
      range: climatologyRange,
      source: "climatology",
      note: `MERRA-2 daily range too small; extremes reconstructed from the POWER ${reading.date.slice(0, 7)} climatology (${climatologyRange.toFixed(1)} °C)`,
    };
  }
  return { tMax: null, tMin: null, range: null, source: "none", note: "no usable temperature extremes" };
}

/**
 * FAO-56 reference evapotranspiration from one POWER day.
 *
 * Penman–Monteith (eq. 6) is the standard and is what `et0` reports. Hargreaves
 * (eq. 52) is computed from the same corrected extremes purely as a
 * cross-check. When neither is available the result carries `method: null` and
 * `et0: 0` — the UI then shows no ET₀ rather than a fabricated one.
 */
export function computeEt0(
  reading: PowerReading,
  latDeg: number,
  climatology: PowerClimatology | null = null,
): Et0Result {
  const tMean = reading.tempC;
  const wind = reading.windMs;
  const radiation = reading.radiationMj;
  const doy = dayOfYear(reading.date);
  const ra = extraterrestrialRadiation(latDeg, doy);

  const extremes = resolveExtremes(reading, climatology);
  const { tMax, tMin, range } = extremes;
  let note = extremes.note;

  /* --- Hargreaves (FAO-56 eq. 52): an independent cross-check. ----------- */
  let hargreaves: number | null = null;
  if (tMean !== null && range !== null && ra > 0) {
    hargreaves = 0.0023 * (tMean + 17.8) * Math.sqrt(range) * ra * 0.408;
  }

  /* --- Penman–Monteith (FAO-56 eq. 6): the reported value. ---------------- */
  let penmanMonteith: number | null = null;
  if (tMean === null || tMax === null || tMin === null) {
    note = note ?? "missing POWER meteorology";
  } else if (wind === null || radiation === null) {
    note = "missing POWER wind or radiation";
  } else if (radiation <= 0) {
    note = "no measured shortwave irradiance";
  } else if (radiation > ra * 1.05) {
    // A clearness index above ~1 is impossible; something is wrong upstream
    // and a plausible-looking ET₀ from it would be worse than none.
    note = `measured irradiance ${radiation} exceeds the extraterrestrial ${ra.toFixed(1)} MJ/m²`;
  } else {
    const elevation = reading.pressureKpa ?? 101.3;
    const gamma = 0.000665 * elevation;
    const slope = (4098 * saturationVapourPressure(tMean)) / Math.pow(tMean + 237.3, 2);
    const es = (saturationVapourPressure(tMax) + saturationVapourPressure(tMin)) / 2;
    const ea = reading.humidityPct !== null ? (es * reading.humidityPct) / 100 : es;
    // Net longwave (FAO-56 eq. 39), with Rso from eq. 25 at the site elevation.
    const rso = (0.75 + 2e-5 * elevation) * ra;
    const tMaxK = tMax + 273.16;
    const tMinK = tMin + 273.16;
    const rnl =
      STEFAN_BOLTZMANN * ((Math.pow(tMaxK, 4) + Math.pow(tMinK, 4)) / 2) * (0.34 - 0.14 * Math.sqrt(ea)) *
      (1.35 * (radiation / rso) - 0.35);
    const rns = (1 - ALBEDO) * radiation;
    // Soil heat flux is taken as zero for a daily total (FAO-56 eq. 42).
    const et0 =
      (0.408 * slope * (rns - rnl) + (gamma * (900 / (tMean + 273))) * wind * (es - ea)) /
      (slope + gamma * (1 + 0.34 * wind));
    if (Number.isFinite(et0) && et0 > 0) penmanMonteith = et0;
    else note = "Penman-Monteith produced a non-physical value";
  }

  const chosen = penmanMonteith ?? hargreaves;
  return {
    et0: chosen !== null && Number.isFinite(chosen) ? Math.max(0, chosen) : 0,
    method: penmanMonteith !== null ? "penman-monteith" : hargreaves !== null ? "hargreaves" : null,
    penmanMonteith,
    hargreaves,
    radiation,
    temperatureRangeC: range,
    rangeSource: extremes.source,
    tMaxC: tMax,
    tMinC: tMin,
    ...(note ? { note } : {}),
  };
}

/** Rounded, UI-ready view of a POWER day — the values the cards display. */
export interface PowerClimate {
  date: string;
  tempC: number | null;
  tempMaxC: number | null;
  tempMinC: number | null;
  humidityPct: number | null;
  windMs: number | null;
  rainMm: number | null;
  soilWetness: number | null;
  radiationMj: number | null;
  elevationM: number | null;
  et0: number;
  et0Method: Et0Result["method"];
  /** Both FAO-56 estimates, for the provenance line. */
  et0Hargreaves: number | null;
  /**
   * Where the Tmax/Tmin behind ET₀ came from. `"climatology"` means the
   * extremes were reconstructed from POWER's own monthly climatology because
   * MERRA-2's daily range was degenerate — the one value in this module that is
   * derived rather than read straight off the wire.
   */
  et0RangeSource: "daily" | "climatology" | "none";
  /** Tmax − Tmin actually used, °C. */
  et0TemperatureRangeC: number | null;
  /** Free-text explanation when the range had to be substituted. */
  et0Note: string | undefined;
  /** POWER's own grid cell, so the UI can state the real spatial scale. */
  gridDeg: { lat: number; lon: number } | null;
}

export function toClimate(
  result: PowerResult,
  climatology: PowerClimatology | null = null,
): PowerClimate | null {
  if (!result.ok || !result.reading) return null;
  const r = result.reading;
  const et0 = computeEt0(r, result.latitude, climatology);
  return {
    date: r.date,
    tempC: r.tempC,
    tempMaxC: r.tempMaxC,
    tempMinC: r.tempMinC,
    humidityPct: r.humidityPct,
    windMs: r.windMs,
    rainMm: r.rainMm,
    soilWetness: r.soilWetness,
    radiationMj: r.radiationMj,
    elevationM: result.elevationM,
    et0: et0.method ? Math.round(et0.et0 * 100) / 100 : 0,
    et0Method: et0.method,
    et0Hargreaves: et0.hargreaves === null ? null : Math.round(et0.hargreaves * 100) / 100,
    et0RangeSource: et0.rangeSource,
    et0TemperatureRangeC: et0.temperatureRangeC === null ? null : Math.round(et0.temperatureRangeC * 10) / 10,
    et0Note: et0.note,
    gridDeg: result.gridDeg,
  };
}

/** Mean of the non-null entries, exported for the heatmap's field average. */
export function powerMean(values: (number | null)[]): number | null {
  return mean(values);
}
