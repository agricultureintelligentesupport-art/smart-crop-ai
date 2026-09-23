"use client";

import { Satellite, TrendingUp } from "lucide-react";
import { ndviBand, ndviFor, type NdviReading } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { CROPS, type CropKey, type Lang } from "@/lib/wilayas";
import { fmt } from "./WeatherCard";
import { Card, Chip, Progress, Sparkline } from "./parts";

const BAND_TONE = {
  poor: "amber",
  fair: "amber",
  good: "emerald",
  excellent: "emerald",
} as const;

export default function SatelliteCard({
  t,
  lang,
  wilayaCode,
  crop,
}: {
  t: DashboardCopy;
  lang: Lang;
  wilayaCode: string;
  crop?: CropKey;
}) {
  const reading: NdviReading = ndviFor(wilayaCode, crop ?? "wheat");
  const band = ndviBand(reading.value);
  const cropLabel = crop ? CROPS[crop][lang] : undefined;

  return (
    <Card
      title={t.satellite.title}
      subtitle={cropLabel ? `${t.satellite.subtitle} · ${cropLabel}` : t.satellite.subtitle}
      icon={<Satellite size={18} strokeWidth={2.4} aria-hidden />}
      aside={
        <Chip tone={BAND_TONE[band]} icon={<TrendingUp size={11} strokeWidth={3} aria-hidden />}>
          <span dir="ltr">{reading.trendPct >= 0 ? "+" : ""}{fmt(reading.trendPct)}%</span>
        </Chip>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11.5px] font-extrabold tracking-wide text-emerald-800/65">{t.satellite.value}</p>
            <p dir="ltr" className="mt-1 text-[30px] font-black leading-none tabular-nums text-emerald-950">
              {reading.value.toFixed(2)}
            </p>
          </div>
          <Chip tone={BAND_TONE[band]}>{t.satellite.bands[band]}</Chip>
        </div>

        <Sparkline
          values={reading.series}
          min={0.2}
          max={0.95}
          tone={band === "poor" || band === "fair" ? "amber" : "emerald"}
          label={t.satellite.trend}
        />

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[11.5px] font-bold text-emerald-800/85">
            <span>{t.satellite.stress}</span>
            <span dir="ltr">{fmt(reading.stressShare * 100)}%</span>
          </div>
          <Progress value={reading.stressShare * 100} tone={reading.stressShare > 0.25 ? "amber" : "emerald"} />
        </div>

        <p className="text-[10.5px] font-semibold leading-5 text-emerald-900/50">{t.satellite.note}</p>
      </div>
    </Card>
  );
}
