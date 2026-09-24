"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Bot, Settings, Sprout, UserRound } from "lucide-react";
import Link from "next/link";
import { memo, type ReactNode } from "react";
import { FOCUS_RING, SPRING } from "@/components/auth/ui";
import { APP_SHELL } from "@/lib/app/copy";
import type { Lang } from "@/lib/wilayas";

export type TabId = "home" | "assistant" | "account" | "settings";

const TAB_ICONS: Record<TabId, typeof Bot> = {
  home: Sprout,
  assistant: Bot,
  account: UserRound,
  settings: Settings,
};

/**
 * Bottom tab bar — the app's primary navigation, sized for the thumb zone.
 *
 * - Full-bleed and safe-area padded on phones, a floating pill from `sm` up.
 * - The active tab is marked by a spring-eased pill that slides between tabs.
 * - "حسابي" opens the account sheet when a handler is supplied (dashboard) and
 *   otherwise deep-links to the dashboard with `#account` (assistant screen),
 *   so the bar never dead-ends.
 * - "الإعدادات" works the same way with `onSettings` / `#settings`.
 */
function TabBar({
  active,
  lang,
  onAccount,
  accountOpen = false,
  onSettings,
  settingsOpen = false,
}: {
  active: TabId;
  lang: Lang;
  onAccount?: () => void;
  /** Keeps the account pill lit while its sheet is open. */
  accountOpen?: boolean;
  onSettings?: () => void;
  /** Keeps the settings pill lit while its sheet is open. */
  settingsOpen?: boolean;
}) {
  const t = APP_SHELL[lang];
  const reduce = useReducedMotion();

  const items: { id: TabId; label: string; href?: string }[] = [
    { id: "home", label: t.tabs.home, href: "/dashboard" },
    { id: "assistant", label: t.tabs.assistant, href: "/assistant" },
    { id: "account", label: t.tabs.account, href: onAccount ? undefined : "/dashboard#account" },
    { id: "settings", label: t.tabs.settings, href: onSettings ? undefined : "/dashboard#settings" },
  ];

  return (
    <nav
      aria-label={t.navLabel}
      className="tab-safe app-tabbar fixed inset-x-0 bottom-0 z-40 sm:inset-x-4 sm:bottom-4 sm:mx-auto sm:max-w-[420px]"
    >
      <ul className="flex items-stretch px-2 sm:px-3">
        {items.map((item) => {
          const Icon = TAB_ICONS[item.id];
          const isActive = item.id === active || (item.id === "account" && accountOpen) ||
            (item.id === "settings" && settingsOpen);
          const className = `relative flex h-[3.25rem] flex-1 select-none flex-col items-center justify-center gap-0.5 rounded-[1.1rem] transition-transform active:scale-[0.94] ${FOCUS_RING}`;

          const content: ReactNode = (
            <>
              {isActive && (
                <motion.span
                  aria-hidden
                  layoutId="tab-active-pill"
                  className="absolute inset-x-1 top-1 bottom-1 rounded-[1.1rem] bg-emerald-500/12 ring-1 ring-emerald-500/15"
                  transition={reduce ? { duration: 0 } : SPRING}
                />
              )}
              <motion.span
                aria-hidden
                animate={{ scale: isActive && !reduce ? 1.08 : 1, y: isActive && !reduce ? -1 : 0 }}
                transition={reduce ? { duration: 0 } : SPRING}
                className="relative z-10 grid place-items-center"
              >
                <Icon
                  size={22}
                  strokeWidth={isActive ? 2.6 : 2.1}
                  className={isActive ? "text-emerald-700" : "text-emerald-900/45"}
                />
              </motion.span>
              <span
                className={`relative z-10 text-[10.5px] font-black tracking-tight transition-colors ${
                  isActive ? "text-emerald-800" : "text-emerald-900/50"
                }`}
              >
                {item.label}
              </span>
            </>
          );

          return (
            <li key={item.id} className="flex flex-1">
              {item.href ? (
                <Link href={item.href} aria-current={isActive ? "page" : undefined} className={className}>
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={item.id === "settings" ? onSettings : onAccount}
                  aria-expanded={item.id === "settings" ? settingsOpen : accountOpen}
                  className={className}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default memo(TabBar);
