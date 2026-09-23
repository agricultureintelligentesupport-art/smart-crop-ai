"use client";

import { Clock, ShieldCheck, Sun, Waves } from "lucide-react";
import { CROPS, type CropKey, type Lang } from "@/lib/wilayas";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { fmt } from "./WeatherCard";

/**
 * "قراءة سريعة" — the daily status hero. A high-contrast emerald card that
 * leads the home screen: headline number (mm/day), the irrigation window and
 * the three advisory lines derived from the same irrigation computation the
 * other cards use.
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
      className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-600 via-emerald-600 to-green-700 p-4 text-white shadow-[0_20px_44px_-20px_rgba(5,150,105,0.65)] ring-1 ring-emerald-500/40"
    >
      {/* Decorative sheen + soft sun glow */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -end-10 -top-14 h-44 w-44 rounded-full bg-white/12 blur-2xl" />
        <div className="absolute -start-12 bottom-[-52px] h-40 w-40 rounded-full bg-lime-300/20 blur-2xl" />
        <div
          className="absolute inset-0 opacity-[0.16]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.85) 1px, transparent 0)",
            backgroundSize: "22px 22px",
          }}
        />
      </div>

      <div className="relative">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-white/18 ring-1 ring-white/25"
          >
            <Sun size={17} strokeWidth={2.5} />
          </span>
          <div className="min-w-0">
            <p className="text-[13.5px] font-black leading-tight">{t.advice.title}</p>
            <p className="truncate text-[10.5px] font-semibold text-white/70">
              {t.advice.subtitle}
            </p>
          </div>
        </div>

        {/* Headline number + irrigation window */}
        <div className="mt-3 flex items-end justify-between gap-3">
          <p className="flex items-baseline gap-1.5">
            <span dir="ltr" className="text-[38px] font-black leading-none tracking-tight tabular-nums">
              {fmt(netMmDay, 1)}
            </span>
            <span dir="ltr" className="text-[13px] font-extrabold text-white/80">
              mm / day
            </span>
          </p>
          <span
            dir="ltr"
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/16 px-2.5 py-1 text-[11px] font-black tabular-nums ring-1 ring-white/25"
          >
            <Clock size={12} strokeWidth={2.8} aria-hidden />
            05:30 – 08:30
          </span>
        </div>

        <div aria-hidden className="my-3 h-px bg-white/15" />

        <ul className="flex flex-col gap-2">
          {lines.map(({ icon: Icon, text }) => (
            <li
              key={text}
              className="flex items-start gap-2 text-[12px] font-bold leading-5 text-white/92"
            >
              <Icon
                size={14}
                strokeWidth={2.6}
                aria-hidden
                className="mt-[3px] shrink-0 text-lime-200"
              />
              <span className="min-w-0">{text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
