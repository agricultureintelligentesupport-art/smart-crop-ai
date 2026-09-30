"use client";

/**
 * The plot shape itself: the drawn boundary, the satellite texture clipped to
 * it, the NDVI raster clipped to it and the loading shimmer — all in one SVG,
 * north up, in the parcel's own proportions.
 *
 * Extracted from the plot screen without changing a line of its rendering: the
 * same geometry, the same clip paths, the same `data-*` hooks. It is rendered in
 * two sizes (`preview` on the confirm screen, `hero` on the analysis screen) and
 * in both cases the drawing is identical — only the frame around it changes.
 */

import { useId, type MouseEventHandler } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import type { PlotGeometry } from "@/lib/plot/geometry";
import type { PlotTexture } from "@/lib/plot/imagery";

const VIEW_MARGIN = 20;

export interface PlotShapeCopy {
  /** Section label above the shape. */
  outline: string;
  /** Accessible name of the figure. */
  shape: string;
  north: string;
  loading: string;
  analyzing: string;
  satellite: string;
  fallback: string;
  attribution: string;
}

export default function PlotShape({
  copy,
  geometry,
  texture,
  loading,
  analyzing,
  ndviImage,
  probe = false,
  onTap,
  mode = "preview",
}: {
  copy: PlotShapeCopy;
  geometry: PlotGeometry;
  texture: PlotTexture | null;
  loading: boolean;
  analyzing: boolean;
  /** The composed NDVI PNG, or `null` when no raster is available. */
  ndviImage: string | null;
  /** A tap reads the nearest real pixel — only true once the analysis is up. */
  probe?: boolean;
  onTap?: MouseEventHandler<SVGSVGElement>;
  mode?: "preview" | "hero";
}) {
  const clipId = useId(), gradientId = useId(), shimmerId = useId();

  return (
    <figure
      className={`plot-view__figure plot-view__figure--${mode}`}
      aria-label={copy.outline}
    >
      <div className="plot-view__figure-heading">
        <span>{copy.outline}</span>
        <span className="plot-view__north">
          <ArrowRight size={15} aria-hidden />
          {copy.north}
        </span>
      </div>
      <div
        className="plot-view__art"
        data-testid="plot-art"
        data-imagery={loading ? "loading" : texture ? "satellite" : "fallback"}
        data-min-zoom={texture?.minZoom}
        data-max-zoom={texture?.maxZoom}
      >
        {/* A definite frame around the SVG: the shape then always fits its
            slot, whatever the parcel's proportions. */}
        <div className="plot-view__art-frame">
          <svg
            viewBox={`${-VIEW_MARGIN} ${-VIEW_MARGIN} ${geometry.svgWidth + VIEW_MARGIN * 2} ${geometry.svgHeight + VIEW_MARGIN * 2}`}
            role="img"
            aria-label={copy.shape}
            preserveAspectRatio="xMidYMid meet"
            onClick={onTap}
            data-ndvi={probe && ndviImage ? "on" : undefined}
            className={probe && ndviImage ? "plot-view__art-svg--probe" : undefined}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#65b991" />
                <stop offset="48%" stopColor="#168367" />
                <stop offset="100%" stopColor="#064e3b" />
              </linearGradient>
              <clipPath id={clipId}>
                <polygon points={geometry.points} />
              </clipPath>
              <linearGradient id={shimmerId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
                <stop offset="50%" stopColor="#ffffff" stopOpacity="0.5" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon points={geometry.points} fill={`url(#${gradientId})`} />
            {texture && (
              <image
                href={texture.url}
                x="0"
                y="0"
                width={geometry.svgWidth}
                height={geometry.svgHeight}
                preserveAspectRatio="none"
                clipPath={`url(#${clipId})`}
              />
            )}
            {probe && ndviImage && (
              <image
                href={ndviImage}
                x="0"
                y="0"
                width={geometry.svgWidth}
                height={geometry.svgHeight}
                preserveAspectRatio="none"
                clipPath={`url(#${clipId})`}
                className="plot-view__ndvi"
                data-testid="plot-ndvi-layer"
              />
            )}
            {analyzing && (
              /* Soft shimmer over the REAL plot shape only — the sweep is
                 clipped to the drawn boundary, so the wait happens on the
                 farmer's parcel, not on a rectangle around it. */
              <g clipPath={`url(#${clipId})`} className="plot-view__shimmer" aria-hidden>
                <polygon points={geometry.points} className="plot-view__shimmer-tint" />
                <rect
                  x="0"
                  y="0"
                  width={Math.max(30, geometry.svgWidth * 0.35)}
                  height={geometry.svgHeight}
                  fill={`url(#${shimmerId})`}
                  className="plot-view__shimmer-sweep"
                />
              </g>
            )}
            <polygon
              points={geometry.points}
              fill="none"
              stroke="#fff"
              strokeWidth="5"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
            <polygon
              points={geometry.points}
              fill="none"
              stroke="#08765b"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
        </svg>
        </div>
      </div>
      <figcaption>
        <span role="status">
          {analyzing ? (
            <>
              <Loader2 size={13} className="plot-view__spinner" aria-hidden />
              {copy.analyzing}
            </>
          ) : loading ? (
            <>
              <Loader2 size={13} className="plot-view__spinner" aria-hidden />
              {copy.loading}
            </>
          ) : texture ? (
            copy.satellite
          ) : (
            copy.fallback
          )}
        </span>
        {texture && <small dir="ltr">{copy.attribution}</small>}
      </figcaption>
    </figure>
  );
}
