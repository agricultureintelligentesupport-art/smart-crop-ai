/**
 * Per-hectare flow numbers — the display-side view of the exact chain
 * `computeIrrigation` already ran.
 *
 * The hero card shows L/ha and m³; this module exposes the *intermediates* of
 * the same arithmetic so the flow diagram can print them without ever
 * re-deriving (or contradicting) the headline numbers:
 *
 *   ET₀ → × Kc → × soil factor → ÷ efficiency → × 10 000 L/ha → × area
 *
 * Everything is read back from the `IrrigationResult` and the live
 * `WeatherSnapshot` the dashboard already renders, so the diagram, the hero
 * card and the calculator can never disagree. `verifyFlow` states the two
 * invariants explicitly — the unit tests assert them across every wilaya, crop
 * and parcel size.
 */

import { referenceEt0Detail, type Et0Breakdown, type IrrigationResult, type WeatherSnapshot } from "@/lib/agronomy";

export interface PerHectareFlow {
  /** The real ET₀ intermediates (humidity damping, wind boost, final value). */
  et0: Et0Breakdown;
  /** Net crop requirement, mm/day (gross × efficiency). */
  netMm: number;
  /** Gross requirement, mm/day — the value that produced `litresPerHa`. */
  grossMm: number;
  /** Gross requirement × 10 000 L/mm/ha, i.e. `IrrigationResult.litresPerHaDay`. */
  litresPerHa: number;
  /** Parcel volume for the day, m³ (`IrrigationResult.dailyM3`). */
  parcelM3: number;
  /** Parcel volume for the week, m³. */
  weeklyM3: number;
  /** Parcel size the volume was computed for, hectares. */
  areaHa: number;
}

export interface FlowVerification {
  /** `grossMm × 10 000` rounds back to the canonical per-hectare litre figure. */
  litresMatch: boolean;
  /** `litresPerHa × area ÷ 1000` rounds back to the canonical parcel volume. */
  parcelMatches: boolean;
  /** Exact difference (m³) between the recomputed parcel volume and the result. */
  parcelDeltaM3: number;
}

/**
 * Rebuilds the chain from the shared result. `et0` is re-derived with
 * `referenceEt0Detail` from the *snapshot's* climate values, which is the same
 * call that produced `weather.et0` — so live and reference modes both show the
 * terms actually used, and `irrigation.et0 === weather.et0`.
 */
export function perHectareFlow({
  irrigation,
  weather,
  areaHa,
}: {
  irrigation: IrrigationResult;
  weather: WeatherSnapshot;
  areaHa: number;
}): PerHectareFlow {
  const et0 = referenceEt0Detail({
    tempC: weather.tempC,
    humidity: weather.humidity,
    windKph: weather.windKph,
    rainMm: weather.rainMmYear,
  });

  const { kc, soilFactor, efficiency, litresPerHaDay, dailyM3, weeklyM3 } = irrigation;
  // Same operations, same order as `computeIrrigation`: net → gross → litres.
  const netMm = irrigation.et0 * kc * soilFactor;
  const grossMm = netMm / efficiency;

  return {
    et0,
    netMm,
    grossMm,
    litresPerHa: litresPerHaDay,
    parcelM3: dailyM3,
    weeklyM3,
    areaHa,
  };
}

/** The two guarantees the flow diagram promises the hero card. */
export function verifyFlow(flow: PerHectareFlow): FlowVerification {
  const recomputedLitres = Math.round(flow.grossMm * 10000);
  const recomputedParcel = (flow.litresPerHa * flow.areaHa) / 1000;
  return {
    litresMatch: recomputedLitres === flow.litresPerHa,
    parcelMatches: Math.round(recomputedParcel) === flow.parcelM3,
    parcelDeltaM3: recomputedParcel - flow.parcelM3,
  };
}
