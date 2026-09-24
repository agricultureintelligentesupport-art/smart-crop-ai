/**
 * Deterministic agro-computation layer for the dashboard.
 *
 * Everything here is *derived* from the wilaya baseline in `wilayas.ts` plus a
 * small seeded PRNG, so a given wilaya always produces the same numbers on
 * every render and on every device (no hydration mismatch, no flapping UI).
 * No network, no fake "live" claims: the UI labels these as estimates.
 */

import { CROPS, SOILS, getWilaya, type CropKey, type SoilKey, type Wilaya } from "./wilayas";

/* ------------------------------------------------------------------ */
/*  Seeded PRNG (mulberry32) — stable pseudo-random per wilaya         */
/* ------------------------------------------------------------------ */

function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededSeries(key: string, count: number, min: number, max: number): number[] {
  const rand = mulberry32(seedFrom(key));
  return Array.from({ length: count }, () => {
    const v = min + rand() * (max - min);
    return Math.round(v * 100) / 100;
  });
}

/* ------------------------------------------------------------------ */
/*  Weather                                                            */
/* ------------------------------------------------------------------ */

export interface HourPoint {
  label: string;
  tempC: number;
  /** Chance of rain, %. `null` = not available from the current source. */
  rainPct: number | null;
  /** Relative humidity, % — present only for live hourly data. */
  humidity?: number | null;
  /** Wind speed km/h — present only for live hourly data. */
  windKph?: number | null;
}

export interface DayPoint {
  labelKey: number;
  minC: number;
  maxC: number;
  /** Chance of rain, %. `null` = not available from the current source. */
  rainPct: number | null;
}

export interface WeatherSnapshot {
  wilaya: Wilaya;
  tempC: number;
  humidity: number;
  windKph: number;
  rainMmYear: number;
  /** Estimated reference evapotranspiration (mm/day). */
  et0: number;
  hours: HourPoint[];
  days: DayPoint[];
}

/** Labels are index-based so the component can localise them (no AR/FR strings here). */
export const HOUR_LABELS = ["06", "09", "12", "15", "18", "21"] as const;
export const DAY_KEYS = [0, 1, 2, 3, 4, 5, 6] as const;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Intermediate terms of the ET0 formula, surfaced so the UI can explain the
 * calculation with the exact numbers that were used. Same arithmetic as
 * `referenceEt0` — nothing here changes the result.
 */
export interface Et0Breakdown {
  /** Humidity damping factor: `0.72 + (humidity/100) × 0.42`. */
  humidityDamping: number;
  /** Wind boost factor: `1 + (windKph − 12) × 0.012`. */
  windBoost: number;
  /** `0.155 × tempC × humidityDamping × windBoost`, before clamping. */
  raw: number;
  /** Final ET0 (mm/day): the raw value clamped to [1.4, 9.5], rounded to 1 decimal. */
  final: number;
  /** True when the [1.4, 9.5] clamp actually changed the value. */
  clamped: boolean;
}

export function referenceEt0Detail(climate: Wilaya["climate"]): Et0Breakdown {
  const humidityDamping = 0.72 + (climate.humidity / 100) * 0.42; // ~0.8 humid → ~1.06 arid
  const windBoost = 1 + (climate.windKph - 12) * 0.012;
  const raw = 0.155 * climate.tempC * humidityDamping * windBoost;
  const final = round1(Math.min(Math.max(raw, 1.4), 9.5));
  return { humidityDamping, windBoost, raw, final, clamped: final !== round1(raw) };
}

/**
 * Hargreaves-style reference evapotranspiration estimate for the reference
 * season. Coastal/humid sites are damped, arid sites amplified.
 */
export function referenceEt0(climate: Wilaya["climate"]): number {
  return referenceEt0Detail(climate).final;
}

export function weatherFor(wilayaCode: string | null | undefined): WeatherSnapshot {
  const wilaya = getWilaya(wilayaCode);
  const { tempC, humidity, windKph, rainMm } = wilaya.climate;
  const rand = mulberry32(seedFrom(`w-${wilaya.code}`));

  const hours: HourPoint[] = HOUR_LABELS.map((label, i) => {
    // Diurnal curve: coolest at dawn, peak early afternoon.
    const curve = [-3.6, -1.2, 1.8, 2.6, 0.4, -2.2][i];
    const jitter = (rand() - 0.5) * 1.2;
    return {
      label,
      tempC: round1(tempC + curve + jitter),
      rainPct: Math.round(Math.min(85, Math.max(0, 90 - humidity + (rand() - 0.4) * 30))),
    };
  });

  const days: DayPoint[] = DAY_KEYS.map((labelKey, i) => {
    const drift = Math.sin(i * 0.9) * 2.4 + (rand() - 0.5) * 2;
    const maxC = round1(tempC + drift);
    const minC = round1(maxC - (7 + rand() * 5));
    const rainPct = Math.round(Math.min(90, Math.max(0, humidity - 18 + (rand() - 0.5) * 34)));
    return { labelKey, minC, maxC, rainPct };
  });

  return {
    wilaya,
    tempC,
    humidity,
    windKph,
    rainMmYear: rainMm,
    et0: referenceEt0(wilaya.climate),
    hours,
    days,
  };
}

/* ------------------------------------------------------------------ */
/*  Weather advice thresholds                                          */
/* ------------------------------------------------------------------ */

/**
 * The exact thresholds the dashboard's advisory rules use (see WeatherCard):
 * `tempC ≥ 33` → heat-wave advice, `windKph ≥ 20` → wind advice, otherwise
 * `et0 ≥ 5` → keep-usual-schedule, else calm. Exported so the window detail
 * sheet can evaluate the same rules with the same numbers.
 */
export const HEAT_THRESHOLD_C = 33;
export const WIND_THRESHOLD_KPH = 20;
export const ET0_ADVISE_MM_DAY = 5;

/* ------------------------------------------------------------------ */
/*  Irrigation                                                         */
/* ------------------------------------------------------------------ */

/** Mid-season crop coefficients (FAO-56 ballpark, mid-season stage). */
const KC: Record<CropKey, number> = {
  dates: 0.95,
  tomato: 1.15,
  potato: 1.15,
  onion: 1.05,
  pepper: 1.05,
  wheat: 1.1,
  barley: 1.05,
  olive: 0.7,
  citrus: 0.75,
  grape: 0.8,
  apple: 1.0,
  peach: 1.0,
  apricot: 1.0,
  pomegranate: 0.9,
  fig: 0.85,
  almond: 0.95,
  watermelon: 1.0,
  melon: 1.0,
  carrot: 1.05,
  garlic: 1.0,
  faba: 1.15,
  pea: 1.1,
  chickpea: 1.0,
  lentil: 1.05,
  artichoke: 1.05,
  alfalfa: 0.95,
  alfa: 0.6,
  sorghum: 1.0,
  henna: 0.9,
  groundnut: 1.05,
  rice: 1.2,
  sunflower: 1.05,
};

/** Extra demand from soil texture (sandy soils leach and evaporate faster). */
const SOIL_FACTOR: Record<SoilKey, number> = {
  sandy: 1.16,
  loamy: 1.0,
  clayey: 0.94,
  calcareous: 1.08,
  silty: 1.04,
  saline: 1.12,
  gravelly: 1.14,
};

export type IrrigationSystem = "drip" | "sprinkler" | "furrow";

/** Application efficiency per system (share of applied water the crop uses). */
export const SYSTEM_EFFICIENCY: Record<IrrigationSystem, number> = {
  drip: 0.9,
  sprinkler: 0.75,
  furrow: 0.55,
};

export interface IrrigationInput {
  wilayaCode: string | null | undefined;
  crop: CropKey;
  /** Irrigated area in hectares. */
  areaHa: number;
  soil: SoilKey;
  system: IrrigationSystem;
  /**
   * Optional weather snapshot (e.g. live Open-Meteo data) whose climate values
   * feed the ET0 step. When omitted, the static reference values for the
   * wilaya are used. The formula itself is identical either way.
   */
  weather?: WeatherSnapshot;
}

export interface IrrigationResult {
  /** Net crop water requirement, mm/day. */
  netMmDay: number;
  /** Water to apply (gross), litres per hectare per day. */
  litresPerHaDay: number;
  /** Gross daily volume for the parcel, m³/day (1 mm over 1 ha = 10 m³). */
  dailyM3: number;
  /** Gross weekly volume, m³/week. */
  weeklyM3: number;
  /** Litres saved per day on this parcel compared with furrow irrigation. */
  savedLitresPerDay: number;
  /** Share of water saved versus furrow, %. */
  savedPct: number;
  et0: number;
  kc: number;
  /** Soil texture factor applied to ET0 × Kc (see SOIL_FACTOR). */
  soilFactor: number;
  /** Application efficiency of the chosen system (0–1). */
  efficiency: number;
  /** Gross (applied) requirement in mm/day before the volume conversion. */
  grossMmDay: number;
  /** Gross requirement in mm/day if the furrow system were used instead. */
  furrowMmDay: number;
}

export function computeIrrigation({
  wilayaCode,
  crop,
  areaHa,
  soil,
  system,
  weather: weatherOverride,
}: IrrigationInput): IrrigationResult {
  // Only the climate INPUT may differ (live snapshot vs static reference);
  // every formula below is identical either way.
  const weather = weatherOverride ?? weatherFor(wilayaCode);
  const kc = KC[crop];
  const soilFactor = SOIL_FACTOR[soil];
  const netMmDay = weather.et0 * kc * soilFactor;
  const efficiency = SYSTEM_EFFICIENCY[system];
  const grossMmDay = netMmDay / efficiency;

  const mmToM3 = (mm: number) => Math.round(mm * areaHa * 10);
  const litresPerHaDay = Math.round(grossMmDay * 10000); // 1 mm over 1 ha = 10 000 L
  const dailyM3 = mmToM3(grossMmDay);
  const weeklyM3 = mmToM3(grossMmDay * 7);

  const furrowEfficiency = SYSTEM_EFFICIENCY.furrow;
  const furrowMmDay = netMmDay / furrowEfficiency;
  const savedLitresPerDay = Math.round((furrowMmDay - grossMmDay) * areaHa * 10000);
  const savedPct = Math.max(0, Math.round(((furrowMmDay - grossMmDay) / furrowMmDay) * 100));

  return {
    netMmDay: round1(netMmDay),
    litresPerHaDay,
    dailyM3,
    weeklyM3,
    savedLitresPerDay,
    savedPct,
    et0: weather.et0,
    kc,
    soilFactor,
    efficiency,
    grossMmDay: round1(grossMmDay),
    furrowMmDay: round1(furrowMmDay),
  };
}

/* ------------------------------------------------------------------ */
/*  Vegetation index (NDVI)                                            */
/* ------------------------------------------------------------------ */

export interface NdviReading {
  /** 0–1 vegetation index. */
  value: number;
  /** % change over the observed window. */
  trendPct: number;
  /** 8-point history, oldest → newest. */
  series: number[];
  /** 0–1 share of the parcel showing stress. */
  stressShare: number;
}

export function ndviFor(wilayaCode: string | null | undefined, crop: CropKey): NdviReading {
  const wilaya = getWilaya(wilayaCode);
  const vigour =
    0.34 +
    (wilaya.climate.humidity / 100) * 0.35 +
    (wilaya.climate.rainMm / 1000) * 0.14 +
    (KC[crop] - 0.9) * 0.08;
  const base = Math.min(Math.max(vigour, 0.28), 0.86);
  const clean = seededSeries(`ndvi-${wilaya.code}-${crop}`, 8, base - 0.1, base + 0.09).map(
    (v) => Math.round(Math.min(Math.max(v, 0.2), 0.92) * 100) / 100,
  );
  const first = clean[0];
  const last = clean[clean.length - 1];
  const trendPct = Math.round(((last - first) / first) * 100);

  return {
    value: last,
    trendPct,
    series: clean,
    stressShare: Math.round(Math.min(0.42, Math.max(0.03, 0.3 - (last - 0.5))) * 100) / 100,
  };
}

export function ndviBand(value: number): "poor" | "fair" | "good" | "excellent" {
  if (value < 0.35) return "poor";
  if (value < 0.55) return "fair";
  if (value < 0.72) return "good";
  return "excellent";
}

/* ------------------------------------------------------------------ */
/*  On-device leaf scan (demo engine)                                  */
/* ------------------------------------------------------------------ */

export type DiagnosisKey =
  | "healthy"
  | "early_blight"
  | "powdery_mildew"
  | "leaf_rust"
  | "nitrogen_gap"
  | "water_stress";

export interface Diagnosis {
  key: DiagnosisKey;
  /** 0–1 model confidence. */
  confidence: number;
  /** 0–1 severity. */
  severity: number;
  /** Crop keys the finding is most common on. */
  crops: CropKey[];
}

const DIAGNOSES: Omit<Diagnosis, "confidence" | "severity">[] = [
  { key: "healthy", crops: ["tomato", "potato", "citrus", "olive"] },
  { key: "early_blight", crops: ["tomato", "potato", "pepper"] },
  { key: "powdery_mildew", crops: ["grape", "melon", "watermelon", "apricot"] },
  { key: "leaf_rust", crops: ["wheat", "barley", "alfalfa"] },
  { key: "nitrogen_gap", crops: ["wheat", "barley", "potato", "tomato"] },
  { key: "water_stress", crops: ["dates", "potato", "onion", "citrus", "olive"] },
];

/**
 * Deterministic demo classifier. It hashes the picked file's name + size +
 * wilaya so the "diagnosis" is stable per photo but varies between photos.
 * Replace with the real model call when the inference service is wired.
 */
export function diagnoseImage(file: { name: string; size: number }, wilayaCode: string | null): Diagnosis {
  const rand = mulberry32(seedFrom(`${file.name}:${file.size}:${wilayaCode ?? "na"}`));
  const pick = DIAGNOSES[Math.floor(rand() * DIAGNOSES.length)];
  const confidence = Math.round((0.78 + rand() * 0.18) * 100) / 100;
  const severity = pick.key === "healthy" ? 0 : Math.round((0.15 + rand() * 0.6) * 100) / 100;
  return { ...pick, confidence, severity };
}

export const DIAGNOSIS_CROPS = DIAGNOSES;

/* ------------------------------------------------------------------ */
/*  Recommendations                                                    */
/* ------------------------------------------------------------------ */

export interface Advice {
  key: string;
  tone: "good" | "watch" | "alert";
  params?: Record<string, string | number>;
}

/** Ranks the crop list for the wilaya, keeping the on-file order as weight. */
export function recommendedCrops(wilayaCode: string | null | undefined, limit = 4): CropKey[] {
  const wilaya = getWilaya(wilayaCode);
  return wilaya.crops.slice(0, limit);
}

export function cropLabel(crop: CropKey, lang: "ar" | "fr"): string {
  return CROPS[crop][lang];
}

export function soilLabel(soil: SoilKey, lang: "ar" | "fr"): string {
  return SOILS[soil][lang];
}
