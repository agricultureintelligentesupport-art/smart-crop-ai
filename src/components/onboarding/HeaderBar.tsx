"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Leaf } from "lucide-react";
import type { Copy, Lang } from "@/lib/content";

const LANGS: { code: Lang; label: string; full: string }[] = [
  { code: "ar", label: "ع", full: "العربية" },
  { code: "fr", label: "FR", full: "Français" },
];

export default function HeaderBar({
  t,
  lang,
  onLangChange,
  showSkip,
  onSkip,
}: {
  t: Copy;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  showSkip: boolean;
  onSkip: () => void;
}) {
  return (
    <header className="pt-safe relative z-30 flex shrink-0 items-center justify-between gap-1.5 px-3.5 pb-1 sm:px-4">
      {/* App badge — starts at the right in RTL, left in LTR */}
      <div className="glass flex h-12 min-w-0 items-center gap-2 rounded-2xl px-2 shadow-sm">
        <span className="hidden h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 shadow-[0_0_16px_rgba(16,185,129,0.6)] min-[360px]:grid">
          <Leaf size={15} strokeWidth={2.4} className="text-white" />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[11.5px] font-black tracking-tight whitespace-nowrap">{t.brand}</span>
          <span className="hidden truncate whitespace-nowrap text-[8px] font-bold text-emerald-600/85 min-[360px]:block dark:text-emerald-300/75">
            {t.brandTag}
          </span>
        </span>
      </div>

      {/* Language selector pill — 48px touch targets, compact footprint */}
      <div role="group" aria-label={t.languageAria} className="glass flex shrink-0 items-center rounded-full p-1 shadow-sm">
        {LANGS.map((l) => {
          const active = lang === l.code;
          return (
            <button
              key={l.code}
              type="button"
              onClick={() => onLangChange(l.code)}
              aria-pressed={active}
              aria-label={l.full}
              className={`relative grid h-12 min-w-[46px] place-items-center rounded-full px-2 text-[11.5px] font-black transition-colors ${
                active ? "text-white" : "text-slate-500 hover:text-emerald-600 dark:text-slate-400 dark:hover:text-emerald-300"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="lang-thumb"
                  className="absolute inset-0 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 shadow-[0_4px_14px_rgba(16,185,129,0.45)]"
                  transition={{ type: "spring", stiffness: 480, damping: 34 }}
                />
              )}
              <span className="relative z-10">{l.label}</span>
            </button>
          );
        })}
      </div>

      {/* Skip — ends on the left in RTL, right in LTR. Fixed slot so the header never jumps */}
      <div className="grid h-12 min-w-[64px] flex-none place-items-center justify-items-end">
        <AnimatePresence initial={false} mode="popLayout">
          {showSkip && (
            <motion.button
              key="skip"
              type="button"
              onClick={onSkip}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.22 }}
              whileTap={{ scale: 0.94 }}
              className="h-12 rounded-xl px-2 text-[12.5px] font-bold text-slate-500 transition-colors hover:text-emerald-600 dark:text-slate-400 dark:hover:text-emerald-300"
            >
              {t.skip}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}
