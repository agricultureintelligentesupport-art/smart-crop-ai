"use client";

import { motion } from "framer-motion";
import { memo } from "react";
import type { Lang } from "@/lib/wilayas";
import { FOCUS_RING, GPU, SPRING } from "./ui";

const LANGS: { code: Lang; label: string }[] = [
  { code: "ar", label: "AR" },
  { code: "fr", label: "FR" },
];

/** AR / FR pill with a spring-eased thumb. 48px touch targets. */
function LanguageSwitch({
  lang,
  onChange,
  ariaLabel,
  labels,
  layoutId = "auth-lang-thumb",
}: {
  lang: Lang;
  onChange: (lang: Lang) => void;
  ariaLabel: string;
  labels: { ar: string; fr: string };
  layoutId?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="glass flex shrink-0 items-center rounded-full p-1 shadow-sm"
    >
      {LANGS.map((l) => {
        const active = lang === l.code;
        return (
          <button
            key={l.code}
            type="button"
            onClick={() => onChange(l.code)}
            aria-pressed={active}
            aria-label={labels[l.code]}
            className={`relative grid h-10 min-w-[46px] place-items-center rounded-full px-2.5 text-[12px] font-black transition-colors ${FOCUS_RING} ${
              active ? "text-white" : "text-emerald-800/70 hover:text-emerald-700"
            }`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className={`absolute inset-0 rounded-full bg-gradient-to-r from-emerald-500 to-green-600 shadow-[0_6px_16px_rgba(16,185,129,0.5)] ${GPU}`}
                transition={SPRING}
              />
            )}
            <span className="relative z-10">{l.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default memo(LanguageSwitch);
