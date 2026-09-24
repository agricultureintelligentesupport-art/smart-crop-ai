"use client";

import { motion, useInView, useReducedMotion } from "framer-motion";
import {
  Check,
  ChevronDown,
  CloudRain,
  Clock,
  Droplets,
  Info,
  Thermometer,
  TrendingDown,
  TrendingUp,
  Waves,
  Wind,
} from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import Sheet from "@/components/app/Sheet";
import type {
  DayPoint,
  Et0Breakdown,
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
import type { WeatherSource } from "@/lib/weather/useLiveWeather";
import { fmt } from "./WeatherCard";

/**
 * Irrigation-window detail sheet, opened from the "نافذة السقي" tile in the
 * hero decision card.
 *
 * Real data only — everything shown here is derived from the exact same
 * sources the dashboard already uses:
 *   - `WeatherSnapshot` — live Open-Meteo forecast when the fetch succeeds
 *     (6 hourly temp/rain/humidity/wind points + 7 daily ranges, the same
 *     values WeatherCard renders), otherwise the deterministic wilaya
 *     reference series as a clearly-labelled fallback; and
 *   - `IrrigationResult` + `referenceEt0Detail` (the actual intermediate
 *     values of the existing `computeIrrigation` formula — no re-derivation,
 *     no new numbers).
 *
 * Granularity honesty: in reference mode humidity/wind have no hourly series,
 * so they are shown as single values with an explicit "no time series" note.
 * In live mode the real hourly humidity/wind forecast is charted instead,
 * and the notes say exactly which source is being shown.
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
  source,
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
  /** Where `weather`'s numbers come from (drives copy + the live-only charts). */
  source: WeatherSource;
}) {
  const d = t.windowDetail;
  const isLive = source === "live";
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
    {
      id: "heat",
      title: d.ruleHeatTitle,
      text: fill(d.ruleHeatText, { temp: fmt(tempC) }),
      condition: d.ruleHeatCondition,
    },
    {
      id: "wind",
      title: d.ruleWindTitle,
      text: fill(d.ruleWindText, { wind: fmt(windKph) }),
      condition: d.ruleWindCondition,
    },
    {
      id: "et0",
      title: d.ruleEt0Title,
      text: fill(d.ruleEt0Text, { et0: fmt(weather.et0, 1) }),
      condition: d.ruleEt0Condition,
    },
    { id: "calm", title: d.ruleCalmTitle, text: d.ruleCalmText, condition: d.ruleCalmCondition },
  ] as const;

  // Micro trend indicators: direction of the real hourly series (last vs first
  // point of the same `hours` array the charts draw). Purely visual — no new numbers.
  const trendOf = (pick: (h: WeatherSnapshot["hours"][number]) => number | null | undefined) => {
    const series = hours.map(pick).filter((v): v is number => typeof v === "number");
    if (series.length < 2) return 0;
    return Math.sign(series[series.length - 1] - series[0]);
  };
  const tempTrend = trendOf((h) => h.tempC);
  const humidityTrend = isLive ? trendOf((h) => h.humidity) : 0;
  const windTrend = isLive ? trendOf((h) => h.windKph) : 0;
  const peak = (value: string) => fill(d.peakLabel, { value });

  return (
    <Sheet open={open} onClose={onClose} title={d.title} subtitle={d.subtitle} lang={lang}>
      <div className="flex flex-col gap-5">
        {/* Decision recap — the two numbers the hero promotes, verbatim */}
        <Reveal index={0} className="grid grid-cols-2 gap-2">
          <div className={GLASS_TILE}>
            <p className="flex items-center gap-1 text-[10.5px] font-bold tracking-wide text-emerald-800/65">
              <Clock size={11} strokeWidth={2.8} aria-hidden />
              {d.windowLabel}
            </p>
            <p dir="ltr" className="mt-1 text-[15px] font-black tabular-nums text-emerald-950">
              {t.hero.windowValue}
            </p>
          </div>
          <div className={GLASS_TILE}>
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
        </Reveal>

        {/* Why the early-morning window — the app's real advisory rules, evaluated live */}
        <Reveal as="section" index={1} aria-label={d.whyTitle} className="flex flex-col gap-2.5">
          <h3 className="px-1 text-[12px] font-black tracking-wide text-emerald-800/85">
            {d.whyTitle}
          </h3>
          <p className="px-1 text-[11.5px] font-semibold leading-[1.7] text-emerald-900/80">
            {fill(d.windowFixed, { window: t.hero.windowValue })}
          </p>
          <DecisionRules d={d} rules={rules} activeRule={activeRule} />
        </Reveal>

        {/* The real inputs — same series/values WeatherCard shows, with honest granularity */}
        <Reveal as="section" index={2} aria-label={d.dataTitle} className="flex flex-col gap-2.5">
          <h3 className="px-1 text-[12px] font-black tracking-wide text-emerald-800/65">
            {d.dataTitle}
          </h3>
          <p className="px-1 text-[11.5px] font-semibold leading-[1.7] text-emerald-900/65">
            {isLive ? fill(d.dataNoteLive, { wilaya: wilayaName }) : fill(d.dataNote, { wilaya: wilayaName })}
          </p>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <ChartFigure
              index={0}
              title={d.hoursTempTitle}
              tone="heat"
              icon={<Thermometer size={13} strokeWidth={2.6} aria-hidden />}
              note={isLive ? d.hoursLiveNote : d.hoursTempNote}
            >
              <HourLineChart
                points={hours.map((h) => ({ label: h.label, value: h.tempC }))}
                format={(v) => `${fmt(v, 0)}°`}
                tone="heat"
                label={`${d.hoursTempTitle} (${wilayaName})`}
                peakLabel={peak}
              />
            </ChartFigure>
            <ChartFigure
              index={1}
              title={d.hoursRainTitle}
              tone="rain"
              icon={<CloudRain size={13} strokeWidth={2.6} aria-hidden />}
              note={isLive ? d.hoursLiveNote : d.hoursRainNote}
            >
              <HourBarChart
                points={hours.map((h) => ({ label: h.label, value: h.rainPct }))}
                format={(v) => `${fmt(v)}%`}
                tone="rain"
                label={`${d.hoursRainTitle} (${wilayaName})`}
                peakLabel={peak}
              />
            </ChartFigure>
            {/* Live source only: real hourly humidity/wind forecasts exist then. */}
            {isLive && (
              <ChartFigure
                index={2}
                title={d.humidityChartTitle}
                tone="humidity"
                icon={<Droplets size={13} strokeWidth={2.6} aria-hidden />}
                note={d.hoursLiveNote}
              >
                <HourLineChart
                  points={hours.map((h) => ({ label: h.label, value: h.humidity ?? null }))}
                  format={(v) => `${fmt(v)}%`}
                  tone="humidity"
                  label={`${d.humidityChartTitle} (${wilayaName})`}
                  peakLabel={peak}
                />
              </ChartFigure>
            )}
            {isLive && (
              <ChartFigure
                index={3}
                title={d.windChartTitle}
                tone="wind"
                icon={<Wind size={13} strokeWidth={2.6} aria-hidden />}
                note={d.hoursLiveNote}
              >
                <HourBarChart
                  points={hours.map((h) => ({ label: h.label, value: h.windKph ?? null }))}
                  format={(v) => `${fmt(v)} km/h`}
                  tone="wind"
                  label={`${d.windChartTitle} (${wilayaName})`}
                  peakLabel={peak}
                />
              </ChartFigure>
            )}
          </div>

          <ChartFigure
            index={4}
            title={d.weekTempTitle}
            tone="heat"
            icon={<Thermometer size={13} strokeWidth={2.6} aria-hidden />}
            note={isLive ? d.weekTempNoteLive : d.weekTempNote}
          >
            <WeekRangeChart
              days={days}
              dayLabels={t.weather.dayLabels}
              label={`${d.weekTempTitle} (${wilayaName})`}
              peakLabel={peak}
            />
          </ChartFigure>

          <div className="flex flex-col gap-1.5">
            <p className="px-1 text-[11.5px] font-black text-emerald-900">{isLive ? d.singleTitleLive : d.singleTitle}</p>
            <p className="px-1 text-[10.5px] font-semibold leading-[1.7] text-emerald-900/55">
              {isLive ? d.singleNoteLive : d.singleNote}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <TrendMetric
                label={d.tempRef}
                value={`${fmt(tempC)}°C`}
                trend={tempTrend}
                icon={<Thermometer size={11} strokeWidth={2.8} aria-hidden />}
              />
              <TrendMetric
                label={t.weather.humidity}
                value={`${fmt(humidity)}%`}
                trend={humidityTrend}
                icon={<Droplets size={11} strokeWidth={2.8} aria-hidden />}
              />
              <TrendMetric
                label={t.weather.wind}
                value={`${fmt(windKph)} km/h`}
                trend={windTrend}
                tone={windy ? "warn" : "default"}
                icon={<Wind size={11} strokeWidth={2.8} aria-hidden />}
              />
              <TrendMetric
                label={t.weather.rain}
                value={`${fmt(rainMmYear)} mm`}
                trend={0}
                icon={<CloudRain size={11} strokeWidth={2.8} aria-hidden />}
              />
            </div>
          </div>
        </Reveal>

        {/* The calculation, step by step, with the exact numbers used */}
        <Reveal as="section" index={3} aria-label={d.breakdownTitle} className="flex flex-col gap-2">
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
        </Reveal>

        {/* Data-source note — says exactly which source is shown. */}
        <Reveal index={4}>
          <p className="flex items-start gap-2 rounded-[1.1rem] border border-emerald-500/10 bg-[#f4f8f5] p-3.5 text-[10.5px] font-semibold leading-[1.8] text-emerald-900/60">
            <Info size={13} strokeWidth={2.6} aria-hidden className="mt-[3px] shrink-0 text-emerald-500" />
            {isLive ? d.sourceNoteLive : d.sourceNote}
          </p>
        </Reveal>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/*  Decision rules — one active summary; secondary conditions on demand */
/* ------------------------------------------------------------------ */

type DecisionRuleId = "heat" | "wind" | "et0" | "calm";
type DecisionRule = { id: DecisionRuleId; title: string; text: string; condition: string };

function DecisionRules({
  d,
  rules,
  activeRule,
}: {
  d: DashboardCopy["windowDetail"];
  rules: readonly DecisionRule[];
  activeRule: DecisionRuleId;
}) {
  const [expanded, setExpanded] = useState(false);
  const otherRulesId = useId();
  // The same priority cascade as WeatherCard always picks one of these rules.
  const selected = rules.find((rule) => rule.id === activeRule)!;

  return (
    <div className="flex flex-col gap-1">
      <div
        role="group"
        aria-label={d.activeRule}
        className="rounded-[1rem] border border-emerald-200 bg-emerald-50 px-3.5 py-3"
      >
        <p className="text-[11px] font-bold text-emerald-800">{d.activeRule}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[14px] font-black text-emerald-950">
          {selected.title}
          <Check size={16} strokeWidth={3} aria-hidden className="shrink-0 text-emerald-700" />
        </p>
        <p className="mt-1 text-[12px] font-semibold leading-[1.7] text-emerald-900">{selected.text}</p>
      </div>

      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={otherRulesId}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-xl px-2.5 text-[12px] font-bold text-emerald-800 transition-colors hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 motion-reduce:transition-none"
      >
        {expanded ? d.otherRulesHide : d.otherRulesShow}
        <ChevronDown
          size={15}
          strokeWidth={2.4}
          aria-hidden
          className={`shrink-0 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      <div id={otherRulesId} hidden={!expanded} className="w-full">
        <ul className="divide-y divide-emerald-900/10 border-t border-emerald-900/10 px-1">
          {rules
            .filter((rule) => rule.id !== activeRule)
            .map((rule) => (
              <li key={rule.id} className="py-2.5">
                <p className="text-[12px] font-bold text-emerald-950">{rule.title}</p>
                <p className="mt-0.5 text-[11.5px] font-semibold leading-[1.7] text-emerald-900/75">
                  {rule.condition}
                </p>
              </li>
            ))}
        </ul>
        <p className="px-1 text-[10.5px] font-semibold leading-5 text-emerald-900/80">{d.rulesNote}</p>
      </div>
    </div>
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
    <div className={`${GLASS_TILE} p-3`}>
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-green-600 text-[11px] font-black text-white shadow-[0_4px_10px_-4px_rgba(16,185,129,0.8)]"
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
/*  `null` values (no data from the source) are drawn as gaps, never   */
/*  invented. Motion is presentational only: progressive path drawing, */
/*  bottom-up bar growth, pulsing peak nodes and tap-to-inspect tips.  */
/* ------------------------------------------------------------------ */

const CHART_W = 300;

interface SeriesPoint {
  label: string;
  value: number | null;
}

/**
 * Semantic chart tones — one palette per weather metric so every line, bar,
 * gradient, glow node and peak badge reads in its natural colour:
 *   heat     → warm amber / orange     (temperature, 7-day range)
 *   rain     → rain blue / sky         (rain probability)
 *   wind     → slate / steel-cyan      (wind speed)
 *   humidity → teal / cyan             (relative humidity)
 */
type Tone = "heat" | "rain" | "wind" | "humidity";

interface Palette {
  /** Primary stroke / dot colour. */
  stroke: string;
  /** Deeper end of gradients, peak node, badge fill. */
  deep: string;
  /** Lighter end of gradients (line start, bar top). */
  soft: string;
  /** Drop-shadow glow (rgba). */
  glow: string;
  /** Bar capsule: bottom → top. */
  barFrom: string;
  barTo: string;
  /** Emphasised ("hot" / peak) capsule: bottom → top. */
  hotFrom: string;
  hotTo: string;
  /** Peak badge (translucent container + tinted text + hairline border). */
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
  /** Tooltip value tint on the dark bubble. */
  tipText: string;
  /** Tailwind classes for the figure's icon chip. */
  iconClass: string;
}

const PALETTE: Record<Tone, Palette> = {
  heat: {
    stroke: "#f59e0b",
    deep: "#ea580c",
    soft: "#fbbf24",
    glow: "rgba(245,158,11,0.38)",
    barFrom: "rgba(245,158,11,0.25)",
    barTo: "#f59e0b",
    hotFrom: "#ea580c",
    hotTo: "#fbbf24",
    badgeBg: "rgba(245,158,11,0.12)",
    badgeText: "#d97706",
    badgeBorder: "rgba(245,158,11,0.3)",
    tipText: "#fde68a",
    iconClass: "bg-amber-500/10 text-amber-600",
  },
  rain: {
    stroke: "#3b82f6",
    deep: "#2563eb",
    soft: "#38bdf8",
    glow: "rgba(59,130,246,0.38)",
    barFrom: "rgba(59,130,246,0.25)",
    barTo: "#38bdf8",
    hotFrom: "#3b82f6",
    hotTo: "#38bdf8",
    badgeBg: "rgba(59,130,246,0.12)",
    badgeText: "#2563eb",
    badgeBorder: "rgba(59,130,246,0.3)",
    tipText: "#bae6fd",
    iconClass: "bg-blue-500/10 text-blue-600",
  },
  wind: {
    stroke: "#64748b",
    deep: "#0891b2",
    soft: "#94a3b8",
    glow: "rgba(8,145,178,0.32)",
    barFrom: "rgba(100,116,139,0.25)",
    barTo: "#64748b",
    hotFrom: "#64748b",
    hotTo: "#0891b2",
    badgeBg: "rgba(100,116,139,0.12)",
    badgeText: "#475569",
    badgeBorder: "rgba(100,116,139,0.3)",
    tipText: "#cffafe",
    iconClass: "bg-slate-500/10 text-slate-600",
  },
  humidity: {
    stroke: "#14b8a6",
    deep: "#0d9488",
    soft: "#22d3ee",
    glow: "rgba(20,184,166,0.38)",
    barFrom: "rgba(20,184,166,0.25)",
    barTo: "#14b8a6",
    hotFrom: "#14b8a6",
    hotTo: "#22d3ee",
    badgeBg: "rgba(20,184,166,0.12)",
    badgeText: "#0d9488",
    badgeBorder: "rgba(20,184,166,0.3)",
    tipText: "#99f6e4",
    iconClass: "bg-teal-500/10 text-teal-600",
  },
};

const DRAW_MS = 0.8;
const BAR_STAGGER = 0.08;

/**
 * Draw-on-enter: charts animate when the sheet opens *and* the figure is
 * actually in view (the long sheet scrolls), so a chart further down draws
 * itself as the user reaches it. Reduced-motion skips straight to the end.
 */
function useDrawOnView<T extends Element>() {
  const ref = useRef<T | null>(null);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { once: true, amount: 0.35 });
  return { ref, drawn: reduce || inView, reduce };
}

/** Glass tile used by every container in the sheet: hairline emerald glow + soft blur. */
const GLASS_TILE =
  "rounded-[1rem] border border-emerald-500/15 bg-white/70 px-3 py-2.5 backdrop-blur-md transition-all duration-300 hover:border-emerald-500/30 hover:shadow-[0_8px_24px_-16px_rgba(16,185,129,0.55)]";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Staggered fade-and-slide-up wrapper for the sheet's top-level sections. */
function Reveal({
  as = "div",
  index,
  className,
  children,
  ...rest
}: {
  as?: "div" | "section";
  index: number;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const reduce = useReducedMotion();
  const Tag = as === "section" ? motion.section : motion.div;
  return (
    <Tag
      {...rest}
      className={className}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.08 + index * 0.08, ease: EASE_OUT }}
    >
      {children}
    </Tag>
  );
}

/** Metric tile with a micro trend arrow (↑ / ↓ / flat) next to the number. */
function TrendMetric({
  label,
  value,
  icon,
  trend,
  tone = "default",
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  trend: number;
  tone?: "default" | "warn";
}) {
  return (
    <div
      className={`min-w-0 ${
        tone === "warn"
          ? "rounded-[1rem] border border-amber-300/60 bg-amber-50/80 px-3 py-2.5 backdrop-blur-md transition-all duration-300 hover:border-amber-400/70"
          : GLASS_TILE
      }`}
    >
      <p className="flex items-center gap-1 text-[10.5px] font-bold tracking-wide text-emerald-800/65">
        {icon}
        {label}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-[15px] font-black tabular-nums text-emerald-950">
        <span className="truncate">{value}</span>
        {trend !== 0 && (
          <motion.span
            aria-hidden
            initial={{ opacity: 0, y: trend > 0 ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.5, ease: EASE_OUT }}
            className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${
              trend > 0 ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"
            }`}
          >
            {trend > 0 ? (
              <TrendingUp size={10} strokeWidth={3} />
            ) : (
              <TrendingDown size={10} strokeWidth={3} />
            )}
          </motion.span>
        )}
      </p>
    </div>
  );
}

/** Tile shell shared by every chart: title row + svg + footnote. */
function ChartFigure({
  title,
  icon,
  note,
  children,
  index = 0,
  tone = "heat",
}: {
  title: string;
  icon: ReactNode;
  note: string;
  children: ReactNode;
  index?: number;
  tone?: Tone;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.figure
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.15 + index * 0.07, ease: EASE_OUT }}
      className={`${GLASS_TILE} m-0 flex flex-col gap-1.5 p-3`}
    >
      <figcaption className="flex items-center gap-1.5 text-[11.5px] font-black text-emerald-900">
        <span aria-hidden className={`grid h-5 w-5 place-items-center rounded-md ${PALETTE[tone].iconClass}`}>
          {icon}
        </span>
        {title}
      </figcaption>
      {children}
      <p className="text-[10px] font-bold leading-4 text-emerald-900/50">{note}</p>
    </motion.figure>
  );
}

/** Small tap-to-inspect tooltip inside the SVG coordinate space. */
function SvgTooltip({
  x,
  y,
  text,
  tone,
  chartW,
}: {
  x: number;
  y: number;
  text: string;
  tone: Tone;
  chartW: number;
}) {
  const w = Math.max(30, text.length * 6.2 + 14);
  const h = 18;
  const left = Math.min(Math.max(x - w / 2, 2), chartW - w - 2);
  const top = Math.max(y - h - 10, 2);
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18, ease: EASE_OUT }}
      style={{ transformOrigin: `${x}px ${y}px` }}
      pointerEvents="none"
    >
      <rect x={left} y={top} width={w} height={h} rx={9} fill="#064e3b" opacity={0.94} />
      <polygon
        points={`${x - 4},${top + h} ${x + 4},${top + h} ${x},${top + h + 5}`}
        fill="#064e3b"
        opacity={0.94}
      />
      <text
        x={left + w / 2}
        y={top + h / 2 + 3.5}
        textAnchor="middle"
        fontSize="9.5"
        fontWeight={800}
        fill={PALETTE[tone].tipText}
      >
        {text}
      </text>
    </motion.g>
  );
}

/** Pill badge drawn above the peak bar / point. */
function PeakBadge({
  x,
  y,
  text,
  tone,
  chartW,
  delay,
}: {
  x: number;
  y: number;
  text: string;
  tone: Tone;
  chartW: number;
  delay: number;
}) {
  const w = Math.max(34, text.length * 5.6 + 14);
  const h = 14;
  const left = Math.min(Math.max(x - w / 2, 2), chartW - w - 2);
  const top = Math.max(y - h - 2, 1);
  return (
    <motion.g
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, delay, ease: EASE_OUT }}
      style={{ transformOrigin: `${left + w / 2}px ${top + h}px` }}
      pointerEvents="none"
    >
      <rect x={left} y={top} width={w} height={h} rx={7} fill="#ffffff" opacity={0.92} />
      <rect
        x={left}
        y={top}
        width={w}
        height={h}
        rx={7}
        fill={PALETTE[tone].badgeBg}
        stroke={PALETTE[tone].badgeBorder}
        strokeWidth={1}
        style={{ filter: `drop-shadow(0 2px 4px ${PALETTE[tone].glow})` }}
      />
      <text
        x={left + w / 2}
        y={top + h / 2 + 3}
        textAnchor="middle"
        fontSize="8.5"
        fontWeight={800}
        fill={PALETTE[tone].badgeText}
      >
        {text}
      </text>
    </motion.g>
  );
}

/**
 * Stable signature of a series. Used as a React `key` so the draw animation
 * re-runs whenever the underlying data changes, and to scope the tapped point
 * to the series it was tapped on (so a data refresh clears the tooltip).
 */
function seriesKey(values: readonly (number | null)[]) {
  return values.map((v) => (v === null ? "x" : v.toFixed(2))).join("|");
}

/** Tap-to-inspect state, automatically reset when the series changes. */
function useActivePoint(drawKey: string) {
  const [active, setActive] = useState<{ key: string; idx: number } | null>(null);
  const activeIdx = active && active.key === drawKey ? active.idx : null;
  const toggle = (idx: number) =>
    setActive((cur) => (cur && cur.key === drawKey && cur.idx === idx ? null : { key: drawKey, idx }));
  const set = (idx: number) => setActive({ key: drawKey, idx });
  const clear = () => setActive(null);
  return { activeIdx, toggle, set, clear };
}

/** Smooth Catmull-Rom → cubic Bézier path through the given points. */
function smoothPath(pts: { x: number; y: number }[]) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function HourLineChart({
  points,
  format,
  label,
  tone = "heat",
  peakLabel,
}: {
  points: SeriesPoint[];
  format: (value: number) => string;
  label: string;
  tone?: Tone;
  peakLabel?: (value: string) => string;
}) {
  const H = 96;
  const PX = 20;
  const PY_TOP = 18;
  const PY_BOTTOM = 20;
  const { ref, drawn, reduce } = useDrawOnView<SVGSVGElement>();
  const pal = PALETTE[tone];
  const gradId = useId();
  const values = points.map((p) => p.value);
  const drawKey = seriesKey(values);
  const { activeIdx, toggle, set, clear } = useActivePoint(drawKey);
  const present = values.filter((v): v is number => v !== null);
  const min = present.length ? Math.min(...present) : 0;
  const max = present.length ? Math.max(...present) : 1;
  const span = max - min || 1;
  const x = (i: number) => PX + (i / Math.max(points.length - 1, 1)) * (CHART_W - 2 * PX);
  const y = (v: number) => H - PY_BOTTOM - ((v - min) / span) * (H - PY_TOP - PY_BOTTOM);
  const coords = values
    .map((v, i) => (v === null ? null : { x: x(i), y: y(v) }))
    .filter((p): p is { x: number; y: number } => p !== null);
  const peakIdx = values.findIndex((v) => v === max);
  const lastIdx = values.length - 1;

  if (present.length === 0) {
    return (
      <svg viewBox={`0 0 ${CHART_W} ${H}`} role="img" aria-label={`${label} — unavailable`} className="w-full">
        <text x={CHART_W / 2} y={H / 2} textAnchor="middle" fontSize="11" fontWeight={700} fill="rgba(6,78,59,0.4)">
          —
        </text>
      </svg>
    );
  }

  const linePath = smoothPath(coords);
  const areaPath =
    coords.length > 1
      ? `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${H - PY_BOTTOM} L ${coords[0].x.toFixed(1)} ${H - PY_BOTTOM} Z`
      : "";
  const gradient = `line-${gradId}`;
  const glow = `glow-${gradId}`;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${H}`}
      ref={ref}
      role="img"
      aria-label={label}
      className="w-full touch-manipulation select-none"
      onPointerLeave={clear}
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={pal.stroke} stopOpacity={0.22} />
          <stop offset="60%" stopColor={pal.stroke} stopOpacity={0.08} />
          <stop offset="100%" stopColor={pal.stroke} stopOpacity={0} />
        </linearGradient>
        <linearGradient id={`${gradient}-stroke`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={pal.stroke} />
          <stop offset="100%" stopColor={pal.deep} />
        </linearGradient>
        <filter id={glow} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Baseline hairline */}
      <line
        x1={PX}
        x2={CHART_W - PX}
        y1={H - PY_BOTTOM}
        y2={H - PY_BOTTOM}
        stroke="rgba(6,78,59,0.08)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />

      {/* Area gradient — fades in and gently pulses for depth */}
      {areaPath && (
        <motion.path
          key={`area-${drawKey}`}
          d={areaPath}
          fill={`url(#${gradient})`}
          initial={reduce ? false : { opacity: 0 }}
          animate={!drawn ? { opacity: 0 } : reduce ? { opacity: 1 } : { opacity: [0, 1, 0.8, 1] }}
          transition={
            reduce
              ? { duration: 0 }
              : { duration: 2.6, times: [0, 0.3, 0.65, 1], delay: 0.25, ease: "easeInOut" }
          }
        />
      )}

      {/* Progressive line drawing */}
      {linePath && (
        <motion.path
          key={`line-${drawKey}`}
          d={linePath}
          fill="none"
          stroke={`url(#${gradient}-stroke)`}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={reduce ? false : { pathLength: 0, opacity: 0.4 }}
          animate={drawn ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0.4 }}
          transition={reduce ? { duration: 0 } : { duration: DRAW_MS, ease: "easeOut" }}
          style={{ filter: `drop-shadow(0 2px 3px ${pal.glow})` }}
        />
      )}

      {values.map((v, i) => {
        const isPeak = i === peakIdx;
        const isCurrent = i === lastIdx;
        const highlight = isPeak || isCurrent;
        const isActive = activeIdx === i;
        return (
          <g key={points[i].label}>
            {v !== null && highlight && !reduce && (
              <circle
                cx={x(i)}
                cy={y(v)}
                r={7}
                fill={pal.stroke}
                opacity={drawn ? 0.25 : 0}
                style={{ transition: "opacity 300ms ease" }}
                className="animate-pulse"
                pointerEvents="none"
              />
            )}
            {v !== null && (
              <motion.circle
                key={`dot-${drawKey}-${i}`}
                cx={x(i)}
                cy={y(v)}
                r={isActive ? 4.2 : highlight ? 3.4 : 2.6}
                fill={isActive || highlight ? pal.deep : "#ffffff"}
                stroke={pal.stroke}
                strokeWidth={isActive || highlight ? 0 : 1.8}
                filter={highlight ? `url(#${glow})` : undefined}
                initial={reduce ? false : { scale: 0.8, opacity: 0 }}
                animate={drawn ? { scale: 1, opacity: 1 } : { scale: 0.8, opacity: 0 }}
                transition={{ duration: 0.3, delay: reduce ? 0 : DRAW_MS * (i / Math.max(values.length - 1, 1)) + 0.05 }}
                style={{ transformOrigin: `${x(i)}px ${y(v)}px`, transition: "r 160ms ease" }}
              />
            )}
            {v !== null && (
              <motion.text
                x={x(i)}
                y={y(v) - 7}
                textAnchor="middle"
                fontSize="9.5"
                fontWeight={800}
                fill="#064e3b"
                initial={reduce ? false : { opacity: 0, y: y(v) - 3 }}
                animate={drawn ? { opacity: isActive ? 0 : 1, y: y(v) - 7 } : { opacity: 0, y: y(v) - 3 }}
                transition={{ duration: 0.3, delay: reduce ? 0 : DRAW_MS * (i / Math.max(values.length - 1, 1)) + 0.2 }}
              >
                {format(v)}
              </motion.text>
            )}
            <text x={x(i)} y={H - 6} textAnchor="middle" fontSize="9.5" fontWeight={700} fill="rgba(6,78,59,0.55)">
              {points[i].label}
            </text>
            {/* Hit target: whole slot column, so touch is forgiving. */}
            {v !== null && (
              <rect
                x={x(i) - (CHART_W - 2 * PX) / Math.max(points.length - 1, 1) / 2}
                y={0}
                width={(CHART_W - 2 * PX) / Math.max(points.length - 1, 1)}
                height={H - PY_BOTTOM}
                fill="transparent"
                className="cursor-pointer"
                onPointerDown={() => toggle(i)}
                onPointerEnter={(e) => {
                  if (e.pointerType === "mouse") set(i);
                }}
              />
            )}
          </g>
        );
      })}

      {drawn && peakLabel && peakIdx >= 0 && values[peakIdx] !== null && activeIdx === null && (
        <PeakBadge
          x={x(peakIdx)}
          y={y(values[peakIdx] as number) - 15}
          text={peakLabel(format(values[peakIdx] as number))}
          tone={tone}
          chartW={CHART_W}
          delay={reduce ? 0 : DRAW_MS + 0.1}
        />
      )}

      {activeIdx !== null && values[activeIdx] !== null && (
        <SvgTooltip
          x={x(activeIdx)}
          y={y(values[activeIdx] as number)}
          text={`${points[activeIdx].label} · ${format(values[activeIdx] as number)}`}
          tone={tone}
          chartW={CHART_W}
        />
      )}
    </svg>
  );
}

function HourBarChart({
  points,
  format,
  label,
  tone = "rain",
  peakLabel,
}: {
  points: SeriesPoint[];
  format: (value: number) => string;
  label: string;
  tone?: Tone;
  peakLabel?: (value: string) => string;
}) {
  const H = 96;
  const PX = 16;
  const PY_TOP = 16;
  const PY_BOTTOM = 20;
  const { ref, drawn, reduce } = useDrawOnView<SVGSVGElement>();
  const pal = PALETTE[tone];
  const gradId = useId();
  const values = points.map((p) => p.value);
  const drawKey = seriesKey(values);
  const { activeIdx, toggle, set, clear } = useActivePoint(drawKey);
  const present = values.filter((v): v is number => v !== null);
  const max = present.length ? Math.max(...present, 1) : 1;
  const slot = (CHART_W - 2 * PX) / points.length;
  const barW = Math.min(26, slot * 0.55);
  const peakIdx = present.length ? values.findIndex((v) => v === Math.max(...present)) : -1;

  const gradSoft = `bar-soft-${gradId}`;
  const gradHot = `bar-hot-${gradId}`;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${H}`}
      ref={ref}
      role="img"
      aria-label={label}
      className="w-full touch-manipulation select-none"
      onPointerLeave={clear}
    >
      <defs>
        {/* Soft capsule: transparent base → solid top */}
        <linearGradient id={gradSoft} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={pal.barFrom} />
          <stop offset="100%" stopColor={pal.barTo} />
        </linearGradient>
        {/* Emphasised capsule (peak / ≥50 % rain): the metric's full two-tone gradient */}
        <linearGradient id={gradHot} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={pal.hotFrom} />
          <stop offset="100%" stopColor={pal.hotTo} />
        </linearGradient>
      </defs>

      <line
        x1={PX}
        x2={CHART_W - PX}
        y1={H - PY_BOTTOM}
        y2={H - PY_BOTTOM}
        stroke="rgba(6,78,59,0.08)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />

      {points.map((p, i) => {
        const cx = PX + slot * i + slot / 2;
        if (p.value === null) {
          return (
            <g key={p.label}>
              <rect x={cx - barW / 2} y={H - PY_BOTTOM - 2} width={barW} height={2} rx={1} fill="rgba(6,78,59,0.15)" />
              <text x={cx} y={H - PY_BOTTOM - 7} textAnchor="middle" fontSize="9" fontWeight={700} fill="rgba(6,78,59,0.4)">
                —
              </text>
              <text x={cx} y={H - 6} textAnchor="middle" fontSize="9.5" fontWeight={700} fill="rgba(6,78,59,0.55)">
                {p.label}
              </text>
            </g>
          );
        }
        const hBar = (p.value / max) * (H - PY_TOP - PY_BOTTOM);
        const yBar = H - PY_BOTTOM - hBar;
        const hot = (p.value >= 50 && tone === "rain") || i === peakIdx;
        const isActive = activeIdx === i;
        const delay = reduce ? 0 : i * BAR_STAGGER;
        return (
          <g key={p.label}>
            <motion.rect
              key={`bar-${drawKey}-${i}`}
              x={cx - barW / 2}
              y={yBar}
              width={barW}
              height={Math.max(hBar, 1.5)}
              rx={Math.min(barW / 2, 8)}
              fill={`url(#${hot ? gradHot : gradSoft})`}
              initial={reduce ? false : { scaleY: 0, opacity: 0.4 }}
              animate={
                drawn
                  ? { scaleY: 1, opacity: isActive || activeIdx === null ? 1 : 0.55 }
                  : { scaleY: 0, opacity: 0.4 }
              }
              transition={{ duration: 0.6, delay, ease: "easeOut" }}
              style={{
                transformOrigin: `${cx}px ${H - PY_BOTTOM}px`,
                filter: hot ? `drop-shadow(0 3px 6px ${pal.glow})` : undefined,
              }}
            />
            {/* Glossy cap highlight on the top of the capsule */}
            {hBar > 8 && (
              <motion.rect
                key={`cap-${drawKey}-${i}`}
                x={cx - barW / 2 + 3}
                y={yBar + 2.5}
                width={barW - 6}
                height={2}
                rx={1}
                fill="#ffffff"
                opacity={0.5}
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: drawn ? 0.5 : 0 }}
                transition={{ duration: 0.3, delay: delay + 0.45 }}
                pointerEvents="none"
              />
            )}
            <motion.text
              key={`val-${drawKey}-${i}`}
              x={cx}
              y={yBar - 5}
              textAnchor="middle"
              fontSize="9.5"
              fontWeight={800}
              fill="#064e3b"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: !drawn || isActive ? 0 : 1 }}
              transition={{ duration: 0.3, delay: delay + 0.35 }}
            >
              {format(p.value)}
            </motion.text>
            <text x={cx} y={H - 6} textAnchor="middle" fontSize="9.5" fontWeight={700} fill="rgba(6,78,59,0.55)">
              {p.label}
            </text>
            <rect
              x={PX + slot * i}
              y={0}
              width={slot}
              height={H - PY_BOTTOM}
              fill="transparent"
              className="cursor-pointer"
              onPointerDown={() => toggle(i)}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") set(i);
              }}
            />
          </g>
        );
      })}

      {drawn && peakLabel && peakIdx >= 0 && values[peakIdx] !== null && activeIdx === null && (
        <PeakBadge
          x={PX + slot * peakIdx + slot / 2}
          y={H - PY_BOTTOM - ((values[peakIdx] as number) / max) * (H - PY_TOP - PY_BOTTOM) - 14}
          text={peakLabel(format(values[peakIdx] as number))}
          tone={tone}
          chartW={CHART_W}
          delay={reduce ? 0 : (points.length - 1) * BAR_STAGGER + 0.6}
        />
      )}

      {activeIdx !== null && values[activeIdx] !== null && (
        <SvgTooltip
          x={PX + slot * activeIdx + slot / 2}
          y={H - PY_BOTTOM - ((values[activeIdx] as number) / max) * (H - PY_TOP - PY_BOTTOM)}
          text={`${points[activeIdx].label} · ${format(values[activeIdx] as number)}`}
          tone={tone}
          chartW={CHART_W}
        />
      )}
    </svg>
  );
}

function WeekRangeChart({
  days,
  dayLabels,
  label,
  peakLabel,
}: {
  days: DayPoint[];
  dayLabels: readonly string[];
  label: string;
  peakLabel?: (value: string) => string;
}) {
  const H = 104;
  const PX = 12;
  const PY_TOP = 16;
  const PY_BOTTOM = 20;
  const { ref, drawn, reduce } = useDrawOnView<SVGSVGElement>();
  const pal = PALETTE.heat;
  const gradId = useId();
  const mins = days.map((d) => d.minC);
  const maxs = days.map((d) => d.maxC);
  const drawKey = seriesKey([...mins, ...maxs]);
  const { activeIdx, toggle, set, clear } = useActivePoint(drawKey);
  const lo = Math.min(...mins);
  const hi = Math.max(...maxs);
  const span = hi - lo || 1;
  const y = (v: number) => H - PY_BOTTOM - ((v - lo) / span) * (H - PY_TOP - PY_BOTTOM);
  const slot = (CHART_W - 2 * PX) / days.length;
  const barW = Math.min(14, slot * 0.42);
  const peakIdx = maxs.indexOf(hi);
  const grad = `range-${gradId}`;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${H}`}
      ref={ref}
      role="img"
      aria-label={label}
      className="w-full touch-manipulation select-none"
      onPointerLeave={clear}
    >
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
          {/* Warm range capsule: hot orange at the day's max → pale amber at the min */}
          <stop offset="0%" stopColor={pal.stroke} />
          <stop offset="100%" stopColor="#fde68a" />
        </linearGradient>
        <linearGradient id={`${grad}-hot`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={pal.deep} />
          <stop offset="100%" stopColor="#fcd34d" />
        </linearGradient>
      </defs>

      {days.map((day, i) => {
        const cx = PX + slot * i + slot / 2;
        const yTop = y(day.maxC);
        const yBottom = y(day.minC);
        const isPeak = i === peakIdx;
        const isActive = activeIdx === i;
        const delay = reduce ? 0 : i * BAR_STAGGER;
        return (
          <g key={day.labelKey}>
            {/* Track behind the capsule, so the range reads against the full scale */}
            <line
              x1={cx}
              x2={cx}
              y1={y(hi)}
              y2={y(lo)}
              stroke="rgba(6,78,59,0.06)"
              strokeWidth={barW}
              strokeLinecap="round"
            />
            <motion.line
              key={`range-${drawKey}-${i}`}
              x1={cx}
              x2={cx}
              y1={yTop}
              y2={yBottom}
              stroke={`url(#${isPeak ? `${grad}-hot` : grad})`}
              strokeWidth={barW}
              strokeLinecap="round"
              initial={reduce ? false : { scaleY: 0, opacity: 0.3 }}
              animate={
                drawn
                  ? { scaleY: 1, opacity: activeIdx === null || isActive ? (isPeak ? 0.95 : 0.75) : 0.4 }
                  : { scaleY: 0, opacity: 0.3 }
              }
              transition={{ duration: 0.6, delay, ease: "easeOut" }}
              style={{
                transformOrigin: `${cx}px ${yBottom}px`,
                filter: isPeak ? `drop-shadow(0 3px 6px ${pal.glow})` : undefined,
              }}
            />
            {isPeak && !reduce && (
              <circle
                cx={cx}
                cy={yTop}
                r={6.5}
                fill={pal.stroke}
                opacity={drawn ? 0.25 : 0}
                className="animate-pulse"
                style={{ transition: "opacity 300ms ease" }}
                pointerEvents="none"
              />
            )}
            <motion.circle
              key={`hi-${drawKey}-${i}`}
              cx={cx}
              cy={yTop}
              r={isPeak ? 3 : 2.4}
              fill={pal.deep}
              initial={reduce ? false : { scale: 0.8, opacity: 0 }}
              animate={drawn ? { scale: 1, opacity: 1 } : { scale: 0.8, opacity: 0 }}
              transition={{ duration: 0.3, delay: delay + 0.45 }}
              style={{ transformOrigin: `${cx}px ${yTop}px` }}
            />
            <motion.circle
              key={`lo-${drawKey}-${i}`}
              cx={cx}
              cy={yBottom}
              r={2.4}
              fill="#fde68a"
              stroke="#ffffff"
              strokeWidth={1}
              initial={reduce ? false : { scale: 0.8, opacity: 0 }}
              animate={drawn ? { scale: 1, opacity: 1 } : { scale: 0.8, opacity: 0 }}
              transition={{ duration: 0.3, delay: delay + 0.1 }}
              style={{ transformOrigin: `${cx}px ${yBottom}px` }}
            />
            <motion.text
              key={`max-${drawKey}-${i}`}
              x={cx}
              y={yTop - 5}
              textAnchor="middle"
              fontSize="9"
              fontWeight={800}
              fill="#064e3b"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: !drawn || isActive ? 0 : 1 }}
              transition={{ duration: 0.3, delay: delay + 0.45 }}
            >
              {fmt(day.maxC)}°
            </motion.text>
            {/* Min sits beside the low dot so it never collides with the day label. */}
            <motion.text
              key={`min-${drawKey}-${i}`}
              x={cx + barW / 2 + 3}
              y={yBottom + 3}
              textAnchor="start"
              fontSize="8.5"
              fontWeight={700}
              fill="rgba(6,78,59,0.6)"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: !drawn || isActive ? 0 : 1 }}
              transition={{ duration: 0.3, delay: delay + 0.3 }}
            >
              {fmt(day.minC)}°
            </motion.text>
            <text x={cx} y={H - 6} textAnchor="middle" fontSize="9.5" fontWeight={700} fill="rgba(6,78,59,0.55)">
              {dayLabels[day.labelKey]}
            </text>
            <rect
              x={PX + slot * i}
              y={0}
              width={slot}
              height={H - PY_BOTTOM}
              fill="transparent"
              className="cursor-pointer"
              onPointerDown={() => toggle(i)}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") set(i);
              }}
            />
          </g>
        );
      })}

      {drawn && peakLabel && peakIdx >= 0 && activeIdx === null && (
        <PeakBadge
          x={PX + slot * peakIdx + slot / 2}
          y={y(hi) - 14}
          text={peakLabel(`${fmt(hi)}°`)}
          tone="heat"
          chartW={CHART_W}
          delay={reduce ? 0 : (days.length - 1) * BAR_STAGGER + 0.6}
        />
      )}

      {activeIdx !== null && (
        <SvgTooltip
          x={PX + slot * activeIdx + slot / 2}
          y={y(days[activeIdx].maxC)}
          text={`${dayLabels[days[activeIdx].labelKey]} · ${fmt(days[activeIdx].minC)}° – ${fmt(days[activeIdx].maxC)}°`}
          tone="heat"
          chartW={CHART_W}
        />
      )}
    </svg>
  );
}
