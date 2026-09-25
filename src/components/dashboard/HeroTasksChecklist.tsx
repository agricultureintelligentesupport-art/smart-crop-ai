"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { DailyTask } from "@/lib/dailyTasks/types";

/**
 * Daily AI task tray — the lower zone of the hero decision card.
 *
 * It is deliberately NOT a card: no fill, no ring, no second radius. The tray
 * lives inside the hero's single gradient container, separated from the metrics
 * above only by the hairline divider the hero draws (`border-t border-white/10
 * my-3`), and each task is a borderless wash row (checkbox → title +
 * category/subtitle → priority chip) instead of a nested box.
 *
 * Header row: `✨ مهام اليوم الذكية` on the reading start edge, and on the other
 * edge the `0/5 منجزة` counter with its thin 64px progress rail. Collapsed, the
 * first (always highest-priority) task stays visible and the rest wait behind
 * the integrated glass handle — `عرض باقي المهام (4+) ⚡ ⌄` — which springs the
 * list open (`height: 0 → auto`, `stiffness: 300, damping: 30`) and reveals the
 * remaining rows with a short stagger. Checked state lives in the store owned by
 * `useDailyTasks`, so a tick survives collapse, expand and reload; the toggle
 * never reorders or re-derives a task, and no figure on this card changes with
 * it.
 */

type DisplayTask = DailyTask & { title: string; subtitle: string };
type ChecklistCopy = DashboardCopy["heroTasks"];
type ReducedMotion = ReturnType<typeof useReducedMotion>;

/** One motion signature for the whole tray: height reveal, rows and chevron. */
const TRAY_SPRING = { type: "spring", stiffness: 300, damping: 30 } as const;

/** One tray row — shared by the pinned first task and every revealed task. */
function TaskRow({
  task,
  checked,
  onToggle,
  copy,
  reduce,
  delay = 0,
}: {
  task: DisplayTask;
  checked: boolean;
  onToggle: (taskId: string) => void;
  copy: ChecklistCopy;
  reduce: ReducedMotion;
  /** Small stagger when a batch of rows is revealed at once. */
  delay?: number;
}) {
  const high = task.priority === "high";
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { ...TRAY_SPRING, delay }}
    >
      <label
        className={`group flex cursor-pointer items-start gap-2.5 rounded-2xl px-3 py-2.5 transition-colors duration-200 ${
          checked ? "bg-emerald-300/[0.08]" : "bg-white/10 hover:bg-white/15"
        }`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(task.id)}
          aria-label={copy.checkAria.replace("{title}", task.title)}
          className="peer sr-only"
        />
        {/* Animated check bubble (the sr-only input keeps the semantics). */}
        <motion.span
          aria-hidden
          whileTap={reduce ? undefined : { scale: 0.85 }}
          className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full transition-colors duration-200 peer-focus-visible:ring-4 peer-focus-visible:ring-white/60 ${
            checked
              ? "bg-emerald-400"
              : "border border-white/45 bg-white/[0.06] group-hover:border-white/70"
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
              className={`text-[12.5px] font-bold leading-[1.6] transition-colors duration-300 ${
                checked ? "text-white/60 line-through decoration-white/70 decoration-2" : "text-white"
              }`}
            >
              {task.title}
            </span>
            {/* Category badge (💧 سقي / 🛡️ وقاية / 🚜 تسميد/صيانة) — a quiet tint,
                never a box. */}
            <span className="shrink-0 rounded-full bg-emerald-300/15 px-1.5 py-px text-[9.5px] font-bold text-emerald-50">
              {copy.categories[task.category] ?? copy.categories.fertilization}
            </span>
          </span>
          <span
            className={`mt-0.5 block text-[11.5px] font-medium leading-[1.7] transition-colors duration-300 ${
              checked ? "text-emerald-50/45" : "text-emerald-50/75"
            }`}
          >
            {task.subtitle}
          </span>
        </span>

        {/* Priority chip — solid amber when it is the day's urgent task, ghost
            otherwise, so the list reads as one hierarchy. */}
        <span
          className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-bold ${
            high ? "bg-amber-300 text-amber-950" : "bg-white/10 text-emerald-50/80"
          }`}
        >
          {high ? copy.priorities.high : copy.priorities.normal}
        </span>
      </label>
    </motion.li>
  );
}

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
  tasks: DisplayTask[];
  done: Record<string, boolean>;
  onToggle: (taskId: string) => void;
  doneCount: number;
  total: number;
  allDone: boolean;
}) {
  const reduce = useReducedMotion();
  const d = t.heroTasks;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  // Collapsed is the default: the hero stays a quick read on a phone, so only
  // the first — always the generator's highest-priority — task is pinned.
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const moreListId = useId();

  const firstTask = tasks[0];
  const restTasks = tasks.slice(1);
  const collapsible = restTasks.length > 0;
  const open = expanded && collapsible;
  const progressLabel = d.progress.replace("{done}", String(doneCount)).replace("{total}", String(total));
  const handleLabel = (open ? d.collapse : d.showMore).replace("{count}", String(restTasks.length));

  return (
    <section aria-labelledby={titleId}>
      {/* Header row: identity + the counter/rail pair. */}
      <header className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="min-w-0 text-[13px] font-bold leading-6 text-white">
          {d.title}
        </h2>
        <span className="flex shrink-0 items-center gap-2">
          <AnimatePresence mode="wait" initial={false}>
            {allDone ? (
              <motion.span
                key="done"
                initial={reduce ? false : { scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={reduce ? undefined : { opacity: 0 }}
                transition={TRAY_SPRING}
                className="text-[10.5px] font-bold text-emerald-200"
              >
                {d.allDone.replace("{done}", String(doneCount)).replace("{total}", String(total))}
              </motion.span>
            ) : (
              <motion.span
                key="progress"
                initial={false}
                exit={reduce ? undefined : { opacity: 0 }}
                className="text-[10.5px] font-semibold tabular-nums text-emerald-50/80"
              >
                {progressLabel}
              </motion.span>
            )}
          </AnimatePresence>
          {/* Day progress — a thin rail beside the counter. */}
          <span
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={doneCount}
            aria-label={progressLabel}
            className="block h-1.5 w-16 overflow-hidden rounded-full bg-white/20"
          >
            <motion.span
              className="block h-full rounded-full bg-emerald-300"
              initial={false}
              animate={{ width: `${pct}%` }}
              transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 180, damping: 24 }}
            />
          </span>
        </span>
      </header>

      {/* Task 1 — pinned, full width, borderless. */}
      {firstTask && (
        <ul className="mt-2.5">
          <TaskRow
            task={firstTask}
            checked={Boolean(done[firstTask.id])}
            onToggle={onToggle}
            copy={d}
            reduce={reduce}
          />
        </ul>
      )}

      {/* Tasks 2…n — the wrapper stays mounted so the handle's `aria-controls`
          never dangles, whatever the state. */}
      <div id={moreListId}>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="rest"
              initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={reduce ? { duration: 0.12 } : TRAY_SPRING}
              className="overflow-hidden"
            >
              <ul className="mt-2 flex flex-col gap-2">
                {restTasks.map((task, index) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    checked={Boolean(done[task.id])}
                    onToggle={onToggle}
                    copy={d}
                    reduce={reduce}
                    delay={reduce ? 0 : Math.min(index, 3) * 0.04}
                  />
                ))}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Integrated handle — a glass pill attached to the tray's foot, not a
          heavy button. 44px+ touch target, spring chevron, keyboard native. */}
      {collapsible && (
        <div className="mt-2.5 flex justify-center">
          <motion.button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={open}
            aria-controls={moreListId}
            whileTap={reduce ? undefined : { scale: 0.98 }}
            className="hero-glass flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-medium text-white backdrop-blur-md transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <span>{handleLabel}</span>
            {!open && <span aria-hidden className="text-[11px] leading-none">⚡</span>}
            <motion.span
              aria-hidden
              initial={false}
              animate={{ rotate: open ? 180 : 0 }}
              transition={reduce ? { duration: 0 } : TRAY_SPRING}
              className="grid place-items-center"
            >
              <ChevronDown size={15} strokeWidth={2.6} />
            </motion.span>
          </motion.button>
        </div>
      )}

      {/* Publish stamp of the 00:00 workflow — quiet, still readable. */}
      <p className="mt-2.5 text-center text-[9.5px] font-medium tracking-wide text-emerald-50/70">
        {d.updatedAi}
      </p>
    </section>
  );
}
