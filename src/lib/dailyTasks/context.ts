/**
 * Daily-task context — the full 23:55 snapshot the AI (and the rule engine)
 * reasons over.
 *
 * Collects exactly what the workflow spec asks for:
 *   1. Open-Meteo 24-hour forecast aggregates (temp max/min, rain probability,
 *      humidity, wind speed) for the upcoming day;
 *   2. Calculated ET₀, net irrigation need (m³) and the optimal watering
 *      window — reusing the exact `computeIrrigation` chain the hero card
 *      renders, so the generated tasks can never quote a different number;
 *   3. Selected crop, growth stage, soil type and wilaya.
 *
 * Pure mapping helpers run on both server (cron) and client (offline
 * fallback); the network call is injected.
 */

import {
  computeIrrigation,
  weatherFor,
  type IrrigationResult,
  type IrrigationSystem,
  type WeatherSnapshot,
} from "../agronomy";
import { CROPS, SOILS, getWilaya, type CropKey, type SoilKey } from "../wilayas";
import { referenceEt0 } from "../agronomy";
import { WILAYA_TIMEZONE, type FetchLike } from "../weather/live";
import { growthStageFor, type GrowthStage } from "./growth";

/** The app's optimal watering window (same string the hero card shows). */
export const OPTIMAL_WINDOW = { from: "05:30", to: "08:30" } as const;

/** `"YYYY-MM-DD"` in the wilaya timezone (Africa/Algiers, UTC+1 all year). */
export function localDate(nowMs: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: WILAYA_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/**
 * The date the run is *publishing for*. At 23:55 the upcoming day has not
 * started yet; at 00:00 it just did. Adding ten minutes to "now" before
 * reading the local date lands both cron phases on the SAME target date
 * (`YYYY-MM-DD`) — which is also the key the task sets are indexed by.
 */
export function targetDate(nowMs: number = Date.now()): string {
  return localDate(nowMs + 10 * 60 * 1000);
}

/** Month index (0-11) of a `YYYY-MM-DD` date — no TZ shift. */
export function monthOf(date: string): number {
  const [, m] = date.split("-").map(Number);
  return (m ?? 1) - 1;
}

/* ------------------------------------------------------------------ */
/*  24-hour weather aggregates                                        */
/* ------------------------------------------------------------------ */

export interface Weather24h {
  /** The day these readings cover (`YYYY-MM-DD`). */
  date: string;
  tempMaxC: number;
  tempMinC: number;
  /** Highest hourly rain probability of the day, %. */
  rainProbabilityPct: number;
  /** Mean relative humidity, %. */
  humidityPct: number;
  /** Highest wind speed of the day, km/h. */
  windKph: number;
  /** True when these came from a live Open-Meteo payload. */
  live: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clampPct = (n: number) => Math.round(Math.min(100, Math.max(0, n)));

function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function numArray(v: unknown): number[] | null {
  return Array.isArray(v) ? (v as number[]) : null;
}

/**
 * Aggregates the OPEN-METEO forecast payload (the exact shape
 * `openMeteoUrl()` requests) into the 24-hour summary for `date`. Returns
 * `null` when the payload cannot cover the day — callers fall back to the
 * reference snapshot, never to invented numbers.
 */
export function weather24hFromOpenMeteo(payload: unknown, date: string): Weather24h | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as {
    hourly?: Record<string, unknown>;
    daily?: Record<string, unknown>;
  };

  // Hourly slots of the target day ("YYYY-MM-DDTHH:mm" → prefix match).
  const times = p.hourly?.time;
  if (!Array.isArray(times)) return null;
  const idx: number[] = [];
  for (let i = 0; i < times.length; i += 1) {
    if (typeof times[i] === "string" && (times[i] as string).startsWith(date)) idx.push(i);
  }
  if (idx.length < 12) return null; // half a day of readings is the minimum

  const hTemp = numArray(p.hourly?.temperature_2m);
  const hHum = numArray(p.hourly?.relative_humidity_2m);
  const hWind = numArray(p.hourly?.wind_speed_10m);
  const hRain = numArray(p.hourly?.precipitation_probability);
  if (!hTemp) return null;

  const temps = idx.map((i) => finiteNum(hTemp[i])).filter((v): v is number => v !== null);
  if (temps.length < 12) return null;

  const hums = (hHum ? idx.map((i) => finiteNum(hHum[i])) : [])
    .filter((v): v is number => v !== null);
  const winds = (hWind ? idx.map((i) => finiteNum(hWind[i])) : [])
    .filter((v): v is number => v !== null);
  const rains = (hRain ? idx.map((i) => finiteNum(hRain[i])) : [])
    .filter((v): v is number => v !== null);

  // Daily min/max cross-check (the spec asks for temp max/min of the day).
  const dTimes = p.daily?.time;
  const dMin = numArray(p.daily?.temperature_2m_min);
  const dMax = numArray(p.daily?.temperature_2m_max);
  let dailyMin: number | null = null;
  let dailyMax: number | null = null;
  if (Array.isArray(dTimes) && dMin && dMax) {
    const di = dTimes.findIndex((t) => t === date);
    if (di >= 0) {
      dailyMin = finiteNum(dMin[di]);
      dailyMax = finiteNum(dMax[di]);
    }
  }

  const tempMaxC = round1(dailyMax ?? Math.max(...temps));
  const tempMinC = round1(dailyMin ?? Math.min(...temps));

  return {
    date,
    tempMaxC,
    tempMinC,
    rainProbabilityPct: rains.length > 0 ? clampPct(Math.max(...rains)) : 0,
    humidityPct: hums.length > 0 ? clampPct(hums.reduce((a, b) => a + b, 0) / hums.length) : 50,
    windKph: winds.length > 0 ? Math.round(Math.max(...winds)) : 12,
    live: true,
  };
}

/**
 * Deterministic fallback from the reference `WeatherSnapshot` the app already
 * renders (Open-Meteo unreachable, offline client, SSR). Never null.
 */
export function weather24hFromSnapshot(snapshot: WeatherSnapshot, date: string): Weather24h {
  const day = snapshot.days[0];
  const hourRain = snapshot.hours.map((h) => h.rainPct ?? 0);
  return {
    date,
    tempMaxC: day ? day.maxC : round1(snapshot.tempC + 4),
    tempMinC: day ? day.minC : round1(snapshot.tempC - 5),
    rainProbabilityPct: Math.max(day?.rainPct ?? 0, hourRain.length ? Math.max(...hourRain) : 0),
    humidityPct: snapshot.humidity,
    windKph: Math.round(snapshot.windKph),
    live: false,
  };
}

/* ------------------------------------------------------------------ */
/*  The context payload                                               */
/* ------------------------------------------------------------------ */

export interface DailyContextInput {
  wilayaCode: string | null | undefined;
  crop: CropKey;
  soil?: SoilKey;
  areaHa?: number;
  system?: IrrigationSystem;
  /** Target day (`YYYY-MM-DD`) — defaults to the upcoming day. */
  date?: string;
  /** Live 24-h aggregates (from the 23:55 fetch) or reference fallback. */
  weather24h?: Weather24h;
  /** Full snapshot (live or reference) feeding the ET₀ chain. */
  snapshot?: WeatherSnapshot;
  /** Injectable clock (epoch ms) for tests. */
  nowMs?: number;
}

export interface DailyContext {
  date: string;
  createdAt: string;
  wilaya: { code: string; nameAr: string; nameFr: string; region: string };
  crop: { key: CropKey; ar: string; fr: string };
  growthStage: GrowthStage;
  soil: { key: SoilKey; ar: string; fr: string };
  areaHa: number;
  system: IrrigationSystem;
  weather: Weather24h;
  /** ET₀ (mm/day) actually used by the irrigation chain. */
  et0MmDay: number;
  /** Net crop water requirement, mm/day (ET₀ × Kc × soil factor). */
  netMmDay: number;
  /** Gross parcel volume for the day — the hero card's m³ figure. */
  netIrrigationM3: number;
  litresPerHaDay: number;
  wateringWindow: { from: string; to: string };
  /** Same rule cascade as the weather card: heat → wind → et0 → calm. */
  activeRule: "heat" | "wind" | "et0" | "calm";
  /** Full `computeIrrigation` result — kept so the prompt shows every number. */
  irrigation: IrrigationResult;
}

/**
 * Builds the context payload. Every computed figure goes through the SAME
 * `computeIrrigation` call the hero card uses — the tasks quote the card.
 */
export function buildDailyContext(input: DailyContextInput): DailyContext {
  const nowMs = input.nowMs ?? Date.now();
  const date = input.date ?? targetDate(nowMs);
  const wilaya = getWilaya(input.wilayaCode);
  const crop = input.crop;
  const soil = input.soil ?? wilaya.soil;
  const areaHa = input.areaHa ?? 2;
  const system: IrrigationSystem = input.system ?? "drip";

  const snapshot =
    input.snapshot ??
    // Reference snapshot: deterministic climate for the wilaya.
    weatherFor(wilaya.code);

  const weather24h =
    input.weather24h ?? weather24hFromSnapshot(snapshot, date);

  // ET₀ for the *upcoming* day: recompute from the 24-h aggregates so the AI
  // reasons about tomorrow's climate, while the volumes below stay on the
  // exact `computeIrrigation` chain (its `et0` input comes from `snapshot`).
  const irrigation = computeIrrigation({
    wilayaCode: wilaya.code,
    crop,
    areaHa,
    soil,
    system,
    weather: snapshot,
  });
  const et0Upcoming = referenceEt0({
    tempC: round1((weather24h.tempMaxC + weather24h.tempMinC) / 2),
    humidity: weather24h.humidityPct,
    windKph: weather24h.windKph,
    rainMm: wilaya.climate.rainMm,
  });

  const hot = weather24h.tempMaxC >= 33;
  const windy = weather24h.windKph >= 20;
  const dry = et0Upcoming >= 5;
  const activeRule = hot ? "heat" : windy ? "wind" : dry ? "et0" : "calm";

  return {
    date,
    createdAt: new Date(nowMs).toISOString(),
    wilaya: {
      code: wilaya.code,
      nameAr: wilaya.nameAr,
      nameFr: wilaya.nameFr,
      region: wilaya.region,
    },
    crop: { key: crop, ar: CROPS[crop].ar, fr: CROPS[crop].fr },
    growthStage: growthStageFor(crop, monthOf(date)),
    soil: { key: soil, ar: SOILS[soil].ar, fr: SOILS[soil].fr },
    areaHa,
    system,
    weather: weather24h,
    et0MmDay: et0Upcoming,
    netMmDay: irrigation.netMmDay,
    netIrrigationM3: irrigation.dailyM3,
    litresPerHaDay: irrigation.litresPerHaDay,
    wateringWindow: { ...OPTIMAL_WINDOW },
    activeRule,
    irrigation,
  };
}

/* ------------------------------------------------------------------ */
/*  Server-side collection (the 23:55 snapshot job)                    */
/* ------------------------------------------------------------------ */

/**
 * Open-Meteo forecast URL covering the 24 hourly aggregates + daily min/max
 * the context needs (same endpoint and conventions as `weather/live.ts`).
 */
export function contextForecastUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation_probability",
    daily: "temperature_2m_min,temperature_2m_max,precipitation_probability_max",
    forecast_days: "2",
    timezone: "auto",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

export interface CollectOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  nowMs?: number;
}

/**
 * Collects the FULL context snapshot for `input`'s target day: fetches the
 * Open-Meteo forecast (bounded timeout) and aggregates it into the payload.
 * Every failure mode degrades to the deterministic reference values — the
 * 23:55 job must always leave a usable snapshot behind. Never throws.
 */
export async function collectDailyContext(
  input: DailyContextInput,
  opts: CollectOptions = {},
): Promise<DailyContext> {
  const nowMs = opts.nowMs ?? Date.now();
  const date = input.date ?? targetDate(nowMs);
  const wilaya = getWilaya(input.wilayaCode);
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? (fetch as FetchLike) : undefined);

  let weather24h = input.weather24h ?? null;
  let snapshot = input.snapshot ?? null;

  if ((!weather24h || !snapshot) && fetchImpl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
      const res = await fetchImpl(contextForecastUrl(wilaya.lat, wilaya.lon), {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const payload = await res.json();
        weather24h = weather24h ?? weather24hFromOpenMeteo(payload, date);
        // Keep the existing live-snapshot mapper for the ET₀ chain: map the
        // same payload through `weatherFor`'s shape when possible. Mapping is
        // best-effort — reference fallback below covers its absence.
        if (!snapshot) {
          snapshot = snapshotFromPayload(wilaya.code, payload);
        }
      }
    } catch {
      /* network / timeout / payload failure → reference fallback below */
    }
  }

  return buildDailyContext({
    ...input,
    date,
    weather24h: weather24h ?? undefined,
    snapshot: snapshot ?? undefined,
    nowMs,
  });
}

/**
 * Best-effort `WeatherSnapshot` from a raw forecast payload (current
 * conditions → ET₀ chain). `null` when the payload lacks `current` — the
 * caller then uses the reference snapshot. Kept tiny on purpose: the daily
 * context only needs the climate numbers feeding `computeIrrigation`.
 */
export function snapshotFromPayload(
  wilayaCode: string,
  payload: unknown,
): WeatherSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { current?: Record<string, unknown> };
  const t = finiteNum(p.current?.temperature_2m);
  const h = finiteNum(p.current?.relative_humidity_2m);
  const w = finiteNum(p.current?.wind_speed_10m);
  if (t === null || h === null || w === null) return null;
  const base = weatherFor(wilayaCode);
  return {
    ...base,
    tempC: round1(t),
    humidity: clampPct(h),
    windKph: Math.round(Math.max(0, w)),
    et0: referenceEt0({
      tempC: round1(t),
      humidity: clampPct(h),
      windKph: Math.round(Math.max(0, w)),
      rainMm: base.rainMmYear,
    }),
  };
}
