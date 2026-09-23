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

/** Live glowing pulse dot for the active NDVI band badge. */
function PulseDot({ tone }: { tone: "emerald" | "amber" }) {
  const dot = tone === "emerald" ? "bg-emerald-500" : "bg-amber-500";
  const ping = tone === "emerald" ? "bg-emerald-400" : "bg-amber-400";
  return (
    <span aria-hidden className="relative flex h-2 w-2">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${ping}`} />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
    </span>
  );
}

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
  const tone = BAND_TONE[band];

  return (
    <Card
      title={t.satellite.title}
      subtitle={cropLabel ? `${t.satellite.subtitle} · ${cropLabel}` : t.satellite.subtitle}
      icon={<Satellite size={17} strokeWidth={2.4} aria-hidden />}
      aside={
        <Chip tone={tone} icon={<TrendingUp size={11} strokeWidth={3} aria-hidden />}>
          <span dir="ltr">{reading.trendPct >= 0 ? "+" : ""}{fmt(reading.trendPct)}%</span>
        </Chip>
      }
    >
      {/* Value + glowing band badge beside the mini sparkline */}
      <div className="flex items-center justify-between gap-3">
        <div className="shrink-0">
          <p className="text-[10.5px] font-bold text-emerald-800/70">{t.satellite.value}</p>
          <p dir="ltr" className="text-[28px] font-black leading-none tracking-tight tabular-nums text-emerald-950">
            {reading.value.toFixed(2)}
          </p>
          <span className="mt-1.5 inline-flex">
            <Chip tone={tone}>
              <PulseDot tone={tone} />
              {t.satellite.bands[band]}
            </Chip>
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <Sparkline
            values={reading.series}
            min={0.2}
            max={0.95}
            tone={band === "poor" || band === "fair" ? "amber" : "emerald"}
            label={t.satellite.trend}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <div className="flex items-center justify-between text-[10.5px] font-bold text-emerald-800">
          <span>{t.satellite.stress}</span>
          <span dir="ltr">{fmt(reading.stressShare * 100)}%</span>
        </div>
        <Progress value={reading.stressShare * 100} tone={reading.stressShare > 0.25 ? "amber" : "emerald"} />
      </div>

      <p className="mt-2 text-[10px] font-semibold leading-4 text-emerald-900/55">{t.satellite.note}</p>
    </Card>
  );
}
