"use client";

import {
  Check,
  Circle,
  CloudRain,
  Clock,
  Droplets,
  Info,
  Thermometer,
  Waves,
  Wind,
} from "lucide-react";
import Sheet from "@/components/app/Sheet";
import type {
  DayPoint,
  Et0Breakdown,
  HourPoint,
  IrrigationResult,
  WeatherSnapshot,
} from "@/lib/agronomy";
import {
  ET0_ADVISE_MM_DAY,
  HEAT_THRESHOLD_C,
  SYSTEM_EFFICIENCY,
  WIND_THRESHOLD_KPH,
  referenceEt0Detail,
} from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { CROPS, SOILS, getWilaya, type CropKey, type Lang, type SoilKey } from "@/lib/wilayas";
import { fmt } from "./WeatherCard";
import { Chip, Metric } from "./parts";

/**
 * Irrigation-window detail sheet, opened from the "نافذة السقي" tile in the
 * hero decision card.
 *
 * Real data only — everything shown here is derived from the exact same
 * sources the dashboard already uses:
 *   - `WeatherSnapshot` (wilaya baseline + deterministic hourly/7-day series,
 *     the same values WeatherCard renders), and
 *   - `IrrigationResult` + `referenceEt0Detail` (the actual intermediate
 *     values of the existing `computeIrrigation` formula — no re-derivation,
 *     no new numbers).
 *
 * Granularity honesty: temperature and rain probability have 6 hourly + 7
 * daily points in the current source; humidity and wind exist only as a
 * single wilaya baseline value, so they are shown as single values with an
 * explicit "no time series" note instead of a fabricated chart.
 */
export default function IrrigationWindowSheet({
  open,
  onClose,
  t,
  lang,
  wilayaCode,
  crop,
  soil,
  areaHa,
  weather,
  irrigation,
}: {
  open: boolean;
  onClose: () => void;
  t: DashboardCopy;
  lang: Lang;
  wilayaCode: string;
  crop: CropKey;
  soil: SoilKey;
  areaHa: number;
  weather: WeatherSnapshot;
  irrigation: IrrigationResult;
}) {
  const d = t.windowDetail;
  const wilaya = getWilaya(wilayaCode);
  const wilayaName = lang === "ar" ? wilaya.nameAr : wilaya.nameFr;
  const cropName = CROPS[crop][lang];
  const soilName = SOILS[soil][lang];
  const systemName = t.irrigation.systems.drip; // the hero decision is computed for the drip system

  /* ---------------- Real inputs, exactly as the dashboard uses them ---------------- */

  const et0: Et0Breakdown = referenceEt0Detail(wilaya.climate);
  const { tempC, humidity, windKph, rainMmYear, hours, days } = weather;
  const { netMmDay, litresPerHaDay, dailyM3, weeklyM3, kc, soilFactor, efficiency, grossMmDay } =
    irrigation;

  // Same cascade WeatherCard uses to pick its advice (thresholds shared from agronomy.ts).
  const hot = tempC >= HEAT_THRESHOLD_C;
  const windy = windKph >= WIND_THRESHOLD_KPH;
  const dry = weather.et0 >= ET0_ADVISE_MM_DAY;
  const activeRule = hot ? "heat" : windy ? "wind" : dry ? "et0" : "calm";

  const effPct = Math.round(SYSTEM_EFFICIENCY.drip * 100);

  const fill = (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (match, key: string) =>
      key in values ? String(values[key]) : match,
    );

  const stepEt0Formula = fill(d.stepEt0Formula, {
    temp: fmt(tempC),
    damp: fmt(et0.humidityDamping, 3),
    windFactor: fmt(et0.windBoost, 3),
    raw: fmt(et0.raw, 2),
  });
  const stepEt0Note = fill(d.stepEt0Note, {
    damp: fmt(et0.humidityDamping, 3),
    windFactor: fmt(et0.windBoost, 3),
    et0: fmt(et0.final, 1),
  });
  const stepNetFormula = fill(d.stepNetFormula, {
    et0: fmt(et0.final, 1),
    kc: fmt(kc, 2),
    crop: cropName,
    soilFactor: fmt(soilFactor, 2),
    soil: soilName,
    net: fmt(netMmDay, 2),
  });
  const stepGrossFormula = fill(d.stepGrossFormula, {
    net: fmt(netMmDay, 2),
    efficiency: fmt(efficiency, 2),
    system: systemName,
    gross: fmt(grossMmDay, 2),
  });
  const stepGrossNote = fill(d.stepGrossNote, { system: systemName, effPct });
  const stepVolumeFormula = fill(d.stepVolumeFormula, {
    gross: fmt(grossMmDay, 2),
    litres: fmt(litresPerHaDay),
  });
  const stepParcelFormula = fill(d.stepParcelFormula, {
    gross: fmt(grossMmDay, 2),
    area: fmt(areaHa, 1),
    daily: fmt(dailyM3, 1),
  });
  const stepVolumeNote = fill(d.stepVolumeNote, { weekly: fmt(weeklyM3) });

  const rules = [
    { id: "heat", title: d.ruleHeatTitle, text: fill(d.ruleHeatText, { temp: fmt(tempC) }) },
    { id: "wind", title: d.ruleWindTitle, text: fill(d.ruleWindText, { wind: fmt(windKph) }) },
    { id: "et0", title: d.ruleEt0Title, text: fill(d.ruleEt0Text, { et0: fmt(weather.et0, 1) }) },
    { id: "calm", title: d.ruleCalmTitle, text: d.ruleCalmText },
  ] as const;

  return (
    <Sheet open={open} onClose={onClose} title={d.title} subtitle={d.subtitle} lang={lang}>
      <div className="flex flex-col gap-5">
        {/* Decision recap — the two numbers the hero promotes, verbatim */}
        <div className="grid grid-cols-2 gap-2">
          <div className="app-tile rounded-[1rem] px-3 py-2.5">
            <p className="flex items-center gap-1 text-[10.5px] font-bold tracking-wide text-emerald-800/65">
              <Clock size={11} strokeWidth={2.8} aria-hidden />
              {d.windowLabel}
            </p>
            <p dir="ltr" className="mt-1 text-[15px] font-black tabular-nums text-emerald-950">
              {t.hero.windowValue}
            </p>
          </div>
          <div className="app-tile rounded-[1rem] px-3 py-2.5">
            <p className="flex items-center gap-1 text-[10.5px] font-bold tracking-wide text-emerald-800/65">
              <Waves size={11} strokeWidth={2.8} aria-hidden />
              {d.volumeLabel}
            </p>
            <p className="mt-1 text-[15px] font-black tabular-nums text-emerald-950">
              <span dir="ltr">{fmt(dailyM3, 1)}</span> m³
            </p>
            <p className="mt-0.5 text-[10.5px] font-bold text-emerald-800/60">
              {d.perHaLabel} · <span dir="ltr" className="tabular-nums">{fmt(litresPerHaDay)} L</span>
            </p>
          </div>
        </div>

        {/* Why the early-morning window — the app's real advisory rules, evaluated live */}
        <section aria-label={d.whyTitle} className="flex flex-col gap-2.5">
          <h3 className="px-1 text-[12px] font-black tracking-wide text-emerald-800/65">
            {d.whyTitle}
          </h3>
          <p className="px-1 text-[11.5px] font-semibold leading-[1.7] text-emerald-900/65">
            {fill(d.windowFixed, { window: t.hero.windowValue })}
          </p>
          <div className="flex flex-col gap-1.5">
            {rules.map((rule) => {
              const active = rule.id === activeRule;
              return (
                <div
                  key={rule.id}
                  className={`flex items-start gap-2.5 rounded-[1rem] p-3 ring-1 ${
                    active
                      ? "bg-emerald-50 ring-emerald-200"
                      : "bg-[#f6faf7] ring-[rgba(6,78,59,0.07)] opacity-75"
                  }`}
                >
                  <span className={`mt-[2px] shrink-0 ${active ? "text-emerald-600" : "text-emerald-900/30"}`}>
                    {active ? (
                      <Check size={16} strokeWidth={3} aria-hidden />
                    ) : (
                      <Circle size={14} strokeWidth={2.4} aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 text-[12.5px] font-black text-emerald-950">
                      {rule.title}
                      {active && <Chip tone="emerald">{d.activeRule}</Chip>}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] font-semibold leading-[1.7] text-emerald-900/65">
                      {rule.text}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="px-1 text-[10.5px] font-semibold leading-5 text-emerald-900/50">{d.rulesNote}</p>
        </section>

        {/* The real inputs — same series/values WeatherCard shows, with honest granularity */}
        <section aria-label={d.dataTitle} className="flex flex-col gap-2.5">
          <h3 className="px-1 text-[12px] font-black tracking-wide text-emerald-800/65">
            {d.dataTitle}
          </h3>
          <p className="px-1 text-[11.5px] font-semibold leading-[1.7] text-emerald-900/65">
            {fill(d.dataNote, { wilaya: wilayaName })}
          </p>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <figure className="app-tile m-0 flex flex-col gap-1.5 rounded-[1rem] p-3">
              <figcaption className="flex items-center gap-1.5 text-[11.5px] font-black text-emerald-900">
                <Thermometer size={13} strokeWidth={2.6} aria-hidden className="text-emerald-600" />
                {d.hoursTempTitle}
              </figcaption>
              <HourTempChart hours={hours} label={`${d.hoursTempTitle} (${wilayaName})`} />
              <p className="text-[10px] font-bold leading-4 text-emerald-900/50">{d.hoursTempNote}</p>
            </figure>

            <figure className="app-tile m-0 flex flex-col gap-1.5 rounded-[1rem] p-3">
              <figcaption className="flex items-center gap-1.5 text-[11.5px] font-black text-emerald-900">
                <CloudRain size={13} strokeWidth={2.6} aria-hidden className="text-emerald-600" />
                {d.hoursRainTitle}
              </figcaption>
              <HourRainChart hours={hours} label={`${d.hoursRainTitle} (${wilayaName})`} />
              <p className="text-[10px] font-bold leading-4 text-emerald-900/50">{d.hoursRainNote}</p>
            </figure>
          </div>

          <figure className="app-tile m-0 flex flex-col gap-1.5 rounded-[1rem] p-3">
            <figcaption className="flex items-center gap-1.5 text-[11.5px] font-black text-emerald-900">
              <Thermometer size={13} strokeWidth={2.6} aria-hidden className="text-emerald-600" />
              {d.weekTempTitle}
            </figcaption>
            <WeekRangeChart days={days} dayLabels={t.weather.dayLabels} label={`${d.weekTempTitle} (${wilayaName})`} />
            <p className="text-[10px] font-bold leading-4 text-emerald-900/50">{d.weekTempNote}</p>
          </figure>

          <div className="flex flex-col gap-1.5">
            <p className="px-1 text-[11.5px] font-black text-emerald-900">{d.singleTitle}</p>
            <p className="px-1 text-[10.5px] font-semibold leading-[1.7] text-emerald-900/55">
              {d.singleNote}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Metric
                label={d.tempRef}
                value={`${fmt(tempC)}°C`}
                icon={<Thermometer size={11} strokeWidth={2.8} aria-hidden />}
              />
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
            </div>
          </div>
        </section>

        {/* The calculation, step by step, with the exact numbers used */}
        <section aria-label={d.breakdownTitle} className="flex flex-col gap-2">
          <h3 className="px-1 text-[12px] font-black tracking-wide text-emerald-800/65">
            {d.breakdownTitle}
          </h3>

          <StepTile
            n="1"
            label={d.stepEt0Label}
            result={`${fmt(et0.final, 1)} mm`}
            formula={stepEt0Formula}
            note={stepEt0Note}
          />
          <StepTile
            n="2"
            label={d.stepNetLabel}
            result={`${fmt(netMmDay, 2)} mm`}
            formula={stepNetFormula}
            note={d.stepNetNote}
          />
          <StepTile
            n="3"
            label={d.stepGrossLabel}
            result={`${fmt(grossMmDay, 2)} mm`}
            formula={stepGrossFormula}
            note={stepGrossNote}
          />
          <StepTile
            n="4"
            label={d.stepVolumeLabel}
            result={`${fmt(dailyM3, 1)} m³`}
            formula={stepVolumeFormula}
            formula2={stepParcelFormula}
            note={stepVolumeNote}
          />
        </section>

        {/* Data-source honesty note */}
        <p className="flex items-start gap-2 rounded-[1.1rem] bg-[#f4f8f5] p-3.5 text-[10.5px] font-semibold leading-[1.8] text-emerald-900/60">
          <Info size={13} strokeWidth={2.6} aria-hidden className="mt-[3px] shrink-0 text-emerald-500" />
          {d.sourceNote}
        </p>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/*  Step tile — one numbered line of the real formula chain            */
/* ------------------------------------------------------------------ */

function StepTile({
  n,
  label,
  formula,
  formula2,
  note,
  result,
}: {
  n: string;
  label: string;
  formula: string;
  formula2?: string;
  note: string;
  result: string;
}) {
  return (
    <div className="app-tile rounded-[1rem] p-3">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-green-600 text-[11px] font-black text-white"
        >
          {n}
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] font-black text-emerald-950">{label}</p>
        <span dir="ltr" className="shrink-0 text-[12px] font-black tabular-nums text-emerald-700">
          {result}
        </span>
      </div>
      <p dir="ltr" className="mt-2 overflow-x-auto whitespace-nowrap px-0.5 font-mono text-[11px] font-semibold tabular-nums text-emerald-900/80">
        {formula}
        {formula2 && (
          <>
            <br />
            {formula2}
          </>
        )}
      </p>
      <p className="mt-1.5 px-0.5 text-[10.5px] font-semibold leading-[1.7] text-emerald-900/55">{note}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Charts — pure SVG, pinned LTR (time axis always reads left→right), */
/*  fed exclusively from the WeatherSnapshot the app already renders.  */
/* ------------------------------------------------------------------ */

const CHART_W = 300;

function HourTempChart({ hours, label }: { hours: HourPoint[]; label: string }) {
  const H = 96;
  const PX = 20;
  const PY_TOP = 18;
  const PY_BOTTOM = 20;
  const values = hours.map((h) => h.tempC);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => PX + (i / Math.max(hours.length - 1, 1)) * (CHART_W - 2 * PX);
  const y = (v: number) => H - PY_BOTTOM - ((v - min) / span) * (H - PY_TOP - PY_BOTTOM);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${H}`}
      role="img"
      aria-label={label}
      className="w-full"
    >
      <polygon points={`0,${H - PY_BOTTOM} ${pts.join(" ")} ${CHART_W},${H - PY_BOTTOM}`} fill="rgba(16,185,129,0.16)" />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="#10b981"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {values.map((v, i) => (
        <g key={hours[i].label}>
          <circle cx={x(i)} cy={y(v)} r={2.6} fill="#10b981" />
          <text
            x={x(i)}
            y={y(v) - 6}
            textAnchor="middle"
            fontSize="9.5"
            fontWeight={800}
            fill="#064e3b"
          >
            {fmt(v, 0)}°
          </text>
          <text x={x(i)} y={H - 6} textAnchor="middle" fontSize="9.5" fontWeight={700} fill="rgba(6,78,59,0.55)">
            {hours[i].label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function HourRainChart({ hours, label }: { hours: HourPoint[]; label: string }) {
  const H = 96;
  const PX = 16;
  const PY_TOP = 16;
  const PY_BOTTOM = 20;
  const values = hours.map((h) => h.rainPct);
  const max = Math.max(...values, 1);
  const slot = (CHART_W - 2 * PX) / hours.length;
  const barW = Math.min(26, slot * 0.55);

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${H}`}
      role="img"
      aria-label={label}
      className="w-full"
    >
      {values.map((v, i) => {
        const cx = PX + slot * i + slot / 2;
        const hBar = (v / max) * (H - PY_TOP - PY_BOTTOM);
        const yBar = H - PY_BOTTOM - hBar;
        return (
          <g key={hours[i].label}>
            <rect
              x={cx - barW / 2}
              y={yBar}
              width={barW}
              height={Math.max(hBar, 1.5)}
              rx={3}
              fill={v >= 50 ? "#f59e0b" : "rgba(245,158,11,0.55)"}
            />
            <text x={cx} y={yBar - 5} textAnchor="middle" fontSize="9.5" fontWeight={800} fill="#064e3b">
              {fmt(v)}%
            </text>
            <text x={cx} y={H - 6} textAnchor="middle" fontSize="9.5" fontWeight={700} fill="rgba(6,78,59,0.55)">
              {hours[i].label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function WeekRangeChart({
  days,
  dayLabels,
  label,
}: {
  days: DayPoint[];
  dayLabels: readonly string[];
  label: string;
}) {
  const H = 104;
  const PX = 12;
  const PY_TOP = 16;
  const PY_BOTTOM = 20;
  const mins = days.map((d) => d.minC);
  const maxs = days.map((d) => d.maxC);
  const lo = Math.min(...mins);
  const hi = Math.max(...maxs);
  const span = hi - lo || 1;
  const y = (v: number) => H - PY_BOTTOM - ((v - lo) / span) * (H - PY_TOP - PY_BOTTOM);
  const slot = (CHART_W - 2 * PX) / days.length;
  const barW = Math.min(14, slot * 0.42);

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${H}`}
      role="img"
      aria-label={label}
      className="w-full"
    >
      {days.map((day, i) => {
        const cx = PX + slot * i + slot / 2;
        const yTop = y(day.maxC);
        const yBottom = y(day.minC);
        return (
          <g key={day.labelKey}>
            <line x1={cx} x2={cx} y1={yTop} y2={yBottom} stroke="#10b981" strokeWidth={barW} strokeLinecap="round" opacity={0.55} />
            <circle cx={cx} cy={yTop} r={2.4} fill="#059669" />
            <circle cx={cx} cy={yBottom} r={2.4} fill="#a7f3d0" />
            <text x={cx} y={yTop - 5} textAnchor="middle" fontSize="9" fontWeight={800} fill="#064e3b">
              {fmt(day.maxC)}°
            </text>
            {/* Min sits beside the low dot so it never collides with the day label. */}
            <text x={cx + barW / 2 + 3} y={yBottom + 3} textAnchor="start" fontSize="8.5" fontWeight={700} fill="rgba(6,78,59,0.6)">
              {fmt(day.minC)}°
            </text>
            <text x={cx} y={H - 6} textAnchor="middle" fontSize="9.5" fontWeight={700} fill="rgba(6,78,59,0.55)">
              {dayLabels[day.labelKey]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
