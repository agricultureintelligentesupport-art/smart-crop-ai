"use client";

import { Droplet, Droplets, Minus, Plus, Ruler, Sprout, Waves } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { computeIrrigation, weatherFor, type IrrigationSystem, type WeatherSnapshot } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { CROPS, SOILS, WILAYA_BY_CODE, getWilaya, type CropKey, type Lang, type SoilKey } from "@/lib/wilayas";
import { FOCUS_RING } from "@/components/auth/ui";
import { fmt } from "./WeatherCard";
import { Card, Metric, Segmented } from "./parts";

const ALL_CROPS = Object.keys(CROPS) as CropKey[];
const ALL_SOILS = Object.keys(SOILS) as SoilKey[];

export default function IrrigationCard({
  t,
  lang,
  wilayaCode,
  areaHa,
  onAreaChange,
  weather,
}: {
  t: DashboardCopy;
  lang: Lang;
  wilayaCode: string;
  /** Parcel size lives in the dashboard so every card and the advice line agree. */
  areaHa: number;
  onAreaChange: (area: number) => void;
  /** Live (or reference) snapshot shared by the dashboard; falls back to the
      static reference values when not provided. */
  weather?: WeatherSnapshot;
}) {
  const wilaya = getWilaya(wilayaCode);
  const [crop, setCrop] = useState<CropKey>(wilaya.crops[0]);
  const [soil, setSoil] = useState<SoilKey>(wilaya.soil);
  const [system, setSystem] = useState<IrrigationSystem>("drip");

  // Keep the defaults aligned when the user switches wilaya.
  const [seed, setSeed] = useState(wilayaCode);
  if (seed !== wilayaCode) {
    setSeed(wilayaCode);
    setCrop(WILAYA_BY_CODE[wilayaCode]?.crops[0] ?? wilaya.crops[0]);
    setSoil(WILAYA_BY_CODE[wilayaCode]?.soil ?? wilaya.soil);
  }

  const result = useMemo(
    () => computeIrrigation({ wilayaCode, crop, areaHa, soil, system, weather: weather ?? weatherFor(wilayaCode) }),
    [wilayaCode, crop, areaHa, soil, system, weather],
  );

  const cropOptions = useMemo(() => {
    const local = wilaya.crops;
    const rest = ALL_CROPS.filter((c) => !local.includes(c));
    return [...local, ...rest];
  }, [wilaya.crops]);

  // Direction-aware slider fill (the track reads from the start edge).
  const fill = `${Math.round(((areaHa - 0.5) / 19.5) * 100)}%`;
  const rangeStyle = {
    "--range-from": lang === "ar" ? "left" : "right",
    "--range-fill": fill,
  } as CSSProperties;

  const stepper = `grid h-11 w-11 shrink-0 place-items-center rounded-[0.9rem] border border-[rgba(6,78,59,0.09)] bg-white text-emerald-800 transition-colors hover:border-emerald-300 active:scale-95 ${FOCUS_RING}`;

  return (
    <Card
      title={t.irrigation.title}
      subtitle={t.irrigation.subtitle}
      icon={<Droplets size={18} strokeWidth={2.4} aria-hidden />}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-emerald-900">
            <Sprout size={14} strokeWidth={2.6} aria-hidden className="text-emerald-600" />
            {t.irrigation.crop}
          </span>
          <select
            value={crop}
            onChange={(e) => setCrop(e.target.value as CropKey)}
            className="field-input h-12 px-3.5 text-[15px]"
          >
            {cropOptions.map((key) => (
              <option key={key} value={key}>
                {CROPS[key][lang]}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[12.5px] font-extrabold text-emerald-900">
              <Ruler size={14} strokeWidth={2.6} aria-hidden className="text-emerald-600" />
              {t.irrigation.area}
            </span>
            <span dir="ltr" className="text-[13px] font-black tabular-nums text-emerald-700">
              {fmt(areaHa, 1)} {t.irrigation.areaUnit}
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => onAreaChange(Math.max(0.5, Math.round((areaHa - 0.5) * 2) / 2))}
              aria-label={`${t.irrigation.area} −`}
              className={stepper}
            >
              <Minus size={17} strokeWidth={3} aria-hidden />
            </button>
            <input
              type="range"
              min={0.5}
              max={20}
              step={0.5}
              value={areaHa}
              onChange={(e) => onAreaChange(Number(e.target.value))}
              aria-label={t.irrigation.area}
              aria-valuetext={`${fmt(areaHa, 1)} ${t.irrigation.areaUnit}`}
              style={rangeStyle}
              className="range-native"
            />
            <button
              type="button"
              onClick={() => onAreaChange(Math.min(20, Math.round((areaHa + 0.5) * 2) / 2))}
              aria-label={`${t.irrigation.area} +`}
              className={stepper}
            >
              <Plus size={17} strokeWidth={3} aria-hidden />
            </button>
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-extrabold text-emerald-900">{t.irrigation.soil}</span>
          <select
            value={soil}
            onChange={(e) => setSoil(e.target.value as SoilKey)}
            className="field-input h-12 px-3.5 text-[15px]"
          >
            {ALL_SOILS.map((key) => (
              <option key={key} value={key}>
                {SOILS[key][lang]}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-extrabold text-emerald-900">{t.irrigation.system}</span>
          <Segmented<IrrigationSystem>
            layoutId="dash-irrigation-system"
            ariaLabel={t.irrigation.system}
            value={system}
            onChange={setSystem}
            options={[
              { id: "drip", label: t.irrigation.systems.drip },
              { id: "sprinkler", label: t.irrigation.systems.sprinkler },
              { id: "furrow", label: t.irrigation.systems.furrow },
            ]}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Metric
            label={t.irrigation.perHectare}
            value={`${fmt(result.litresPerHaDay)} L`}
            icon={<Droplet size={11} strokeWidth={2.8} aria-hidden />}
          />
          <Metric
            label={t.irrigation.perDay}
            value={`${fmt(result.dailyM3, 1)} m³`}
            icon={<Waves size={11} strokeWidth={2.8} aria-hidden />}
          />
          <Metric
            label={t.irrigation.perWeek}
            value={`${fmt(result.weeklyM3)} m³`}
            icon={<Waves size={11} strokeWidth={2.8} aria-hidden />}
          />
          <Metric
            label={t.irrigation.saved}
            value={`${fmt(result.savedPct)}%`}
            tone={result.savedPct >= 30 ? "default" : "warn"}
            icon={<Droplets size={11} strokeWidth={2.8} aria-hidden />}
          />
        </div>

        <p className="px-1 text-[10.5px] font-semibold leading-5 text-emerald-900/55">
          {t.irrigation.savedCaption} · <span dir="ltr">{fmt(result.savedLitresPerDay)} L</span> ·{" "}
          {t.irrigation.formulaNote}
        </p>
      </div>
    </Card>
  );
}
