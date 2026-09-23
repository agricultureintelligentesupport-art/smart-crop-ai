"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CloudRain,
  Droplets,
  LocateFixed,
  MapPin,
  Mountain,
  Search,
  Thermometer,
  Wheat,
  Wind,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { interpolate } from "@/lib/auth/copy";
import { findNearestWilaya, getBrowserPosition } from "@/lib/auth/geolocation";
import {
  CROPS,
  DEFAULT_WILAYA_CODE,
  REGIONS,
  SOILS,
  getWilaya,
  searchWilayas,
  wilayaName,
} from "@/lib/wilayas";
import type { FlowController } from "./useAuthFlow";
import { EASE_OUT, FOCUS_RING, GPU, GhostButton, PrimaryButton } from "./ui";

/**
 * Step 3 — wilaya picker. A searchable list of all 58 wilayas (Arabic name,
 * French name, code and agro-region) plus a live preview of the climate and
 * crops the choice will seed in the dashboard.
 */
export default function WilayaStep({ flow }: { flow: FlowController }) {
  const { t, lang } = flow;
  const rtl = lang === "ar";
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchWilayas(query, lang), [query, lang]);
  const selectedCode = flow.wilayaCode ?? DEFAULT_WILAYA_CODE;
  const selected = getWilaya(selectedCode);
  const selectedRef = useRef<HTMLLIElement | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoMessage, setGeoMessage] = useState<string | null>(null);

  // Park the highlighted row in view when the step opens.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  /**
   * "Use my current location": resolves the nearest wilaya from a one-shot
   * GPS fix and pre-selects it. Every failure path (denied permission,
   * unavailable, timeout, no API) lands on the same gentle fallback copy —
   * the manual search below always stays available, nothing hard-blocks.
   */
  const handleLocate = async () => {
    if (locating) return;
    setLocating(true);
    setGeoMessage(t.location.locating);
    try {
      const fix = await getBrowserPosition();
      const nearest = findNearestWilaya(fix.lat, fix.lon);
      flow.handleWilayaSelect(nearest.code);
      setQuery("");
      setGeoMessage(interpolate(t.location.geoDetected, { name: wilayaName(getWilaya(nearest.code), lang) }));
    } catch {
      setGeoMessage(t.location.geoDenied);
    } finally {
      setLocating(false);
    }
  };

  return (
    <section aria-labelledby="wilaya-title" className="flex flex-col gap-3.5">
      <header className="text-center">
        <h1 id="wilaya-title" className="text-[20px] font-black leading-tight text-emerald-950">
          {t.location.title}
        </h1>
        <p className="mx-auto mt-1 max-w-[38ch] text-[12.5px] font-semibold leading-6 text-emerald-900/75">
          {t.location.subtitle}
        </p>
      </header>

      {/* Search */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="wilaya-search" className="text-[12.5px] font-extrabold text-emerald-900">
          {t.location.search}
        </label>
        <div className="relative">
          <Search
            size={16}
            strokeWidth={2.4}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 start-3.5 my-auto text-emerald-700/70"
          />
          <input
            id="wilaya-search"
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder={t.location.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="field-input h-12 px-4 ps-11 pe-11"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t.location.clear}
              className={`absolute inset-y-0 end-1.5 my-auto grid h-9 w-9 place-items-center rounded-xl text-emerald-700 transition-colors hover:bg-emerald-50 ${FOCUS_RING}`}
            >
              <X size={15} strokeWidth={2.6} aria-hidden />
            </button>
          )}
        </div>
        <p aria-live="polite" className="text-[11px] font-bold text-emerald-800/70">
          {interpolate(t.location.results, { n: results.length })}
        </p>
      </div>

      {/* Automatic detection: optional shortcut, manual search stays available. */}
      <div className="flex flex-col gap-1">
        <GhostButton
          onClick={() => void handleLocate()}
          loading={locating}
          loadingLabel={t.location.locating}
          icon={<LocateFixed size={16} strokeWidth={2.6} aria-hidden />}
        >
          {t.location.useMyLocation}
        </GhostButton>
        <p aria-live="polite" className="min-h-[1rem] text-center text-[11px] font-bold text-emerald-800">
          {geoMessage ?? ""}
        </p>
      </div>

      {/* List */}
      <ul
        className="scroll-area -mx-1 flex max-h-[40vh] min-h-[180px] flex-col gap-1.5 overflow-y-auto overscroll-contain px-1 py-0.5"
      >
        {results.map((w) => {
          const active = w.code === selectedCode;
          const region = REGIONS[w.region];
          return (
            <li key={w.code} ref={active ? selectedRef : undefined}>
              <button
                type="button"
                onClick={() => flow.handleWilayaSelect(w.code)}
                aria-pressed={active}
                className={`relative flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-start transition-colors ${FOCUS_RING} ${
                  active
                    ? "border-emerald-400 bg-emerald-50/80 shadow-[0_8px_20px_-16px_rgba(6,78,59,0.8)]"
                    : "border-[#E2F1E8] bg-white/70 hover:border-emerald-300 hover:bg-white"
                }`}
              >
                <span
                  aria-hidden
                  dir="ltr"
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[11.5px] font-black ${
                    active ? "bg-emerald-500 text-white" : "bg-white text-emerald-700 ring-1 ring-[#E2F1E8]"
                  }`}
                >
                  {w.code}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[13.5px] font-black text-emerald-950">{w.nameAr}</span>
                    <span dir="ltr" className="truncate text-[11.5px] font-bold text-emerald-800/70">
                      {w.nameFr}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[10.5px] font-bold text-emerald-800/70">
                    <span>{lang === "ar" ? region.ar : region.fr}</span>
                    <span aria-hidden className="h-2.5 w-px bg-emerald-900/15" />
                    <span className="inline-flex items-center gap-1">
                      <Thermometer size={11} strokeWidth={2.6} aria-hidden />
                      {w.climate.tempC}°
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Wheat size={11} strokeWidth={2.6} aria-hidden />
                      {CROPS[w.crops[0]][lang]}
                    </span>
                  </span>
                </span>

                <span
                  aria-hidden
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors ${
                    active
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : "border-emerald-900/15 bg-white text-transparent"
                  }`}
                >
                  <Check size={13} strokeWidth={3.4} />
                </span>
              </button>
            </li>
          );
        })}

        {results.length === 0 && (
          <li className="flex flex-col items-center gap-1 rounded-2xl border border-dashed border-emerald-300/70 bg-white/60 px-4 py-8 text-center">
            <MapPin size={22} strokeWidth={2.2} aria-hidden className="text-emerald-500" />
            <p className="text-[13px] font-black text-emerald-900">{t.location.empty}</p>
            <p className="text-[11px] font-semibold text-emerald-800/70">{t.location.emptyHint}</p>
          </li>
        )}
      </ul>

      {/* Live preview of what this wilaya seeds */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={selected.code}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
          className={`${GPU} rounded-3xl border border-emerald-200/70 bg-emerald-50/50 p-3`}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 text-[11px] font-black tracking-wide text-emerald-800">
              <MapPin size={13} strokeWidth={2.8} aria-hidden />
              {t.location.selectedLabel}
            </p>
            <p className="text-[12.5px] font-black text-emerald-950">
              {wilayaName(selected, lang)}
              <span aria-hidden className="mx-1 text-emerald-900/30">·</span>
              <span dir="ltr">{selected.code}</span>
            </p>
          </div>

          <dl className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <Stat icon={<Thermometer size={12} strokeWidth={2.6} aria-hidden />} label={t.location.tempLabel}>
              {selected.climate.tempC}°C
            </Stat>
            <Stat icon={<Droplets size={12} strokeWidth={2.6} aria-hidden />} label={t.location.humidityLabel}>
              {interpolate(t.location.humidity, { n: selected.climate.humidity })}
            </Stat>
            <Stat icon={<Wind size={12} strokeWidth={2.6} aria-hidden />} label={t.location.windLabel}>
              {interpolate(t.location.wind, { n: selected.climate.windKph })}
            </Stat>
            <Stat icon={<CloudRain size={12} strokeWidth={2.6} aria-hidden />} label={t.location.rainLabel}>
              {interpolate(t.location.rain, { n: selected.climate.rainMm })}
            </Stat>
            <Stat icon={<Mountain size={12} strokeWidth={2.6} aria-hidden />} label={t.location.altitudeLabel}>
              {selected.altitudeM} m
            </Stat>
            <Stat icon={<Wheat size={12} strokeWidth={2.6} aria-hidden />} label={t.location.soilLabel}>
              {SOILS[selected.soil][lang]}
            </Stat>
          </dl>

          <p className="mt-2 text-[11px] font-black text-emerald-800">{t.location.cropsLabel}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {selected.crops.map((crop) => (
              <li
                key={crop}
                className="rounded-full border border-emerald-200 bg-white/85 px-2 py-0.5 text-[10.5px] font-bold text-emerald-800"
              >
                {CROPS[crop][lang]}
              </li>
            ))}
          </ul>
        </motion.div>
      </AnimatePresence>

      <div className="flex items-center gap-2">
        <GhostButton
          onClick={() => flow.goToStep("role")}
          block={false}
          className="h-12 shrink-0 px-4"
          icon={rtl ? <ArrowRight size={17} strokeWidth={2.6} aria-hidden /> : <ArrowLeft size={17} strokeWidth={2.6} aria-hidden />}
          aria-label={t.location.back}
        >
          <span className="hidden min-[380px]:inline">{t.location.back}</span>
        </GhostButton>
        <PrimaryButton
          onClick={() => void flow.handleWilayaConfirm()}
          loading={flow.busy === "email"}
          loadingLabel={t.email.busy}
          icon={rtl ? <ArrowLeft size={17} strokeWidth={2.8} aria-hidden /> : <ArrowRight size={17} strokeWidth={2.8} aria-hidden />}
        >
          {t.location.confirm}
        </PrimaryButton>
      </div>

    </section>
  );
}

function Stat({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl bg-white/75 px-2 py-1.5">
      <dt className="flex items-center gap-1 text-[10px] font-bold text-emerald-800/70">
        <span className="text-emerald-600" aria-hidden>
          {icon}
        </span>
        {label}
      </dt>
      <dd className="truncate text-[12px] font-black text-emerald-900">{children}</dd>
    </div>
  );
}
