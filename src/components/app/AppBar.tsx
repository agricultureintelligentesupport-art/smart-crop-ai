"use client";

import { memo, type ReactNode } from "react";
import { SHELL_BAR_HEIGHT, SHELL_COLUMN } from "./shell";

/**
 * Translucent app bar: fixed to the top edge, blurs whatever scrolls under it
 * and grows a hairline + a hint of elevation once the content moves (the
 * "large title collapsing" cue users expect from a native app).
 *
 * Purely presentational — every screen passes its own leading/trailing slots.
 */
function AppBar({
  label,
  leading,
  trailing,
  elevated = false,
}: {
  /** Accessible name of the header landmark. */
  label: string;
  leading: ReactNode;
  trailing?: ReactNode;
  /** Adds the hairline + shadow once the screen has scrolled. */
  elevated?: boolean;
}) {
  return (
    <header
      aria-label={label}
      className={`app-bar bar-safe fixed inset-x-0 top-0 z-40 ${elevated ? "app-bar-elevated" : ""}`}
    >
      <div className={`${SHELL_COLUMN} ${SHELL_BAR_HEIGHT} flex items-center gap-2 px-4`}>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">{leading}</div>
        {trailing && <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>}
      </div>
    </header>
  );
}

export default memo(AppBar);

/**
 * Brand mark used in the bar's leading slot: a small gradient tile plus a
 * two-line title (name over a live status line). The tile hides below 360px
 * so the title never truncates on the narrowest phones.
 */
export function AppBarBrand({
  icon,
  title,
  subtitle,
  /** Optional trailing node rendered inside the leading block (e.g. a dot). */
  status,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  status?: ReactNode;
}) {
  return (
    <>
      <span
        aria-hidden
        className="hidden h-9 w-9 shrink-0 place-items-center rounded-[0.9rem] bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 shadow-[0_6px_16px_-6px_rgba(16,185,129,0.9)] min-[360px]:grid"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[13.5px] font-black tracking-tight text-emerald-950">{title}</span>
        <span className="flex items-center gap-1.5">
          {status}
          <span className="truncate text-[10.5px] font-bold text-emerald-800/70">{subtitle}</span>
        </span>
      </span>
    </>
  );
}

/** Soft 44px round action used in the bar's trailing slot. */
export function AppBarAction({
  label,
  onClick,
  children,
  className = "",
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-[rgba(6,78,59,0.09)] bg-white/85 text-emerald-800 shadow-[0_1px_2px_rgba(6,78,59,0.06)] transition-colors hover:bg-white active:scale-[0.96] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45 ${className}`}
    >
      {children}
    </button>
  );
}
