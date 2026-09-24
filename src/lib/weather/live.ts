/**
 * Live weather via Open-Meteo (https://open-meteo.com) — free, no API key,
 * CORS-open so the fetch runs client-side in the user's browser.
 *
 * Data-layer contract:
 *   - `buildLiveSnapshot(wilaya, payload, nowIso)` — pure mapping from an
 *     Open-Meteo forecast JSON to the app's existing `WeatherSnapshot` shape,
 *     so every consumer (ET0 formula, cards, charts) keeps working unchanged.
 *   - `readLiveCache` / `writeLiveCache` — per-wilaya cache (in-memory +
 *     localStorage) with a 1-hour TTL; stale entries are usable as a
 *     fallback while a background refresh is in flight.
 *   - `fetchLiveSnapshot(wilaya, opts)` — network call with timeout +
 *     in-flight dedupe. Every failure mode (network, HTTP, timeout,
 *     unexpected payload) resolves to `null` — callers fall back to the
 *     static reference values. Nothing here ever throws.
 *
 * The fetch implementation, clock and URL parts are injectable so the whole
 * layer is unit-testable without a browser or network.
 */

import { referenceEt0, type WeatherSnapshot } from "../agronomy";
import type { Wilaya } from "../wilayas";

/** Cache lifetime for a fetched snapshot — refreshed at most once per hour. */
export const LIVE_TTL_MS = 60 * 60 * 1000;

/** Default fetch timeout: don't hold the UI hostage to a slow network. */
export const LIVE_TIMEOUT_MS = 8_000;

const CACHE_PREFIX = "smart-crop.live-weather.v1.";

/**
 * The app covers Algeria only — every wilaya is in the Africa/Algiers zone
 * (UTC+1, no DST). Open-Meteo returns local times with `timezone=auto`, so
 * "now" must be expressed in this zone for the hour comparison below.
 */
export const WILAYA_TIMEZONE = "Africa/Algiers";

export interface LiveCacheEntry {
  /** Epoch ms of the successful fetch. */
  fetchedAt: number;
  snapshot: WeatherSnapshot;
}

/* ------------------------------------------------------------------ */
/*  URL + payload helpers                                              */
/* ------------------------------------------------------------------ */

export function openMeteoUrl(lat: number, lon: number): string {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,relative_humidity_2m,wind_speed_10m",
    hourly: "temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation_probability",
    daily: "temperature_2m_min,temperature_2m_max,precipitation_probability_max",
    forecast_days: "7",
    timezone: "auto",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clampPct = (n: number) => Math.round(Math.min(100, Math.max(0, n)));

/** "YYYY-MM-DDTHH:mm" for the wilaya timezone (falls back to UTC on failure). */
export function wilayaLocalNowIso(nowMs: number = Date.now()): string {
  try {
    // sv-SE renders "YYYY-MM-DD HH:mm:ss" — stable across ICU builds.
    const s = new Intl.DateTimeFormat("sv-SE", {
      timeZone: WILAYA_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(nowMs));
    return s.replace(" ", "T").slice(0, 16);
  } catch {
    return new Date(nowMs).toISOString().slice(0, 16);
  }
}

/**
 * Weekday index (0 = Sunday) for a "YYYY-MM-DD" date, matching the order of
 * `t.weather.dayLabels`. Parsed as local date parts — no TZ shift.
 */
export function weekdayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).getDay();
}

/**
 * Indexes of the NEXT `count` hourly slots strictly after `nowIso`
 * ("2026-09-24T12:15" → slots 13:00, 14:00, …). ISO local strings compare
 * chronologically, so this is a plain string comparison.
 */
export function selectNextHourIndexes(times: string[], nowIso: string, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < times.length && out.length < count; i += 1) {
    if (times[i] > nowIso) out.push(i);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Pure payload → WeatherSnapshot mapping                             */
/* ------------------------------------------------------------------ */

interface NumArray {
  [key: string]: unknown;
}

function numArray(v: unknown): number[] | null {
  return Array.isArray(v) ? (v as number[]) : null;
}

function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Maps a real Open-Meteo forecast payload to the snapshot shape the app
 * already renders. Returns `null` when the payload is not usable — the
 * caller then falls back to reference values (never fabricates).
 */
export function buildLiveSnapshot(
  wilaya: Wilaya,
  payload: unknown,
  nowIso: string,
): WeatherSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { current?: Record<string, unknown>; hourly?: NumArray; daily?: NumArray };

  // Current conditions — the values that feed the ET0 step.
  const currentT = finiteNum(p.current?.temperature_2m);
  const currentH = finiteNum(p.current?.relative_humidity_2m);
  const currentW = finiteNum(p.current?.wind_speed_10m);
  if (currentT === null || currentH === null || currentW === null) return null;

  // Next 6 hourly readings (real clock labels, e.g. "13").
  const times = p.hourly?.time;
  if (!Array.isArray(times) || times.length === 0) return null;
  const idx = selectNextHourIndexes(times, nowIso, 6);
  if (idx.length < 6) return null;

  const hTemp = numArray(p.hourly?.temperature_2m);
  if (!hTemp) return null;
  const hHum = numArray(p.hourly?.relative_humidity_2m);
  const hWind = numArray(p.hourly?.wind_speed_10m);
  const hRain = numArray(p.hourly?.precipitation_probability);

  // A single missing core reading invalidates the snapshot (fallback) —
  // we never interpolate or invent values.
  if (!idx.every((i) => finiteNum(hTemp[i]) !== null)) return null;

  const hours = idx.map((i) => {
    const t = finiteNum(hTemp[i]) as number;
    const rain = hRain ? finiteNum(hRain[i]) : null;
    const hum = hHum ? finiteNum(hHum[i]) : null;
    return {
      label: (times[i] as string).slice(11, 13),
      tempC: round1(t),
      rainPct: rain === null ? null : clampPct(rain),
      humidity: hum === null ? null : clampPct(hum),
      windKph: hWind ? finiteNum(hWind[i]) : null,
    };
  });

  // 7-day min/max (real weekday labels) + daily rain probability.
  const dTimes = p.daily?.time;
  const dMin = numArray(p.daily?.temperature_2m_min);
  const dMax = numArray(p.daily?.temperature_2m_max);
  const dRain = numArray(p.daily?.precipitation_probability_max);
  if (!Array.isArray(dTimes) || dTimes.length < 7 || !dMin || !dMax) return null;

  const dSlice = dTimes.slice(0, 7);
  if (!dSlice.every((_, i) => finiteNum(dMin[i]) !== null && finiteNum(dMax[i]) !== null)) return null;

  const days = dSlice.map((t, i) => {
    const rain = dRain ? finiteNum(dRain[i]) : null;
    return {
      labelKey: weekdayIndex(t as string),
      minC: round1(finiteNum(dMin[i]) as number),
      maxC: round1(finiteNum(dMax[i]) as number),
      rainPct: rain === null ? null : clampPct(rain),
    };
  });

  const tempC = round1(currentT);
  const humidity = clampPct(currentH);
  const windKph = Math.round(Math.max(0, currentW));

  return {
    wilaya,
    tempC,
    humidity,
    windKph,
    // Annual rainfall stays the long-term climatology (not a "today" reading).
    rainMmYear: wilaya.climate.rainMm,
    et0: referenceEt0({ tempC, humidity, windKph, rainMm: wilaya.climate.rainMm }),
    hours,
    days,
  };
}

/* ------------------------------------------------------------------ */
/*  Cache (in-memory + localStorage, SSR-safe, never throws)           */
/* ------------------------------------------------------------------ */

const memCache = new Map<string, LiveCacheEntry>();
const cacheListeners = new Set<() => void>();

/** Subscribes to live-weather cache updates (used by useSyncExternalStore). */
export function subscribeToWeatherCache(onStoreChange: () => void): () => void {
  cacheListeners.add(onStoreChange);
  return () => {
    cacheListeners.delete(onStoreChange);
  };
}

function notifyCacheChange(): void {
  cacheListeners.forEach((listener) => listener());
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isFresh(fetchedAt: number, now: number = Date.now()): boolean {
  return now - fetchedAt < LIVE_TTL_MS;
}

export function readLiveCache(wilayaCode: string): LiveCacheEntry | null {
  const mem = memCache.get(wilayaCode);
  if (mem) return mem;
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(CACHE_PREFIX + wilayaCode);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LiveCacheEntry;
    const ok =
      parsed &&
      typeof parsed.fetchedAt === "number" &&
      parsed.snapshot &&
      Array.isArray(parsed.snapshot.hours) &&
      Array.isArray(parsed.snapshot.days);
    if (!ok) return null;
    // Promote to the in-memory map so repeated reads return the same
    // reference (required for useSyncExternalStore snapshots).
    memCache.set(wilayaCode, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function writeLiveCache(wilayaCode: string, entry: LiveCacheEntry): void {
  memCache.set(wilayaCode, entry);
  const s = storage();
  if (s) {
    try {
      s.setItem(CACHE_PREFIX + wilayaCode, JSON.stringify(entry));
    } catch {
      /* storage full/blocked — in-memory entry still works for this session */
    }
  }
  notifyCacheChange();
}

/* ------------------------------------------------------------------ */
/*  Fetch (timeout + dedupe; every failure → null)                     */
/* ------------------------------------------------------------------ */

/** Minimal structural fetch contract — keeps the layer stub-friendly in tests. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface FetchOptions {
  fetchImpl?: FetchLike;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  timeoutMs?: number;
}

const inFlight = new Map<string, Promise<LiveCacheEntry | null>>();

/**
 * Fetches a live snapshot for the wilaya (cached per code, deduped per
 * in-flight request). Resolves `null` on ANY failure — the UI then keeps
 * showing reference (or stale-live) values. Never rejects.
 */
export function fetchLiveSnapshot(wilaya: Wilaya, opts: FetchOptions = {}): Promise<LiveCacheEntry | null> {
  const existing = inFlight.get(wilaya.code);
  if (existing) return existing;
  const job = doFetch(wilaya, opts).finally(() => inFlight.delete(wilaya.code));
  inFlight.set(wilaya.code, job);
  return job;
}

async function doFetch(wilaya: Wilaya, opts: FetchOptions): Promise<LiveCacheEntry | null> {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === "function" ? (fetch as FetchLike) : undefined);
  if (!fetchImpl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? LIVE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(openMeteoUrl(wilaya.lat, wilaya.lon), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const payload: unknown = await res.json();
    const snapshot = buildLiveSnapshot(wilaya, payload, wilayaLocalNowIso(now()));
    if (!snapshot) return null;
    const entry: LiveCacheEntry = { fetchedAt: now(), snapshot };
    writeLiveCache(wilaya.code, entry);
    return entry;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
