"use client";

import { motion } from "framer-motion";
import { Bot, Droplets, House, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { FOCUS_RING, GPU, SPRING } from "@/components/auth/ui";
import type { DashboardCopy } from "@/lib/dashboard/copy";

/** Screens driven by the bottom dock. `assistant` is a routed page, not a tab. */
export type DashboardTab = "home" | "irrigation" | "profile";

const PILL_LAYOUT_ID = "dash-nav-thumb";
const DOT_LAYOUT_ID = "dash-nav-dot";

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
      whileTap={{ scale: 0.92 }}
      transition={SPRING}
      className={`relative flex h-14 min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[20px] transition-colors duration-200 ${FOCUS_RING} ${
        active ? "text-emerald-700" : "text-emerald-900/45 hover:text-emerald-800"
      }`}
    >
      {active && (
        <>
          <motion.span
            layoutId={PILL_LAYOUT_ID}
            transition={SPRING}
            className={`absolute inset-0 rounded-[20px] bg-gradient-to-b from-emerald-500/15 to-teal-500/10 ring-1 ring-emerald-500/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] ${GPU}`}
          />
          <motion.span
            layoutId={DOT_LAYOUT_ID}
            transition={SPRING}
            aria-hidden
            className="absolute bottom-[3px] h-1 w-1 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.9)]"
          />
        </>
      )}
      <span className="relative z-10 flex flex-col items-center gap-0.5">
        <motion.span
          aria-hidden
          animate={{ y: active ? -1 : 0, scale: active ? 1.08 : 1 }}
          transition={SPRING}
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
 * safe area, with four primary destinations. Home / Irrigation / Profile are
 * in-dashboard screens; Assistant routes to the AI assistant page.
 * A spring pill + glowing dot slide between active items.
 * Order follows the RTL/LTR document direction automatically.
 */
export default function BottomNav({
  t,
  tab,
  onTabChange,
  assistantHref = "/assistant",
}: {
  t: DashboardCopy;
  tab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
  assistantHref?: string;
}) {
  return (
    <nav
      aria-label={t.nav.aria}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center"
    >
      <div className="pointer-events-auto w-full max-w-[560px] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="glass-dock flex items-center gap-1 rounded-[26px] p-1.5">
          <NavItem
            icon={House}
            label={t.nav.home}
            active={tab === "home"}
            onClick={() => onTabChange("home")}
          />
          <motion.div
            whileTap={{ scale: 0.92 }}
            transition={SPRING}
            className="min-w-0 flex-1"
          >
            <Link
              href={assistantHref}
              className={`flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-[20px] text-emerald-900/45 transition-colors hover:text-emerald-800 ${FOCUS_RING}`}
            >
              <span className="flex flex-col items-center gap-0.5">
                <Bot size={21} strokeWidth={2.1} aria-hidden />
                <span className="text-[10px] font-bold leading-none">{t.nav.assistant}</span>
              </span>
            </Link>
          </motion.div>
          <NavItem
            icon={Droplets}
            label={t.nav.irrigation}
            active={tab === "irrigation"}
            onClick={() => onTabChange("irrigation")}
          />
          <NavItem
            icon={UserRound}
            label={t.nav.profile}
            active={tab === "profile"}
            onClick={() => onTabChange("profile")}
          />
        </div>
      </div>
    </nav>
  );
}
