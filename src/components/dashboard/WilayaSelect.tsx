"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, MapPin, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FOCUS_RING, GPU, SPRING } from "@/components/auth/ui";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { REGIONS, getWilaya, searchWilayas, type Lang } from "@/lib/wilayas";

/**
 * Searchable wilaya picker presented as a native bottom sheet (drag-to-
 * dismiss, backdrop, grabber). Search, listbox semantics and the change
 * contract (`onChange(code)`) are unchanged.
 */
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
      const sheet = document.getElementById("dash-wilaya-sheet");
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node) && !(sheet && sheet.contains(event.target as Node))) {
        setOpen(false);
      }
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
        className={`glass-card flex h-12 w-full items-center gap-2 rounded-2xl px-3 text-start transition-all duration-150 hover:border-emerald-300 active:scale-[0.99] ${FOCUS_RING}`}
      >
        <MapPin size={15} strokeWidth={2.6} aria-hidden className="shrink-0 text-emerald-600" />
        <span className="min-w-0 flex-1">
          <span className="block text-[9.5px] font-bold text-emerald-800/70">{t.personalize.wilaya}</span>
          <span className="block truncate text-[12.5px] font-black text-emerald-950">
            {lang === "ar" ? current.nameAr : current.nameFr}
            <span aria-hidden className="mx-1 text-emerald-900/30">·</span>
            <span dir="ltr">{current.code}</span>
          </span>
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2.6}
          aria-hidden
          className={`shrink-0 text-emerald-700 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {open && [
          <motion.div
            key="sheet-backdrop"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-emerald-950/25 backdrop-blur-[2px]"
          />,
          <motion.div
            key="sheet"
            id="dash-wilaya-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t.personalize.wilaya}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={SPRING}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.55 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 80 || info.velocity.y > 500) setOpen(false);
            }}
            className={`glass-widget fixed inset-x-0 bottom-0 z-50 mx-auto max-w-[560px] rounded-t-3xl px-4 pt-2.5 pb-[calc(1.1rem+env(safe-area-inset-bottom))] ${GPU}`}
          >
            <div aria-hidden className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-emerald-900/15" />
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[13px] font-black text-emerald-950">{t.personalize.wilaya}</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.personalize.close}
                className={`grid h-9 w-9 place-items-center rounded-full bg-white/85 text-emerald-800 ring-1 ring-[#E2F1E8] transition-all duration-150 hover:bg-white active:scale-95 ${FOCUS_RING}`}
              >
                <X size={16} strokeWidth={2.8} aria-hidden />
              </button>
            </div>

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
                className="field-input h-11 ps-10 pe-3 text-[14px]"
              />
            </div>

            <ul
              role="listbox"
              aria-label={t.personalize.wilaya}
              className="scroll-area mt-2 flex max-h-[min(20rem,46vh)] flex-col gap-1 overflow-y-auto"
            >
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
                      className={`flex w-full items-center gap-2 rounded-xl px-2 py-2.5 text-start transition-all duration-150 active:scale-[0.99] ${FOCUS_RING} ${
                        active ? "bg-emerald-50/90" : "hover:bg-white/80"
                      }`}
                    >
                      <span
                        aria-hidden
                        dir="ltr"
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[10px] font-black ${
                          active ? "bg-emerald-500 text-white" : "bg-white text-emerald-700 ring-1 ring-[#E2F1E8]"
                        }`}
                      >
                        {w.code}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-emerald-950">
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
                <li className="px-2 py-6 text-center text-[12px] font-bold text-emerald-900/60">
                  {t.personalize.noResults}
                </li>
              )}
            </ul>
          </motion.div>,
        ]}
      </AnimatePresence>
    </div>
  );
}
