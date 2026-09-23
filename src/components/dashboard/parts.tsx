"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { FOCUS_RING, GPU, SPRING } from "@/components/auth/ui";

/** Shared shells for the dashboard cards. */

export function Card({
  title,
  subtitle,
  icon,
  children,
  className = "",
  aside,
}: {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
  aside?: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`glass-widget flex min-w-0 flex-col rounded-3xl p-4 ${className}`}
    >
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-50 to-teal-100 text-emerald-700 ring-1 ring-emerald-500/15"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-black leading-5 text-emerald-950">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-[11px] font-semibold leading-4 text-emerald-900/65">{subtitle}</p>
          )}
        </div>
        {aside}
      </header>
      <div className="mt-3 flex-1">{children}</div>
    </section>
  );
}

/** Icon tints for the 2×2 metric widget grid (weather + irrigation). */
const METRIC_TINTS = {
  emerald: "bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-600 ring-emerald-200/70",
  sky: "bg-gradient-to-br from-sky-50 to-sky-100 text-sky-600 ring-sky-200/70",
  blue: "bg-gradient-to-br from-blue-50 to-blue-100 text-blue-600 ring-blue-200/70",
  amber: "bg-gradient-to-br from-amber-50 to-amber-100 text-amber-600 ring-amber-200/70",
  rose: "bg-gradient-to-br from-rose-50 to-rose-100 text-rose-600 ring-rose-200/70",
} as const;

export type MetricTint = keyof typeof METRIC_TINTS;

export function Metric({
  label,
  value,
  icon,
  tone = "default",
  tint = "emerald",
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  tone?: "default" | "warn";
  tint?: MetricTint;
}) {
  const resolved: MetricTint = tone === "warn" ? "amber" : tint;
  return (
    <div className="min-w-0 rounded-2xl bg-white/85 p-3 ring-1 ring-emerald-500/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_10px_24px_-18px_rgba(6,78,59,0.45)]">
      <span
        aria-hidden
        className={`grid h-8 w-8 place-items-center rounded-xl ring-1 ${METRIC_TINTS[resolved]}`}
      >
        {icon}
      </span>
      <p className="mt-2 truncate text-[10px] font-bold text-emerald-800/70">{label}</p>
      <p
        dir="ltr"
        className={`mt-0.5 truncate text-start text-[16px] font-black tabular-nums tracking-tight ${
          tone === "warn" ? "text-amber-700" : "text-emerald-950"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export function Chip({
  children,
  tone = "emerald",
  icon,
}: {
  children: ReactNode;
  tone?: "emerald" | "amber" | "slate";
  icon?: ReactNode;
}) {
  const tones = {
    emerald: "border-emerald-200 bg-emerald-50/90 text-emerald-800",
    amber: "border-amber-200 bg-amber-50/90 text-amber-800",
    slate: "border-[#E2F1E8] bg-white/85 text-emerald-900/80",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[3px] text-[10.5px] font-black ${tones[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  layoutId,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  layoutId: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex items-center gap-1 rounded-2xl border border-[#E2F1E8] bg-white/60 p-1"
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.id)}
            className={`relative flex h-11 flex-1 cursor-pointer items-center justify-center rounded-xl px-1 text-[11.5px] font-extrabold transition-colors ${FOCUS_RING} ${
              active ? "text-white" : "text-emerald-900/70 hover:text-emerald-800"
            }`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className={`absolute inset-0 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 ${GPU}`}
                transition={SPRING}
              />
            )}
            <span className="relative z-10 whitespace-nowrap">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Progress({ value, tone = "emerald" }: { value: number; tone?: "emerald" | "amber" }) {
  const clamped = Math.min(Math.max(value, 0), 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-emerald-900/10" aria-hidden>
      <motion.div
        className={`h-full rounded-full ${
          tone === "amber"
            ? "bg-gradient-to-r from-amber-400 to-amber-500"
            : "bg-gradient-to-r from-emerald-400 via-emerald-500 to-green-600"
        } ${GPU}`}
        initial={{ width: 0 }}
        animate={{ width: `${clamped}%` }}
        transition={SPRING}
      />
    </div>
  );
}

/** Compact data-viz sparkline (a chart, not an icon). */
export function Sparkline({
  values,
  min,
  max,
  tone = "emerald",
  label,
}: {
  values: number[];
  min: number;
  max: number;
  tone?: "emerald" | "amber";
  label: string;
}) {
  const w = 240;
  const h = 64;
  const span = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * w;
    const y = h - ((v - min) / span) * (h - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke = tone === "amber" ? "#f59e0b" : "#10b981";
  const fill = tone === "amber" ? "rgba(245,158,11,0.18)" : "rgba(16,185,129,0.18)";

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={label}
      className="h-16 w-full"
      preserveAspectRatio="none"
    >
      <polygon points={`0,${h} ${points.join(" ")} ${w},${h}`} fill={fill} />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {values.map((v, i) => {
        const [x, y] = points[i].split(",");
        return <circle key={i} cx={x} cy={y} r={i === values.length - 1 ? 3.4 : 2} fill={stroke} />;
      })}
    </svg>
  );
}
