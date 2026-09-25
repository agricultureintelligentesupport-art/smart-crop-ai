"use client";

import { CloudRain, Droplets, Info, Sun, Thermometer, TriangleAlert, Waves, Wind } from "lucide-react";
import type { WeatherSnapshot } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { fmt } from "@/lib/dashboard/format";
import { weatherAdvice, weatherCondition } from "@/lib/dashboard/widgets";
import type { Lang } from "@/lib/wilayas";
import type { WeatherSource } from "@/lib/weather/useLiveWeather";
import { Chip, Metric } from "./parts";

/**
 * The complete weather view: current readings, the hourly strip, the 7-day
 * forecast, the active advisory rule and the source note.
 *
 * It used to be a grouped dashboard card; the weather section is now the
 * "الطقس والتوقعات" quick-access widget, so this full view fills
 * `WeatherDetailModal`'s bottom sheet instead. Nothing was dropped in the
 * move: the sheet's header carries the title/subtitle the card used to draw,
 * and this file renders the same metrics, series and notes as before.
 */

/* `fmt` has lived in this module since the first dashboard and is imported by
   five other surfaces — it now lives in `lib/dashboard/format.ts` and is
   re-exported here so those imports (and the widget figures) share one formatter. */
export { fmt };

/** Rain chance as displayed text — `null` means the source has no probability. */
const rainText = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `${fmt(value)}%`;

export default function WeatherCard({
  t,
  lang,
  weather,
  source,
  fetchedAt,
}: {
  t: DashboardCopy;
  lang: Lang;
  weather: WeatherSnapshot;
  /** Where `weather`'s numbers come from (drives the source note). */
  source: WeatherSource;
  /** Epoch ms of the successful live fetch (null in reference mode). */
  fetchedAt?: number | null;
}) {
  const { tempC, humidity, windKph, rainMmYear, et0, hours, days } = weather;
  const condition = weatherCondition(weather);
  const hot = condition === "heat";
  const windy = condition === "wind";
  const advice = weatherAdvice(condition, t.weather);

  const lastUpdate =
    source === "live" && fetchedAt
      ? new Intl.DateTimeFormat(lang === "ar" ? "ar-DZ" : "fr-DZ", { hour: "2-digit", minute: "2-digit" }).format(
          new Date(fetchedAt),
        )
      : null;

  return (
    <div className="flex flex-col">
      {/* Now strip — the temperature the sheet header no longer shows. */}
      <div className="flex items-center justify-between gap-2">
        <Chip tone={hot ? "amber" : "emerald"} icon={<Thermometer size={12} strokeWidth={3} aria-hidden />}>
          <span dir="ltr">{fmt(tempC, 1)}°C</span>
        </Chip>
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-800/65">
          <Sun size={13} strokeWidth={2.6} aria-hidden />
          {t.weather.now}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Metric
          label={t.weather.humidity}
          value={`${fmt(humidity)}%`}
          icon={<Droplets size={11} strokeWidth={2.8} aria-hidden />}
        />
        <Metric
          label={t.weather.wind}
          value={`${fmt(windKph)} km/h`}
          tone={windy ? "warn" : "default"}
          icon={<Wind size={11} strokeWidth={2.8} aria-hidden />}
        />
        <Metric
          label={t.weather.rain}
          value={`${fmt(rainMmYear)} mm`}
          icon={<CloudRain size={11} strokeWidth={2.8} aria-hidden />}
        />
        <Metric
          label={t.weather.et0}
          value={`${fmt(et0, 1)} mm`}
          icon={<Waves size={11} strokeWidth={2.8} aria-hidden />}
        />
      </div>

      <p className="mt-4 text-[12px] font-extrabold tracking-wide text-emerald-800/65">{t.weather.hourLabel}</p>
      <ul className="mt-2 grid grid-cols-6 gap-1">
        {hours.map((hour) => (
          <li
            key={hour.label}
            className="app-tile flex min-w-0 flex-col items-center gap-0.5 rounded-[0.85rem] py-2"
            title={hour.rainPct === null ? undefined : t.weather.rainChance.replace("{n}", String(hour.rainPct))}
          >
            <span dir="ltr" className="text-[10.5px] font-black tabular-nums text-emerald-800/60">
              {hour.label}
            </span>
            <span dir="ltr" className="text-[13px] font-black tabular-nums text-emerald-950">
              {fmt(hour.tempC, 0)}°
            </span>
            <span dir="ltr" className="text-[10px] font-bold tabular-nums text-emerald-700/70">
              {rainText(hour.rainPct)}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-[12px] font-extrabold tracking-wide text-emerald-800/65">{t.weather.days}</p>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {days.map((day) => (
          <div
            key={day.labelKey}
            className="app-tile flex min-w-0 flex-col items-center gap-0.5 rounded-[0.85rem] px-0.5 py-2"
          >
            <span className="w-full truncate text-center text-[10.5px] font-black text-emerald-800/70">
              {t.weather.dayLabels[day.labelKey]}
            </span>
            <span dir="ltr" className="text-[12.5px] font-black tabular-nums text-emerald-950">
              {fmt(day.maxC)}°
            </span>
            <span dir="ltr" className="text-[10px] font-bold tabular-nums text-emerald-800/60">
              {fmt(day.minC)}°
            </span>
            <span dir="ltr" className="text-[10px] font-bold tabular-nums text-emerald-600">
              {rainText(day.rainPct)}
            </span>
          </div>
        ))}
      </div>

      <p
        className={`mt-3 flex items-start gap-2 rounded-[1rem] px-3 py-2.5 text-[12px] font-bold leading-[1.7] ${
          hot || windy
            ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200"
            : "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-100"
        }`}
      >
        <TriangleAlert size={14} strokeWidth={2.6} aria-hidden className="mt-[3px] shrink-0" />
        {advice}
      </p>

      {/* Data-source line: live (with last update) or reference fallback. */}
      {source === "live" ? (
        <p className="mt-2 flex items-center gap-1.5 px-1 text-[10.5px] font-semibold leading-5 text-emerald-900/55">
          <span aria-hidden className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          {t.weather.liveNote.replace("{time}", lastUpdate ?? "")}
        </p>
      ) : (
        <p className="mt-2 flex items-start gap-1.5 rounded-[0.9rem] bg-amber-50 px-2.5 py-1.5 text-[10.5px] font-semibold leading-[1.7] text-amber-900 ring-1 ring-amber-200">
          <Info size={12} strokeWidth={2.6} aria-hidden className="mt-[3px] shrink-0" />
          {t.weather.baselineNote}
        </p>
      )}
    </div>
  );
}
