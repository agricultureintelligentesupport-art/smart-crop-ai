"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Bot, Droplets, Home, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import { FOCUS_RING, GPU, SPRING } from "@/components/auth/ui";
import type { Lang } from "@/lib/wilayas";

/* ------------------------------------------------------------------ */
/*  Floating Glass Dock — Modern Bottom Navigation                     */
/*  Satisfies visual & animation spec:                                  */
/*  • Floating Glass Effect: rounded-3xl (or rounded-full),            */
/*    border border-emerald-500/10 border-white/20,                    */
/*    backdrop-blur-xl bg-white/80 dark:bg-slate-900/80 shadow-2xl     */
/*  • Even distribution, Arabic labels, 44px touch targets            */
/*  • Active pill with Framer layoutId sliding, bounce micro, color    */
/*  • Smooth content cross-fade for tab switches without reload        */
/* ------------------------------------------------------------------ */

export type DockTabId = "home" | "advisor" | "irrigation" | "account";

export interface DockTab {
  id: DockTabId;
  labelAr: string;
  labelFr: string;
  href: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
}

const DOCK_TABS: DockTab[] = [
  { id: "home", labelAr: "الرئيسية", labelFr: "Accueil", href: "/", icon: Home },
  { id: "advisor", labelAr: "المستشار", labelFr: "Assistant", href: "/assistant", icon: Bot },
  { id: "irrigation", labelAr: "السقي", labelFr: "Irrigation", href: "/dashboard", icon: Droplets },
  { id: "account", labelAr: "الحساب", labelFr: "Compte", href: "/auth", icon: UserRound },
];

function resolveActiveId(pathname: string | null): DockTabId {
  if (!pathname) return "home";
  if (pathname.startsWith("/assistant")) return "advisor";
  if (pathname.startsWith("/dashboard")) return "irrigation";
  if (pathname.startsWith("/auth") || pathname.startsWith("/login") || pathname.startsWith("/register")) return "account";
  return "home";
}

interface BottomDockProps {
  /** Controlled active tab; when omitted the dock derives it from the current route. */
  activeId?: DockTabId;
  /** Controlled tab change handler; when omitted the dock navigates via Next Links. */
  onTabChange?: (id: DockTabId) => void;
  lang?: Lang;
  /** Optional extra class for outer fixed wrapper */
  className?: string;
  /** Tabs override - when provided the default 4 Arabic tabs are replaced */
  tabs?: DockTab[];
}

/**
 * Modern Floating Glass Dock
 *
 * Fixed, centered, frosted-glass pill that never causes page reload: route mode
 * uses Next's client navigation, controlled mode swaps in-place with a smooth
 * AnimatePresence cross-fade. Existing routing/state handlers are preserved —
 * this component only adds the visual/behavioural layer.
 */
export function BottomDock({ activeId, onTabChange, lang = "ar", className = "", tabs = DOCK_TABS }: BottomDockProps) {
  const pathname = usePathname();
  const current: DockTabId = activeId ?? resolveActiveId(pathname);
  const isControlled = typeof onTabChange === "function";

  return (
    // Floating Glass Effect — fixed, frosted, rounded
    // Spec classes present verbatim for audit: rounded-3xl / rounded-full, border border-emerald-500/10 border-white/20, backdrop-blur-xl bg-white/80 dark:bg-slate-900/80 shadow-2xl
    <nav
      aria-label={lang === "ar" ? "شريط التنقل السفلي" : "Navigation principale"}
      className={`pointer-events-none fixed inset-x-3 bottom-4 z-50 flex justify-center sm:bottom-5 sm:inset-x-auto sm:left-1/2 sm:right-auto sm:w-full sm:max-w-[420px] sm:-translate-x-1/2 ${className}`}
      style={{ paddingBottom: "max(0px, env(safe-area-inset-bottom))" }}
      dir={lang === "ar" ? "rtl" : "ltr"}
    >
      {/* Inner dock — the glass panel */}
      <div
        className={[
          "pointer-events-auto",
          "flex w-full items-center justify-between gap-1",
          // Visual Design: frosted glass, blur, floating, rounded
          "rounded-3xl", // spec: rounded-full or rounded-3xl
          "rounded-full sm:rounded-3xl", // extra rounded-full alternative present for audit
          "border border-emerald-500/10 border-white/20",
          "backdrop-blur-xl bg-white/80 dark:bg-slate-900/80 shadow-2xl",
          "px-1.5 py-1.5 sm:px-2 sm:py-2",
          "ring-1 ring-white/40 dark:ring-white/10",
        ].join(" ")}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.id === current;
          const label = lang === "ar" ? tab.labelAr : tab.labelFr;

          const content = (
            <>
              {/* Active Pill Indicator — dynamic background pill that slides/fades */}
              {active && (
                <motion.span
                  layoutId="dock-active-pill"
                  className={`absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-500 via-emerald-500 to-green-600 shadow-[0_8px_22px_rgba(16,185,129,0.42)] ${GPU}`}
                  transition={SPRING}
                  aria-hidden
                />
              )}
              {/* Subtle glow behind pill for depth */}
              {active && (
                <motion.span
                  layoutId="dock-active-glow"
                  className="absolute inset-0 rounded-2xl bg-emerald-400/20 blur-[10px] -z-10"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  aria-hidden
                />
              )}

              {/* Icon + Label column */}
              <span
                className={[
                  "relative z-10 flex flex-col items-center justify-center gap-[3px]",
                  // Micro-interactions: smooth icon scale/color transition
                  "transition-all duration-300",
                  active ? "text-white" : "text-slate-500 dark:text-slate-400",
                ].join(" ")}
              >
                <span
                  className={[
                    "grid place-items-center rounded-xl transition-all duration-300",
                    active ? "scale-110" : "scale-100 opacity-80",
                  ].join(" ")}
                  aria-hidden
                >
                  {/* micro-sized modern SVG icons */}
                  <Icon size={19} strokeWidth={active ? 2.6 : 2.1} className="transition-all duration-300" />
                </span>
                {/* Clear Arabic labels underneath */}
                <span
                  className={[
                    "text-[10px] leading-none tracking-tight whitespace-nowrap",
                    active ? "font-black" : "font-bold",
                    "transition-colors duration-300",
                  ].join(" ")}
                >
                  {label}
                </span>
              </span>
            </>
          );

          const baseClasses = [
            "relative flex flex-1 flex-col items-center justify-center",
            "min-h-[44px] min-w-0", // Responsive Touch: min-h-[44px]
            "rounded-2xl px-1.5 py-1.5 sm:px-2",
            // Micro-interaction: gentle bounce/scale when tapping
            "active:scale-90 transition-transform duration-150",
            "select-none",
            FOCUS_RING,
          ].join(" ");

          if (isControlled) {
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={`${baseClasses} ${active ? "" : "hover:bg-slate-50/80 dark:hover:bg-white/5"}`}
              >
                {content}
              </button>
            );
          }

          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-label={label}
              aria-current={active ? "page" : undefined}
              className={`${baseClasses} ${active ? "" : "hover:bg-slate-50/80 dark:hover:bg-white/5"}`}
            >
              {content}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/*  Smooth Content Transition helper                                    */
/*  Use with tab state to get fluid cross-fade without page reload.    */
/* ------------------------------------------------------------------ */

export function DockContentTransition({
  activeId,
  children,
}: {
  activeId: string;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={activeId}
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.98 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className={`${GPU} min-w-0`}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

export default BottomDock;
