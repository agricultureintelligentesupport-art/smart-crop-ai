"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, MapPin, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EASE_OUT, FOCUS_RING, GPU } from "@/components/auth/ui";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { REGIONS, getWilaya, searchWilayas, type Lang } from "@/lib/wilayas";

/** Compact searchable wilaya picker used by the dashboard personalisation bar. */
export default function WilayaSelect({
  t,
  lang,
  value,
  onChange,
}: {
  t: DashboardCopy;
  lang: Lang;
  value: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const current = getWilaya(value);
  const results = useMemo(() => searchWilayas(query, lang).slice(0, 60), [query, lang]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`app-surface flex h-14 w-full items-center gap-2.5 rounded-[1.1rem] px-3.5 text-start transition-colors hover:border-emerald-300 ${FOCUS_RING}`}
      >
        <MapPin size={17} strokeWidth={2.6} aria-hidden className="shrink-0 text-emerald-600" />
        <span className="min-w-0 flex-1">
          <span className="block text-[10.5px] font-bold tracking-wide text-emerald-800/65">{t.personalize.wilaya}</span>
          <span className="block truncate text-[14px] font-black text-emerald-950">
            {lang === "ar" ? current.nameAr : current.nameFr}
            <span aria-hidden className="mx-1 text-emerald-900/30">·</span>
            <span dir="ltr">{current.code}</span>
          </span>
        </span>
        <ChevronDown
          size={18}
          strokeWidth={2.6}
          aria-hidden
          className={`shrink-0 text-emerald-700 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.99 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            data-nested-popover="true"
            className={`app-surface absolute inset-x-0 top-[54px] z-40 p-2.5 ${GPU}`}
          >
            <label className="sr-only" htmlFor="dash-wilaya-search">
              {t.personalize.search}
            </label>
            <div className="relative">
              <Search
                size={15}
                strokeWidth={2.6}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 start-3 my-auto text-emerald-700/70"
              />
              <input
                id="dash-wilaya-search"
                type="search"
                autoComplete="off"
                placeholder={t.personalize.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="field-input h-12 ps-10 pe-3 text-[15px]"
              />
            </div>

            <ul role="listbox" aria-label={t.personalize.wilaya} className="scroll-area mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto">
              {results.map((w) => {
                const active = w.code === value;
                return (
                  <li key={w.code}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onChange(w.code);
                        setOpen(false);
                        setQuery("");
                      }}
                      className={`flex min-h-[2.75rem] w-full items-center gap-2.5 rounded-[0.9rem] px-2 py-2 text-start transition-colors ${FOCUS_RING} ${
                        active ? "bg-emerald-50" : "hover:bg-[#f6faf7]"
                      }`}
                    >
                      <span
                        aria-hidden
                        dir="ltr"
                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-[0.6rem] text-[11px] font-black ${
                          active ? "bg-emerald-500 text-white" : "app-tile text-emerald-700"
                        }`}
                      >
                        {w.code}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-emerald-950">
                        {lang === "ar" ? w.nameAr : w.nameFr}
                        <span aria-hidden className="mx-1.5 text-emerald-900/25">·</span>
                        <span className="text-[11px] font-semibold text-emerald-800/70">
                          {lang === "ar" ? REGIONS[w.region].ar : REGIONS[w.region].fr}
                        </span>
                      </span>
                      {active && <Check size={14} strokeWidth={3.2} aria-hidden className="shrink-0 text-emerald-600" />}
                    </button>
                  </li>
                );
              })}
              {results.length === 0 && (
                <li className="px-2 py-6 text-center text-[12.5px] font-bold text-emerald-900/60">
                  {t.personalize.noResults}
                </li>
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
