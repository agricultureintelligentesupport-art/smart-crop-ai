"use client";

/**
 * The analysis section of the plot-details screen: the layer chips, the NDVI
 * legend (real min/max, scene date, cloud cover), the stats computed from
 * measured pixels only, and the failure card — which keeps the NASA POWER
 * day visible, because the weather upstream is independent of the satellite
 * one and a failed pass is no reason to hide real meteorology.
 *
 * Every number this panel prints comes from `FieldObservation.raster` pixels
 * with a real measurement (`dataMask` ∧ inside the drawn boundary). A masked
 * pixel is never filled, averaged or guessed.
 */

import { useMemo, useState } from "react";
import { Cloud, CloudOff, Droplets, Loader2, RotateCcw, Ruler, Satellite, ScanLine, ThermometerSun, Wind } from "lucide-react";
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

const COPY = {
  ar: {
    title: "تحليل القطعة",
    layers: "طبقات التحليل",
    soon: "قريبًا",
    loading: "جارٍ التحليل…",
    loadingHint: "يُقرأ أحدث لقطة Sentinel-2 لقطعتك",
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
      noScenes: "Aucun passage Sentinel-2 sans nuages au-dessus de cette parcelle depuis trois semaines. Aucun chiffre non mesuré n'est affiché.",
      malformed: "Le service satellite a renvoyé une réponse illisible. Aucun chiffre non mesuré n'est affiché.",
      "invalid-input": "Le contour de cette parcelle n'a pas pu être analysé : un contrôle local a échoué avant tout envoi au satellite.",
      tooSmall: "Cette parcelle est trop petite pour une mesure fiable. Tracez au moins 0,05 ha.",
    } as Record<FieldDataReason, string>,
  },
};

/** The NASA POWER day, compact — shown even when the satellite step failed. */
function WeatherStrip({ climate, lang }: { climate: ClimateObservation; lang: Lang }) {
  const t = COPY[lang];
  const rtl = lang === "ar";
  const fmt = (value: number | null, decimals = 1, unit = "") =>
    value === null
      ? "—"
      : `${new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)}${unit ? ` ${unit}` : ""}`;
  const items = [
    { icon: <Droplets size={13} aria-hidden />, label: t.rain, value: fmt(climate.rainMm, 1, t.mm) },
    { icon: <ThermometerSun size={13} aria-hidden />, label: t.tmax, value: fmt(climate.tempMaxC, 1, "°C") },
    { icon: <ThermometerSun size={13} aria-hidden />, label: t.tmin, value: fmt(climate.tempMinC, 1, "°C") },
    { icon: <Wind size={13} aria-hidden />, label: t.et0, value: fmt(climate.et0, 1, t.mm) },
  ];
  return (
    <div className="plot-analysis__weather">
      <span className="plot-analysis__weather-title">{t.weatherTitle}</span>
      <ul>
        {items.map((item) => (
          <li key={item.label}>
            {item.icon}
            <span>{item.label}</span>
            <strong dir="ltr">{item.value}</strong>
          </li>
        ))}
      </ul>
      <small>{t.weatherNote}</small>
    </div>
  );
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
  const [layerId, setLayerId] = useState<string>("ndvi");
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

  const fmt = (value: number | null | undefined, decimals = 2) =>
    value === null || value === undefined
      ? "—"
      : new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(value);

  return (
    <section className="plot-analysis" data-testid="plot-analysis" aria-label={t.title}>
      <div className="plot-analysis__heading">
        <ScanLine size={16} aria-hidden />
        <h3>{t.title}</h3>
        {stale && observation && <span className="plot-analysis__stale">{t.staleBadge}</span>}
      </div>

      {/* Layer chips — RTL row, driven entirely by PLOT_LAYERS so adding a
          layer is a config entry plus its data path. */}
      <div className="plot-analysis__chips" role="group" aria-label={t.layers}>
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
              className={`plot-analysis__chip${active ? " is-active" : ""}`}
              onClick={() => setLayerId(entry.id)}
            >
              <span>{rtl ? entry.labelAr : entry.labelFr}</span>
              <small>{wired ? entry.unit : t.soon}</small>
            </button>
          );
        })}
      </div>

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
          {/* POWER is independent: the satellite failing never hides the weather. */}
          {climate && <WeatherStrip climate={climate} lang={lang} />}
        </div>
      )}

      {state === "ready" && observation && (
        <>
          {stale && <p className="plot-analysis__stale-note">{t.staleNote.replace("{date}", observation.sceneDate ?? observation.date)}</p>}

          {raster && domain && stats ? (
            <>
              <div className="plot-analysis__legend" dir="ltr">
                <span className="plot-analysis__legend-title" dir={rtl ? "rtl" : "ltr"}>
                  {t.legend} · {layer.unit}
                </span>
                <div className="plot-analysis__legend-bar" style={{ background: ndviLegendGradientCss() }} />
                <div className="plot-analysis__legend-labels">
                  <span>{fmt(domain[0])}</span>
                  <span>{fmt(domain[1])}</span>
                </div>
              </div>

              <ul className="plot-analysis__meta">
                {observation.sceneDate && (
                  <li>
                    <Satellite size={13} aria-hidden />
                    <span>
                      {t.scene}: <bdi dir="ltr">{observation.sceneDate}</bdi>
                    </span>
                  </li>
                )}
                {observation.cloudCoverPct != null && (
                  <li>
                    <Cloud size={13} aria-hidden />
                    <span>
                      {t.cloud}: <bdi dir="ltr">{fmt(observation.cloudCoverPct, 1)}%</bdi>
                    </span>
                  </li>
                )}
                <li>
                  <Ruler size={13} aria-hidden />
                  <span>{t.caption.replace("{res}", String(raster.resolutionM))}</span>
                </li>
              </ul>

              {stats.count > 0 ? (
                <dl className="plot-analysis__stats" data-testid="plot-analysis-stats">
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
              ) : (
                <p className="plot-analysis__status">{t.noMeasured}</p>
              )}
              <p className="plot-analysis__note">
                {t.measured.replace("{n}", new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR").format(stats.count)).replace(
                  "{source}",
                  layer.source,
                )}
              </p>
              <p className="plot-analysis__hint">{t.tapHint}</p>
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

          {climate && <WeatherStrip climate={climate} lang={lang} />}
        </>
      )}
    </section>
  );
}
