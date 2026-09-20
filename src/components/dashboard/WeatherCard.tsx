"use client";

import { CloudRain, Droplets, Sun, Thermometer, TriangleAlert, Waves, Wind } from "lucide-react";
import type { WeatherSnapshot } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { Lang } from "@/lib/wilayas";
import { Card, Chip, Metric } from "./parts";

export const fmt = (value: number, digits = 0) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

export default function WeatherCard({
  t,
  lang,
  weather,
}: {
  t: DashboardCopy;
  lang: Lang;
  weather: WeatherSnapshot;
}) {
  const { tempC, humidity, windKph, rainMmYear, et0, hours, days, wilaya } = weather;
  const hot = tempC >= 33;
  const windy = windKph >= 20;
  const advice = hot ? t.weather.adviceHeat : windy ? t.weather.adviceWind : et0 >= 5 ? t.weather.adviceIrrigate : t.weather.adviceCalm;

  return (
    <Card
      title={t.weather.title}
      subtitle={t.weather.subtitle.replace("{wilaya}", lang === "ar" ? wilaya.nameAr : wilaya.nameFr)}
      icon={<Sun size={17} strokeWidth={2.4} aria-hidden />}
      aside={
        <Chip tone={hot ? "amber" : "emerald"} icon={<Thermometer size={11} strokeWidth={3} aria-hidden />}>
          <span dir="ltr">{fmt(tempC, 1)}°C</span>
        </Chip>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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

      <p className="mt-3 text-[11px] font-black text-emerald-800">{t.weather.hourLabel}</p>
      <ul className="mt-1.5 grid grid-cols-6 gap-1">
        {hours.map((hour) => (
          <li
            key={hour.label}
            className="flex min-w-0 flex-col items-center gap-0.5 rounded-xl bg-white/70 py-1.5 ring-1 ring-[#E2F1E8]"
            title={t.weather.rainChance.replace("{n}", String(hour.rainPct))}
          >
            <span dir="ltr" className="text-[10px] font-black tabular-nums text-emerald-800/70">
              {hour.label}
            </span>
            <span dir="ltr" className="text-[12px] font-black tabular-nums text-emerald-950">
              {fmt(hour.tempC, 0)}°
            </span>
            <span dir="ltr" className="text-[9px] font-bold tabular-nums text-emerald-700/70">
              {fmt(hour.rainPct)}%
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-7 gap-1">
        {days.map((day) => (
          <div
            key={day.labelKey}
            className="flex min-w-0 flex-col items-center gap-0.5 rounded-2xl bg-white/70 px-0.5 py-2 ring-1 ring-[#E2F1E8]"
          >
            <span className="truncate text-[10px] font-black text-emerald-800/80">
              {t.weather.dayLabels[day.labelKey]}
            </span>
            <span dir="ltr" className="text-[12px] font-black tabular-nums text-emerald-950">
              {fmt(day.maxC)}°
            </span>
            <span dir="ltr" className="text-[9.5px] font-bold tabular-nums text-emerald-800/60">
              {fmt(day.minC)}°
            </span>
            <span dir="ltr" className="text-[9.5px] font-bold tabular-nums text-emerald-600">
              {fmt(day.rainPct)}%
            </span>
          </div>
        ))}
      </div>

      <p
        className={`mt-3 flex items-start gap-1.5 rounded-2xl px-2.5 py-2 text-[11px] font-bold leading-5 ${
          hot || windy ? "bg-amber-50/90 text-amber-900 ring-1 ring-amber-200" : "bg-emerald-50/80 text-emerald-900 ring-1 ring-emerald-200/70"
        }`}
      >
        <TriangleAlert size={13} strokeWidth={2.6} aria-hidden className="mt-[3px] shrink-0" />
        {advice}
      </p>

      <p className="mt-2 text-[10px] font-semibold leading-4 text-emerald-900/55">{t.weather.baselineNote}</p>
    </Card>
  );
}
