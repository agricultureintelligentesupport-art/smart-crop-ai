"use client";

/**
 * «قطعتي» — the single plot card on Home. Replaces the old square-grid
 * heatmap card with one honest summary of the farmer's real boundary: the
 * satellite thumbnail clipped to the drawn polygon (the same texture pipeline
 * the plot screen uses), the name, the measured area and the date of the last
 * analysis, plus one primary action into the flow.
 *
 * No plot yet: an empty state whose primary button opens the draw screen.
 * Display only — every value comes straight from the saved `Plot` and the
 * existing observation, and nothing is recomputed here.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { CalendarDays, Expand, MapPinned } from "lucide-react";
import type { FieldObservation, Plot } from "@/lib/field-data/types";
import { plotGeometry } from "@/lib/plot/geometry";
import { composePlotTexture, type PlotTexture } from "@/lib/plot/imagery";
import type { Lang } from "@/lib/wilayas";
import { PrimaryButton } from "@/components/auth/ui";
import { Card } from "./parts";

/** Arabic labels only — the flow's language. */
const COPY = {
  title: "قطعتي",
  empty: "لا توجد قطعة محفوظة بعد.",
  draw: "ارسم قطتك",
  view: "عرض القطعة",
  area: "المساحة",
  ha: "هكتار",
  lastAnalysis: "آخر تحليل",
  shape: "شكل قطعتك من الصورة الفضائية",
  loading: "جارٍ تحميل قطعتك…",
};

export default function MyPlotCard({
  lang,
  plot,
  loading,
  observation,
  onView,
  onDraw,
}: {
  lang: Lang;
  plot: Plot | null;
  /** The device store is still syncing — skeleton, never «no plot». */
  loading: boolean;
  observation: FieldObservation | null;
  onView: () => void;
  onDraw: () => void;
}) {
  const gradientId = useId();
  const clipId = useId();
  const geometry = useMemo(() => (plot ? plotGeometry(plot.ring) : null), [plot]);
  const [texture, setTexture] = useState<PlotTexture | null>(null);

  /* Same client-side Esri composition as the plot screen, on the small shape.
     Aborted on unmount / boundary change; a failed thumbnail falls back to the
     gradient shape exactly like the details screen does. */
  useEffect(() => {
    if (!geometry) return;
    const controller = new AbortController();
    composePlotTexture(geometry, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setTexture(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTexture(null);
      });
    return () => controller.abort();
  }, [geometry]);

  const number = (value: number, decimals = 0) =>
    new Intl.NumberFormat(lang === "ar" ? "ar-DZ-u-nu-latn" : "fr-FR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);

  return (
    <Card
      title={COPY.title}
      icon={<MapPinned size={18} strokeWidth={2.4} aria-hidden />}
    >
      {loading && !plot ? (
        <div className="flex items-center gap-3" aria-busy="true">
          <div className="h-[76px] w-[76px] shrink-0 animate-pulse rounded-[1.1rem] bg-emerald-100/70" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/3 animate-pulse rounded-full bg-emerald-100/70" />
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-emerald-100/50" />
          </div>
        </div>
      ) : !plot ? (
        <div className="flex flex-col items-center gap-3 py-1 text-center">
          <span
            aria-hidden
            className="grid h-14 w-14 place-items-center rounded-[1.15rem] bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
          >
            <MapPinned size={24} strokeWidth={2.2} />
          </span>
          <p className="text-[12.5px] font-semibold leading-5 text-emerald-900/60">{COPY.empty}</p>
          <PrimaryButton icon={<MapPinned size={17} strokeWidth={2.6} aria-hidden />} onClick={onDraw}>
            {COPY.draw}
          </PrimaryButton>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            {/* The real polygon, clipped out of the satellite texture. */}
            <div className="h-[76px] w-[76px] shrink-0 rounded-[1.1rem] bg-gradient-to-br from-emerald-50 to-emerald-100/80 p-1.5 ring-1 ring-emerald-100">
              <svg
                viewBox={`${-geometry!.svgWidth * 0.08} ${-geometry!.svgHeight * 0.08} ${geometry!.svgWidth * 1.16} ${geometry!.svgHeight * 1.16}`}
                role="img"
                aria-label={COPY.shape}
                preserveAspectRatio="xMidYMid meet"
                className="h-full w-full drop-shadow-[0_6px_8px_rgba(24,62,48,0.25)]"
                data-testid="my-plot-thumb"
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#65b991" />
                    <stop offset="48%" stopColor="#168367" />
                    <stop offset="100%" stopColor="#064e3b" />
                  </linearGradient>
                  <clipPath id={clipId}>
                    <polygon points={geometry!.points} />
                  </clipPath>
                </defs>
                <polygon points={geometry!.points} fill={`url(#${gradientId})`} />
                {texture && (
                  <image
                    href={texture.url}
                    x="0"
                    y="0"
                    width={geometry!.svgWidth}
                    height={geometry!.svgHeight}
                    preserveAspectRatio="none"
                    clipPath={`url(#${clipId})`}
                  />
                )}
                <polygon
                  points={geometry!.points}
                  fill="none"
                  stroke="#fff"
                  strokeWidth="3"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
                <polygon
                  points={geometry!.points}
                  fill="none"
                  stroke="#08765b"
                  strokeWidth="1.25"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-black leading-6 text-emerald-950">{plot.name}</p>
              <p className="mt-1 flex items-center gap-1.5 text-[12px] font-bold text-emerald-900/70">
                <Expand size={13} strokeWidth={2.6} className="shrink-0" aria-hidden />
                <span className="tabular-nums">
                  {COPY.area}: <bdi dir="ltr">{number(plot.areaHa, 2)}</bdi> {COPY.ha}
                </span>
              </p>
              {observation && (
                <p className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-900/55">
                  <CalendarDays size={12} strokeWidth={2.6} className="shrink-0" aria-hidden />
                  <span>
                    {COPY.lastAnalysis}:{" "}
                    <bdi>
                      {new Intl.DateTimeFormat(lang === "ar" ? "ar-DZ" : "fr-DZ", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      }).format(new Date(observation.date))}
                    </bdi>
                  </span>
                </p>
              )}
            </div>
          </div>
          <PrimaryButton icon={<MapPinned size={17} strokeWidth={2.6} aria-hidden />} onClick={onView}>
            {COPY.view}
          </PrimaryButton>
        </div>
      )}
    </Card>
  );
}
