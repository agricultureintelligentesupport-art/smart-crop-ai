"use client";

import { Leaf } from "lucide-react";
import Link from "next/link";
import { memo } from "react";
import type { Lang } from "@/lib/wilayas";
import type { AuthCopy } from "@/lib/auth/copy";
import LanguageSwitch from "./LanguageSwitch";
import { FOCUS_RING } from "./ui";

interface AuthHeaderProps {
  t: AuthCopy;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  /** Top navigation link: always a real route, never a dead end. */
  navHref: string;
  navLabel: string;
  navIcon?: React.ReactNode;
}

/**
 * Brand badge + language switcher + one contextual navigation link.
 * Memoized: the header (and its backdrop-blur pills) never re-renders while
 * the user types inside a step panel.
 */
function AuthHeader({ t, lang, onLangChange, navHref, navLabel, navIcon }: AuthHeaderProps) {
  return (
    <header className="pt-safe relative z-30 flex shrink-0 items-center justify-between gap-2 px-3.5 pb-1.5 sm:px-4">
      <div className="glass flex h-12 min-w-0 items-center gap-2 rounded-2xl px-2 shadow-sm">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 shadow-[0_0_18px_rgba(16,185,129,0.55)]">
          <Leaf size={15} strokeWidth={2.4} className="text-white" aria-hidden />
        </span>
        {/* Wordmark hides on the narrowest phones (320px) where the mark,
            language pill and nav link need the room; the leaf keeps the brand. */}
        <span className="hidden min-w-0 flex-col leading-tight min-[360px]:flex">
          <span className="truncate text-[11.5px] font-black whitespace-nowrap text-emerald-950">
            {t.header.brand}
          </span>
          <span className="hidden truncate text-[8px] font-bold whitespace-nowrap text-emerald-700/80 min-[420px]:block">
            {t.header.brandTag}
          </span>
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <LanguageSwitch
          lang={lang}
          onChange={onLangChange}
          ariaLabel={t.header.langAria}
          labels={{ ar: t.header.langAr, fr: t.header.langFr }}
        />

        <Link
          href={navHref}
          className={`glass inline-flex h-12 items-center gap-1.5 rounded-2xl px-3 text-[11.5px] font-extrabold whitespace-nowrap text-emerald-900 transition-colors hover:bg-white/95 ${FOCUS_RING}`}
        >
          {navIcon}
          {navLabel}
        </Link>
      </div>
    </header>
  );
}

export default memo(AuthHeader);
