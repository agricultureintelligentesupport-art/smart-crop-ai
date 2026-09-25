"use client";

import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, CloudSun, Droplet, Droplets, Sprout, Sun, Wind } from "lucide-react";
import type { ReactNode } from "react";
import type { IrrigationResult, WeatherSnapshot } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { fmt } from "@/lib/dashboard/format";
import { quickAccessFigures, type CalculatorWidgetFigures, type WeatherWidgetFigures } from "@/lib/dashboard/widgets";

/**
 * Quick-access widget grid — the compact 2-column entry point that sits
 * directly under the hero decision card.
 *
 * This is a pure presentation swap for the two long inline sections: every
 * calculation still happens in `lib/agronomy.ts`, and every figure on a widget
 * is read from the same `WeatherSnapshot` / `IrrigationResult` the decision
 * card renders (`lib/dashboard/widgets.ts` guarantees it), so a widget can
 * never advertise a number the card contradicts. Tapping one opens the
 * matching detail sheet, which holds the complete view.
 *
 * Surfaces use the app's `.glass-card` primitive (white/80 + emerald hairline +
 * blur) rather than a hand-rolled `bg-white/80 dark:…` recipe, because that
 * primitive already carries the opaque fallbacks the design rules require
 * (`prefers-reduced-transparency`, `prefers-contrast`, missing
 * `backdrop-filter`). The pressed scale is a CSS utility so the global
 * `prefers-reduced-motion` rule strips its animation.
 */
export default function QuickAccessGrid({
  t,
  weather,
  irrigation,
  cropLabel,
  areaHa,
  onOpenWeather,
  onOpenCalculator,
  weatherOpen,
  calculatorOpen,
}: {
  t: DashboardCopy;
  /** The live (or reference) snapshot shared by the whole dashboard. */
  weather: WeatherSnapshot;
  /** The hero decision card's own irrigation result. */
  irrigation: IrrigationResult;
  /** Localised crop label of the parcel inputs. */
  cropLabel: string;
  areaHa: number;
  onOpenWeather: () => void;
  onOpenCalculator: () => void;
  /** Whether each detail sheet is on screen (drives the widget's state ring). */
  weatherOpen: boolean;
  calculatorOpen: boolean;
}) {
  const figures = quickAccessFigures({ weather, irrigation, copy: t, cropLabel, areaHa });

  return (
    <div className="grid grid-cols-2 gap-3.5">
      <WeatherWidget t={t} figures={figures.weather} open={weatherOpen} onOpen={onOpenWeather} />
      <CalculatorWidget
        t={t}
        figures={figures.calculator}
        cropLabel={cropLabel}
        areaHa={areaHa}
        open={calculatorOpen}
        onOpen={onOpenCalculator}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared widget shell                                                */
/* ------------------------------------------------------------------ */

/**
 * One widget: a real `<button>` (keyboard and screen-reader first class), a
 * 168px-tall glass surface, and a callout pinned to the foot, so the two
 * widgets still read as a pair when their copy wraps differently in FR.
 */
function WidgetShell({
  title,
  cta,
  ariaLabel,
  open,
  onOpen,
  children,
}: {
  title: string;
  cta: string;
  ariaLabel: string;
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={ariaLabel}
      className={`glass-card group flex min-h-[10.5rem] w-full flex-col rounded-2xl border border-emerald-500/10 p-4 text-start transition-transform duration-200 active:scale-95 ${
        open ? "ring-2 ring-emerald-500/40" : ""
      }`}
    >
      <span className="truncate text-[11px] font-black tracking-wide text-emerald-800/70">{title}</span>
      <span className="mt-2 flex flex-1 flex-col">{children}</span>
      <span className="mt-3 flex items-center justify-between gap-1.5 border-t border-emerald-900/10 pt-2.5">
        <span className="text-[11.5px] font-extrabold leading-tight text-emerald-900">{cta}</span>
        <ArrowUpRight
          size={15}
          strokeWidth={2.8}
          aria-hidden
          className="shrink-0 text-emerald-600 transition-transform duration-200 group-hover:-translate-y-0.5 group-active:translate-x-0.5 rtl:-scale-x-100"
        />
      </span>
    </button>
  );
}

/** Small high-contrast pill used for the metric summary chips. */
function MetricChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-white/70 px-2 py-1 text-[11.5px] font-black tabular-nums text-emerald-800">
      <span aria-hidden className="shrink-0 text-emerald-600">
        {icon}
      </span>
      <span dir="ltr" className="truncate">
        {children}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Widget A · weather + forecast                                      */
/* ------------------------------------------------------------------ */

function WeatherWidget({
  t,
  figures,
  open,
  onOpen,
}: {
  t: DashboardCopy;
  figures: WeatherWidgetFigures;
  open: boolean;
  onOpen: () => void;
}) {
  const reduce = useReducedMotion();
  const hot = figures.condition === "heat";
  const windy = figures.condition === "wind";
  /* Sun / wind / cloud: the glyph follows whichever rule is active today. */
  const Glyph = hot ? Sun : windy ? Wind : CloudSun;

  return (
    <WidgetShell
      title={t.widgets.weather.title}
      cta={t.widgets.weather.cta}
      ariaLabel={figures.aria}
      open={open}
      onOpen={onOpen}
    >
      {/* Icon ⇄ temperature: the two things a farmer reads first. */}
      <span className="flex items-center justify-between gap-2">
        <motion.span
          aria-hidden
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-[0.85rem] ${
            hot
              ? "bg-amber-500/15 text-amber-600 ring-1 ring-amber-500/25"
              : "bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/25"
          }`}
          animate={reduce ? undefined : { rotate: [0, 7, -5, 0], scale: [1, 1.06, 1] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
        >
          <Glyph size={20} strokeWidth={2.4} />
        </motion.span>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[14px] font-black tabular-nums ring-1 ${
            hot ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200"
          }`}
        >
          <span dir="ltr">{figures.tempText}</span>
        </span>
      </span>

      <span className="mt-3 flex flex-wrap gap-1.5">
        <MetricChip icon={<Droplets size={11} strokeWidth={2.8} />}>{figures.humidityText}</MetricChip>
        <MetricChip icon={<Wind size={11} strokeWidth={2.8} />}>{figures.windText}</MetricChip>
      </span>
    </WidgetShell>
  );
}

/* ------------------------------------------------------------------ */
/*  Widget B · irrigation calculator                                   */
/* ------------------------------------------------------------------ */

function CalculatorWidget({
  t,
  figures,
  cropLabel,
  areaHa,
  open,
  onOpen,
}: {
  t: DashboardCopy;
  figures: CalculatorWidgetFigures;
  cropLabel: string;
  areaHa: number;
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <WidgetShell
      title={t.irrigation.title}
      cta={t.widgets.calculator.cta}
      ariaLabel={figures.aria}
      open={open}
      onOpen={onOpen}
    >
      {/* Selected crop ⇄ the water glyph, then the parcel's two live figures. */}
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[0.85rem] bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/25"
        >
          <Droplets size={20} strokeWidth={2.4} />
        </span>
        <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-white/70 px-2 py-1 text-[11px] font-black text-emerald-800">
          <Sprout size={11} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-600" />
          <span className="truncate">{cropLabel}</span>
        </span>
      </span>

      <span className="mt-3 flex flex-col items-start gap-1.5">
        <span className="flex items-baseline gap-1">
          <span dir="ltr" className="text-[19px] font-black leading-none tabular-nums text-emerald-950">
            {fmt(areaHa, 1)}
          </span>
          <span className="text-[11.5px] font-extrabold text-emerald-800/70">{t.irrigation.areaUnit}</span>
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600/10 px-2.5 py-1 text-[12.5px] font-black tabular-nums text-emerald-800 ring-1 ring-emerald-500/25">
          <Droplet size={12} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-600" />
          <span dir="ltr">{figures.volumeText}</span>
        </span>
      </span>
    </WidgetShell>
  );
}
