"use client";

import { motion } from "framer-motion";
import { Bot, Droplets, House, UserRound, type LucideIcon } from "lucide-react";
import { FOCUS_RING, GPU } from "@/components/auth/ui";
import type { DashboardCopy } from "@/lib/dashboard/copy";

/** Screens driven by the bottom dock (assistant now hosts the plant scan). */
export type DashboardTab = "home" | "irrigation" | "assistant" | "profile";

const PILL_LAYOUT_ID = "dash-nav-thumb";
const DOT_LAYOUT_ID = "dash-nav-dot";
/** Slightly bouncier than the shared SPRING so the pill snaps between tabs. */
const DOCK_SPRING = { type: "spring", stiffness: 430, damping: 30, mass: 0.9 } as const;

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      whileTap={{ scale: 0.9 }}
      transition={DOCK_SPRING}
      className={`relative flex h-14 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[20px] transition-colors duration-200 ${FOCUS_RING} ${
        active ? "text-emerald-700" : "text-emerald-900/45 hover:text-emerald-800"
      }`}
    >
      {active && (
        <>
          <motion.span
            layoutId={PILL_LAYOUT_ID}
            transition={DOCK_SPRING}
            className={`absolute inset-0 rounded-[20px] bg-gradient-to-b from-emerald-500/15 to-teal-500/10 ring-1 ring-emerald-500/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] ${GPU}`}
          />
          <motion.span
            layoutId={DOT_LAYOUT_ID}
            transition={DOCK_SPRING}
            aria-hidden
            className="absolute bottom-[3px] h-1 w-1 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.9)]"
          />
        </>
      )}
      <span className="relative z-10 flex flex-col items-center gap-0.5">
        <motion.span
          aria-hidden
          animate={{ y: active ? -1 : 0, scale: active ? 1.08 : 1 }}
          transition={DOCK_SPRING}
          className="block"
        >
          <Icon size={21} strokeWidth={active ? 2.6 : 2.1} />
        </motion.span>
        <span className={`text-[10px] leading-none ${active ? "font-black" : "font-bold"}`}>{label}</span>
      </span>
    </motion.button>
  );
}

/**
 * Mobile app-shell bottom dock: a premium frosted-glass pill fixed above the
 * safe area, with the four primary screens (home / irrigation / assistant /
 * profile). The gradient pill + glowing dot bounce smoothly into position on
 * every switch. Order follows the RTL/LTR document direction automatically.
 */
export default function BottomNav({
  t,
  tab,
  onTabChange,
}: {
  t: DashboardCopy;
  tab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
}) {
  const items: { id: DashboardTab; icon: LucideIcon; label: string }[] = [
    { id: "home", icon: House, label: t.nav.home },
    { id: "irrigation", icon: Droplets, label: t.nav.irrigation },
    { id: "assistant", icon: Bot, label: t.nav.assistant },
    { id: "profile", icon: UserRound, label: t.nav.profile },
  ];

  return (
    <nav
      aria-label={t.nav.aria}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center"
    >
      <div className="pointer-events-auto w-full max-w-[560px] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="glass-dock flex items-center gap-1 rounded-[26px] p-1.5">
          {items.map(({ id, icon, label }) => (
            <NavItem
              key={id}
              icon={icon}
              label={label}
              active={tab === id}
              onClick={() => onTabChange(id)}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}
