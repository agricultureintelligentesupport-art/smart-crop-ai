"use client";

/**
 * The analysis screen's draggable bottom sheet: four tabs over the hero plot
 * map — نظرة عامة (key numbers + status), الخرائط (layer chips + legend),
 * الطقس (the NASA POWER day) and التفاصيل (sources, scene date, cloud,
 * resolution — one row per fact).
 *
 * LAYERS
 * ------
 * NDVI rides on the main observation; NDMI, NDRE and the true-colour image
 * are LAZY: their pixels are requested the first time the chip is selected
 * (over the NDVI scene's own date) and cached in memory per plot + scene.
 * The overview stats, the legend and the tap probe all follow the selected
 * layer; masked pixels (dataMask 0) stay transparent and nothing is ever
 * estimated. «الاحتياج المائي» and «الإجهاد الحراري» stay locked «قريباً».
 *
 * The weather tab stays live even when the satellite step fails, because the
 * weather upstream is independent of the satellite one and a failed pass is
 * no reason to hide real meteorology.
 *
 * Every number this panel prints comes from measured pixels (`dataMask` ∧
 * inside the drawn boundary). A masked pixel is never filled, averaged or
 * guessed.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { motion, useDragControls, useReducedMotion } from "framer-motion";
import { Cloud, CloudOff, Droplets, Image as ImageIcon, Loader2, Lock, RotateCcw, Ruler, Satellite, ScanLine, ThermometerSun, Wind } from "lucide-react";
import type { ClimateObservation, FieldDataReason, FieldLayerId, FieldObservation, NdviRaster } from "@/lib/field-data/types";
import type { FieldDataState } from "@/lib/field-data/useFieldData";
import { ndviBand } from "@/lib/agronomy";
import { DASHBOARD } from "@/lib/dashboard/copy";
import type { LazyLayerState } from "@/lib/plot/layer-fetch";
import {
  layerCssColor,
  layerLegendGradientCss,
  measuredPixelMask,
  ndviColorDomain,
  ndviCssColor,
  PLOT_LAYERS,
  rasterStats,
  type PlotLayerId,
} from "@/lib/plot/ndvi-layers";
import type { Ring } from "@/lib/geo/polygon";
import type { Lang } from "@/lib/wilayas";

const COPY = {
  ar: {
    title: "تحليل القطعة",
    layers: "طبقات التحليل",
    soon: "قريبًا",
    loading: "جارٍ التحليل…",
    loadingHint: "يُقرأ أحدث لقطة Sentinel-2 لقطعتك",
    layerLoading: "جارٍ تحميل الطبقة…",
    layerLoadingHint: "تُقرأ الطبقة من نفس لقطة الـ NDVI، بنفس الحدود والدقة",
    layerErrorTitle: "تعذّر تحميل الطبقة",
    errorTitle: "تعذّر تحليل القطعة",
    retry: "إعادة المحاولة",
    technical: "التفصيل التقني",
    legend: "مقياس اللون",
    scene: "لقطة Sentinel-2",
    cloud: "غيوم المشهد",
    caption: "دقة القياس {res} م، والعرض منعَّم",
    resolution: "دقة القياس",
    resolutionValue: "Sentinel-2 · {res} م · عرض مُنعَّم",
    activeLayer: "الطبقة المعروضة",
    pixelsRow: "البكسلات المُقاسة",
    imageNote: "طبقة صورة حقيقية من نفس اللقطة — لا تحمل قيماً رقمية.",
    mean: "متوسط القطعة",
    min: "الأدنى",
    max: "الأعلى",
    measured: "{n} بكسل مُقاس فعليًا · {source}",
    tapHint: "اضغط على أي نقطة داخل القطعة لعرض قراءة أقرب بكسل مُقاس.",
    trueColorHint: "الصورة الحقيقية طبقاً لألوان اللقطة — البكسلات المحجوبة تبقى شفافة.",
    staleBadge: "قراءة سابقة",
    staleNote: "تُعرض قراءة {date} المخزنة؛ بيانات اليوم غير متاحة.",
    legacyTitle: "قراءة بالتنسيق القديم",
    legacyNote:
      "خُزِّنت هذه القراءة قبل اعتماد الخريطة البكسلية، فمتوسطاتها لكل منطقة لا بكسلات. اضغط «إعادة المحاولة» لجلب الخريطة البكسلية.",
    noMeasured: "لا يوجد بكسل مُقاس في هذه القطعة اليوم — الغيوم تغطي المشهد.",
    weatherTitle: "طقس القطعة اليوم · NASA POWER",
    et0: "تبخر-نتح مرجعي",
    mm: "مم",
    tmax: "حرارة قصوى",
    tmin: "حرارة دنيا",
    rain: "أمطار",
    weatherNote: "قياس NASA POWER يغطي خلية ~0.5° — واحد للقطعة كلها.",
    reason: {
      noPlot: "لا توجد حدود محفوظة لهذه القطعة.",
      notConfigured: "بيانات الأقمار الصناعية غير مهيّأة في هذا التثبيت. أضف CDSE_CLIENT_ID و CDSE_CLIENT_SECRET إلى إعدادات الخادم.",
      auth: "رفض فضاء بيانات كوبرنيكوس بيانات الدخول. تحقّق من CDSE_CLIENT_ID و CDSE_CLIENT_SECRET.",
      network: "تعذّر الوصول إلى خدمة الأقمار الصناعية. لا نعرض أرقاماً لم تُقَس.",
      timeout: "استغرقت خدمة الأقمار الصناعية وقتاً طويلاً للإجابة. لا نعرض أرقاماً لم تُقَس.",
      http: "أعادت خدمة الأقمار الصناعية خطأ. لا نعرض أرقاماً لم تُقَس.",
      quota: "نفدت حصة المعالجة الشهرية في فضاء بيانات كوبرنيكوس. لا نعرض أرقاماً لم تُقَس.",
      noScenes: "لا توجد لقطة Sentinel-2 خالية من الغيوم فوق هذه القطعة خلال آخر ثلاثة أسابيع. لا نعرض أرقاماً لم تُقَس.",
      malformed: "أعادت خدمة الأقمار الصناعية رداً غير مفهوم. لا نعرض أرقاماً لم تُقَس.",
      "invalid-input": "تعذّر تحليل حدود هذه القطعة: فشل فحص محلي قبل إرسال أي طلب إلى الأقمار الصناعية.",
      tooSmall: "هذه القطعة أصغر من أن تعطي قراءة موثوقة. ارسم حدوداً لا تقل عن 0.05 هكتار.",
    } as Record<FieldDataReason, string>,
  },
  fr: {
    title: "Analyse de la parcelle",
    layers: "Couches d'analyse",
    soon: "bientôt",
    loading: "Analyse en cours…",
    loadingHint: "lecture du dernier passage Sentinel-2",
    layerLoading: "Chargement de la couche…",
    layerLoadingHint: "La couche est lue sur le même passage que le NDVI, mêmes limites, même résolution",
    layerErrorTitle: "Couche indisponible",
    errorTitle: "Analyse impossible",
    retry: "Réessayer",
    technical: "Détail technique",
    legend: "Échelle de couleur",
    scene: "Passage Sentinel-2",
    cloud: "Nuages du passage",
    caption: "Mesure à {res} m, affichage lissé",
    resolution: "Résolution",
    resolutionValue: "Sentinel-2 · {res} m · affichage lissé",
    activeLayer: "Couche affichée",
    pixelsRow: "Pixels mesurés",
    imageNote: "Image vraie du même passage — aucune valeur numérique.",
    mean: "Moyenne parcelle",
    min: "Minimum",
    max: "Maximum",
    measured: "{n} pixels réellement mesurés · {source}",
    tapHint: "Touchez un point de la parcelle pour lire le pixel mesuré le plus proche.",
    trueColorHint: "L'image vraie restitue les couleurs de la scène — les pixels masqués restent transparents.",
    staleBadge: "lecture antérieure",
    staleNote: "Lecture du {date} affichée ; les données d'aujourd'hui sont indisponibles.",
    legacyTitle: "Lecture à l'ancien format",
    legacyNote:
      "Cette lecture a été enregistrée avant la couche par pixel : elle ne porte que des moyennes par zone. Appuyez sur « Réessayer » pour obtenir la carte par pixel.",
    noMeasured: "Aucun pixel mesuré sur cette parcelle aujourd'hui — la scène est couverte de nuages.",
    weatherTitle: "Météo de la parcelle aujourd'hui · NASA POWER",
    et0: "ET₀ de référence",
    mm: "mm",
    tmax: "Température max",
    tmin: "Température min",
    rain: "Pluie",
    weatherNote: "Mesure NASA POWER sur une maille ~0,5° — une seule valeur pour toute la parcelle.",
    reason: {
      noPlot: "Aucun contour enregistré pour cette parcelle.",
      notConfigured: "Les données satellite ne sont pas configurées sur ce déploiement. Ajoutez CDSE_CLIENT_ID et CDSE_CLIENT_SECRET à l'environnement du serveur.",
      auth: "Le Copernicus Data Space a refusé les identifiants. Vérifiez CDSE_CLIENT_ID / CDSE_CLIENT_SECRET.",
      network: "Impossible de joindre le service satellite. Aucun chiffre non mesuré n'est affiché.",
      timeout: "Le service satellite a mis trop de temps à répondre. Aucun chiffre non mesuré n'est affiché.",
      http: "Le service satellite a renvoyé une erreur. Aucun chiffre non mesuré n'est affiché.",
      quota: "Le quota de traitement mensuel du Copernicus Data Space est épuisé. Aucun chiffre non mesuré n'est affiché.",
      noScenes: "Aucun passage Sentinel-2 sans nuage au-dessus de cette parcelle depuis trois semaines. Aucun chiffre non mesuré n'est affiché.",
      malformed: "Le service satellite a renvoyé une réponse illisible. Aucun chiffre non mesuré n'est affiché.",
      "invalid-input": "Le contour de cette parcelle n'a pas pu être analysé : un contrôle local a échoué avant tout envoi au satellite.",
      tooSmall: "Cette parcelle est trop petite pour une mesure fiable. Tracez au moins 0,05 ha.",
    } as Record<FieldDataReason, string>,
  },
};

/** Sheet chrome — Arabic only, the flow's language. */
const UI = {
  tabsLabel: "أقسام التحليل",
  tabs: ["نظرة عامة", "الخرائط", "الطقس", "التفاصيل"],
  sheetSize: "تغيير حجم اللوحة",
  noWeather: "لا تتوفر بيانات الطقس بعد.",
  noTech: "لا توجد تفاصيل تقنية بعد.",
};

/** Sheet snap heights as a share of the analysis stage (hero keeps the rest). */
const SNAP_HEIGHT = { peek: "27%", half: "45%", tall: "72%" } as const;
const SNAP_ORDER = { peek: 0, half: 1, tall: 2 } as const;

/** Index name printed next to a layer's values — unit-free, so the name is the unit. */
const INDEX_NAME: Record<"ndvi" | "ndmi" | "ndre", string> = { ndvi: "NDVI", ndmi: "NDMI", ndre: "NDRE" };

/** The NASA POWER day — icon tiles with semantic tones, big value, small unit. */
function WeatherStrip({ climate, lang }: { climate: ClimateObservation; lang: Lang }) {
  const t = COPY[lang];
  const rtl = lang === "ar";
  const fmt = (value: number | null, decimals = 1) =>
    value === null
      ? "—"
      : new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  const items = [
    { tone: "water", icon: <Droplets size={15} aria-hidden />, label: t.rain, value: fmt(climate.rainMm), unit: t.mm },
    { tone: "heat", icon: <ThermometerSun size={15} aria-hidden />, label: t.tmax, value: fmt(climate.tempMaxC), unit: "°C" },
    { tone: "cool", icon: <ThermometerSun size={15} aria-hidden />, label: t.tmin, value: fmt(climate.tempMinC), unit: "°C" },
    { tone: "caution", icon: <Wind size={15} aria-hidden />, label: t.et0, value: fmt(climate.et0), unit: t.mm },
  ];
  return (
    <div className="plot-analysis__weather">
      <span className="plot-analysis__weather-title">{t.weatherTitle}</span>
      <ul>
        {items.map((item) => (
          <li key={item.label} data-tone={item.tone}>
            <span className="plot-analysis__weather-tile-head">
              <span className="plot-analysis__weather-icon">{item.icon}</span>
              <span>{item.label}</span>
            </span>
            <strong dir="ltr">
            {item.value}
              <em>{item.unit}</em>
            </strong>
          </li>
        ))}
      </ul>
      <small>{t.weatherNote}</small>
    </div>
  );
}

/** Eased count-up for the hero value; static under reduced motion. */
function CountUp({ value, reduce, format }: { value: number; reduce: boolean; format: (value: number) => string }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (reduce) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      setDisplay(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduce]);
  return <>{format(reduce ? value : display)}</>;
}

export default function PlotAnalysisPanel({
  lang,
  state,
  reason,
  technical,
  stale,
  observation,
  climate,
  ring,
  onRetry,
  layerId,
  onLayerSelect,
  lazyLayers,
  onLayerRetry,
}: {
  lang: Lang;
  state: FieldDataState;
  reason: FieldDataReason | null;
  technical: string | null;
  stale: boolean;
  observation: FieldObservation | null;
  /** NASA POWER day of the failed request, when the satellite step failed. */
  climate: ClimateObservation | null;
  ring: Ring;
  onRetry: () => void;
  /** The layer chip currently selected by the farmer. */
  layerId: PlotLayerId;
  onLayerSelect: (id: PlotLayerId) => void;
  /** Fetch state of every lazy layer (NDMI / NDRE / true colour). */
  lazyLayers: Partial<Record<FieldLayerId, LazyLayerState>>;
  onLayerRetry: (id: FieldLayerId) => void;
}) {
  const t = COPY[lang];
  const rtl = lang === "ar";
  const bands = DASHBOARD[lang].satellite.bands;
  const layer = PLOT_LAYERS.find((l) => l.id === layerId) ?? PLOT_LAYERS[0];
  /** Active sheet tab: overview · maps · weather · details. */
  const [tab, setTab] = useState(0);
  /** Draggable sheet size; the grabber drags up/down to move between these. */
  const [snap, setSnap] = useState<keyof typeof SNAP_HEIGHT>("half");
  const controls = useDragControls();
  const reduce = useReducedMotion();
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const tabId = (index: number) => `${baseId}-tab-${index}`;

  const raster = observation?.raster ?? null;
  /* The one mask that drives display, stats and the probe: the provider
     measured the pixel AND it lies inside the farmer's real boundary. */
  const mask = useMemo(() => (raster ? measuredPixelMask(ring, raster) : null), [ring, raster]);
  const domain = useMemo(() => (raster ? ndviColorDomain(raster) : null), [raster]);
  const stats = useMemo(() => (raster && mask ? rasterStats(raster, mask) : null), [raster, mask]);

  /* ---- the SELECTED layer's own pixels (overview, legend, probe follow) ---- */
  const lazyState = layer.fetchId ? lazyLayers[layer.fetchId] : undefined;
  const isIndexLayer = layer.id === "ndvi" || layer.id === "ndmi" || layer.id === "ndre";
  /** The raster behind the selected layer: NDVI's own or a settled lazy one. */
  const activeRaster: NdviRaster | null =
    layer.id === "ndvi" ? raster : isIndexLayer && lazyState?.status === "ready" ? lazyState.raster : null;
  const activeMask = useMemo(() => (activeRaster ? measuredPixelMask(ring, activeRaster) : null), [ring, activeRaster]);
  const activeDomain = useMemo(() => (activeRaster ? ndviColorDomain(activeRaster) : null), [activeRaster]);
  const activeStats = useMemo(
    () => (activeRaster && activeMask ? rasterStats(activeRaster, activeMask) : null),
    [activeRaster, activeMask],
  );
  /** True-colour layer: an image — measured pixels counted, never valued. */
  const trueColorState = lazyLayers.truecolor;
  const trueColorCount = useMemo(() => {
    const tc = trueColorState?.status === "ready" ? trueColorState.raster : null;
    if (!tc) return null;
    const tcMask = measuredPixelMask(ring, tc);
    let count = 0;
    for (let i = 0; i < tcMask.length; i += 1) count += tcMask[i];
    return count;
  }, [ring, trueColorState]);

  /* Legacy records (cached before the raster path) still carry honest per-cell
     means; they keep their stats so the panel never goes blank on deploy day. */
  const cellValues = useMemo(
    () => (observation && !raster ? observation.cells.map((c) => c.ndvi).filter((v): v is number => v !== null) : []),
    [observation, raster],
  );

  /* Distribution of the REAL measured pixels of the SELECTED index layer over
     its own domain — 24 bins, painted with that layer's own ramp. */
  const distribution = useMemo(() => {
    if (!activeRaster || !activeMask || !activeDomain || activeStats?.count === 0) return [];
    const BINS = 24;
    const [min, max] = activeDomain;
    const counts = new Array<number>(BINS).fill(0);
    for (let i = 0; i < activeRaster.ndvi.length; i += 1) {
      const value = activeRaster.ndvi[i];
      if (!activeMask[i] || value === null) continue;
      const ratio = max > min ? (value - min) / (max - min) : 0.5;
      counts[Math.min(BINS - 1, Math.max(0, Math.floor(ratio * BINS)))] += 1;
    }
    const peak = Math.max(...counts, 1);
    return counts.map((count, index) => {
      const value = min + ((index + 0.5) / BINS) * (max - min);
      return {
        share: count / peak,
        color: layer.id === "ndvi" ? ndviCssColor(value, activeDomain) : layerCssColor(layer.id, value, activeDomain),
        count,
      };
    });
  }, [activeRaster, activeMask, activeDomain, activeStats, layer.id]);

  const fmt = (value: number | null | undefined, decimals = 2) =>
    value === null || value === undefined
      ? "—"
      : new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(value);

  /* A lazy layer is selectable only when the NDVI scene can anchor it — the
     layer must be read from that very scene, so no scene date, no layer. */
  const canUseLazy = Boolean(raster && observation?.sceneDate);
  const selectable = (entry: (typeof PLOT_LAYERS)[number]) =>
    entry.mode === "primary" ? Boolean(raster) : entry.mode === "lazy" ? canUseLazy : false;

  /** Per-layer failure card — the same reason copy, the layer's own retry. */
  const layerErrorCard = (fetchId: FieldLayerId, failed: FieldDataReason | null, failedTechnical: string | null) => (
    <div className="plot-analysis__error" role="alert">
      <p>
        <CloudOff size={17} aria-hidden />
        <span>
          <strong>{t.layerErrorTitle}</strong>
          {failed ? t.reason[failed] : ""}
        </span>
      </p>
      {failedTechnical && (
        <code dir="ltr" className="plot-analysis__technical">
          {failedTechnical}
        </code>
      )}
      <button type="button" className="plot-analysis__retry" onClick={() => onLayerRetry(fetchId)}>
        <RotateCcw size={15} aria-hidden />
        {t.retry}
      </button>
    </div>
  );

  /* A tab with little to say keeps the sheet at its peek snap, so the hero
     plot — not an empty half-screen — owns the stage. */
  const substantial =
    tab === 0
      ? state === "ready" && Boolean(observation) && (raster ? Boolean(stats && stats.count > 0) : cellValues.length > 0)
      : tab === 1
        ? Boolean(raster && domain && stats)
        : tab === 2
          ? Boolean(climate)
          : Boolean(observation && raster && domain && stats);
  /* The sheet never grows past what its tab actually has to say: a thin tab
     stays at peek, a filled one reaches half, and only the data-long tabs
     (layers + legend, the timeline) reach tall. No empty half-screens. */
  const maxSnap: keyof typeof SNAP_HEIGHT =
    tab === 0
      ? substantial
        ? "half"
        : "peek"
      : tab === 1
        ? Boolean(raster && domain && stats)
          ? "tall"
          : "peek"
        : tab === 2
          ? Boolean(climate)
            ? "half"
            : "peek"
          : Boolean(observation && raster && domain && stats)
            ? "tall"
            : "peek";
  const snapShown = SNAP_ORDER[snap] <= SNAP_ORDER[maxSnap] ? snap : maxSnap;
  const grow = () => setSnap(snapShown === "peek" ? (SNAP_ORDER[maxSnap] >= 1 ? "half" : "peek") : SNAP_ORDER[maxSnap] >= 2 ? "tall" : snapShown);
  const shrink = () => setSnap(snapShown === "tall" ? "half" : "peek");

  /* Measured-pixel count of whatever layer is on screen (details row). */
  const shownCount =
    layer.id === "truecolor"
      ? trueColorCount ?? 0
      : isIndexLayer && activeStats
        ? activeStats.count
        : stats?.count ?? 0;

  return (
    <motion.section
      className="plot-analysis"
      data-snap={snapShown}
      data-testid="plot-analysis"
      aria-label={t.title}
      drag="y"
      dragListener={false}
      dragControls={controls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.04, bottom: 0.04 }}
      animate={{ height: SNAP_HEIGHT[snapShown] }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 40, mass: 0.9 }}
      onDragEnd={(_, info) => {
        if (info.offset.y < -40 || info.velocity.y < -450) grow();
        else if (info.offset.y > 40 || info.velocity.y > 450) shrink();
      }}
    >
      {/* Grabber: drag up/down (pointer) or press (keyboard) to resize. */}
      <div className="plot-analysis__grab-row" onPointerDown={(event) => controls.start(event)}>
        <button
          type="button"
          className="plot-analysis__grabber"
          aria-label={UI.sheetSize}
          onClick={() => setSnap(snapShown === "peek" ? "half" : snapShown === "half" ? "tall" : "peek")}
        >
          <span aria-hidden />
        </button>
      </div>

      <div className="plot-analysis__tabs" role="tablist" aria-label={UI.tabsLabel}>
        {UI.tabs.map((label, index) => {
          const active = tab === index;
          return (
            <button
              key={label}
              type="button"
              role="tab"
              id={tabId(index)}
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              className={`plot-analysis__tab${active ? " is-active" : ""}`}
              onClick={() => { setTab(index); setSnap("half"); }}
            >
              {active &&
                (reduce ? (
                  <span className="plot-analysis__tab-glow" aria-hidden />
                ) : (
                  <motion.span
                    layoutId="plot-analysis-tab-glow"
                    className="plot-analysis__tab-glow"
                    aria-hidden
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                ))}
              {label}
            </button>
          );
        })}
      </div>

      <div
        className="plot-analysis__body"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(tab)}
        tabIndex={0}
      >
        {/* ---------- نظرة عامة: hero number + verbal status + distribution ---------- */}
        {tab === 0 && (
          <div className="plot-analysis__stack">
            {stale && observation && <span className="plot-analysis__stale plot-rise" style={{ "--i": 0 } as React.CSSProperties}>{t.staleBadge}</span>}

            {state === "loading" && (
              <p className="plot-analysis__status" role="status">
                <Loader2 size={14} className="plot-view__spinner" aria-hidden />
                <span>
                  {t.loading}
                  <small>{t.loadingHint}</small>
                </span>
              </p>
            )}

            {state === "error" && (
              /* One clear failure card: the existing technical reason + retry. */
              <div className="plot-analysis__error" role="alert">
                <p>
                  <CloudOff size={17} aria-hidden />
                  <span>
                    <strong>{t.errorTitle}</strong>
                    {reason ? t.reason[reason] : ""}
                  </span>
                </p>
                {technical && (
                  <code dir="ltr" className="plot-analysis__technical">
                    {technical}
                  </code>
                )}
                <button type="button" className="plot-analysis__retry" onClick={onRetry}>
                  <RotateCcw size={15} aria-hidden />
                  {t.retry}
                </button>
              </div>
            )}

            {state === "ready" && observation && (
              <>
                {stale && <p className="plot-analysis__stale-note">{t.staleNote.replace("{date}", observation.sceneDate ?? observation.date)}</p>}

                {raster && domain && stats ? (
                  <>
                    {/* ---------- NDVI — the existing overview, unchanged ---------- */}
                    {layer.id === "ndvi" &&
                      (stats.count > 0 ? (
                        <>
                          <div className="plot-analysis__hero plot-rise" style={{ "--i": 0 } as React.CSSProperties}>
                            <div className="plot-analysis__hero-num-wrap">
                              <span className="plot-analysis__hero-label">{t.mean}</span>
                              <strong dir="ltr" className="plot-analysis__hero-num">
                                <CountUp value={stats.mean ?? 0} reduce={Boolean(reduce)} format={(value) => fmt(value)} />
                              </strong>
                              <span className="plot-analysis__hero-unit">NDVI</span>
                            </div>
                            {/* Verbal status — the app's existing NDVI thresholds. */}
                            <span className="plot-analysis__status-chip" data-tone={ndviBand(stats.mean ?? 0)}>
                              {bands[ndviBand(stats.mean ?? 0)]}
                            </span>
                          </div>
                          {distribution.length > 0 && (
                            <div className="plot-analysis__dist plot-rise" style={{ "--i": 1 } as React.CSSProperties} aria-hidden>
                              {distribution.map((bin, index) => (
                                <span
                                  key={index}
                                  style={{
                                    height: `${Math.round(8 + bin.share * 92)}%`,
                                    background: bin.count > 0 ? bin.color : "rgba(255,255,255,0.06)",
                                  }}
                                />
                              ))}
                            </div>
                          )}
                          <dl className="plot-analysis__stats plot-rise" style={{ "--i": 2 } as React.CSSProperties} data-testid="plot-analysis-stats">
                            <div>
                              <dt>{t.mean}</dt>
                              <dd dir="ltr">{fmt(stats.mean)}</dd>
                            </div>
                            <div>
                              <dt>{t.min}</dt>
                              <dd dir="ltr">{fmt(stats.min)}</dd>
                            </div>
                            <div>
                              <dt>{t.max}</dt>
                              <dd dir="ltr">{fmt(stats.max)}</dd>
                            </div>
                          </dl>
                        </>
                      ) : (
                        <p className="plot-analysis__status">{t.noMeasured}</p>
                      ))}

                    {/* ---------- NDMI / NDRE — the selected index, on its own ramp ---------- */}
                    {(layer.id === "ndmi" || layer.id === "ndre") &&
                      (lazyState?.status === "ready" && activeStats && activeDomain ? (
                        activeStats.count > 0 ? (
                          <>
                            <div className="plot-analysis__hero plot-rise" style={{ "--i": 0 } as React.CSSProperties}>
                              <div className="plot-analysis__hero-num-wrap">
                                <span className="plot-analysis__hero-label">{t.mean}</span>
                                <strong dir="ltr" className="plot-analysis__hero-num">
                                  <CountUp value={activeStats.mean ?? 0} reduce={Boolean(reduce)} format={(value) => fmt(value)} />
                                </strong>
                                <span className="plot-analysis__hero-unit">{INDEX_NAME[layer.id]}</span>
                              </div>
                              {/* No invented thresholds: the layer's own one-line meaning. */}
                              <span className="plot-analysis__status-chip plot-analysis__status-chip--meaning" data-tone="info">
                                {rtl ? layer.meaningAr : layer.meaningFr}
                              </span>
                            </div>
                            {distribution.length > 0 && (
                              <div className="plot-analysis__dist plot-rise" style={{ "--i": 1 } as React.CSSProperties} aria-hidden>
                                {distribution.map((bin, index) => (
                                  <span
                                    key={index}
                                    style={{
                                      height: `${Math.round(8 + bin.share * 92)}%`,
                                      background: bin.count > 0 ? bin.color : "rgba(255,255,255,0.06)",
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                            <dl className="plot-analysis__stats plot-rise" style={{ "--i": 2 } as React.CSSProperties} data-testid="plot-analysis-stats">
                              <div>
                                <dt>{t.mean}</dt>
                                <dd dir="ltr">{fmt(activeStats.mean)}</dd>
                              </div>
                              <div>
                                <dt>{t.min}</dt>
                                <dd dir="ltr">{fmt(activeStats.min)}</dd>
                              </div>
                              <div>
                                <dt>{t.max}</dt>
                                <dd dir="ltr">{fmt(activeStats.max)}</dd>
                              </div>
                            </dl>
                          </>
                        ) : (
                          <p className="plot-analysis__status">{t.noMeasured}</p>
                        )
                      ) : lazyState?.status === "error" && lazyState.fetchId ? (
                        layerErrorCard(lazyState.fetchId, lazyState.reason, lazyState.technical)
                      ) : (
                        <p className="plot-analysis__status" role="status">
                          <Loader2 size={14} className="plot-view__spinner" aria-hidden />
                          <span>
                            {t.layerLoading}
                            <small>{t.layerLoadingHint}</small>
                          </span>
                        </p>
                      ))}

                    {/* ---------- الصورة الحقيقية — an image layer carries no numbers ---------- */}
                    {layer.id === "truecolor" &&
                      (trueColorState?.status === "ready" ? (
                        <div className="plot-analysis__hero plot-analysis__hero--image plot-rise" style={{ "--i": 0 } as React.CSSProperties}>
                          <span className="plot-analysis__hero-image-icon" aria-hidden>
                            <ImageIcon size={20} />
                          </span>
                          <span className="plot-analysis__hero-text">
                            <strong>{rtl ? layer.labelAr : layer.labelFr}</strong>
                            <small>{t.imageNote}</small>
                            {trueColorCount !== null && (
                              <small dir="ltr">{new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR").format(trueColorCount)} px</small>
                            )}
                          </span>
                        </div>
                      ) : trueColorState?.status === "error" && trueColorState.fetchId ? (
                        layerErrorCard(trueColorState.fetchId, trueColorState.reason, trueColorState.technical)
                      ) : (
                        <p className="plot-analysis__status" role="status">
                          <Loader2 size={14} className="plot-view__spinner" aria-hidden />
                          <span>
                            {t.layerLoading}
                            <small>{t.layerLoadingHint}</small>
                          </span>
                        </p>
                      ))}
                  </>
                ) : (
                  <div className="plot-analysis__error plot-analysis__error--soft" role="note">
                    <p>
                      <span>
                        <strong>{t.legacyTitle}</strong>
                        {t.legacyNote}
                      </span>
                    </p>
                    {cellValues.length > 0 && (
                      <dl className="plot-analysis__stats">
                        <div>
                          <dt>{t.mean}</dt>
                          <dd dir="ltr">{fmt(cellValues.reduce((s, v) => s + v, 0) / cellValues.length)}</dd>
                        </div>
                        <div>
                          <dt>{t.min}</dt>
                          <dd dir="ltr">{fmt(Math.min(...cellValues))}</dd>
                        </div>
                        <div>
                          <dt>{t.max}</dt>
                          <dd dir="ltr">{fmt(Math.max(...cellValues))}</dd>
                        </div>
                      </dl>
                    )}
                    <button type="button" className="plot-analysis__retry" onClick={onRetry}>
                      <RotateCcw size={15} aria-hidden />
                      {t.retry}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ---------- الخرائط: layer cards + per-layer legend ---------- */}
        {tab === 1 && (
          <div className="plot-analysis__stack">
            {/* Layer cards — driven entirely by PLOT_LAYERS so adding a layer
                is a config entry plus its data path. */}
            <div className="plot-analysis__layers" role="group" aria-label={t.layers}>
              {PLOT_LAYERS.map((entry) => {
                const isSelectable = selectable(entry);
                const active = entry.id === layer.id;
                const entryLazy = entry.fetchId ? lazyLayers[entry.fetchId] : undefined;
                const entryLoading = entryLazy?.status === "loading";
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={!isSelectable}
                    aria-pressed={active}
                    aria-busy={entryLoading || undefined}
                    data-testid={`plot-layer-chip-${entry.id}`}
                    className={`plot-analysis__layer${active ? " is-active" : ""}`}
                    onClick={() => isSelectable && onLayerSelect(entry.id)}
                  >
                    <span aria-hidden className={`plot-analysis__layer-thumb plot-analysis__layer-thumb--${entry.id}`} />
                    <span className="plot-analysis__layer-text">
                      <span>{rtl ? entry.labelAr : entry.labelFr}</span>
                      <small>{isSelectable ? rtl ? entry.meaningAr ?? entry.unit : entry.meaningFr ?? entry.unit : t.soon}</small>
                    </span>
                    {!isSelectable && (
                      <span className="plot-analysis__layer-lock">
                        <Lock size={11} aria-hidden />
                        {t.soon}
                      </span>
                    )}
                    {isSelectable && entryLoading && <Loader2 size={16} className="plot-view__spinner plot-analysis__layer-spin" aria-hidden />}
                  </button>
                );
              })}
            </div>

            {/* The legend + caption follow the SELECTED layer. */}
            {isIndexLayer && activeRaster && activeDomain && activeStats ? (
              <>
                <div className="plot-analysis__legend plot-rise" style={{ "--i": 1 } as React.CSSProperties} dir="ltr">
                  <span className="plot-analysis__legend-title" dir={rtl ? "rtl" : "ltr"}>
                    {t.legend} · {layer.unit}
                  </span>
                  <div
                    className="plot-analysis__legend-bar"
                    style={layer.id === "ndvi" ? undefined : { background: layerLegendGradientCss(layer.id) }}
                  />
                  <div className="plot-analysis__legend-labels">
                    <span>{fmt(activeDomain[0])}</span>
                    <span>{fmt(activeDomain[1])}</span>
                  </div>
                </div>
                {(rtl ? layer.captionAr : layer.captionFr) && (
                  <p className="plot-analysis__caption">{rtl ? layer.captionAr : layer.captionFr}</p>
                )}
                <p className="plot-analysis__hint">{t.tapHint}</p>
              </>
            ) : layer.id === "truecolor" && trueColorState?.status === "ready" ? (
              <>
                <p className="plot-analysis__caption">{rtl ? layer.meaningAr : layer.meaningFr}</p>
                <p className="plot-analysis__hint">{t.trueColorHint}</p>
              </>
            ) : layer.fetchId && lazyState?.status === "error" ? (
              layerErrorCard(layer.fetchId, lazyState.reason, lazyState.technical)
            ) : layer.fetchId ? (
              /* Shimmer while the selected lazy layer is on its way. */
              <div className="plot-analysis__legend plot-analysis__legend--loading plot-rise" style={{ "--i": 1 } as React.CSSProperties} role="status" aria-label={t.layerLoading}>
                <span className="plot-analysis__legend-title">
                  {t.layerLoading}
                </span>
                <div className="plot-analysis__legend-bar plot-analysis__legend-bar--skeleton" aria-hidden />
                <p className="plot-analysis__hint">{t.layerLoadingHint}</p>
              </div>
            ) : (
              <p className="plot-analysis__hint">{t.loadingHint}</p>
            )}
          </div>
        )}

        {/* ---------- الطقس: NASA POWER tiles (satellite-independent) ---------- */}
        {tab === 2 && (
          <div className="plot-analysis__stack">
            {climate ? <WeatherStrip climate={climate} lang={lang} /> : <p className="plot-analysis__empty">{UI.noWeather}</p>}
          </div>
        )}

        {/* ---------- التفاصيل: each fact on ONE row — label right, value left ---------- */}
        {tab === 3 && (
          <div className="plot-analysis__stack">
            {observation && raster && domain && stats ? (
              <>
                <dl className="plot-analysis__details plot-rise" style={{ "--i": 0 } as React.CSSProperties} data-testid="plot-analysis-details">
                  {observation.sceneDate && (
                    <div>
                      <dt><Satellite size={12} aria-hidden />{t.scene}</dt>
                      <dd dir="ltr">{observation.sceneDate}</dd>
                    </div>
                  )}
                  {observation.cloudCoverPct != null && (
                    <div>
                      <dt><Cloud size={12} aria-hidden />{t.cloud}</dt>
                      <dd dir="ltr">{fmt(observation.cloudCoverPct, 1)}%</dd>
                    </div>
                  )}
                  <div>
                    <dt><Ruler size={12} aria-hidden />{t.resolution}</dt>
                    <dd dir="ltr">{t.resolutionValue.replace("{res}", String(raster.resolutionM))}</dd>
                  </div>
                  <div>
                    <dt><ScanLine size={12} aria-hidden />{t.activeLayer}</dt>
                    <dd>{rtl ? layer.labelAr : layer.labelFr} · {layer.source}</dd>
                  </div>
                  <div>
                    <dt><ScanLine size={12} aria-hidden />{t.pixelsRow}</dt>
                    <dd dir="ltr">{new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR").format(shownCount)}</dd>
                  </div>
                </dl>
                <p className="plot-analysis__note">
                  {t.measured
                    .replace("{n}", new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR").format(shownCount))
                    .replace("{source}", layer.source)}
                </p>
              </>
            ) : (
              <p className="plot-analysis__empty">{UI.noTech}</p>
            )}
            {/* The scan-line mark keeps the analysis identity on this tab too. */}
            <p className="plot-analysis__hint">
              <ScanLine size={12} aria-hidden /> {t.title}
            </p>
          </div>
        )}
      </div>
    </motion.section>
  );
}
