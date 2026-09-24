"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Droplets, Leaf, MapPinned, ThermometerSun, Waves } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { IrrigationResult, WeatherSnapshot } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import {
  buildFieldHeatmap,
  layerAverage,
  zoneReading,
  type FieldHeatmap,
  type HeatmapLayer,
  type ZoneStatus,
} from "@/lib/dashboard/heatmap";
import type { CropKey, Lang } from "@/lib/wilayas";
import { fmt } from "./WeatherCard";
import { Card, Chip, Progress } from "./parts";

/**
 * Field heatmap: the parcel split into zones, three switchable layers
 * (thermal stress, water requirement, transpiration index) and a tap-to-inspect
 * reading per zone.
 *
 * It is deliberately honest about its provenance: the spatial pattern is a
 * deterministic *model* estimate (see `lib/dashboard/heatmap.ts`), and the
 * moisture layer averages exactly back to the same per-hectare figure the hero
 * decision card shows — switching layers or tapping a zone can never invent a
 * number that contradicts the daily calculation.
 *
 * Rendering is plain SVG (crisp on every DPI, no canvas context to lose on
 * resize) with the app's existing motion language: staggered cell entrance, a
 * slow sensor shimmer, and a pulsing marker on the inspected zone. Everything
 * collapses to a static map under `prefers-reduced-motion`.
 */

const LAYER_META: Record<HeatmapLayer, { icon: typeof Droplets; ramp: [string, string, string] }> = {
  // Emerald → teal → amber: the field's own moisture deficit ramp.
  moisture: { icon: Droplets, ramp: ["#0e9f6e", "#14b8a6", "#f59e0b"] },
  // Emerald → amber → deep orange: stress climbing.
  thermal: { icon: ThermometerSun, ramp: ["#10b981", "#fbbf24", "#ea580c"] },
  // Teal → emerald → lime: active transpiration.
  transpiration: { icon: Leaf, ramp: ["#0d9488", "#22c55e", "#a3e635"] },
};

const LAYER_ORDER: HeatmapLayer[] = ["thermal", "moisture", "transpiration"];

/** Hex lerp across a three-stop ramp (t = 0…1). */
function rampColor(ramp: [string, string, string], t: number): string {
  const clamp = Math.min(Math.max(t, 0), 1);
  const stops = ramp.map((hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]);
  const scaled = clamp * (stops.length - 1);
  const i = Math.min(Math.floor(scaled), stops.length - 2);
  const local = scaled - i;
  const mix = stops[i].map((c, ch) => Math.round(c + (stops[i + 1][ch] - c) * local));
  return `rgb(${mix[0]} ${mix[1]} ${mix[2]})`;
}

/** Maps a zone verdict onto its localised label for the active layer. */
function statusLabel(t: DashboardCopy, layer: HeatmapLayer, status: ZoneStatus): string {
  return (t.heatmap.status[layer] as Record<string, string>)[status] ?? status;
}

/** Width of the zones grid inside the SVG viewBox. */
const VIEW_W = 340;
const VIEW_H = 232;
const PAD = 10;
const GAP = 5;

export default function FieldHeatmapCard({
  t,
  lang,
  wilayaCode,
  crop,
  areaHa,
  irrigation,
  weather,
}: {
  t: DashboardCopy;
  lang: Lang;
  wilayaCode: string;
  crop: CropKey;
  areaHa: number;
  /** The same result the hero card renders: the map is centred on it. */
  irrigation: IrrigationResult;
  weather: WeatherSnapshot;
}) {
  const reduce = Boolean(useReducedMotion());
  const [layer, setLayer] = useState<HeatmapLayer>("moisture");
  const [selected, setSelected] = useState(0);
  /** Which cell currently holds keyboard focus (drives the dashed focus ring). */
  const [focused, setFocused] = useState<number | null>(null);
  const cellRefs = useRef<(SVGRectElement | null)[]>([]);
  const shimmerId = useId();
  const clipId = useId();

  const map: FieldHeatmap = useMemo(
    () =>
      buildFieldHeatmap({
        wilayaCode,
        crop,
        areaHa,
        litresPerHaDay: irrigation.litresPerHaDay,
        et0: irrigation.et0,
        tempC: weather.tempC,
        humidity: weather.humidity,
      }),
    [wilayaCode, crop, areaHa, irrigation.litresPerHaDay, irrigation.et0, weather.tempC, weather.humidity],
  );

  const readings = map.zones.map((zone) => zoneReading(map, zone, layer));
  const active = readings[Math.min(selected, readings.length - 1)];
  const average = layerAverage(map, layer);
  const unit = t.heatmap.units[layer];
  const ramp = LAYER_META[layer].ramp;

  const cellW = (VIEW_W - PAD * 2 - GAP * (map.cols - 1)) / map.cols;
  const cellH = (VIEW_H - PAD * 2 - GAP * (map.rows - 1)) / map.rows;
  /* SVG is never mirrored by `dir`, so the plot is reflected by hand: in Arabic
     the first zone sits top-right, and the abjad letters read right to left. */
  const rtl = lang === "ar";
  const columnX = (col: number) => PAD + (rtl ? map.cols - 1 - col : col) * (cellW + GAP);

  const deltaText =
    active.deltaPct === 0
      ? t.heatmap.deltaEven
      : active.deltaPct > 0
        ? t.heatmap.deltaAbove.replace("{pct}", fmt(Math.abs(active.deltaPct)))
        : t.heatmap.deltaBelow.replace("{pct}", fmt(Math.abs(active.deltaPct)));

  const statusText = statusLabel(t, layer, active.status);
  /* Amber means "needs attention" for this layer (a dry zone, a heat-stressed
     zone, or a stalled transpiration index) — never a blanket rule. */
  const needsAttention =
    layer === "moisture"
      ? active.status === "dry" || active.status === "mildDry"
      : layer === "thermal"
        ? active.status === "high" || active.status === "severe"
        : active.status === "low";
  const zoneName = (index: number) =>
    t.heatmap.zoneLabel.replace("{id}", t.heatmap.zoneIds[index] ?? String(index + 1));

  const layerNote = t.heatmap.layerNote[layer]
    .replace("{value}", fmt(active.value))
    .replace("{delta}", deltaText);

  /** Arrow keys walk the grid; Enter/Space select (same as a tap). */
  const onCellKeyDown = (event: KeyboardEvent<SVGRectElement>, index: number) => {
    const { rows, cols } = map;
    const row = Math.floor(index / cols);
    const col = index % cols;
    let next: number | null = null;
    const left = rtl ? col + 1 : col - 1;
    const right = rtl ? col - 1 : col + 1;
    if (event.key === "ArrowLeft" && left >= 0 && left < cols) next = row * cols + left;
    else if (event.key === "ArrowRight" && right >= 0 && right < cols) next = row * cols + right;
    else if (event.key === "ArrowUp" && row > 0) next = (row - 1) * cols + col;
    else if (event.key === "ArrowDown" && row < rows - 1) next = (row + 1) * cols + col;
    if (next === null) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setSelected(index);
      }
      return;
    }
    event.preventDefault();
    setSelected(next);
    cellRefs.current[next]?.focus();
  };

  return (
    <Card
      className="lg:col-span-2"
      title={t.heatmap.title}
      subtitle={t.heatmap.subtitle
        .replace("{zones}", fmt(map.zones.length))
        .replace("{area}", fmt(areaHa, 1))}
      icon={<MapPinned size={18} strokeWidth={2.4} aria-hidden />}
    >
      <div className="flex flex-col gap-3">
        {/* Layer switcher */}
        <div
          role="radiogroup"
          aria-label={t.heatmap.layersAria}
          className="flex items-center gap-1 rounded-[1.1rem] bg-[#f1f7f3] p-1 ring-1 ring-[rgba(6,78,59,0.07)]"
        >
          {LAYER_ORDER.map((id) => {
            const Icon = LAYER_META[id].icon;
            const isActive = id === layer;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => setLayer(id)}
                className={`relative flex min-h-[2.75rem] flex-1 items-center justify-center gap-1.5 rounded-[0.9rem] px-1 text-[11px] font-extrabold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45 ${
                  isActive ? "text-white" : "text-emerald-900/70 hover:text-emerald-800"
                }`}
              >
                {isActive && (
                  <motion.span
                    layoutId="heatmap-layer"
                    className="absolute inset-0 rounded-[0.9rem] bg-gradient-to-br from-emerald-500 to-green-600 shadow-[0_8px_18px_-10px_rgba(16,185,129,0.9)]"
                    transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 330, damping: 34 }}
                  />
                )}
                <Icon size={12} strokeWidth={2.8} aria-hidden className="relative z-10 shrink-0" />
                <span className="relative z-10">{t.heatmap.layers[id]}</span>
              </button>
            );
          })}
        </div>

        {/* The field itself */}
        <div className="relative overflow-hidden rounded-[1.1rem] bg-[#f4fbf7] p-1 ring-1 ring-[rgba(6,78,59,0.07)]">
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            role="group"
            aria-label={t.heatmap.hint}
            className="w-full touch-manipulation select-none"
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={0} y={0} width={VIEW_W} height={VIEW_H} rx={14} />
              </clipPath>
              <linearGradient id={shimmerId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
                <stop offset="50%" stopColor="#ffffff" stopOpacity="0.42" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Ploughed-row texture: the field reads as a field, not a spreadsheet. */}
            <g clipPath={`url(#${clipId})`} aria-hidden>
              {Array.from({ length: 14 }).map((_, i) => (
                <line
                  key={i}
                  x1={-40 + i * 32}
                  y1={VIEW_H}
                  x2={30 + i * 32}
                  y2={0}
                  stroke="rgba(6,78,59,0.05)"
                  strokeWidth={1}
                />
              ))}
            </g>

            {/* Zones */}
            <g>
              {readings.map((reading, index) => {
                const col = index % map.cols;
                const row = Math.floor(index / map.cols);
                const x = columnX(col);
                const y = PAD + row * (cellH + GAP);
                const isSelected = index === active.zone.index;
                const fill = rampColor(ramp, reading.intensity);
                return (
                  <g key={reading.zone.id}>
                    <motion.rect
                      ref={(el) => {
                        cellRefs.current[index] = el;
                      }}
                      x={x}
                      y={y}
                      width={cellW}
                      height={cellH}
                      rx={10}
                      fill={fill}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={t.heatmap.cellAria
                        .replace("{zone}", zoneName(index))
                        .replace("{value}", fmt(reading.value))
                        .replace("{unit}", unit)
                        .replace("{status}", statusLabel(t, layer, reading.status))}
                      onPointerDown={() => setSelected(index)}
                      onFocus={() => setFocused(index)}
                      onBlur={() => setFocused(null)}
                      onKeyDown={(event) => onCellKeyDown(event, index)}
                      initial={reduce ? false : { opacity: 0, scale: 0.88 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.4, delay: reduce ? 0 : 0.03 * index, ease: [0.22, 1, 0.36, 1] }}
                      style={{ transformOrigin: `${x + cellW / 2}px ${y + cellH / 2}px`, cursor: "pointer" }}
                    />
                    {/* Zone letter: the key that links a cell to the panel below. */}
                    <text
                      x={rtl ? x + cellW - 9 : x + 9}
                      y={y + 16}
                      textAnchor={rtl ? "end" : "start"}
                      fontSize="10"
                      fontWeight={900}
                      fill="rgba(255,255,255,0.82)"
                      pointerEvents="none"
                    >
                      {t.heatmap.zoneIds[index] ?? index + 1}
                    </text>
                    {/* Keyboard focus ring: dashed, so it never reads as a selection. */}
                    {focused === index && !isSelected && (
                      <rect
                        x={x - 2}
                        y={y - 2}
                        width={cellW + 4}
                        height={cellH + 4}
                        rx={12}
                        fill="none"
                        stroke="#022c22"
                        strokeWidth={2}
                        strokeDasharray="5 4"
                        pointerEvents="none"
                      />
                    )}
                    {isSelected && (
                      <motion.g
                        pointerEvents="none"
                        initial={reduce ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.2 }}
                      >
                        <rect
                          x={x - 2}
                          y={y - 2}
                          width={cellW + 4}
                          height={cellH + 4}
                          rx={12}
                          fill="none"
                          stroke="#ffffff"
                          strokeWidth={2.5}
                        />
                        <rect
                          x={x - 2}
                          y={y - 2}
                          width={cellW + 4}
                          height={cellH + 4}
                          rx={12}
                          fill="none"
                          stroke="#047857"
                          strokeWidth={1.2}
                        />
                        {/* Sensor ping on the inspected zone. */}
                        {!reduce && (
                          <circle
                            cx={x + cellW / 2}
                            cy={y + cellH / 2}
                            r={8}
                            fill="none"
                            stroke="#ffffff"
                            strokeWidth={1.6}
                            className="animate-ping"
                            style={{ transformOrigin: `${x + cellW / 2}px ${y + cellH / 2}px` }}
                          />
                        )}
                      </motion.g>
                    )}
                  </g>
                );
              })}
            </g>

            {/* Slow measurement shimmer sweeping the plot (visual only). */}
            <g clipPath={`url(#${clipId})`} aria-hidden pointerEvents="none">
              <motion.rect
                width={90}
                height={VIEW_H}
                fill={`url(#${shimmerId})`}
                initial={{ x: -110 }}
                animate={reduce ? { x: VIEW_W / 3 } : { x: [-110, VIEW_W + 10] }}
                transition={reduce ? { duration: 0 } : { duration: 6.5, repeat: Infinity, ease: "linear", repeatDelay: 1.4 }}
                opacity={reduce ? 0.2 : 0.75}
              />
            </g>
          </svg>

        </div>

        {/* Legend */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-emerald-800/60">{t.heatmap.legendLow}</span>
          <span
            aria-hidden
            className="h-2 flex-1 rounded-full"
            style={{
              background: `linear-gradient(${rtl ? "to left" : "to right"}, ${ramp[0]}, ${ramp[1]}, ${ramp[2]})`,
            }}
          />
          <span className="text-[10px] font-bold text-emerald-800/60">{t.heatmap.legendHigh}</span>
        </div>

        {/* Zone inspection: opens on tap, follows the active layer */}
        <div
          role="region"
          aria-label={t.heatmap.selectedZone}
          aria-live="polite"
          className="app-tile flex flex-col gap-2 px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-black text-emerald-900">
              <Waves size={12} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-600" />
              <span className="truncate">{zoneName(active.zone.index)}</span>
              <span className="shrink-0 text-[10px] font-bold text-emerald-800/55">
                · {fmt(map.zoneAreaHa, 3)} {lang === "ar" ? "هكتار" : "ha"}
              </span>
            </p>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={`${layer}-${active.status}-${active.zone.index}`}
                initial={reduce ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
                transition={{ duration: 0.18 }}
              >
                <Chip tone={needsAttention ? "amber" : "emerald"}>{statusText}</Chip>
              </motion.span>
            </AnimatePresence>
          </div>

          <p dir="ltr" className="text-[24px] font-black leading-none tabular-nums text-emerald-950">
            {fmt(active.value)}{" "}
            <span className="text-[12px] font-extrabold text-emerald-900/70">{unit}</span>
          </p>

          <Progress value={active.intensity * 100} tone={needsAttention ? "amber" : "emerald"} />

          <p className="text-[11.5px] font-semibold leading-[1.75] text-emerald-900/75">{layerNote}</p>
          <p className="text-[10px] font-bold text-emerald-800/55">
            {t.heatmap.zonesCount.replace("{n}", fmt(map.zones.length)).replace("{area}", fmt(areaHa, 1))} ·{" "}
            {t.heatmap.hint}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[1rem] bg-white px-3 py-2 ring-1 ring-[rgba(6,78,59,0.08)]">
          <span className="text-[11px] font-bold text-emerald-800/70">{t.heatmap.average}</span>
          <span dir="ltr" className="text-[13px] font-black tabular-nums text-emerald-950">
            {layer === "moisture" ? `${fmt(average)} ${unit}` : `${fmt(average)} / 100`}
          </span>
        </div>

        <p className="text-[10.5px] font-semibold leading-5 text-emerald-900/50">{t.heatmap.note}</p>
      </div>
    </Card>
  );
}
