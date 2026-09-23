"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { FOCUS_RING, GPU, SPRING } from "@/components/auth/ui";

/**
 * Shared shells for the dashboard cards.
 *
 * Signed-in surfaces are opaque and crisp (`.app-surface`) instead of the
 * glass recipe used by the auth wizard: fewer blurs to composite, tighter
 * type scale, and the grouped-inset look users read as "native app".
 */

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
    <section aria-label={title} className={`app-surface flex min-w-0 flex-col p-4 ${className}`}>
      <header className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[0.85rem] bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="text-[15px] font-black leading-5 tracking-tight text-emerald-950">{title}</h2>
          {subtitle && (
            <p className="mt-1 text-[12px] font-semibold leading-[1.6] text-emerald-900/60">{subtitle}</p>
          )}
        </div>
        {aside && <div className="shrink-0 pt-0.5">{aside}</div>}
      </header>
      <div className="mt-3.5 flex-1">{children}</div>
    </section>
  );
}

/**
 * Section header: a small grouped-list label with an optional trailing action.
 * Gives the long dashboard scroll a native "grouped list" rhythm.
 */
export function SectionHeader({
  title,
  action,
  icon,
}: {
  title: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3 px-1">
      <h2 className="flex items-center gap-1.5 text-[12px] font-black tracking-wide text-emerald-800/65">
        {icon}
        {title}
      </h2>
      {action}
    </div>
  );
}

export function Metric({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  tone?: "default" | "warn";
}) {
  return (
    <div
      className={`min-w-0 rounded-[1rem] px-3 py-2.5 ${
        tone === "warn" ? "bg-amber-50 ring-1 ring-amber-200" : "app-tile"
      }`}
    >
      <p className="flex items-center gap-1 text-[10.5px] font-bold tracking-wide text-emerald-800/65">
        {icon}
        {label}
      </p>
      <p className="mt-1 truncate text-[15px] font-black tabular-nums text-emerald-950">{value}</p>
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
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    slate: "border-[rgba(6,78,59,0.1)] bg-white text-emerald-900/75",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10.5px] font-black tracking-tight ${tones[tone]}`}
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
      className="flex items-center gap-1 rounded-[1.1rem] bg-[#f1f7f3] p-1 ring-1 ring-[rgba(6,78,59,0.07)]"
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
            className={`relative flex h-11 flex-1 items-center justify-center rounded-[0.9rem] px-1 text-[12px] font-extrabold transition-colors ${FOCUS_RING} ${
              active ? "text-white" : "text-emerald-900/70 hover:text-emerald-800"
            }`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className={`absolute inset-0 rounded-[0.9rem] bg-gradient-to-br from-emerald-500 to-green-600 shadow-[0_8px_18px_-10px_rgba(16,185,129,0.9)] ${GPU}`}
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
    <div className="h-2 w-full overflow-hidden rounded-full bg-emerald-900/8" aria-hidden>
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
