"use client";

/**
 * The analysis output, re-arranged for reading.
 *
 * Everything here already existed and every number still comes from
 * `FieldObservation.raster` pixels with a real measurement (`dataMask` ∧ inside
 * the drawn boundary); a masked pixel is never filled, averaged or guessed.
 * What changed is the reading order, not the reading:
 *
 *   نظرة عامة   the parcel's key numbers and where the reading comes from
 *   الخرائط    the layer switcher, the legend and the tap hint
 *   الطقس      the NASA POWER day, in small cards
 *   التفاصيل   sources, acquisition date, cloud cover, resolution
 *
 * The panel is a draggable bottom sheet under the hero map: a peek height for
 * the numbers, one drag (or one tap on the grabber) away from the full read.
 * A failed satellite pass shows ONE card — the localised reason, the technical
 * detail that produced it and the retry — while the weather tab keeps working,
 * because NASA POWER is an independent upstream.
 */

import { useMemo, useState } from "react";
import { motion, useDragControls } from "framer-motion";
import {
  ChevronDown,
  Cloud,
  CloudOff,
  Droplets,
  Layers,
  Ruler,
  Satellite,
  ScanLine,
  ThermometerSun,
  Wind,
  type LucideIcon,
} from "lucide-react";
import type { ClimateObservation, FieldDataReason, FieldObservation } from "@/lib/field-data/types";
import type { FieldDataState } from "@/lib/field-data/useFieldData";
import {
  measuredPixelMask,
  ndviColorDomain,
  ndviLegendGradientCss,
  PLOT_LAYERS,
  rasterStats,
} from "@/lib/plot/ndvi-layers";
import type { Ring } from "@/lib/geo/polygon";
import type { Lang } from "@/lib/wilayas";
import { formatNumber } from "./format";

type TabId = "overview" | "maps" | "weather" | "details";

const TABS: { id: TabId; icon: LucideIcon }[] = [
  { id: "overview", icon: ScanLine },
  { id: "maps", icon: Layers },
  { id: "weather", icon: ThermometerSun },
  { id: "details", icon: Ruler },
];

const COPY = {
  ar: {
    title: "تحليل القطعة",
    layers: "طبقات التحليل",
    soon: "قريبًا",
    loading: "جارٍ التحليل…",
    loadingHint: "يُقرأ أحدث لقطة Sentinel-2 لقطعتك",
    skeletonMean: "متوسط القطعة",
    skeletonMin: "الأدنى",
    skeletonMax: "الأعلى",
    errorTitle: "تعذّر تحليل القطعة",
    retry: "إعادة المحاولة",
    technical: "التفصيل التقني",
    legend: "مقياس اللون",
    scene: "لقطة Sentinel-2",
    cloud: "غيوم المشهد",
    caption: "دقة القياس {res} م، والعرض منعَّم",
    mean: "متوسط القطعة",
    min: "الأدنى",
    max: "الأعلى",
    measured: "{n} بكسل مُقاس فعليًا · {source}",
    tapHint: "اضغط على أي نقطة داخل القطعة لعرض قراءة أقرب بكسل مُقاس.",
    staleBadge: "قراءة سابقة",
    staleNote: "تُعرض قراءة {date} المخزنة؛ بيانات اليوم غير متاحة.",
    legacyTitle: "قراءة بالتنسيق القديم",
    legacyNote:
      "خُزِّنت هذه القراءة قبل اعتماد الخريطة البكسلية، فمتوسطاتها لكل منطقة لا بكسلات. اضغط «إعادة المحاولة» لجلب الخريطة البكسلية.",
    noMeasured: "لا يوجد بكسل مُقاس في هذه القطعة اليوم — الغيوم تغطي المشهد.",
    noReading: "لا توجد أرقام معروضة لهذه القطعة — سبب التعذّر أعلاه.",
    noRaster: "لا توجد خريطة بكسلية لعرضها على هذه القطعة.",
    weatherTitle: "طقس القطعة اليوم · NASA POWER",
    weatherNone: "لم تصل بيانات الطقس لهذه القطعة اليوم.",
    et0: "تبخر-نتح مرجعي",
    mm: "مم",
    tmax: "حرارة قصوى",
    tmin: "حرارة دنيا",
    rain: "أمطار",
    weatherNote: "قياس NASA POWER يغطي خلية ~0.5° — واحد للقطعة كلها.",
    source: "مصدر القياس",
    readingDate: "تاريخ القراءة",
    resolution: "الدقة",
    expand: "توسيع النتائج",
    collapse: "طيّ النتائج",
    tab: { overview: "نظرة عامة", maps: "الخرائط", weather: "الطقس", details: "التفاصيل" },
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
    skeletonMean: "Moyenne parcelle",
    skeletonMin: "Minimum",
    skeletonMax: "Maximum",
    errorTitle: "Analyse impossible",
    retry: "Réessayer",
    technical: "Détail technique",
    legend: "Échelle de couleur",
    scene: "Passage Sentinel-2",
    cloud: "Nuages du passage",
    caption: "Mesure à {res} m, affichage lissé",
    mean: "Moyenne parcelle",
    min: "Minimum",
    max: "Maximum",
    measured: "{n} pixels réellement mesurés · {source}",
    tapHint: "Touchez un point de la parcelle pour lire le pixel mesuré le plus proche.",
    staleBadge: "lecture antérieure",
    staleNote: "Lecture du {date} affichée ; les données d'aujourd'hui sont indisponibles.",
    legacyTitle: "Lecture à l'ancien format",
    legacyNote:
      "Cette lecture a été enregistrée avant la couche par pixel : elle ne porte que des moyennes par zone. Appuyez sur « Réessayer » pour obtenir la carte par pixel.",
    noMeasured: "Aucun pixel mesuré sur cette parcelle aujourd'hui — la scène est couverte de nuages.",
    noReading: "Aucun chiffre affiché pour cette parcelle — la raison est ci-dessus.",
    noRaster: "Aucune carte par pixel à afficher pour cette parcelle.",
    weatherTitle: "Météo de la parcelle aujourd'hui · NASA POWER",
    weatherNone: "Les données météo de cette parcelle ne sont pas arrivées aujourd'hui.",
    et0: "ET₀ de référence",
    mm: "mm",
    tmax: "Température max",
    tmin: "Température min",
    rain: "Pluie",
    weatherNote: "Mesure NASA POWER sur une maille ~0,5° — une seule valeur pour toute la parcelle.",
    source: "Source de la mesure",
    readingDate: "Date de la lecture",
    resolution: "Résolution",
    expand: "Agrandir les résultats",
    collapse: "Réduire les résultats",
    tab: { overview: "Vue d'ensemble", maps: "Cartes", weather: "Météo", details: "Détails" },
    reason: {
      noPlot: "Aucun contour enregistré pour cette parcelle.",
      notConfigured: "Les données satellite ne sont pas configurées sur ce déploiement. Ajoutez CDSE_CLIENT_ID et CDSE_CLIENT_SECRET à l'environnement du serveur.",
      auth: "Le Copernicus Data Space a refusé les identifiants. Vérifiez CDSE_CLIENT_ID / CDSE_CLIENT_SECRET.",
      network: "Impossible de joindre le service satellite. Aucun chiffre non mesuré n'est affiché.",
      timeout: "Le service satellite a mis trop de temps à répondre. Aucun chiffre non mesuré n'est affiché.",
      http: "Le service satellite a renvoyé une erreur. Aucun chiffre non mesuré n'est affiché.",
      quota: "Le quota de traitement mensuel du Copernicus Data Space est épuisé. Aucun chiffre non mesuré n'est affiché.",
      noScenes: "Aucun passage Sentinel-2 sans nuages au-dessus de cette parcelle depuis trois semaines. Aucun chiffre non mesuré n'est affiché.",
      malformed: "Le service satellite a renvoyé une réponse illisible. Aucun chiffre non mesuré n'est affiché.",
      "invalid-input": "Le contour de cette parcelle n'a pas pu être analysé : un contrôle local a échoué avant tout envoi au satellite.",
      tooSmall: "Cette parcelle est trop petite pour une mesure fiable. Tracez au moins 0,05 ha.",
    } as Record<FieldDataReason, string>,
  },
};

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
}) {
  const t = COPY[lang];
  const rtl = lang === "ar";
  const [tab, setTab] = useState<TabId>("overview");
  const [layerId, setLayerId] = useState<string>("ndvi");
  const [expanded, setExpanded] = useState(false);
  const controls = useDragControls();
  const layer = PLOT_LAYERS.find((l) => l.id === layerId) ?? PLOT_LAYERS[0];

  const raster = observation?.raster ?? null;
  /* The one mask that drives display, stats and the probe: the provider
     measured the pixel AND it lies inside the farmer's real boundary. */
  const mask = useMemo(() => (raster ? measuredPixelMask(ring, raster) : null), [ring, raster]);
  const domain = useMemo(() => (raster ? ndviColorDomain(raster) : null), [raster]);
  const stats = useMemo(() => (raster && mask ? rasterStats(raster, mask) : null), [raster, mask]);
  /* Legacy records (cached before the raster path) still carry honest per-cell
     means; they keep their stats so the panel never goes blank on deploy day. */
  const cellValues = useMemo(
    () => (observation && !raster ? observation.cells.map((c) => c.ndvi).filter((v): v is number => v !== null) : []),
    [observation, raster],
  );
  const fmt = (value: number | null | undefined, decimals = 2) => formatNumber(lang, value, decimals);

  const loading = state === "loading";
  const failed = state === "error";
  const ready = state === "ready" && observation !== null;
  const hasRaster = Boolean(raster && domain && stats);
  const legacy = ready && !raster;

  /* A failed pass gets a taller peek: the reason, the technical detail and the
     retry must all be on screen without a drag. */
  const sheetHeight = failed ? "52dvh" : expanded ? "68dvh" : "42dvh";

  return (
    <motion.section
      className="analysis-sheet"
      style={{ ["--sheet-height" as string]: sheetHeight }}
      data-testid="plot-analysis"
      data-expanded={expanded}
      aria-label={t.title}
      drag="y"
      dragListener={false}
      dragControls={controls}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.02, bottom: 0.4 }}
      onDragEnd={(_, info) => {
        if (info.offset.y < -48 || info.velocity.y < -420) setExpanded(true);
        else if (info.offset.y > 48 || info.velocity.y > 420) setExpanded(false);
      }}
    >
      {/* Grabber: the only drag surface, so the body keeps native scrolling. */}
      <div className="analysis-sheet__grip" data-sheet-handle onPointerDown={(event) => controls.start(event)}>
        <span aria-hidden className="analysis-sheet__grabber" />
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? t.collapse : t.expand}
          className="analysis-sheet__grip-button"
        >
          <ScanLine size={14} strokeWidth={2.6} aria-hidden />
          <span>{t.title}</span>
          <ChevronDown size={14} strokeWidth={2.8} aria-hidden className={expanded ? "rotate-180" : ""} />
        </button>
        {stale && observation && <span className="analysis-sheet__stale">{t.staleBadge}</span>}
      </div>

      {/* ONE failure card, above the tabs: the reason, the technical detail and
          the retry stay reachable from every tab — and the weather tab below
          still works, because NASA POWER is an independent upstream. */}
      {failed && (
        <div className="analysis-error" role="alert">
          <p>
            <CloudOff size={16} aria-hidden />
            <span>
              <strong>{t.errorTitle}</strong>
              {reason ? t.reason[reason] : ""}
            </span>
          </p>
          {technical && (
            <code dir="ltr" className="analysis-error__technical">
              {technical}
            </code>
          )}
          <button type="button" className="analysis-error__retry" onClick={onRetry}>
            {t.retry}
          </button>
        </div>
      )}

      <div role="tablist" aria-label={t.title} className="analysis-sheet__tabs">
        {TABS.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`analysis-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`analysis-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            data-testid={`analysis-tab-${id}`}
            className={`analysis-sheet__tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            <Icon size={14} strokeWidth={2.6} aria-hidden />
            <span>{t.tab[id]}</span>
          </button>
        ))}
      </div>

      <div
        className="analysis-sheet__body scroll-area"
        role="tabpanel"
        id={`analysis-panel-${tab}`}
        aria-labelledby={`analysis-tab-${tab}`}
        tabIndex={0}
      >
        {/* ---------------- 1 · نظرة عامة — the key numbers ---------------- */}
        {tab === "overview" && (
          <div className="analysis-stack">
            {loading ? (
              <>
                <p className="analysis-status" role="status">
                  <span className="analysis-status__dot" aria-hidden />
                  <span>
                    {t.loading}
                    <small>{t.loadingHint}</small>
                  </span>
                </p>
                <dl className="analysis-stats" data-testid="plot-analysis-skeleton">
                  {[t.skeletonMean, t.skeletonMin, t.skeletonMax].map((label) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd className="analysis-stats__skeleton" aria-hidden />
                    </div>
                  ))}
                </dl>
              </>
            ) : hasRaster && stats ? (
              <>
                {stale && <p className="analysis-stale-note">{t.staleNote.replace("{date}", observation?.sceneDate ?? observation?.date ?? "")}</p>}
                <dl className="analysis-stats" data-testid="plot-analysis-stats">
                  <div className="analysis-stats--lead">
                    <dt>{t.mean}</dt>
                    <dd dir="ltr">{fmt(stats.mean)}</dd>
                    <small>NDVI</small>
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
                {stats.count === 0 ? (
                  <p className="analysis-note">{t.noMeasured}</p>
                ) : (
                  <p className="analysis-note">
                    {t.measured
                      .replace("{n}", formatNumber(lang, stats.count, 0))
                      .replace("{source}", layer.source)}
                  </p>
                )}
                <p className="analysis-hint">{t.tapHint}</p>
              </>
            ) : legacy ? (
              <>
                {stale && <p className="analysis-stale-note">{t.staleNote.replace("{date}", observation?.sceneDate ?? observation?.date ?? "")}</p>}
                <div className="analysis-legacy">
                  <p>
                    <strong>{t.legacyTitle}</strong>
                    {t.legacyNote}
                  </p>
                  {cellValues.length > 0 && (
                    <dl className="analysis-stats" data-testid="plot-analysis-stats">
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
                  <button type="button" className="analysis-legacy__retry" onClick={onRetry}>
                    {t.retry}
                  </button>
                </div>
              </>
            ) : failed ? (
              <p className="analysis-note">{t.noReading}</p>
            ) : (
              <p className="analysis-note">{t.noRaster}</p>
            )}
          </div>
        )}

        {/* ---------------- 2 · الخرائط — layers, legend, tap --------------- */}
        {tab === "maps" && (
          <div className="analysis-stack">
            <div className="analysis-chips" role="group" aria-label={t.layers}>
              {PLOT_LAYERS.map((entry) => {
                const wired = entry.available && (entry.id !== "ndvi" || Boolean(raster));
                const active = entry.id === layer.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={!wired}
                    aria-pressed={active}
                    data-testid={`plot-layer-${entry.id}`}
                    className={`analysis-chip${active ? " is-active" : ""}`}
                    onClick={() => setLayerId(entry.id)}
                  >
                    <span>{rtl ? entry.labelAr : entry.labelFr}</span>
                    <small>{wired ? entry.unit : t.soon}</small>
                  </button>
                );
              })}
            </div>

            {hasRaster && domain ? (
              <div className="analysis-legend" dir="ltr">
                <span className="analysis-legend__title" dir={rtl ? "rtl" : "ltr"}>
                  {t.legend} · {layer.unit}
                </span>
                <div className="analysis-legend__bar" style={{ background: ndviLegendGradientCss() }} />
                <div className="analysis-legend__labels">
                  <span>{fmt(domain[0])}</span>
                  <span>{fmt(domain[1])}</span>
                </div>
              </div>
            ) : (
              <p className="analysis-note">{t.noRaster}</p>
            )}

            <p className="analysis-hint">{t.tapHint}</p>
          </div>
        )}

        {/* ---------------- 3 · الطقس — the NASA POWER day ------------------ */}
        {tab === "weather" && (
          <div className="analysis-stack">
            {climate ? (
              <>
                <p className="analysis-subtitle">
                  <ThermometerSun size={13} strokeWidth={2.6} aria-hidden />
                  {t.weatherTitle}
                </p>
                <ul className="analysis-weather">
                  {[
                    { icon: <Droplets size={14} aria-hidden />, label: t.rain, value: formatNumber(lang, climate.rainMm, 1, t.mm) },
                    { icon: <ThermometerSun size={14} aria-hidden />, label: t.tmax, value: formatNumber(lang, climate.tempMaxC, 1, "°C") },
                    { icon: <ThermometerSun size={14} aria-hidden />, label: t.tmin, value: formatNumber(lang, climate.tempMinC, 1, "°C") },
                    { icon: <Wind size={14} aria-hidden />, label: t.et0, value: formatNumber(lang, climate.et0, 1, t.mm) },
                  ].map((item) => (
                    <li key={item.label}>
                      {item.icon}
                      <span>{item.label}</span>
                      <strong dir="ltr">{item.value}</strong>
                    </li>
                  ))}
                </ul>
                <p className="analysis-hint">{t.weatherNote}</p>
              </>
            ) : (
              <p className="analysis-note">{t.weatherNone}</p>
            )}
          </div>
        )}

        {/* ---------------- 4 · التفاصيل — provenance --------------------- */}
        {tab === "details" && (
          <div className="analysis-stack">
            <dl className="analysis-facts">
              <div>
                <dt>
                  <Satellite size={13} aria-hidden />
                  {t.source}
                </dt>
                <dd dir="ltr">{layer.source}</dd>
              </div>
              {observation && (
                <div>
                  <dt>
                    <ScanLine size={13} aria-hidden />
                    {t.readingDate}
                  </dt>
                  <dd dir="ltr">{observation.date}</dd>
                </div>
              )}
              {observation?.sceneDate && (
                <div>
                  <dt>
                    <Satellite size={13} aria-hidden />
                    {t.scene}
                  </dt>
                  <dd dir="ltr">{observation.sceneDate}</dd>
                </div>
              )}
              {observation?.cloudCoverPct != null && (
                <div>
                  <dt>
                    <Cloud size={13} aria-hidden />
                    {t.cloud}
                  </dt>
                  <dd dir="ltr">{fmt(observation.cloudCoverPct, 1)}%</dd>
                </div>
              )}
              {raster && (
                <div>
                  <dt>
                    <Ruler size={13} aria-hidden />
                    {t.resolution}
                  </dt>
                  <dd dir="ltr">{t.caption.replace("{res}", String(raster.resolutionM))}</dd>
                </div>
              )}
              {climate && (
                <div>
                  <dt>
                    <ThermometerSun size={13} aria-hidden />
                    {t.source}
                  </dt>
                  <dd dir="ltr">
                    {climate.source} · {climate.date}
                  </dd>
                </div>
              )}
              {stale && observation && (
                <div>
                  <dt>
                    <Cloud size={13} aria-hidden />
                    {t.staleBadge}
                  </dt>
                  <dd>{t.staleNote.replace("{date}", observation.sceneDate ?? observation.date)}</dd>
                </div>
              )}
            </dl>
            {hasRaster && stats && (
              <p className="analysis-note">
                {t.measured
                  .replace("{n}", formatNumber(lang, stats.count, 0))
                  .replace("{source}", layer.source)}
              </p>
            )}
          </div>
        )}
      </div>
    </motion.section>
  );
}
