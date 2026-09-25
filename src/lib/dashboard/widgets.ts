/**
 * Quick-access widget figures — the compact numbers the two widgets under the
 * decision card advertise, and the free door into the full weather /
 * calculator sheets.
 *
 * A widget is a shortcut, never a second source of truth:
 *   - every figure is read straight off the same `WeatherSnapshot` and
 *     `IrrigationResult` the hero decision card renders (no formula lives in
 *     this file), so the badge on a widget and the number behind it can never
 *     drift apart; and
 *   - the advisory condition comes from the app's one threshold cascade
 *     (heat → wind → ET₀ → calm), which the weather card, the irrigation-window
 *     sheet and these widgets now all read — previously the cascade was
 *     re-written by hand on each surface.
 *
 * Pure and framework-free so `npm run test:unit` can pin both contracts.
 */

import {
  ET0_ADVISE_MM_DAY,
  HEAT_THRESHOLD_C,
  WIND_THRESHOLD_KPH,
  type IrrigationResult,
  type WeatherSnapshot,
} from "../agronomy";
import type { DashboardCopy } from "./copy";
import { fillTemplate, fmt } from "./format";

/** Which advisory rule governs the day (see `DashboardCopy.weather`). */
export type WeatherCondition = "heat" | "wind" | "et0" | "calm";

/**
 * The app's advisory cascade, in the documented order: heat first, then wind,
 * then reference evapotranspiration, otherwise calm. Mirrors the order the
 * irrigation-window sheet prints its rules in.
 */
export function weatherCondition(
  weather: Pick<WeatherSnapshot, "tempC" | "windKph" | "et0">,
): WeatherCondition {
  if (weather.tempC >= HEAT_THRESHOLD_C) return "heat";
  if (weather.windKph >= WIND_THRESHOLD_KPH) return "wind";
  if (weather.et0 >= ET0_ADVISE_MM_DAY) return "et0";
  return "calm";
}

/** The active rule's sentence in the active language. */
export function weatherAdvice(
  condition: WeatherCondition,
  copy: DashboardCopy["weather"],
): string {
  switch (condition) {
    case "heat":
      return copy.adviceHeat;
    case "wind":
      return copy.adviceWind;
    case "et0":
      return copy.adviceIrrigate;
    default:
      return copy.adviceCalm;
  }
}

export interface WeatherWidgetFigures {
  /** Raw values (kept for tests and future surfaces). */
  tempC: number;
  humidity: number;
  windKph: number;
  et0: number;
  /** Display strings — the widget renders exactly these. */
  tempText: string;
  humidityText: string;
  windText: string;
  condition: WeatherCondition;
  /** The active advisory sentence, same cascade the weather card uses. */
  advice: string;
  /** Accessible name of the widget button, numbers included. */
  aria: string;
}

export interface CalculatorWidgetFigures {
  /** Raw values, copied verbatim from `computeIrrigation`. */
  litresPerHaDay: number;
  dailyM3: number;
  weeklyM3: number;
  savedPct: number;
  /** Display strings — the widget renders exactly these. */
  areaText: string;
  volumeText: string;
  /** Accessible name of the widget button, numbers included. */
  aria: string;
}

export interface QuickAccessFigures {
  weather: WeatherWidgetFigures;
  calculator: CalculatorWidgetFigures;
}

export function quickAccessFigures({
  weather,
  irrigation,
  copy,
  cropLabel,
  areaHa,
}: {
  weather: WeatherSnapshot;
  /** The exact result the hero decision card renders. */
  irrigation: IrrigationResult;
  copy: DashboardCopy;
  /** Localised crop label shown in the calculator widget's tag. */
  cropLabel: string;
  areaHa: number;
}): QuickAccessFigures {
  const condition = weatherCondition(weather);
  const tempText = `${fmt(weather.tempC, 1)}°C`;
  const humidityText = `${fmt(weather.humidity)}%`;
  const windText = `${fmt(weather.windKph)} km/h`;
  const areaText = `${fmt(areaHa, 1)} ${copy.irrigation.areaUnit}`;
  const volumeText = `${fmt(irrigation.dailyM3, 1)} m³`;

  return {
    weather: {
      tempC: weather.tempC,
      humidity: weather.humidity,
      windKph: weather.windKph,
      et0: weather.et0,
      tempText,
      humidityText,
      windText,
      condition,
      advice: weatherAdvice(condition, copy.weather),
      aria: fillTemplate(copy.widgets.weather.openAria, {
        temp: tempText,
        humidity: humidityText,
        wind: windText,
      }),
    },
    calculator: {
      litresPerHaDay: irrigation.litresPerHaDay,
      dailyM3: irrigation.dailyM3,
      weeklyM3: irrigation.weeklyM3,
      savedPct: irrigation.savedPct,
      areaText,
      volumeText,
      aria: fillTemplate(copy.widgets.calculator.openAria, {
        crop: cropLabel,
        area: areaText,
        volume: volumeText,
      }),
    },
  };
}
