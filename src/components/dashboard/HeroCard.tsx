"use client";

import { motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronLeft, Droplets, MapPin, Sparkles } from "lucide-react";
import type { IrrigationResult } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { DailyTask } from "@/lib/dailyTasks/types";
import { GPU } from "@/components/auth/ui";
import { fmt } from "./WeatherCard";
import HeroTasksChecklist from "./HeroTasksChecklist";

/**
 * Hero decision card — the first thing a farmer sees.
 *
 * Promotes the "quick reading" that used to be a plain strip in the middle of
 * the scroll into the screen's headline: today's water volume for the parcel
 * and the irrigation window, all still fed by the exact same
 * `computeIrrigation` numbers as the calculator below. The wilaya name —
 * formerly its own card — rides along as a quiet context label in the header
 * row, next to the crop name.
 *
 * The old static advisory lines are gone: their place is taken by the
 * interactive "مهام اليوم الموصى بها (AI)" checklist (see
 * `HeroTasksChecklist`) — the daily AI task engine's output, with per-task
 * checkboxes, category badges and priority indicators.
 */
export default function HeroCard({
  t,
  irrigation,
  cropLabel,
  /** Wilaya name, shown as a small low-emphasis context label. */
  wilayaLabel,
  tasks,
  taskDone,
  onToggleTask,
  tasksDoneCount,
  tasksTotal,
  tasksAllDone,
  onOpenWindowDetail,
  onOpenPerHectareFlow,
  flowOpen,
}: {
  t: DashboardCopy;
  irrigation: IrrigationResult;
  cropLabel: string;
  wilayaLabel: string;
  /** Today's AI-generated tasks (display-ready in the active language). */
  tasks: Array<DailyTask & { title: string; subtitle: string }>;
  /** Checked-task map (persisted locally per day). */
  taskDone: Record<string, boolean>;
  /** Toggles one task's checked state (strike-through + check animation). */
  onToggleTask: (taskId: string) => void;
  tasksDoneCount: number;
  tasksTotal: number;
  tasksAllDone: boolean;
  /** Opens the irrigation-window detail sheet (why this window + volume). */
  onOpenWindowDetail: () => void;
  /** Opens the per-hectare calculation flow (the unit pill below). */
  onOpenPerHectareFlow: () => void;
  /** Whether that flow is currently on screen (drives the pill's arrow + glow). */
  flowOpen: boolean;
}) {
  const reduce = useReducedMotion();

  return (
    <motion.section
      aria-label={t.hero.eyebrow}
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
          <button
            type="button"
            onClick={onOpenWindowDetail}
            aria-label={t.windowDetail.ariaOpen}
            className="group min-w-[9rem] flex-1 rounded-[1rem] bg-white/12 px-3 py-2 text-start ring-1 ring-white/15 transition-colors hover:bg-white/[0.18] hover:ring-white/30 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/45"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-bold text-emerald-50/90">{t.hero.window}</span>
              <ChevronLeft
                size={14}
                strokeWidth={2.8}
                aria-hidden
                className="shrink-0 text-emerald-50/60 transition-colors group-hover:text-white rtl:rotate-0 ltr:rotate-180"
              />
            </span>
            <span dir="ltr" className="mt-0.5 block text-[14px] font-black tabular-nums text-white">
              {t.hero.windowValue}
            </span>
          </button>
          {/* Unit pill: opens the step-by-step calculation flow. The arrow reads
              ↓ while closed and → (the flow's own direction) once it is open. */}
          <motion.button
            type="button"
            onClick={onOpenPerHectareFlow}
            aria-label={t.hero.perHaOpen}
            aria-haspopup="dialog"
            aria-expanded={flowOpen}
            whileTap={reduce ? undefined : { scale: 0.98 }}
            className={`group relative min-w-[7.5rem] flex-1 overflow-hidden rounded-[1rem] bg-white/[0.14] px-3 py-2 text-start transition-colors hover:bg-white/[0.2] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/45 ${
              flowOpen
                ? "ring-2 ring-emerald-300/80 shadow-[0_0_0_1px_rgba(255,255,255,0.22),0_12px_30px_-14px_rgba(16,185,129,0.95)]"
                : "ring-1 ring-emerald-200/35 shadow-[0_10px_26px_-18px_rgba(16,185,129,0.95)]"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-bold text-emerald-50/90">{t.hero.perHa}</span>
              <ChevronDown
                size={13}
                strokeWidth={3}
                aria-hidden
                className={`shrink-0 text-emerald-100 transition-transform duration-300 ${
                  flowOpen ? "rtl:rotate-90 ltr:-rotate-90" : ""
                }`}
              />
            </span>
            <span dir="ltr" className="mt-0.5 flex items-baseline gap-1 text-[14px] font-black tabular-nums text-white">
              {fmt(irrigation.litresPerHaDay)}
              <span className="text-[10px] font-extrabold text-emerald-50/75">L / ha</span>
            </span>
            <span className="mt-0.5 block text-[9.5px] font-bold text-emerald-50/70">{t.hero.perHaCta}</span>
            {!reduce && !flowOpen && (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-[1rem] ring-2 ring-emerald-300/50"
                animate={{ opacity: [0.2, 0.8, 0.2] }}
                transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
          </motion.button>
        </div>

        {/* Daily AI task checklist — replaces the old static advice block. */}
        <HeroTasksChecklist
          t={t}
          tasks={tasks}
          done={taskDone}
          onToggle={onToggleTask}
          doneCount={tasksDoneCount}
          total={tasksTotal}
          allDone={tasksAllDone}
        />
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
