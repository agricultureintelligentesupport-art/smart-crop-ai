"use client";

/**
 * «مؤشر الغطاء النباتي» — the REAL Sentinel-2 NDVI time series of the farmer's
 * saved plot: the last 30 days, one dot per day the satellite actually measured
 * the plot, and nothing in between.
 *
 * Replaces the previous simulated card (`ndviFor`). Data comes from
 * `/api/ndvi-series` (Sentinel Hub Statistical API, per-day mean over the
 * cloud-free pixels inside the boundary). Honesty rules the card keeps:
 *
 *   • Real points only. The curve joins measured days with a monotone cubic
 *     (it cannot overshoot, so it cannot show a value nobody measured); with
 *     fewer than three points it is straight segments and a note says why.
 *   • The x axis is the calendar, so a gap in the observations is a visible gap.
 *   • Passes that were all cloud are hollow markers on the axis («غيوم»), never
 *     bridged. Cloud info the Catalog could not give is simply not shown.
 *   • The status chip is the app's existing NDVI band (`ndviBand`); the change
 *     badge compares the latest real mean with the FIRST real mean.
 *   • Failures show their technical reason and a retry; an empty window and a
 *     missing plot have their own states. No number is ever invented.
 *
 * All maths (path, scales, snapping, change %, response parsing) lives in the
 * unit-tested `lib/satellite/ndvi-series`; this file renders and wires events.
 * Motion is CSS only (`satellite-card.css`, reduced-motion aware) plus one
 * requestAnimationFrame count-up that writes the DOM directly.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { ArrowDownRight, ArrowUpRight, CloudOff, MapPinned, Minus, RotateCw, Satellite, TriangleAlert } from "lucide-react";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { Plot } from "@/lib/field-data/types";
import type { Ring } from "@/lib/geo/polygon";
import {
  areaGradientStops,
  buildChartModel,
  canonicalRingKey,
  formatChangePct,
  formatCloudPct,
  interpretSeriesResponse,
  nearestPointIndex,
  ndviPaletteCss,
  ndviStatus,
  neighborByX,
  networkFailureView,
  placeTooltip,
  seriesChange,
  type NdviSeriesPayload,
  type SeriesView,
} from "@/lib/satellite/ndvi-series";
import type { CropKey, Lang } from "@/lib/wilayas";
import { Card, Chip } from "./parts";
import "./satellite-card.css";

/* ------------------------------------------------------------------ */
/*  Copy (AR is the app's primary language)                            */
/* ------------------------------------------------------------------ */

const COPY = {
  ar: {
    caption: "آخر 30 يوماً · Sentinel-2",
    latest: "آخر قياس",
    since: "منذ",
    changeLabel: "التغير منذ أول قياس",
    chartLabel: "تطور مؤشر NDVI لقطعتك خلال آخر 30 يوماً",
    readings: "قراءات المؤشر",
    cloud: "غيوم",
    cloudPct: "نسبة الغيوم",
    realLegend: "قياس حقيقي",
    cloudLegend: "غيوم، لا قياس",
    count: "عدد القياسات",
    source: "المصدر: Sentinel-2 L2A. المتوسط يخص البكسلات الصافية داخل حدود قطعتك فقط.",
    sparse1: "قياس صافٍ واحد فقط خلال آخر 30 يوماً، لذلك لا نرسم منحنى من نقطة واحدة.",
    sparse2: "قياسان صافيان فقط خلال آخر 30 يوماً، لذلك نصل بينهما بخط مستقيم دون تنعيم.",
    loading: "جارٍ تحميل سلسلة NDVI من Sentinel-2",
    noPlot: "ارسم حدود قطعتك لتظهر هنا سلسلة NDVI الحقيقية من Sentinel-2.",
    emptyTitle: "لا توجد قياسات صافية خلال آخر 30 يوماً",
    emptyNone: "لم يمرّ Sentinel-2 فوق قطعتك بلقطة صالحة في هذه الفترة.",
    emptyCloudy: "لقطات غائمة فوق قطعتك:",
    emptyHint: "لا نعرض أرقاماً لم تُقَس.",
    technical: "التفاصيل التقنية",
    retry: "إعادة المحاولة",
  },
  fr: {
    caption: "30 derniers jours · Sentinel-2",
    latest: "Dernière mesure",
    since: "depuis le",
    changeLabel: "Évolution depuis la première mesure",
    chartLabel: "Évolution du NDVI de votre parcelle sur les 30 derniers jours",
    readings: "Valeurs de l'indice",
    cloud: "Nuages",
    cloudPct: "Couverture nuageuse",
    realLegend: "Mesure réelle",
    cloudLegend: "Nuages, pas de mesure",
    count: "Mesures",
    source: "Source : Sentinel-2 L2A. La moyenne ne porte que sur les pixels dégagés à l'intérieur de votre parcelle.",
    sparse1: "Une seule mesure dégagée sur les 30 derniers jours : aucune courbe n'est tracée à partir d'un point.",
    sparse2: "Deux mesures dégagées seulement sur 30 jours : elles sont reliées par une droite, sans lissage.",
    loading: "Chargement de la série NDVI de Sentinel-2",
    noPlot: "Tracez le contour de votre parcelle pour voir ici sa vraie série NDVI Sentinel-2.",
    emptyTitle: "Aucune mesure dégagée sur les 30 derniers jours",
    emptyNone: "Sentinel-2 n'a pas fourni de passage exploitable au-dessus de votre parcelle sur cette période.",
    emptyCloudy: "Passages nuageux au-dessus de votre parcelle :",
    emptyHint: "Aucun chiffre non mesuré n'est affiché.",
    technical: "Détail technique",
    retry: "Réessayer",
  },
} as const satisfies Record<Lang, Record<string, string>>;

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CHART_HEIGHT = 148;
/** The inner width of the card at 360 px; replaced by the measured width right after mount. */
const FALLBACK_WIDTH = 296;
/** The route answers within ~25 s; the card gives up a little later. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A tap within this many px of a dot pins it (44 px target). */
const TAP_RADIUS = 22;
const TIP_WIDTH = 124;
const TIP_HEIGHT = 52;
const TIP_HEIGHT_WITH_CLOUD = 67;
/** A finished series is reused for this long when the card remounts (tab switches). */
const MEMO_TTL_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Data: one request per plot geometry, remembered across remounts    */
/* ------------------------------------------------------------------ */

type ReadyView = Extract<SeriesView, { kind: "ready" }>;

/**
 * Finished series only — a failure is never remembered. Entries expire on a
 * timer (not by reading the clock while rendering), and a remount of the card
 * (switching tabs and back) then costs no request and no skeleton flash.
 */
const memo = new Map<string, { view: ReadyView; version: number }>();
let versionCounter = 0;

function remember(key: string, view: ReadyView): number {
  versionCounter += 1;
  const version = versionCounter;
  memo.set(key, { view, version });
  // Only the entry this call stored may expire it (a later retry must not lose its newer one).
  setTimeout(() => {
    if (memo.get(key)?.version === version) memo.delete(key);
  }, MEMO_TTL_MS);
  return version;
}

interface SeriesResult {
  tag: string;
  view: SeriesView;
  /** Changes with every fresh answer: the chart re-mounts and its draw animation replays. */
  version: number;
}

function useNdviSeries(ring: Ring | null): { view: SeriesView | null; version: number; retry: () => void } {
  const key = ring ? canonicalRingKey(ring) : null;
  // Retries belong to one geometry: drawing another plot starts from attempt 0 again.
  const [retries, setRetries] = useState<{ key: string | null; n: number }>({ key: null, n: 0 });
  const attempt = retries.key === key ? retries.n : 0;
  const [result, setResult] = useState<SeriesResult | null>(null);
  const ringRef = useRef<Ring | null>(ring);
  useEffect(() => {
    ringRef.current = ring;
  });

  const tag = key === null ? null : `${key}#${attempt}`;
  const remembered = key !== null && attempt === 0 ? memo.get(key) : undefined;
  const current = result !== null && result.tag === tag ? result : null;

  useEffect(() => {
    const body = ringRef.current;
    if (key === null || tag === null || body === null) return;
    if (attempt === 0 && memo.has(key)) return; // a finished series is remembered: nothing to ask
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    fetch("/api/ndvi-series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ring: body }),
      signal: controller.signal,
    })
      .then(async (res) => interpretSeriesResponse(res.status, await res.json().catch(() => null)))
      .catch((error: unknown) => networkFailureView(error, timedOut))
      .then((view) => {
        clearTimeout(timer);
        if (controller.signal.aborted && !timedOut) return; // superseded or unmounted
        const version = view.kind === "ready" ? remember(key, view) : ++versionCounter;
        setResult({ tag, view, version });
      });
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, tag, attempt]);

  // A new attempt (the retry button) never reads the memo.
  const retry = () => setRetries((r) => ({ key, n: (r.key === key ? r.n : 0) + 1 }));

  if (current) return { view: current.view, version: current.version, retry };
  if (remembered) return { view: remembered.view, version: remembered.version, retry };
  return { view: null, version: 0, retry };
}

/* ------------------------------------------------------------------ */
/*  Small browser hooks                                                */
/* ------------------------------------------------------------------ */

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
}

/** Soft entrance: true once the card has scrolled into view (never flips back). */
function useReveal(): [boolean, RefObject<HTMLDivElement | null>] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setRevealed(true));
      return () => cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [revealed, ref];
}

function useElementWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** The big number: counts up from 0 by writing the DOM node directly (no per-frame React render). */
function CountUp({ value, animate }: { value: number; animate: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!animate) {
      el.textContent = value.toFixed(2);
      return;
    }
    el.textContent = (0).toFixed(2);
    const startedAt = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - startedAt) / 950);
      el.textContent = (value * (1 - (1 - progress) ** 3)).toFixed(2);
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, animate]);
  return <span ref={ref} aria-hidden />;
}

/** `29 سبتمبر` — the acquisition day is a UTC calendar date, so it is formatted in UTC. */
function dayFormatter(lang: Lang) {
  const locale = lang === "ar" ? "ar-DZ-u-nu-latn" : "fr-DZ";
  const short = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const long = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" });
  const parse = (day: string) => new Date(`${day}T00:00:00Z`);
  return { short: (day: string) => short.format(parse(day)), long: (day: string) => long.format(parse(day)) };
}

/* ------------------------------------------------------------------ */
/*  The card                                                           */
/* ------------------------------------------------------------------ */

interface SatelliteCardProps {
  t: DashboardCopy;
  lang: Lang;
  /** Kept for the existing call site; the series is measured, no longer modelled from wilaya/crop. */
  wilayaCode: string;
  crop?: CropKey;
  /** The farmer's saved plot, or `null` before one was drawn. */
  plot: Plot | null;
  /** The plot store is still syncing: a skeleton, never «no plot». */
  loading: boolean;
  /** Opens the existing draw flow (the same action as the «قطعتي» card). */
  onDraw: () => void;
}

export default function SatelliteCard({ t, lang, plot, loading, onDraw }: SatelliteCardProps) {
  const c = COPY[lang];
  const [revealed, sentinelRef] = useReveal();
  const { view, version, retry } = useNdviSeries(plot ? plot.ring : null);

  const plotName = plot ? plot.name.trim() || t.heatmap.plotFallback : null;
  const waiting = (loading && !plot) || (plot !== null && view === null);

  let body;
  if (waiting) body = <SeriesSkeleton label={c.loading} />;
  else if (!plot) body = <NoPlotState text={c.noPlot} cta={t.heatmap.mapDraw} onDraw={onDraw} />;
  else if (view?.kind === "ready") {
    body = <SeriesBody key={version} series={view.series} t={t} lang={lang} animate={revealed} />;
  } else if (view?.kind === "empty") body = <EmptyState view={view} lang={lang} />;
  else if (view?.kind === "error") {
    body = <ErrorState message={t.fieldDataReason[view.reason]} technical={view.technical} lang={lang} onRetry={retry} />;
  }

  return (
    <Card
      title={t.satellite.title}
      subtitle={c.caption}
      icon={<Satellite size={18} strokeWidth={2.4} aria-hidden />}
      aside={
        plotName ? (
          <Chip tone="slate" icon={<MapPinned size={11} strokeWidth={3} aria-hidden />}>
            <span className="nds-chip-name" title={plotName}>
              {plotName}
            </span>
          </Chip>
        ) : undefined
      }
      className={`nds-card ${revealed ? "nds-card--in" : "nds-card--pending"}`}
    >
      <div ref={sentinelRef} className="nds-sentinel" aria-hidden />
      {body}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  States                                                             */
/* ------------------------------------------------------------------ */

/** Shaped like the finished card: hero blocks, then the chart's area silhouette. */
function SeriesSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true" aria-label={label}>
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="nds-skel" style={{ height: 11, width: 74 }} />
          <div className="nds-skel" style={{ height: 34, width: 98 }} />
          <div className="nds-skel" style={{ height: 11, width: 118 }} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="nds-skel" style={{ height: 26, width: 64, borderRadius: 999 }} />
          <div className="nds-skel" style={{ height: 26, width: 78, borderRadius: 999 }} />
        </div>
      </div>
      <div className="relative" style={{ marginBottom: 26 }}>
        <div className="nds-skel nds-skel--chart" />
        <div className="nds-skel-grid" aria-hidden />
        <div className="absolute inset-x-0 flex justify-between" style={{ top: CHART_HEIGHT + 8 }} aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="nds-skel" style={{ height: 10, width: 34 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function NoPlotState({ text, cta, onDraw }: { text: string; cta: string; onDraw: () => void }) {
  return (
    <div className="nds-state nds-state--noplot">
      <div className="nds-state-head">
        <span className="nds-state-icon" aria-hidden>
          <MapPinned size={19} strokeWidth={2.4} />
        </span>
        <p className="nds-state-msg">{text}</p>
      </div>
      {/* The same action as the «قطعتي» card's button: it opens the existing draw flow. */}
      <button type="button" className="nds-cta" onClick={onDraw}>
        <MapPinned size={17} strokeWidth={2.6} aria-hidden />
        {cta}
      </button>
    </div>
  );
}

function ErrorState({ message, technical, lang, onRetry }: { message: string; technical: string; lang: Lang; onRetry: () => void }) {
  const c = COPY[lang];
  return (
    <div className="nds-state nds-state--error" role="alert">
      <div className="nds-state-head">
        <span className="nds-state-icon" aria-hidden>
          <TriangleAlert size={19} strokeWidth={2.4} />
        </span>
        <p className="nds-state-msg">{message}</p>
      </div>
      <p className="nds-tech" dir="ltr">
        <b dir={lang === "ar" ? "rtl" : "ltr"}>{c.technical}:</b> {technical}
      </p>
      <button type="button" className="nds-retry" onClick={onRetry}>
        <RotateCw size={16} strokeWidth={2.6} aria-hidden />
        {c.retry}
      </button>
    </div>
  );
}

function EmptyState({ view, lang }: { view: Extract<SeriesView, { kind: "empty" }>; lang: Lang }) {
  const c = COPY[lang];
  return (
    <div className="nds-state nds-state--empty">
      <div className="nds-state-head">
        <span className="nds-state-icon" aria-hidden>
          <CloudOff size={19} strokeWidth={2.4} />
        </span>
        <div>
          <p className="nds-state-title">{c.emptyTitle}</p>
          <p className="nds-state-text">
            {view.cloudyDates.length > 0 ? (
              <>
                {c.emptyCloudy} <span dir="ltr">{view.cloudyDates.length}</span>.
              </>
            ) : (
              c.emptyNone
            )}{" "}
            {c.emptyHint}
          </p>
        </div>
      </div>
      <p className="nds-tech nds-tech--soft" dir="ltr">
        <b dir={lang === "ar" ? "rtl" : "ltr"}>{c.technical}:</b> {view.technical}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  The finished chart                                                 */
/* ------------------------------------------------------------------ */

function SeriesBody({ series, t, lang, animate }: { series: NdviSeriesPayload; t: DashboardCopy; lang: Lang; animate: boolean }) {
  const c = COPY[lang];
  const rtl = lang === "ar";
  const reduced = usePrefersReducedMotion();
  const gradientId = `nds-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(surfaceRef, FALLBACK_WIDTH);
  const fmt = useMemo(() => dayFormatter(lang), [lang]);

  const model = useMemo(
    () =>
      buildChartModel({
        points: series.points,
        cloudyDates: series.cloudyDates ?? [],
        from: series.from,
        to: series.to,
        width,
        height: CHART_HEIGHT,
        rtl,
      }),
    [series, width, rtl],
  );
  const xs = useMemo(() => model.points.map((p) => p.x), [model]);
  const stops = useMemo(() => areaGradientStops(model.yDomain), [model.yDomain]);

  const first = series.points[0];
  const latest = series.points[series.points.length - 1];
  const status = ndviStatus(latest.mean);
  const change = seriesChange(series.points);
  const hasCloudInfo = series.points.some((p) => p.cloudCoverPct !== null);

  /* ---- interaction: scrub, pin, keyboard ---- */
  const [active, setActive] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const press = useRef<{ x: number; y: number; at: number; moved: boolean } | null>(null);
  const shown = active ?? pinned;
  const shownPoint = shown === null ? null : (model.points[shown] ?? null);

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const p = local(event);
    press.current = { x: p.x, y: p.y, at: performance.now(), moved: false };
    setActive(nearestPointIndex(xs, p.x));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = local(event);
    const start = press.current;
    if (start) {
      if (Math.abs(p.x - start.x) > 6 || Math.abs(p.y - start.y) > 6) start.moved = true;
      setActive(nearestPointIndex(xs, p.x));
    } else if (event.pointerType === "mouse") {
      setActive(nearestPointIndex(xs, p.x));
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current;
    press.current = null;
    if (!start) return;
    const p = local(event);
    const index = nearestPointIndex(xs, p.x);
    const dot = model.points[index];
    const tap = !start.moved && performance.now() - start.at < 600;
    if (tap && dot && Math.hypot(dot.x - p.x, dot.y - p.y) <= TAP_RADIUS) setPinned((current) => (current === index ? null : index));
    else if (tap) setPinned(null);
    setActive(event.pointerType === "mouse" ? index : null);
  };
  const onPointerCancel = () => {
    press.current = null;
    setActive(null);
  };
  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && !press.current) setActive(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? pinned ?? model.points.length - 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setActive(neighborByX(xs, current, event.key === "ArrowLeft" ? -1 : 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setPinned((p) => (p === current ? null : current));
    } else if (event.key === "Escape") {
      setActive(null);
      setPinned(null);
    }
  };

  const tipHeight = shownPoint && shownPoint.cloudCoverPct !== null ? TIP_HEIGHT_WITH_CLOUD : TIP_HEIGHT;
  const tip = shownPoint
    ? placeTooltip({ x: shownPoint.x, y: shownPoint.y, tipWidth: TIP_WIDTH, tipHeight, boxWidth: model.width, boxHeight: model.height })
    : null;

  /* x-axis labels stay inside the card edge */
  const tickX = (x: number) => Math.min(Math.max(x, 18), model.width - 18);
  const spanX = model.points[model.points.length - 1].x - model.points[0].x;
  const reading = (p: { date: string; value: number; cloudCoverPct: number | null }) =>
    `${fmt.long(p.date)}: NDVI ${p.value.toFixed(2)}${p.cloudCoverPct === null ? "" : `, ${c.cloudPct} ${formatCloudPct(p.cloudCoverPct)}`}`;
  const listId = `${gradientId}-list`;

  return (
    <div className="flex flex-col gap-3">
      {/* ---- hero ---- */}
      <div className="flex items-end justify-between gap-3">
        <div className="nds-hero-rise min-w-0">
          <p className="text-[11.5px] font-extrabold tracking-wide text-emerald-800/65">{t.satellite.value}</p>
          <p dir="ltr" className="mt-1 text-[34px] font-black leading-none tabular-nums text-emerald-950">
            <CountUp value={latest.mean} animate={animate && !reduced} />
            <span className="sr-only">{latest.mean.toFixed(2)}</span>
          </p>
          <p className="mt-1.5 text-[11.5px] font-bold text-emerald-900/70">
            {c.latest} · {fmt.long(latest.date)}
          </p>
        </div>
        <div className="nds-hero-rise flex flex-col items-end gap-1.5" style={{ animationDelay: "90ms" }}>
          <Chip tone={status.tone}>{t.satellite.bands[status.band]}</Chip>
          {change && (
            <span className={`nds-delta nds-delta--${change.direction}`} role="img" aria-label={`${c.changeLabel}: ${formatChangePct(change)}`}>
              {change.direction === "up" ? (
                <ArrowUpRight size={15} strokeWidth={3} aria-hidden />
              ) : change.direction === "down" ? (
                <ArrowDownRight size={15} strokeWidth={3} aria-hidden />
              ) : (
                <Minus size={15} strokeWidth={3} aria-hidden />
              )}
              <span dir="ltr">{formatChangePct(change)}</span>
            </span>
          )}
          {change && (
            <span className="text-[10.5px] font-bold text-emerald-900/65">
              {c.since} {fmt.short(first.date)}
            </span>
          )}
        </div>
      </div>

      {/* ---- chart ---- */}
      <div
        ref={surfaceRef}
        className={`nds-chart${model.sparse ? " nds-chart--sparse" : ""}`}
        style={{ height: CHART_HEIGHT }}
        tabIndex={0}
        role="group"
        aria-label={c.chartLabel}
        aria-describedby={listId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (!press.current) setActive(model.points.length - 1);
        }}
        onBlur={() => setActive(null)}
      >
        <svg width={model.width} height={model.height} viewBox={`0 0 ${model.width} ${model.height}`} aria-hidden>
          <defs>
            <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" y1={model.plot.top} x2="0" y2={model.plot.bottom}>
              {stops.map((s, i) => (
                <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
              ))}
            </linearGradient>
          </defs>

          {model.yTicks.map((tick) => (
            <line key={tick.value} className="nds-grid" x1={model.plot.left} x2={model.plot.right} y1={tick.y} y2={tick.y} />
          ))}
          <line className="nds-baseline" x1={model.plot.left} x2={model.plot.right} y1={model.plot.bottom} y2={model.plot.bottom} />

          {/* Passes with no usable pixel: hollow markers on the axis row. */}
          {model.cloudy.map((marker) => (
            <circle key={marker.date} className="nds-cloud" cx={marker.x} cy={model.markerY} r={3.2}>
              <title>
                {fmt.long(marker.date)} · {c.cloud}
                {marker.cloudCoverPct === null ? "" : ` ${formatCloudPct(marker.cloudCoverPct)}`}
              </title>
            </circle>
          ))}

          {model.areaPath && <path className="nds-area" d={model.areaPath} fill={`url(#${gradientId})`} />}
          {model.linePath && model.points.length > 1 && <path className="nds-line" d={model.linePath} pathLength={1} />}

          {shownPoint && (
            <line
              className="nds-scrub"
              x1={0}
              x2={0}
              y1={model.plot.top - 4}
              y2={model.plot.bottom}
              style={{ transform: `translateX(${shownPoint.x}px)` }}
            />
          )}

          {model.points.map((p, i) => {
            const isLatest = i === model.points.length - 1;
            const progress = spanX === 0 ? 0 : (p.x - model.points[0].x) / spanX;
            const radius = model.sparse ? 6.5 : 4.5;
            return (
              <g key={p.date}>
                {isLatest && <circle className="nds-pulse" cx={p.x} cy={p.y} r={radius + 2} />}
                <g
                  className={`nds-dotg${shown === i ? " nds-dotg--active" : ""}`}
                  style={{ "--d": `${Math.round(240 + progress * 880)}ms` } as CSSProperties}
                >
                  <circle className="nds-halo" cx={p.x} cy={p.y} r={radius + 2.6} />
                  <circle className="nds-dot" cx={p.x} cy={p.y} r={radius} fill={ndviPaletteCss(p.value)} />
                </g>
              </g>
            );
          })}
        </svg>

        {/* y labels sit in the gutter on the start side of the axis. */}
        {model.yTicks.map((tick) => (
          <span
            key={tick.value}
            className="nds-tick nds-tick--y"
            dir="ltr"
            style={{ top: tick.y, ...(rtl ? { left: model.plot.right + 6 } : { right: model.width - model.plot.left + 6 }) }}
          >
            {tick.value.toFixed(2)}
          </span>
        ))}
        {model.cloudy.length > 0 && (
          <span
            className="nds-tick nds-tick--cloud"
            dir={rtl ? "rtl" : "ltr"}
            style={{ top: model.markerY, ...(rtl ? { left: model.plot.right + 6 } : { right: model.width - model.plot.left + 6 }) }}
          >
            {c.cloud}
          </span>
        )}

        {/* x labels: weekly, oldest on the right in RTL. */}
        {model.xTicks.map((tick) => (
          <span key={tick.date} className="nds-tick nds-tick--x" dir={rtl ? "rtl" : "ltr"} style={{ left: tickX(tick.x), top: CHART_HEIGHT + 6 }}>
            {fmt.short(tick.date)}
          </span>
        ))}

        {shownPoint && tip && (
          <div className="nds-tip" dir={rtl ? "rtl" : "ltr"} style={{ "--x": `${tip.left}px`, "--y": `${tip.top}px` } as CSSProperties} aria-hidden>
            <div className="nds-tip-value">
              <span className="nds-tip-swatch" style={{ background: ndviPaletteCss(shownPoint.value) }} />
              <span dir="ltr">{shownPoint.value.toFixed(2)}</span>
            </div>
            <div className="nds-tip-date">{fmt.long(shownPoint.date)}</div>
            {shownPoint.cloudCoverPct !== null && (
              <div className="nds-tip-cloud">
                {c.cloudPct} <span dir="ltr">{formatCloudPct(shownPoint.cloudCoverPct)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* The same data for screen readers; the live line announces the scrubbed reading. */}
      <ul id={listId} className="sr-only" aria-label={c.readings}>
        {model.points.map((p) => (
          <li key={p.date}>{reading(p)}</li>
        ))}
        {(series.cloudyDates ?? []).map((d) => (
          <li key={d.date}>{`${fmt.long(d.date)}: ${c.cloud}`}</li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">
        {shownPoint ? reading(shownPoint) : ""}
      </p>

      {/* ---- honest notes ---- */}
      {model.sparse && <p className="nds-note">{model.points.length === 1 ? c.sparse1 : c.sparse2}</p>}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5" style={{ marginTop: -6 }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="nds-legend">
            <i className="nds-legend-dot" aria-hidden />
            {c.realLegend}
          </span>
          {hasCloudInfo || (series.cloudyDates?.length ?? 0) > 0 ? (
            <span className="nds-legend">
              <i className="nds-legend-dot nds-legend-dot--cloud" aria-hidden />
              {c.cloudLegend}
            </span>
          ) : null}
        </div>
        <span className="nds-legend">
          {c.count}: <b dir="ltr">{series.points.length}</b>
        </span>
      </div>
      <p className="text-[10.5px] font-semibold leading-5 text-emerald-900/65" style={{ marginTop: -4 }}>
        {c.source}
      </p>
    </div>
  );
}
