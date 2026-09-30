"use client";

/**
 * The single entry point of the whole product on Home: ONE card for the
 * farmer's parcel.
 *
 * It shows the boundary they actually drew (satellite pixels clipped to the real
 * polygon), its name, its measured area, when it was last analysed, and one
 * primary action — «عرض القطعة» when a plot exists, «ارسم قطعتك» when it does
 * not. Everything else about a parcel lives in the confirm and analysis
 * screens; this card only gets the farmer to them.
 *
 * Values come straight from the stored plot and the current observation. No
 * number is computed here.
 */

import { CalendarClock, MapPinned, Ruler, Satellite } from "lucide-react";
import type { Plot } from "@/lib/field-data/types";
import type { Lang } from "@/lib/wilayas";
import PlotThumb from "@/components/plot/PlotThumb";
import { formatDate, formatNumber } from "@/components/plot/format";
import { Card } from "./parts";

const COPY = {
  ar: {
    title: "قطعي",
    flow: "حدّد حدودك، أكّدها، ثم حلّلها",
    emptyTitle: "لم ترسم قطعتك بعد",
    emptyHint: "ارسم حدود أرضك على صور الأقمار الصناعية، وسيظهر هنا اسمها ومساحتها وآخر تحليل لها.",
    draw: "ارسم قطعتك",
    open: "عرض القطعة",
    area: "المساحة",
    lastAnalysis: "آخر تحليل",
    never: "لم يُحلَّل بعد",
    loading: "جارٍ تحميل قطعتك…",
    shape: "الشكل الحقيقي لقطعتك",
    attribution: "Esri · Maxar · Earthstar Geographics",
  },
  fr: {
    title: "Ma parcelle",
    flow: "Tracez, confirmez, puis analysez",
    emptyTitle: "Aucune parcelle tracée",
    emptyHint: "Tracez les limites de votre terrain sur l'imagerie satellite : son nom, sa surface et sa dernière analyse s'afficheront ici.",
    draw: "Tracer ma parcelle",
    open: "Voir la parcelle",
    area: "Surface",
    lastAnalysis: "Dernière analyse",
    never: "Pas encore analysée",
    loading: "Chargement de votre parcelle…",
    shape: "La forme réelle de votre parcelle",
    attribution: "Esri · Maxar · Earthstar Geographics",
  },
} as const;

export default function MyPlotCard({
  lang,
  plot,
  /** Day of the latest real reading for this plot (`YYYY-MM-DD`), if any. */
  analyzedOn = null,
  loading = false,
  onOpen,
}: {
  lang: Lang;
  plot: Plot | null;
  analyzedOn?: string | null;
  loading?: boolean;
  onOpen: () => void;
}) {
  const t = COPY[lang];
  const date = formatDate(lang, analyzedOn);

  return (
    <Card
      title={t.title}
      subtitle={t.flow}
      icon={<MapPinned size={18} strokeWidth={2.4} aria-hidden />}
    >
      {loading ? (
        <div className="flex items-center gap-3" aria-busy>
          <div className="h-[72px] w-[72px] shrink-0 animate-pulse rounded-[1.1rem] bg-emerald-900/8" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-2/5 animate-pulse rounded-full bg-emerald-900/8" />
            <div className="h-3 w-3/5 animate-pulse rounded-full bg-emerald-900/8" />
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-emerald-900/8" />
          </div>
        </div>
      ) : plot ? (
        <>
          <div className="flex items-center gap-3">
            <PlotThumb plot={plot} label={t.shape} className="h-[72px] w-[72px] shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[16px] font-black leading-6 tracking-tight text-emerald-950">
                {plot.name}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-[12.5px] font-bold text-emerald-900/75">
                <Ruler size={13} strokeWidth={2.6} aria-hidden className="shrink-0 text-emerald-600" />
                <span dir="ltr" className="tabular-nums">
                  {formatNumber(lang, plot.areaHa, 2)}
                </span>
                <span className="text-emerald-900/55">{t.area}</span>
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-[11.5px] font-semibold text-emerald-900/55">
                <CalendarClock size={13} strokeWidth={2.6} aria-hidden className="shrink-0 text-emerald-600" />
                <span className="truncate">
                  {t.lastAnalysis}: {analyzedOn ? date : t.never}
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpen}
            className="mt-3.5 flex min-h-[2.75rem] w-full items-center justify-center gap-2 rounded-[0.9rem] bg-gradient-to-br from-emerald-500 to-green-600 text-[13px] font-extrabold text-white shadow-[0_10px_22px_-12px_rgba(16,185,129,0.9)] transition-transform active:scale-[0.99] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
          >
            <Satellite size={15} strokeWidth={2.6} aria-hidden />
            {t.open}
          </button>

          <p className="mt-2 text-center text-[9.5px] font-semibold text-emerald-900/40" dir="ltr">
            {t.attribution}
          </p>
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 py-1 text-center">
          <span
            aria-hidden
            className="grid h-12 w-12 place-items-center rounded-[1.1rem] bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100"
          >
            <Satellite size={20} strokeWidth={2.2} />
          </span>
          <p className="text-[12.5px] font-semibold leading-[1.75] text-emerald-900/65">{t.emptyHint}</p>
          <button
            type="button"
            onClick={onOpen}
            className="flex min-h-[2.75rem] w-full items-center justify-center gap-2 rounded-[0.9rem] bg-gradient-to-br from-emerald-500 to-green-600 text-[13px] font-extrabold text-white shadow-[0_10px_22px_-12px_rgba(16,185,129,0.9)] transition-transform active:scale-[0.99] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45"
          >
            <MapPinned size={15} strokeWidth={2.6} aria-hidden />
            {t.draw}
          </button>
        </div>
      )}
    </Card>
  );
}
