"use client";

/**
 * The three steps of the field flow, shown on the draw screen, the confirm
 * screen and the analysis screen: 1 حدّد · 2 أكّد · 3 حلّل.
 *
 * Display only — it never navigates, never reads data and never changes what
 * a screen does. It answers one question for the farmer at every stage: how far
 * along am I, and what happens next.
 *
 * RTL is structural, not a mirror hack: the list is an `<ol>` inside the page's
 * `dir`, so step 1 sits on the right in Arabic and on the left in French, and
 * the reading order (1 → 2 → 3) is the DOM order for a screen reader.
 */

import { Check } from "lucide-react";
import type { Lang } from "@/lib/wilayas";

export type PlotStep = 1 | 2 | 3;

const STEPS: Record<Lang, { id: PlotStep; label: string }[]> = {
  ar: [
    { id: 1, label: "حدّد" },
    { id: 2, label: "أكّد" },
    { id: 3, label: "حلّل" },
  ],
  fr: [
    { id: 1, label: "Tracer" },
    { id: 2, label: "Confirmer" },
    { id: 3, label: "Analyser" },
  ],
};

const COPY = {
  ar: { aria: "مراحل تحليل القطعة", now: "الخطوة الحالية", done: "تمت" },
  fr: { aria: "Étapes de l'analyse de la parcelle", now: "Étape en cours", done: "terminée" },
} as const;

export default function StepHeader({
  current,
  lang,
  className = "",
}: {
  /** The step this screen belongs to (1 draw, 2 confirm, 3 analyze). */
  current: PlotStep;
  lang: Lang;
  className?: string;
}) {
  const t = COPY[lang];
  const steps = STEPS[lang];
  const font = lang === "ar" ? "font-arabic" : "font-latin";

  return (
    <nav
      aria-label={t.aria}
      className={`${font} ${className}`}
      data-testid="plot-steps"
      data-step={current}
    >
      <ol className="flex w-full items-center">
        {steps.map((step, index) => {
          const done = step.id < current;
          const active = step.id === current;
          return (
            <li
              key={step.id}
              aria-current={active ? "step" : undefined}
              className={`flex min-w-0 flex-1 items-center gap-1.5 ${index > 0 ? "ps-1" : ""}`}
            >
              {/* The rail between two steps: filled once the step behind it is done. */}
              {index > 0 && (
                <span
                  aria-hidden
                  className={`h-px min-w-[6px] max-w-[16px] flex-1 rounded-full ${
                    done || active ? "bg-emerald-500/45" : "bg-emerald-900/12"
                  }`}
                />
              )}
              <span
                aria-hidden
                className={`grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full text-[10.5px] font-black leading-none transition-colors ${
                  active
                    ? "bg-emerald-600 text-white shadow-[0_6px_14px_-6px_rgba(5,150,105,0.9)]"
                    : done
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-white text-emerald-900/40 ring-1 ring-emerald-900/10"
                }`}
              >
                {done ? <Check size={13} strokeWidth={3.2} /> : step.id}
              </span>
              <span
                className={`truncate text-[11.5px] leading-tight ${
                  active
                    ? "font-black text-emerald-950"
                    : done
                      ? "font-bold text-emerald-800/70"
                      : "font-bold text-emerald-900/40"
                }`}
              >
                {step.label}
              </span>
              <span className="sr-only">{active ? t.now : done ? t.done : ""}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
