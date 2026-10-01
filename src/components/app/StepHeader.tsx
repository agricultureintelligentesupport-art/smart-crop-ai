"use client";

/**
 * The draw → confirm → analyse flow header: three numbered steps in RTL
 * reading order — «1 حدّد» (draw the boundary), «2 أكّد» (confirm the plot),
 * «3 حلّل» (run the satellite analysis). Display only: it names the stage the
 * farmer is on and never acts as navigation.
 *
 * Arabic labels only (the app's flow language), one shared component so the
 * three screens of the flow can never drift apart visually.
 */

/** RTL reading order: step 1 first (right), step 3 last (left). */
const STEPS = [
  { n: 1, label: "حدّد" },
  { n: 2, label: "أكّد" },
  { n: 3, label: "حلّل" },
] as const;

export default function StepHeader({ current }: { current: 1 | 2 | 3 }) {
  return (
    <nav aria-label="خطوات تحليل القطعة" className="shrink-0 px-4 pb-2 pt-1">
      <ol className="mx-auto flex w-full max-w-md items-center">
        {STEPS.map((step, index) => {
          const state = step.n < current ? "done" : step.n === current ? "current" : "next";
          return (
            <li key={step.n} className="flex min-w-0 flex-1 items-center last:flex-none">
              {index > 0 && (
                <span
                  aria-hidden
                  className={`mx-1 h-[2px] flex-1 rounded-full ${
                    step.n <= current
                      ? "bg-gradient-to-l from-emerald-500 to-emerald-400"
                      : "bg-emerald-900/10"
                  }`}
                />
              )}
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={`flex min-h-[44px] items-center gap-1.5 rounded-full px-1.5 ${
                  state === "current" ? "text-emerald-950" : state === "done" ? "text-emerald-800/80" : "text-emerald-900/35"
                }`}
              >
                <span
                  aria-hidden
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-black tabular-nums ${
                    state === "current"
                      ? "bg-gradient-to-br from-emerald-500 to-green-600 text-white shadow-[0_8px_16px_-8px_rgba(5,120,85,0.8)]"
                      : state === "done"
                        ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200"
                        : "bg-emerald-900/5 text-emerald-900/40"
                  }`}
                >
                  {step.n}
                </span>
                <span
                  className={`text-[12.5px] leading-none ${
                    state === "current" ? "font-black" : "font-bold"
                  }`}
                >
                  {step.label}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
