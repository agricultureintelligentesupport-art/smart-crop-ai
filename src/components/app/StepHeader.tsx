"use client";

/**
 * The draw → confirm → analyse flow header: three numbered steps in RTL
 * reading order — «1 حدّد» (draw the boundary), «2 أكّد» (confirm the plot),
 * «3 حلّل» (run the satellite analysis). Display only: it names the stage the
 * farmer is on and never acts as navigation.
 *
 * Arabic labels only (the app's flow language), one shared component so the
 * three screens of the flow can never drift apart visually. `tone="night"`
 * is the translucent variant rendered over the analysis screen's dark hero.
 * Styling lives with the plot-flow tokens (`.plot-steps` in plot-theme.css).
 */

/** RTL reading order: step 1 first (right), step 3 last (left). */
const STEPS = [
  { n: 1, label: "حدّد" },
  { n: 2, label: "أكّد" },
  { n: 3, label: "حلّل" },
] as const;

export default function StepHeader({ current, tone = "light" }: { current: 1 | 2 | 3; tone?: "light" | "night" }) {
  return (
    <nav aria-label="خطوات تحليل القطعة" className={`plot-steps${tone === "night" ? " plot-steps--night" : ""}`}>
      <ol>
        {STEPS.map((step, index) => {
          const state = step.n < current ? "done" : step.n === current ? "current" : "next";
          return (
            <li key={step.n}>
              {index > 0 && <span aria-hidden className={`plot-steps__link${step.n <= current ? " plot-steps__link--on" : ""}`} />}
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={`plot-steps__step${state === "done" ? " plot-steps__step--done" : state === "current" ? " plot-steps__step--current" : ""}`}
              >
                <span aria-hidden className="plot-steps__num">{step.n}</span>
                <span className="plot-steps__label">{step.label}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
