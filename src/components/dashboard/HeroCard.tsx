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
 * ONE master container, TWO zones. The card is a single deep-emerald → teal
 * gradient surface (`rounded-3xl`, hairline inner highlight, light emerald
 * glow); nothing inside it is a card:
 *
 *   zone 1  identity row → the day's headline metrics (volume, mm, L/ha) → the
 *           irrigation-window and per-hectare tiles as translucent washes
 *           (`bg-white/5 border-white/10`), no heavy inner boxes;
 *   ──────  a single hairline divider (`border-t border-white/10 my-3`);
 *   zone 2  the AI task tray (`HeroTasksChecklist`) — header + counter/rail,
 *           borderless task rows and the integrated expand handle.
 *
 * Metrics are the same `computeIrrigation` chain as the calculator below and
 * the tray is the same daily AI task engine: this is a pure presentation
 * rebuild, no figure or task is re-derived here.
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
  /** Opens the per-hectare calculation flow (the unit tile below). */
  onOpenPerHectareFlow: () => void;
  /** Whether that flow is currently on screen (drives the tile's arrow + glow). */
  flowOpen: boolean;
}) {
  const reduce = useReducedMotion();

  return (
    <motion.section
      aria-label={t.hero.eyebrow}
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className={`app-hero ${GPU} rounded-3xl p-4`}
    >
      <div className="relative z-10">
        {/* ── Zone 1 · context: decision badge ⇄ wilaya + crop ─────────── */}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white/90">
            <Sparkles size={12} strokeWidth={2.6} aria-hidden />
            {t.hero.eyebrow}
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="flex min-w-0 items-center gap-1 text-[10.5px] font-medium tracking-wide text-emerald-50/85"
              title={wilayaLabel}
            >
              <MapPin size={10} strokeWidth={2.2} aria-hidden className="shrink-0 text-emerald-50/70" />
              <span className="truncate">{wilayaLabel}</span>
            </span>
            <span aria-hidden className="h-2.5 w-px shrink-0 bg-white/20" />
            <span className="shrink-0 text-[11.5px] font-semibold text-emerald-50/90">{cropLabel}</span>
          </span>
        </div>

        {/* ── Zone 1 · the day's numbers, unboxed ─────────────────────── */}
        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-emerald-50/75">{t.hero.needLabel}</p>
            <p className="mt-1 flex items-baseline gap-1.5">
              <span dir="ltr" className="text-[34px] font-black leading-none tabular-nums text-white">
                {fmt(irrigation.dailyM3, 1)}
              </span>
              <span className="text-[15px] font-extrabold text-emerald-50/85">m³</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 text-[11.5px] font-semibold tabular-nums text-emerald-50/80">
            <span dir="ltr">{fmt(irrigation.netMmDay, 1)} mm</span>
            <span dir="ltr">{fmt(irrigation.litresPerHaDay)} L/ha</span>
          </div>
        </div>

        {/* ── Zone 1 · detail tiles: hairline washes, no heavy fills ───── */}
        <div className="mt-4 flex flex-wrap gap-2">
          {/* Values are Latin/numeric → pinned LTR so the range never reorders. */}
          <button
            type="button"
            onClick={onOpenWindowDetail}
            aria-label={t.windowDetail.ariaOpen}
            className="group min-w-[8.5rem] flex-1 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-start transition-colors hover:border-white/20 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-semibold text-emerald-50/75">{t.hero.window}</span>
              <ChevronLeft
                size={14}
                strokeWidth={2.8}
                aria-hidden
                className="shrink-0 text-emerald-50/55 transition-colors group-hover:text-white rtl:rotate-0 ltr:rotate-180"
              />
            </span>
            <span dir="ltr" className="mt-1 block text-[14px] font-black tabular-nums text-white">
              {t.hero.windowValue}
            </span>
          </button>
          {/* Unit tile: opens the step-by-step calculation flow. The arrow reads
              ↓ while closed and → (the flow's own direction) once it is open. */}
          <motion.button
            type="button"
            onClick={onOpenPerHectareFlow}
            aria-label={t.hero.perHaOpen}
            aria-haspopup="dialog"
            aria-expanded={flowOpen}
            whileTap={reduce ? undefined : { scale: 0.98 }}
            className={`group relative min-w-[7.5rem] flex-1 rounded-2xl border px-3 py-2.5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
              flowOpen
                ? "border-emerald-300/60 bg-white/10"
                : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10"
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-semibold text-emerald-50/75">{t.hero.perHa}</span>
              <ChevronDown
                size={13}
                strokeWidth={3}
                aria-hidden
                className={`shrink-0 text-emerald-100/85 transition-transform duration-300 ${
                  flowOpen ? "rtl:rotate-90 ltr:-rotate-90" : ""
                }`}
              />
            </span>
            <span dir="ltr" className="mt-1 flex items-baseline gap-1 text-[14px] font-black tabular-nums text-white">
              {fmt(irrigation.litresPerHaDay)}
              <span className="text-[10px] font-extrabold text-emerald-50/70">L / ha</span>
            </span>
            <span className="mt-0.5 block text-[9.5px] font-medium text-emerald-50/65">{t.hero.perHaCta}</span>
            {!reduce && !flowOpen && (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-emerald-300/40"
                animate={{ opacity: [0.15, 0.5, 0.15] }}
                transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
              />
            )}
          </motion.button>
        </div>

        {/* ── The seam: one hairline, no second card ───────────────────── */}
        <div aria-hidden data-hero-seam className="my-3 border-t border-white/10" />

        {/* ── Zone 2 · the AI task tray, seamless inside this container ── */}
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

      {/* Decorative water-drop corner glyph, kept out of the a11y tree and out
          of the way of the tray's centered handle. */}
      <Droplets
        aria-hidden
        size={54}
        strokeWidth={1}
        className="pointer-events-none absolute -bottom-1 end-2 z-0 text-white/[0.07]"
      />
    </motion.section>
  );
}
