"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ListChecks } from "lucide-react";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { DailyTask } from "@/lib/dailyTasks/types";

/**
 * Daily AI task checklist — the interactive block at the bottom of the hero
 * decision card (it replaced the old static advice lines).
 *
 * Each row: animated check + strike-through, category badge (💧 سقي /
 * 🛡️ وقاية / 🚜 تسميد/صيانة) and priority indicator (High / Normal).
 * Checked state is owned by the dashboard (`useDailyTasks` + LocalStorage per
 * date) so a refresh preserves the day's progress; a thin progress bar and a
 * 🎉 mini-badge celebrate a fully checked day. The subtle footer carries the
 * AI publish stamp of the 00:00 workflow.
 */
export default function HeroTasksChecklist({
  t,
  tasks,
  done,
  onToggle,
  doneCount,
  total,
  allDone,
}: {
  t: DashboardCopy;
  /** Display-ready tasks (title/subtitle in the active language). */
  tasks: Array<DailyTask & { title: string; subtitle: string }>;
  done: Record<string, boolean>;
  onToggle: (taskId: string) => void;
  doneCount: number;
  total: number;
  allDone: boolean;
}) {
  const reduce = useReducedMotion();
  const d = t.heroTasks;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <section
      aria-label={d.title}
      className="mt-3 rounded-[1.1rem] bg-white/10 p-3 ring-1 ring-white/12"
    >
      <header className="flex items-start justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-black leading-[1.5] text-white">
          <ListChecks size={14} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-50/90" />
          <span>{d.title}</span>
        </h2>
        <AnimatePresence mode="wait" initial={false}>
          {allDone ? (
            <motion.span
              key="done"
              initial={reduce ? false : { scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={reduce ? undefined : { scale: 0.7, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 22 }}
              className="mt-0.5 flex shrink-0 items-center rounded-full bg-emerald-300/25 px-2 py-0.5 text-[10.5px] font-black text-emerald-50 ring-1 ring-emerald-200/50"
            >
              {d.allDone.replace("{done}", String(doneCount)).replace("{total}", String(total))}
            </motion.span>
          ) : (
            <motion.span
              key="progress"
              initial={false}
              exit={reduce ? undefined : { opacity: 0 }}
              className="mt-0.5 shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10.5px] font-bold tabular-nums text-emerald-50/85 ring-1 ring-white/15"
            >
              {d.progress.replace("{done}", String(doneCount)).replace("{total}", String(total))}
            </motion.span>
          )}
        </AnimatePresence>
      </header>
      <p className="mt-1 text-[10.5px] font-semibold leading-[1.6] text-emerald-50/65">{d.subtitle}</p>

      {/* Day progress — full bar + a pop when it completes. */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={doneCount}
        aria-label={d.progress.replace("{done}", String(doneCount)).replace("{total}", String(total))}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/15"
      >
        <motion.div
          className="h-full rounded-full bg-emerald-300"
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 180, damping: 24 }}
        />
      </div>

      <ul className="mt-2.5 flex flex-col gap-2">
        {tasks.map((task) => {
          const checked = Boolean(done[task.id]);
          return (
            <motion.li
              key={task.id}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-[0.9rem] px-2.5 py-2 transition-colors duration-200 ${
                  checked ? "bg-emerald-300/[0.12] ring-1 ring-emerald-200/25" : "bg-white/[0.07] ring-1 ring-white/10 hover:bg-white/[0.13]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(task.id)}
                  aria-label={d.checkAria.replace("{title}", task.title)}
                  className="peer sr-only"
                />
                {/* Animated check bubble (the sr-only input keeps semantics). */}
                <motion.span
                  aria-hidden
                  whileTap={reduce ? undefined : { scale: 0.85 }}
                  className={`mt-[2px] grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full ring-2 transition-colors duration-200 peer-focus-visible:ring-4 peer-focus-visible:ring-emerald-200/90 ${
                    checked ? "bg-emerald-400 ring-emerald-300" : "bg-white/10 ring-white/40"
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-[11px] w-[11px] text-emerald-950">
                    <motion.path
                      d="M4.5 12.5l5 5L20 7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={3.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={false}
                      animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
                      transition={{ duration: reduce ? 0 : 0.28, ease: "easeOut" }}
                    />
                  </svg>
                </motion.span>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className={`text-[12.5px] font-black leading-[1.6] transition-colors duration-300 ${
                        checked ? "text-white/55 line-through decoration-white/70 decoration-2" : "text-white"
                      }`}
                    >
                      {task.title}
                    </span>
                    {/* Badge pair wraps as one unit: category + priority. */}
                    <span className="inline-flex shrink-0 items-center gap-1">
                      {/* Category badge (💧 سقي / 🛡️ وقاية / 🚜 تسميد/صيانة) */}
                      <span className="shrink-0 rounded-full bg-emerald-300/15 px-1.5 py-px text-[9.5px] font-black text-emerald-50 ring-1 ring-emerald-200/30">
                        {d.categories[task.category] ?? d.categories.fertilization}
                      </span>
                      {/* Priority indicator (High / Normal) */}
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-black ring-1 ${
                          task.priority === "high"
                            ? "bg-amber-300/20 text-amber-100 ring-amber-200/40"
                            : "bg-white/10 text-emerald-50/75 ring-white/15"
                        }`}
                      >
                        {task.priority === "high" ? d.priorities.high : d.priorities.normal}
                      </span>
                    </span>
                  </span>
                  <span
                    className={`mt-0.5 block text-[11px] font-semibold leading-[1.7] transition-colors duration-300 ${
                      checked ? "text-emerald-50/45" : "text-emerald-50/75"
                    }`}
                  >
                    {task.subtitle}
                  </span>
                </span>
              </label>
            </motion.li>
          );
        })}
      </ul>

      {/* Card footer — the AI publish stamp of the daily workflow. */}
      <p className="mt-2.5 border-t border-white/10 pt-2 text-center text-[9.5px] font-bold tracking-wide text-emerald-50/60">
        {d.updatedAi}
      </p>
    </section>
  );
}
