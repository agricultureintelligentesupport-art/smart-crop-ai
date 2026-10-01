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
 * existing observation, and nothing is recomputed here. The mini NDVI strip
 * (the flow's one fixed gradient) is drawn only when a real analysis exists,
 * with a marker at the measured mean when pixel data is present.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { CalendarDays, Expand, MapPinned } from "lucide-react";
import type { FieldObservation, Plot } from "@/lib/field-data/types";
import { plotGeometry } from "@/lib/plot/geometry";
import { composePlotTexture, type PlotTexture } from "@/lib/plot/imagery";
import { measuredPixelMask, ndviColorDomain, rasterStats } from "@/lib/plot/ndvi-layers";
import type { Lang } from "@/lib/wilayas";
import "@/components/plot/plot-theme.css";

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
  ndviScale: "مقياس NDVI للقطة الأخيرة",
  mean: "المتوسط",
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

  /* Mean of the REAL measured pixels — positions the strip's marker. `null`
     when the analysis carries no raster, then the strip stays unmarked. */
  const meanNdvi = useMemo(() => {
    const raster = observation?.raster;
    if (!plot || !raster) return null;
    const mask = measuredPixelMask(plot.ring, raster);
    const stats = rasterStats(raster, mask);
    return stats.count > 0 && stats.mean !== null ? { mean: stats.mean, domain: ndviColorDomain(raster) } : null;
  }, [observation, plot]);

  const number = (value: number, decimals = 0) =>
    new Intl.NumberFormat(lang === "ar" ? "ar-DZ-u-nu-latn" : "fr-FR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);

  const markerPos =
    meanNdvi && meanNdvi.domain
      ? Math.round(
          Math.min(1, Math.max(0, (meanNdvi.mean - meanNdvi.domain[0]) / (meanNdvi.domain[1] - meanNdvi.domain[0]))) * 100,
        )
      : null;

  return (
    <section aria-label={COPY.title} className="plot-theme plot-home">
      <header className="plot-home__head plot-rise" style={{ "--i": 0 } as React.CSSProperties}>
        <span className="plot-home__icon">
          <MapPinned size={18} strokeWidth={2.4} aria-hidden />
        </span>
        <div className="plot-home__titles">
          <h2>{COPY.title}</h2>
          <p>{plot ? `${COPY.area}: ${number(plot.areaHa, 2)} ${COPY.ha}` : loading ? COPY.loading : ""}</p>
        </div>
        {observation && (
          <span className="plot-home__ndvi-flag" dir="ltr">
            NDVI
          </span>
        )}
      </header>

      {loading && !plot ? (
        <div className="plot-home__body" aria-busy="true">
          <div className="plot-home__row">
            <div className="plot-skeleton" style={{ width: 86, height: 86, borderRadius: 16 }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="plot-skeleton" style={{ height: 14, width: "66%" }} />
              <div className="plot-skeleton" style={{ height: 11, width: "45%" }} />
            </div>
          </div>
          <div className="plot-skeleton" style={{ height: 48 }} />
        </div>
      ) : !plot ? (
        <div className="plot-home__body plot-home__empty plot-rise" style={{ "--i": 1 } as React.CSSProperties}>
          <span className="plot-home__empty-icon" aria-hidden>
            <MapPinned size={24} strokeWidth={2.2} />
          </span>
          <p>{COPY.empty}</p>
          <button type="button" className="plot-cta" onClick={onDraw}>
            <MapPinned size={17} strokeWidth={2.6} aria-hidden />
            {COPY.draw}
          </button>
        </div>
      ) : (
        <div className="plot-home__body">
          <div className="plot-home__row plot-rise" style={{ "--i": 1 } as React.CSSProperties}>
            {/* The real polygon, clipped out of the satellite texture. */}
            <div className="plot-home__thumb">
              <svg
                viewBox={`${-geometry!.svgWidth * 0.08} ${-geometry!.svgHeight * 0.08} ${geometry!.svgWidth * 1.16} ${geometry!.svgHeight * 1.16}`}
                role="img"
                aria-label={COPY.shape}
                preserveAspectRatio="xMidYMid meet"
                data-testid="my-plot-thumb"
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" className="plot-fig__stop-a" />
                    <stop offset="48%" className="plot-fig__stop-b" />
                    <stop offset="100%" className="plot-fig__stop-c" />
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
                  className="plot-fig__outline"
                  strokeWidth="3"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
                <polygon
                  points={geometry!.points}
                  fill="none"
                  className="plot-fig__outline-inner"
                  strokeWidth="1.25"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="plot-home__meta">
              <p className="plot-home__name">{plot.name}</p>
              <p className="plot-home__fact">
                <Expand size={13} strokeWidth={2.6} aria-hidden />
                <span className="tabular-nums">
                  {COPY.area}: <bdi dir="ltr">{number(plot.areaHa, 2)}</bdi> {COPY.ha}
                </span>
              </p>
              {observation && (
                <p className="plot-home__fact" style={{ fontSize: 11, color: "var(--pt-ink-faint)" }}>
                  <CalendarDays size={12} strokeWidth={2.6} aria-hidden />
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

          {/* The one fixed NDVI gradient — only with a real analysis. */}
          {observation && (
            <div className="plot-rise" style={{ "--i": 2 } as React.CSSProperties}>
              <div className="plot-home__strip" dir="ltr" aria-hidden>
                {markerPos !== null && <span className="plot-home__strip-marker" style={{ left: `${markerPos}%` }} />}
              </div>
              <p className="plot-home__strip-note">
                {COPY.ndviScale}
                {meanNdvi ? (
                  <span>
                    · {COPY.mean} <bdi dir="ltr">{number(meanNdvi.mean, 2)}</bdi>
                  </span>
                ) : null}
              </p>
            </div>
          )}

          <button type="button" className="plot-cta plot-rise" style={{ "--i": 3 } as React.CSSProperties} onClick={onView}>
            <MapPinned size={17} strokeWidth={2.6} aria-hidden />
            {COPY.view}
          </button>
        </div>
      )}
    </section>
  );
}
