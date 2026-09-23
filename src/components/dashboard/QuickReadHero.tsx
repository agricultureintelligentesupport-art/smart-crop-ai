"use client";

import { motion } from "framer-motion";
import { Clock, ShieldCheck, Sprout, Sun, Waves } from "lucide-react";
import { EASE_OUT } from "@/components/auth/ui";
import { CROPS, type CropKey, type Lang } from "@/lib/wilayas";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { fmt } from "./WeatherCard";

/** Gauge ceiling: the arc fills relative to this many mm/day. */
const GAUGE_MAX_MM = 10;

/**
 * Semi-circular progress gauge for the hero headline. Purely decorative
 * (aria-hidden): the number itself stays as accessible text next to it.
 */
function ArcGauge({ value }: { value: number }) {
  const pct = Math.min(Math.max(value / GAUGE_MAX_MM, 0.05), 1);
  const r = 30;
  const cx = 36;
  const cy = 34;
  const len = Math.PI * r;
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  // Needle tip position along the arc (180° → 0°).
  const theta = Math.PI - Math.PI * pct;
  const tipX = cx + r * Math.cos(theta);
  const tipY = cy - r * Math.sin(theta);

  return (
    <svg
      width="76"
      height="46"
      viewBox="0 0 72 44"
      aria-hidden
      className="shrink-0 drop-shadow-[0_4px_12px_rgba(255,255,255,0.28)]"
    >
      <defs>
        <linearGradient id="hero-gauge-arc" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#a7f3d0" />
          <stop offset="55%" stopColor="#ecfeff" />
          <stop offset="100%" stopColor="#ffffff" />
        </linearGradient>
      </defs>
      <path
        d={arc}
        fill="none"
        stroke="rgba(255,255,255,0.24)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <motion.path
        d={arc}
        fill="none"
        stroke="url(#hero-gauge-arc)"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={len}
        initial={{ strokeDashoffset: len }}
        animate={{ strokeDashoffset: len * (1 - pct) }}
        transition={{ duration: 0.9, ease: EASE_OUT }}
      />
      <motion.circle
        r={3.4}
        fill="#ffffff"
        initial={{ cx: cx - r, cy }}
        animate={{ cx: tipX, cy: tipY }}
        transition={{ duration: 0.9, ease: EASE_OUT }}
      />
    </svg>
  );
}

/**
 * "قراءة سريعة" — the daily status hero. A gradient-mesh emerald→teal card
 * that leads the home screen: headline stat (mm/day) with a live arc gauge,
 * dynamic mini-badges (irrigation window + crop) and the three advisory
 * lines derived from the same irrigation computation the other cards use.
 */
export default function QuickReadHero({
  t,
  lang,
  netMmDay,
  areaHa,
  crop,
}: {
  t: DashboardCopy;
  lang: Lang;
  netMmDay: number;
  areaHa: number;
  crop: CropKey;
}) {
  const lines = [
    {
      icon: Waves,
      text: t.advice.line1
        .replace("{mm}", fmt(netMmDay, 1))
        .replace("{area}", fmt(areaHa, 1)),
    },
    { icon: Clock, text: t.advice.line2.replace("{from}", "05:30").replace("{to}", "08:30") },
    {
      icon: ShieldCheck,
      text: t.advice.line3
        .replace("{crop}", CROPS[crop][lang])
        .replace("{risk}", lang === "ar" ? "الآفات الفطرية" : "les maladies fongiques"),
    },
  ];

  return (
    <section
      aria-label={t.advice.title}
      className="relative overflow-hidden rounded-3xl p-4 text-white ring-1 ring-white/20 shadow-[0_28px_56px_-24px_rgba(6,95,70,0.7)]"
      style={{ background: "linear-gradient(135deg, #065f46 0%, #059669 46%, #0d9488 100%)" }}
    >
      {/* Gradient mesh: teal + lime glows over a micro-dot texture */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-16 -end-10 h-48 w-48 rounded-full bg-teal-300/35 blur-3xl" />
        <div className="absolute -bottom-24 -start-10 h-56 w-56 rounded-full bg-lime-300/25 blur-3xl" />
        <div className="absolute top-1/3 start-1/2 h-32 w-32 -translate-x-1/2 rounded-full bg-emerald-200/20 blur-2xl" />
        <div
          className="absolute inset-0 opacity-[0.13]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.9) 1px, transparent 0)",
            backgroundSize: "20px 20px",
          }}
        />
      </div>

      <div className="relative flex flex-col gap-3">
        {/* Title row */}
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-white/18 ring-1 ring-white/25"
          >
            <Sun size={17} strokeWidth={2.5} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-black leading-tight">{t.advice.title}</p>
            <p className="truncate text-[10.5px] font-semibold text-white/70">
              {t.advice.subtitle}
            </p>
          </div>
        </div>

        {/* Headline stat + live gauge */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-baseline gap-1.5">
              <span
                dir="ltr"
                className="text-[42px] font-black leading-none tracking-tight tabular-nums drop-shadow-[0_2px_10px_rgba(255,255,255,0.25)]"
              >
                {fmt(netMmDay, 1)}
              </span>
              <span dir="ltr" className="text-[13px] font-extrabold text-white/80">
                mm / day
              </span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                dir="ltr"
                className="inline-flex items-center gap-1 rounded-full bg-white/16 px-2.5 py-1 text-[10.5px] font-black tabular-nums ring-1 ring-white/25"
              >
                <Clock size={11} strokeWidth={2.8} aria-hidden />
                05:30 – 08:30
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-white/16 px-2.5 py-1 text-[10.5px] font-black ring-1 ring-white/25">
                <Sprout size={11} strokeWidth={2.8} aria-hidden />
                {CROPS[crop][lang]}
              </span>
            </div>
          </div>
          <ArcGauge value={netMmDay} />
        </div>

        {/* Advisory lines as translucent glass rows */}
        <ul className="flex flex-col gap-1.5">
          {lines.map(({ icon: Icon, text }) => (
            <li
              key={text}
              className="flex items-start gap-2 rounded-2xl bg-white/10 px-2.5 py-2 text-[12px] font-bold leading-5 text-white/95 ring-1 ring-white/15"
            >
              <span
                aria-hidden
                className="mt-[1px] grid h-6 w-6 shrink-0 place-items-center rounded-xl bg-white/15 text-lime-100"
              >
                <Icon size={13} strokeWidth={2.6} />
              </span>
              <span className="min-w-0">{text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
