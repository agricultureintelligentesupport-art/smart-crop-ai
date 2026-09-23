"use client";

import { motion } from "framer-motion";
import { Bot, Droplets, House, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { FOCUS_RING, GPU, SPRING } from "@/components/auth/ui";
import type { DashboardCopy } from "@/lib/dashboard/copy";

/** Screens driven by the bottom bar. `assistant` is a routed page, not a tab. */
export type DashboardTab = "home" | "irrigation" | "profile";

const THUMB_LAYOUT_ID = "dash-nav-thumb";

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
        <motion.span
          layoutId={THUMB_LAYOUT_ID}
          transition={SPRING}
          className={`absolute inset-0 rounded-[20px] bg-gradient-to-b from-emerald-500/15 to-emerald-500/10 ring-1 ring-emerald-500/25 ${GPU}`}
        />
      )}
      <span className="relative z-10 flex flex-col items-center gap-0.5">
        <motion.span
          aria-hidden
          animate={{ y: active ? -1 : 0, scale: active ? 1.06 : 1 }}
          transition={SPRING}
          className="block"
        >
          <Icon size={21} strokeWidth={active ? 2.5 : 2.1} />
        </motion.span>
        <span className="text-[10px] font-black leading-none">{label}</span>
      </span>
    </motion.button>
  );
}

/**
 * Mobile app-shell bottom navigation: a floating glass pill fixed above the
 * safe area, with four primary destinations. Home / Irrigation / Profile are
 * in-dashboard screens; Assistant routes to the AI assistant page.
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
      <div className="pointer-events-auto w-full max-w-[560px] px-3 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <div className="glass flex items-center gap-1 rounded-[26px] p-1.5 shadow-[0_18px_40px_-18px_rgba(6,78,59,0.45)]">
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
                <span className="text-[10px] font-black leading-none">{t.nav.assistant}</span>
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
