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
      className={`glass-card flex min-w-0 flex-col rounded-3xl p-4 ${className}`}
    >
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
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
      className={`min-w-0 rounded-2xl px-2.5 py-2 ${
        tone === "warn" ? "bg-amber-50/90 ring-1 ring-amber-200" : "bg-white/70 ring-1 ring-[#E2F1E8]"
      }`}
    >
      <p className="flex items-center gap-1 text-[10px] font-bold text-emerald-800/70">
        {icon}
        {label}
      </p>
      <p className="mt-0.5 truncate text-[14px] font-black tabular-nums text-emerald-950">{value}</p>
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
            className={`relative flex h-9 flex-1 items-center justify-center rounded-xl px-1 text-[11.5px] font-extrabold transition-colors ${FOCUS_RING} ${
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
