"use client";

/**
 * A plot drawn as its REAL shape over its own satellite pixels.
 *
 * The same two library helpers the confirm screen uses — `plotGeometry` for the
 * ground-truth outline and `composePlotTexture` for the Esri texture clipped to
 * it — so the card on Home and the screen the farmer opens from it can never
 * disagree about the size or the shape of the parcel. Nothing here computes a
 * new number: it draws the boundary that is already stored.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Plot } from "@/lib/field-data/types";
import { plotGeometry, type PlotGeometry } from "@/lib/plot/geometry";
import { composePlotTexture, type PlotTexture } from "@/lib/plot/imagery";

const VIEW_MARGIN = 20;

export default function PlotThumb({
  plot,
  label,
  className = "",
}: {
  plot: Plot;
  /** Accessible name of the shape. */
  label: string;
  className?: string;
}) {
  const gradientId = useId();
  const clipId = useId();
  const geometry = useMemo(() => plotGeometry(plot.ring), [plot.ring]);
  const [state, setState] = useState<{ geometry: PlotGeometry; texture: PlotTexture | null } | null>(null);
  // A new boundary invalidates the previous fetch: the texture is only ever
  // shown for the geometry it was composed for.
  const texture = state?.geometry === geometry ? state.texture : null;
  const loading = state?.geometry !== geometry;

  useEffect(() => {
    const controller = new AbortController();
    composePlotTexture(geometry, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setState({ geometry, texture: next });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ geometry, texture: null });
      });
    return () => controller.abort();
  }, [geometry]);

  return (
    <div
      className={`relative overflow-hidden rounded-[1.1rem] bg-[#e6f0e2] ${className}`}
      data-testid="plot-thumb"
      data-imagery={loading ? "loading" : texture ? "satellite" : "fallback"}
    >
      <svg
        viewBox={`${-VIEW_MARGIN} ${-VIEW_MARGIN} ${geometry.svgWidth + VIEW_MARGIN * 2} ${geometry.svgHeight + VIEW_MARGIN * 2}`}
        role="img"
        aria-label={label}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full"
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
      {loading && (
        <span
          aria-hidden
          className="absolute inset-0 grid place-items-center bg-white/25 backdrop-blur-[1px]"
        >
          <Loader2 size={16} className="animate-spin text-emerald-700" />
        </span>
      )}
    </div>
  );
}
