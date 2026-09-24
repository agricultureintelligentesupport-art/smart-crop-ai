"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Clock, Droplets, MapPin, ShieldCheck, Sparkles, Waves } from "lucide-react";
import type { IrrigationResult } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { GPU } from "@/components/auth/ui";
import { fmt } from "./WeatherCard";

/**
 * Hero decision card — the first thing a farmer sees.
 *
 * Promotes the "quick reading" that used to be a plain strip in the middle of
 * the scroll into the screen's headline: today's water volume for the parcel,
 * the irrigation window, and the three advisory lines, all still fed by the
 * exact same `computeIrrigation` numbers as the calculator below. The wilaya
 * name — formerly its own card — rides along as a quiet context label in the
 * header row, next to the crop name.
 */
export default function HeroCard({
  t,
  irrigation,
  cropLabel,
  /** Wilaya name, shown as a small low-emphasis context label. */
  wilayaLabel,
  advice,
}: {
  t: DashboardCopy;
  irrigation: IrrigationResult;
  cropLabel: string;
  wilayaLabel: string;
  /** Pre-composed advisory lines (same copy + values as before). */
  advice: { line1: string; line2: string; line3: string };
}) {
  const reduce = useReducedMotion();

  return (
    <motion.section
      aria-label={t.advice.title}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className={`app-hero ${GPU} rounded-[1.6rem] p-4`}
    >
      <div className="relative z-10">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-black text-white ring-1 ring-white/25">
            <Sparkles size={12} strokeWidth={2.8} aria-hidden />
            {t.hero.eyebrow}
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="flex min-w-0 items-center gap-1 text-[10.5px] font-medium tracking-wide text-emerald-50/70"
              title={wilayaLabel}
            >
              <MapPin size={10} strokeWidth={2.2} aria-hidden className="shrink-0 text-emerald-50/70" />
              <span className="truncate">{wilayaLabel}</span>
            </span>
            <span aria-hidden className="h-2.5 w-px shrink-0 bg-white/20" />
            <span className="shrink-0 text-[11.5px] font-bold text-emerald-50/90">{cropLabel}</span>
          </span>
        </div>

        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11.5px] font-bold text-emerald-50/90">{t.hero.needLabel}</p>
            <p className="mt-1 flex items-baseline gap-1.5">
              <span dir="ltr" className="text-[34px] font-black leading-none tabular-nums text-white">
                {fmt(irrigation.dailyM3, 1)}
              </span>
              <span className="text-[15px] font-extrabold text-emerald-50/90">m³</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 text-[11.5px] font-bold text-emerald-50/90">
            <span dir="ltr" className="tabular-nums">
              {fmt(irrigation.netMmDay, 1)} mm
            </span>
            <span dir="ltr" className="tabular-nums">
              {fmt(irrigation.litresPerHaDay)} L/ha
            </span>
          </div>
        </div>

        {/* Values are Latin/numeric → pinned LTR so the range never reorders. */}
        <div className="mt-4 flex flex-wrap gap-2">
          <div className="min-w-[9rem] flex-1 rounded-[1rem] bg-white/12 px-3 py-2 ring-1 ring-white/15">
            <p className="text-[10.5px] font-bold text-emerald-50/90">{t.hero.window}</p>
            <p dir="ltr" className="mt-0.5 text-[14px] font-black tabular-nums text-white">
              {t.hero.windowValue}
            </p>
          </div>
          <div className="min-w-[7.5rem] flex-1 rounded-[1rem] bg-white/12 px-3 py-2 ring-1 ring-white/15">
            <p className="text-[10.5px] font-bold text-emerald-50/90">{t.hero.perHa}</p>
            <p dir="ltr" className="mt-0.5 text-[14px] font-black tabular-nums text-white">
              {fmt(irrigation.litresPerHaDay)} L
            </p>
          </div>
        </div>

        <ul className="mt-3 flex flex-col gap-2 rounded-[1.1rem] bg-white/10 p-3 ring-1 ring-white/12">
          {[
            { icon: <Waves size={14} strokeWidth={2.6} aria-hidden />, text: advice.line1 },
            { icon: <Clock size={14} strokeWidth={2.6} aria-hidden />, text: advice.line2 },
            { icon: <ShieldCheck size={14} strokeWidth={2.6} aria-hidden />, text: advice.line3 },
          ].map((line) => (
            <li key={line.text} className="flex items-start gap-2 text-[12.5px] font-bold leading-[1.7] text-white">
              <span className="mt-[3px] shrink-0 text-emerald-50/90">{line.icon}</span>
              <span className="min-w-0">{line.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Decorative water-drop corner glyph, kept out of the a11y tree. */}
      <Droplets
        aria-hidden
        size={70}
        strokeWidth={1}
        className="pointer-events-none absolute bottom-4 end-4 z-0 text-white/20"
      />
    </motion.section>
  );
}
