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
      <div className="flex flex-col gap-3">
        {/* Current conditions — compact hero strip */}
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-emerald-50/80 px-3 py-2.5 ring-1 ring-emerald-100">
          <div className="flex items-baseline gap-1">
            <span dir="ltr" className="text-[30px] font-black leading-none tracking-tight tabular-nums text-emerald-950">
              {fmt(tempC, 1)}°
            </span>
            <span dir="ltr" className="text-[12px] font-black text-emerald-700/70">C</span>
          </div>
          <p className="max-w-[55%] text-end text-[10.5px] font-bold leading-4 text-emerald-800/75">
            {hot ? t.weather.adviceHeat : windy ? t.weather.adviceWind : t.weather.now}
          </p>
        </div>

        {/* 2×2 metric widget grid */}
        <div className="grid grid-cols-2 gap-2">
          <Metric
            label={t.weather.humidity}
            value={`${fmt(humidity)}%`}
            tint="sky"
            icon={<Droplets size={14} strokeWidth={2.6} aria-hidden />}
          />
          <Metric
            label={t.weather.wind}
            value={`${fmt(windKph)} km/h`}
            tone={windy ? "warn" : "default"}
            tint="emerald"
            icon={<Wind size={14} strokeWidth={2.6} aria-hidden />}
          />
          <Metric
            label={t.weather.rain}
            value={`${fmt(rainMmYear)} mm`}
            tint="blue"
            icon={<CloudRain size={14} strokeWidth={2.6} aria-hidden />}
          />
          <Metric
            label={t.weather.et0}
            value={`${fmt(et0, 1)} mm`}
            tint="amber"
            icon={<Waves size={14} strokeWidth={2.6} aria-hidden />}
          />
        </div>

        {/* Hourly forecast — horizontal snap carousel, "now" highlighted */}
        <div>
          <p className="text-[11px] font-black text-emerald-800">{t.weather.hourLabel}</p>
          <div className="no-scrollbar -mx-1 mt-1.5 overflow-x-auto px-1">
            <ul className="flex min-w-max snap-x gap-1.5">
              {hours.map((hour, i) => {
                const active = i === 0;
                return (
                  <li
                    key={hour.label}
                    title={t.weather.rainChance.replace("{n}", String(hour.rainPct))}
                    className={`flex w-[58px] shrink-0 snap-start flex-col items-center gap-0.5 rounded-2xl py-2 ring-1 transition-colors ${
                      active
                        ? "bg-emerald-500/10 ring-emerald-500/45"
                        : "bg-white/70 ring-[#E2F1E8]"
                    }`}
                  >
                    <span dir="ltr" className={`text-[10px] font-black tabular-nums ${active ? "text-emerald-700" : "text-emerald-800/70"}`}>
                      {hour.label}
                    </span>
                    <span dir="ltr" className="text-[13px] font-black tabular-nums text-emerald-950">
                      {fmt(hour.tempC, 0)}°
                    </span>
                    <span dir="ltr" className="text-[9px] font-bold tabular-nums text-emerald-700/70">
                      {fmt(hour.rainPct)}%
                    </span>
                    <span
                      aria-hidden
                      className={`h-1 w-1 rounded-full ${active ? "bg-emerald-500" : "bg-transparent"}`}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        {/* Weekly forecast — horizontal carousel, "today" highlighted */}
        <div>
          <p className="text-[11px] font-black text-emerald-800">{t.weather.days}</p>
          <div className="no-scrollbar -mx-1 mt-1.5 overflow-x-auto px-1">
            <ul className="flex min-w-max snap-x gap-1.5">
              {days.map((day, i) => {
                const active = i === 0;
                return (
                  <li
                    key={day.labelKey}
                    className={`flex w-[54px] shrink-0 snap-start flex-col items-center gap-0.5 rounded-2xl px-1 py-2 ring-1 transition-colors ${
                      active
                        ? "bg-emerald-500/10 ring-emerald-500/45"
                        : "bg-white/70 ring-[#E2F1E8]"
                    }`}
                  >
                    <span className={`truncate text-[10px] font-black ${active ? "text-emerald-700" : "text-emerald-800/80"}`}>
                      {t.weather.dayLabels[day.labelKey]}
                    </span>
                    <span dir="ltr" className="text-[13px] font-black tabular-nums text-emerald-950">
                      {fmt(day.maxC)}°
                    </span>
                    <span dir="ltr" className="text-[9.5px] font-bold tabular-nums text-emerald-800/60">
                      {fmt(day.minC)}°
                    </span>
                    <span dir="ltr" className="text-[9.5px] font-bold tabular-nums text-emerald-600">
                      {fmt(day.rainPct)}%
                    </span>
                    <span
                      aria-hidden
                      className={`h-1 w-1 rounded-full ${active ? "bg-emerald-500" : "bg-transparent"}`}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <p
          className={`flex items-start gap-1.5 rounded-2xl px-2.5 py-2 text-[11px] font-bold leading-5 ${
            hot || windy ? "bg-amber-50/90 text-amber-900 ring-1 ring-amber-200" : "bg-emerald-50/80 text-emerald-900 ring-1 ring-emerald-200/70"
          }`}
        >
          <TriangleAlert size={13} strokeWidth={2.6} aria-hidden className="mt-[3px] shrink-0" />
          {advice}
        </p>

        <p className="text-[10px] font-semibold leading-4 text-emerald-900/55">{t.weather.baselineNote}</p>
      </div>
    </Card>
  );
}
