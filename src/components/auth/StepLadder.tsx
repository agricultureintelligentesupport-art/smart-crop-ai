"use client";

import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { memo } from "react";
import { FOCUS_RING, GPU, SPRING } from "./ui";

export type StepId = "method" | "role" | "location" | "done";

/**
 * Progress ladder for the onboarding steps. Completed steps stay clickable so
 * the user can go back and change a decision without losing the rest.
 */
function StepLadder({
  plan,
  current,
  labels,
  ariaLabel,
  stepWord,
  ofWord,
  onSelect,
  allDone = false,
}: {
  plan: StepId[];
  current: StepId;
  labels: Record<Exclude<StepId, "done">, string>;
  ariaLabel: string;
  stepWord: string;
  ofWord: string;
  onSelect?: (step: StepId) => void;
  /** Completion screen: every marker turns into a check. */
  allDone?: boolean;
}) {
  const currentIndex = allDone ? plan.length : Math.max(plan.indexOf(current), 0);
  const progress = (Math.min(currentIndex + (allDone ? 0 : 1), plan.length) / plan.length) * 100;

  return (
    <nav aria-label={ariaLabel} className="mb-2.5">
      <ol className="flex items-start justify-between gap-1">
        {plan.map((step, i) => {
          const done = allDone || i < currentIndex;
          const active = !allDone && i === currentIndex;
          const clickable = Boolean(onSelect) && (done || active);
          const label = labels[step as Exclude<StepId, "done">];

          const content = (
            <>
              <span
                aria-hidden
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border text-[12px] font-black transition-colors ${
                  done
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : active
                      ? "border-emerald-600 bg-white text-emerald-700 shadow-[0_0_0_4px_rgba(16,185,129,0.18)]"
                      : "border-emerald-900/15 bg-white/70 text-emerald-900/45"
                }`}
              >
                {done ? <Check size={14} strokeWidth={3.2} /> : i + 1}
              </span>
              <span
                className={`text-[10.5px] font-black whitespace-nowrap transition-colors ${
                  active ? "text-emerald-800" : done ? "text-emerald-700/85" : "text-emerald-900/45"
                }`}
              >
                {label}
              </span>
            </>
          );

          return (
            <li key={step} className="flex min-w-0 flex-1 justify-center">
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onSelect?.(step)}
                  aria-current={active ? "step" : undefined}
                  aria-label={`${stepWord} ${i + 1} ${ofWord} ${plan.length}: ${label}${done ? " ✓" : ""}`}
                  className={`flex flex-col items-center gap-1 rounded-2xl px-1.5 py-1 transition-colors hover:bg-white/70 ${FOCUS_RING}`}
                >
                  {content}
                </button>
              ) : (
                <span
                  aria-current={active ? "step" : undefined}
                  className="flex flex-col items-center gap-1 px-1.5 py-1"
                >
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-emerald-900/10" aria-hidden>
        <motion.div
          className={`h-full rounded-full bg-gradient-to-r from-emerald-400 via-emerald-500 to-green-600 ${GPU}`}
          animate={{ width: `${progress}%` }}
          transition={SPRING}
        />
      </div>
    </nav>
  );
}

export default memo(StepLadder);
