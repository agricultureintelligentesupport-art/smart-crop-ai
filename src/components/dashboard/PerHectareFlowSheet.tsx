"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDown, Droplets, Gauge, Sprout, ThermometerSun, Waves, Wind, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Sheet from "@/components/app/Sheet";
import { GPU, SPRING } from "@/components/auth/ui";
import type { IrrigationResult, WeatherSnapshot } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { perHectareFlow, verifyFlow } from "@/lib/dashboard/flow";
import type { Lang } from "@/lib/wilayas";
import { fmt } from "./WeatherCard";

/**
 * "Per hectare" calculation flow, opened from the unit pill in the hero card.
 *
 * The five steps are the *same* chain `computeIrrigation` runs, in the same
 * order, fed with the same result object — no value is re-derived or invented:
 *
 *   1. climate inputs → ET₀ (the real `referenceEt0Detail` intermediates),
 *   2. ET₀ → net crop need (Kc × soil factor),
 *   3. net → gross need (÷ system efficiency),
 *   4. gross → litres per hectare,
 *   5. litres per hectare → the parcel volume shown in the hero card.
 *
 * Intermediates are printed with two decimals so the multiplication chain adds
 * up to the headline number exactly (the card itself shows them at one decimal,
 * hence the precision note). The two headline figures — L/ha and m³ — come
 * straight out of `IrrigationResult`, so the flow can never drift from the card.
 *
 * Every factor is a real button: hovering or tapping it highlights the term it
 * multiplies inside the formula and draws an animated connector to it.
 */

type FactorId = "temp" | "humidity" | "wind" | "kc" | "soil" | "efficiency";

interface FormulaToken {
  text: string;
  /** When set, this token is the term the factor acts on. */
  factor?: FactorId;
  /** Low-emphasis tokens (operators) render smaller. */
  operator?: boolean;
}

interface FactorSpec {
  id: FactorId;
  label: string;
  effect: string;
  icon: LucideIcon;
}

/** Signed percentage with one decimal, e.g. `+2.4%` / `−16.2%` (ratio in, percent out). */
const signedPct = (ratio: number, digits = 1) =>
  `${ratio >= 0 ? "+" : "−"}${fmt(Math.abs(ratio) * 100, digits)}%`;

/* ------------------------------------------------------------------ */
/*  Connector — a measured arrow from a factor button to its term      */
/* ------------------------------------------------------------------ */

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Connector geometry between a factor button and the formula term it acts on.
 *
 * Measured on the interaction itself (both elements are already in the DOM at
 * that point) and re-measured from a resize subscription, so the arrow tracks
 * text reflow, orientation changes and RTL/LTR switches. Coordinates are
 * card-local: rect differences are invariant under the sheet's own scrolling.
 */
function useFactorConnector(activeId: FactorId | null) {
  const hostRef = useRef<HTMLElement | null>(null);
  const anchors = useRef(new Map<FactorId, HTMLElement>());
  const targets = useRef(new Map<FactorId, HTMLElement>());
  const [line, setLine] = useState<Line | null>(null);

  const measure = useCallback((id: FactorId): Line | null => {
    const host = hostRef.current;
    const from = anchors.current.get(id);
    const to = targets.current.get(id);
    if (!host || !from || !to) return null;
    const h = host.getBoundingClientRect();
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    return {
      x1: a.left + a.width / 2 - h.left,
      y1: a.top - h.top,
      x2: b.left + b.width / 2 - h.left,
      y2: b.bottom - h.top,
    };
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const remeasure = () => setLine(measure(activeId));
    window.addEventListener("resize", remeasure);
    const observer = new ResizeObserver(remeasure);
    if (hostRef.current) observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [activeId, measure]);

  return { hostRef, anchors, targets, line, measure, setLine };
}

/* ------------------------------------------------------------------ */
/*  Step card                                                          */
/* ------------------------------------------------------------------ */

function FormulaRow({
  tokens,
  targetRef,
  activeFactor,
  reduce,
}: {
  tokens: FormulaToken[];
  targetRef: (id: FactorId, el: HTMLElement | null) => void;
  activeFactor: FactorId | null;
  reduce: boolean;
}) {
  return (
    // Values are Latin/numeric: pinned LTR so the multiplication never reorders.
    <div
      dir="ltr"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-[0.9rem] bg-white px-2.5 py-2 ring-1 ring-[rgba(6,78,59,0.08)]"
    >
      {tokens.map((token, i) => {
        const isActive = Boolean(token.factor) && token.factor === activeFactor;
        return (
          <span
            key={`${token.text}-${i}`}
            ref={token.factor ? (el) => targetRef(token.factor as FactorId, el) : undefined}
            className={
              token.operator
                ? "text-[13px] font-bold text-emerald-900/45"
                : `text-[13px] font-black tabular-nums ${
                    token.factor ? "text-emerald-800" : "text-emerald-950"
                  }`
            }
          >
            <motion.span
              animate={
                isActive
                  ? { scale: 1.14, color: "#047857" }
                  : { scale: 1, color: token.factor ? "#065f46" : "#022c22" }
              }
              transition={reduce ? { duration: 0 } : SPRING}
              className={`inline-block origin-center rounded-lg px-1.5 py-0.5 ${
                token.factor
                  ? isActive
                    ? "bg-emerald-100 shadow-[0_0_0_2px_rgba(16,185,129,0.55)]"
                    : "bg-emerald-50"
                  : ""
              }`}
            >
              {token.text}
            </motion.span>
          </span>
        );
      })}
    </div>
  );
}

function StepCard({
  index,
  title,
  note,
  tokens,
  factors,
  result,
  activeFactor,
  onToggle,
  resultTag,
  factorsTag,
  stepLabel,
  highlight,
}: {
  index: number;
  title: string;
  note: string;
  tokens: FormulaToken[];
  factors: FactorSpec[];
  /** The step's produced value: the answer this card hands to the next one. */
  result: { value: string };
  activeFactor: FactorId | null;
  /** Sets (or clears) the sheet-wide highlighted factor. */
  onToggle: (id: FactorId | null) => void;
  resultTag: string;
  factorsTag: string;
  stepLabel: string;
  /** Final steps get the emphasis treatment. */
  highlight?: boolean;
}) {
  const reduce = Boolean(useReducedMotion());
  const owns = factors.some((f) => f.id === activeFactor);
  const { hostRef, anchors, targets, line, measure, setLine } = useFactorConnector(
    owns ? activeFactor : null,
  );
  const active = factors.find((f) => f.id === activeFactor);

  /** Highlights a factor and snaps the connector to it in the same gesture. */
  const activate = (id: FactorId | null) => {
    onToggle(id);
    setLine(id ? measure(id) : null);
  };

  return (
    <article
      ref={(el) => {
        hostRef.current = el;
      }}
      className={`relative flex min-w-0 flex-col gap-2.5 rounded-[1.1rem] p-3 ring-1 ${
        highlight
          ? "bg-emerald-50/70 ring-emerald-200"
          : "bg-[#f6faf7] ring-[rgba(6,78,59,0.07)]"
      }`}
    >
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-black ${
            highlight ? "bg-emerald-600 text-white" : "bg-emerald-100 text-emerald-800"
          }`}
        >
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold tracking-wide text-emerald-800/55">
            {stepLabel.replace("{n}", String(index))}
          </p>
          <h3 className="mt-0.5 text-[13.5px] font-black leading-5 text-emerald-950">{title}</h3>
        </div>
      </header>

      <p className="text-[11.5px] font-semibold leading-[1.7] text-emerald-900/70">{note}</p>

      <FormulaRow
        tokens={tokens}
        activeFactor={activeFactor}
        reduce={reduce}
        targetRef={(id, el) => {
          if (el) targets.current.set(id, el);
          else targets.current.delete(id);
        }}
      />

      {factors.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-bold tracking-wide text-emerald-800/55">{factorsTag}</p>
          <div className="flex flex-wrap gap-1.5">
            {factors.map((factor) => {
              const isActive = factor.id === activeFactor;
              const Icon = factor.icon;
              return (
                <button
                  key={factor.id}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => activate(isActive ? null : factor.id)}
                  onPointerEnter={(event) => {
                    if (event.pointerType === "mouse") activate(factor.id);
                  }}
                  onPointerLeave={(event) => {
                    if (event.pointerType === "mouse") activate(null);
                  }}
                  ref={(el) => {
                    if (el) anchors.current.set(factor.id, el);
                    else anchors.current.delete(factor.id);
                  }}
                  className={`inline-flex min-h-[2.75rem] items-center gap-1.5 rounded-full px-3 text-[11.5px] font-extrabold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45 ${
                    isActive
                      ? "bg-emerald-600 text-white shadow-[0_8px_20px_-10px_rgba(5,150,105,0.95)]"
                      : "bg-white text-emerald-800 ring-1 ring-[rgba(6,78,59,0.12)] hover:ring-emerald-300"
                  }`}
                >
                  <Icon size={12} strokeWidth={2.8} aria-hidden className="shrink-0" />
                  <span dir="ltr">{factor.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <AnimatePresence initial={false}>
        {active && (
          <motion.p
            key={active.id}
            initial={reduce ? false : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="rounded-[0.85rem] border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-[11.5px] font-bold leading-[1.75] text-emerald-900"
          >
            {active.effect}
          </motion.p>
        )}
      </AnimatePresence>

      {/* Measured connector: factor button → the term it changes. */}
      {line && active && (
        <svg
          aria-hidden
          data-connector={activeFactor}
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        >
          <motion.path
            key={`${activeFactor}-line`}
            d={`M ${line.x1} ${line.y1} C ${line.x1} ${line.y1 - Math.max(18, (line.y1 - line.y2) * 0.45)}, ${
              line.x2
            } ${line.y2 + Math.max(18, (line.y1 - line.y2) * 0.45)}, ${line.x2} ${line.y2}`}
            fill="none"
            stroke="#059669"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeDasharray="4 4"
            initial={reduce ? false : { pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 0.85 }}
            transition={{ duration: 0.42, ease: "easeOut" }}
          />
          <g transform={`translate(${line.x2} ${line.y2})`}>
            <motion.path
              d="M -4.5 0 L 4.5 0 L 0 -7.5 Z"
              fill="#059669"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2, delay: reduce ? 0 : 0.32 }}
            />
          </g>
        </svg>
      )}

      {/* The step's answer: the exact value the next card starts from. */}
      <div
        className={`flex items-center gap-2 rounded-[0.85rem] px-2.5 py-2 ring-1 ${
          highlight ? "bg-white ring-emerald-200" : "bg-white/70 ring-[rgba(6,78,59,0.08)]"
        }`}
      >
        <ArrowDown size={13} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-500" />
        <span className="min-w-0 flex-1 text-[11px] font-bold text-emerald-800/70">{resultTag}</span>
        <span dir="ltr" className="shrink-0 text-[14px] font-black tabular-nums text-emerald-800">
          {result.value}
        </span>
      </div>
    </article>
  );
}

/** Animated arrow between two steps: draws down, then a pulse rides along it. */
function FlowArrow({ delay }: { delay: number }) {
  const reduce = Boolean(useReducedMotion());
  return (
    <div className="flex items-center justify-center py-1.5" aria-hidden>
      <div className="relative flex h-9 w-6 items-center justify-center">
        <motion.span
          initial={reduce ? false : { scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={{ duration: 0.4, delay: reduce ? 0 : delay, ease: "easeOut" }}
          className={`h-full w-[2px] origin-top rounded-full bg-gradient-to-b from-emerald-200 via-emerald-300 to-emerald-500 ${GPU}`}
        />
        {!reduce && (
          <motion.span
            className="absolute h-1.5 w-1.5 rounded-full bg-emerald-500"
            initial={{ top: 0, opacity: 0 }}
            animate={{ top: ["0%", "100%"], opacity: [0, 1, 0] }}
            transition={{ duration: 1.6, delay: delay + 0.3, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sheet                                                              */
/* ------------------------------------------------------------------ */

export default function PerHectareFlowSheet({
  open,
  onClose,
  t,
  lang,
  wilayaName,
  cropName,
  soilName,
  systemName,
  areaHa,
  irrigation,
  weather,
}: {
  open: boolean;
  onClose: () => void;
  t: DashboardCopy;
  lang: Lang;
  wilayaName: string;
  cropName: string;
  soilName: string;
  systemName: string;
  areaHa: number;
  irrigation: IrrigationResult;
  weather: WeatherSnapshot;
}) {
  const f = t.flow;
  const [activeFactor, setActiveFactor] = useState<FactorId | null>(null);

  /* ---------------- The real chain, straight from the shared result ---------------- */

  const { tempC, humidity, windKph } = weather;
  const {
    et0,
    netMm,
    grossMm,
    litresPerHa,
    parcelM3,
    weeklyM3,
    areaHa: flowAreaHa,
  } = perHectareFlow({ irrigation, weather, areaHa });
  // True when the printed chain lands on the card's own parcel volume; the
  // display honours the app's round-to-m³ step either way.
  const { parcelMatches } = verifyFlow({ et0, netMm, grossMm, litresPerHa, parcelM3, weeklyM3, areaHa: flowAreaHa });

  const { kc, soilFactor, efficiency } = irrigation;
  const localFactorEffect = (value: number) => signedPct(value - 1);

  const steps: {
    title: string;
    note: string;
    tokens: FormulaToken[];
    factors: FactorSpec[];
    result: { value: string };
    highlight?: boolean;
  }[] = [
    {
      title: f.climateTitle,
      note: f.climateNote,
      tokens: [
        { text: "0.155" },
        { text: "×", operator: true },
        { text: `${fmt(tempC)}°`, factor: "temp" },
        { text: "×", operator: true },
        { text: fmt(et0.humidityDamping, 3), factor: "humidity" },
        { text: "×", operator: true },
        { text: fmt(et0.windBoost, 3), factor: "wind" },
        { text: "=", operator: true },
        { text: `${fmt(et0.final, 1)} mm` },
      ],
      factors: [
        {
          id: "temp",
          icon: ThermometerSun,
          label: f.factorTemp.replace("{temp}", fmt(tempC)),
          effect: f.factorTempEffect
            .replace("{temp}", fmt(tempC))
            .replace("{base}", fmt(0.155 * tempC, 2)),
        },
        {
          id: "humidity",
          icon: Droplets,
          label: f.factorHumidity.replace("{damp}", fmt(et0.humidityDamping, 3)),
          effect: f.factorHumidityEffect
            .replace("{humidity}", fmt(humidity))
            .replace("{damp}", fmt(et0.humidityDamping, 3))
            .replace("{pct}", localFactorEffect(et0.humidityDamping)),
        },
        {
          id: "wind",
          icon: Wind,
          label: f.factorWind.replace("{boost}", fmt(et0.windBoost, 3)),
          effect: f.factorWindEffect
            .replace("{wind}", fmt(windKph))
            .replace("{boost}", fmt(et0.windBoost, 3))
            .replace("{pct}", localFactorEffect(et0.windBoost)),
        },
      ],
      result: { value: `${fmt(et0.final, 1)} mm` },
    },
    {
      title: f.cropTitle,
      note: f.cropNote,
      tokens: [
        { text: `${fmt(et0.final, 1)} mm` },
        { text: "×", operator: true },
        { text: fmt(kc, 2), factor: "kc" },
        { text: "×", operator: true },
        { text: fmt(soilFactor, 2), factor: "soil" },
        { text: "=", operator: true },
        { text: `${fmt(netMm, 2)} mm` },
      ],
      factors: [
        {
          id: "kc",
          icon: Sprout,
          label: f.factorKc.replace("{crop}", cropName).replace("{kc}", fmt(kc, 2)),
          effect: f.factorKcEffect.replace("{kc}", fmt(kc, 2)).replace("{crop}", cropName),
        },
        {
          id: "soil",
          icon: Gauge,
          label: f.factorSoil.replace("{soilFactor}", fmt(soilFactor, 2)),
          effect: f.factorSoilEffect
            .replace("{soil}", soilName)
            .replace("{soilFactor}", fmt(soilFactor, 2))
            .replace("{pct}", localFactorEffect(soilFactor)),
        },
      ],
      result: { value: `${fmt(netMm, 2)} mm` },
    },
    {
      title: f.efficiencyTitle,
      note: f.efficiencyNote,
      tokens: [
        { text: `${fmt(netMm, 2)} mm` },
        { text: "÷", operator: true },
        { text: fmt(efficiency, 2), factor: "efficiency" },
        { text: "=", operator: true },
        { text: `${fmt(grossMm, 2)} mm` },
      ],
      factors: [
        {
          id: "efficiency",
          icon: Waves,
          label: f.factorEfficiency.replace("{efficiency}", fmt(efficiency, 2)),
          effect: f.factorEfficiencyEffect
            .replace("{efficiency}", fmt(efficiency, 2))
            .replace("{pct}", signedPct(1 / efficiency - 1)),
        },
      ],
      result: { value: `${fmt(grossMm, 2)} mm` },
    },
    {
      title: f.hectareTitle,
      note: f.hectareNote,
      tokens: [
        { text: `${fmt(grossMm, 2)} mm` },
        { text: "×", operator: true },
        { text: "10 000 L/ha·mm" },
        { text: "=", operator: true },
        { text: `${fmt(litresPerHa)} L/ha` },
      ],
      factors: [],
      result: { value: `${fmt(litresPerHa)} L` },
      highlight: true,
    },
    {
      title: f.totalTitle,
      note: f.totalNote.replace("{area}", fmt(flowAreaHa, 1)),
      tokens: [
        { text: `${fmt(litresPerHa)} L/ha` },
        { text: "×", operator: true },
        { text: `${fmt(areaHa, 1)} ha` },
        { text: parcelMatches ? "=" : "≈", operator: true },
        { text: `${fmt(parcelM3, 1)} m³` },
      ],
      factors: [],
      result: { value: `${fmt(parcelM3, 1)} m³` },
      highlight: true,
    },
  ];

  /* ---------------- Factor interaction (one highlight across the sheet) ---------------- */

  const close = () => {
    setActiveFactor(null);
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={f.title} subtitle={f.subtitle
      .replace("{crop}", cropName)
      .replace("{wilaya}", wilayaName)
      .replace("{system}", systemName)} lang={lang}>
      <div className="flex flex-col gap-3">
        {/* The two headline numbers, verbatim from the hero card. */}
        <div className="grid grid-cols-2 gap-2">
          <div className="app-tile px-3 py-2.5">
            <p className="text-[10.5px] font-bold tracking-wide text-emerald-800/65">{t.hero.perHa}</p>
            <p dir="ltr" className="mt-1 text-[17px] font-black tabular-nums text-emerald-950">
              {fmt(litresPerHa)} L
            </p>
          </div>
          <div className="app-tile px-3 py-2.5">
            <p className="text-[10.5px] font-bold tracking-wide text-emerald-800/65">{t.hero.needLabel}</p>
            <p dir="ltr" className="mt-1 text-[17px] font-black tabular-nums text-emerald-950">
              {fmt(parcelM3, 1)} m³
            </p>
          </div>
        </div>

        <p className="px-1 text-[11.5px] font-semibold leading-[1.7] text-emerald-900/65">{f.hint}</p>

        <ol className="flex flex-col">
          {steps.map((step, i) => (
            <li key={step.title} className="flex flex-col">
              <StepCard
                index={i + 1}
                title={step.title}
                note={step.note}
                tokens={step.tokens}
                factors={step.factors}
                result={step.result}
                highlight={step.highlight}
                activeFactor={activeFactor}
                onToggle={setActiveFactor}
                resultTag={f.resultTag}
                factorsTag={f.factorsTag}
                stepLabel={f.stepLabel}
              />
              {i < steps.length - 1 && <FlowArrow delay={0.08 * i} />}
            </li>
          ))}
        </ol>

        <div className="flex flex-col gap-2 rounded-[1.1rem] bg-emerald-50/70 p-3 ring-1 ring-emerald-200">
          <p className="text-[11.5px] font-bold leading-[1.8] text-emerald-900">
            {f.syncNote.replace("{litres}", fmt(litresPerHa)).replace("{daily}", fmt(parcelM3, 1))}
          </p>
          <p className="text-[10.5px] font-semibold leading-[1.7] text-emerald-900/60">
            {f.precisionNote.replace("{litres}", fmt(litresPerHa))}
          </p>
          <p className="text-[10.5px] font-semibold leading-[1.7] text-emerald-900/60">
            {t.windowDetail.stepVolumeNote.replace("{weekly}", fmt(weeklyM3))}
          </p>
        </div>
      </div>
    </Sheet>
  );
}
