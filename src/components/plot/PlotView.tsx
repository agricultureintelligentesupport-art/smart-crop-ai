"use client";

/**
 * The plot screen, in its two states — and it is the SAME screen, not two.
 *
 *   step 2 · confirm — the shape over its satellite, the editable name, the
 *           key numbers, a collapsible technical sheet, one primary action.
 *   step 3 · analyze — the same shape as a hero map on top, and the reading
 *           itself in a draggable sheet of four tabs.
 *
 * Everything the farmer can do is unchanged: the boundary is the stored one,
 * the rename writes through the same `renamePlot` call, the delete asks before
 * it deletes, the analysis still runs one `useFieldData` request at most, and a
 * tap on the map still answers the nearest really-measured pixel. What changed
 * is the order things appear in, and the number of primary buttons on screen.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  CornerDownLeft,
  Expand,
  Loader2,
  MapPin,
  MoreHorizontal,
  Pencil,
  Ruler,
  ScanLine,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { Plot } from "@/lib/field-data/types";
import { useFieldData } from "@/lib/field-data/useFieldData";
import { renamePlot } from "@/lib/field-data/plots";
import { centroidOf, normalizeRing, pointInRing, ringAreaHa } from "@/lib/geo/polygon";
import { mercator, perimeterMetres, plotGeometry } from "@/lib/plot/geometry";
import {
  composeNdviLayer,
  measuredPixelMask,
  ndviColorDomain,
  ndviCssColor,
  nearestMeasuredPixel,
  pixelAtIsMeasured,
  type PixelProbe,
} from "@/lib/plot/ndvi-layers";
import { composePlotTexture, type PlotTexture } from "@/lib/plot/imagery";
import Sheet from "@/components/app/Sheet";
import { formatDegrees, formatNumber } from "./format";
import PlotShape from "./PlotShape";
import PlotAnalysisPanel from "./PlotAnalysisPanel";
import StepHeader from "./StepHeader";
import type { Lang } from "@/lib/wilayas";
import "./plot-view.css";

/** Esri World Imagery attribution — required wherever its pixels are shown. */
const IMAGERY_ATTRIBUTION = "Esri · Maxar · Earthstar Geographics · GIS User Community";

const COPY = {
  ar: {
    title: "تفاصيل القطعة", analysisTitle: "تحليل القطعة", back: "العودة إلى خريطة الرسم", backToConfirm: "العودة إلى تأكيد القطعة", saved: "قطعة محفوظة", name: "اسم القطعة",
    edit: "تعديل اسم القطعة", save: "حفظ الاسم", cancel: "إلغاء", renameError: "تعذّر حفظ الاسم. حاول مرة أخرى.",
    outline: "حدود قطعتك", shape: "الشكل الحقيقي لقطعتك، باتجاه الشمال", satellite: "صورة فضائية داخل حدود القطعة",
    loading: "جارٍ تحميل الصورة الفضائية…", fallback: "عرض الحدود · الصورة الفضائية غير متاحة", north: "شمال",
    details: "الأرض بالأرقام", area: "المساحة الإجمالية", ha: "هكتار", sqm: "م²", perimeter: "محيط القطعة", metres: "متر",
    center: "إحداثيات المركز", lat: "خط العرض", lon: "خط الطول", vertices: "نقاط الحدود", points: "نقاط", date: "تاريخ الرسم",
    approximate: "قياسات تقريبية محسوبة من الحدود المرسومة، وليست مسحًا عقاريًا.",
    techDetails: "تفاصيل تقنية",
    analyze: "تحليل القطعة", analyzing: "جارٍ التحليل…", analyzeHint: "NDVI من Sentinel-2 بدقة 10 م",
    redraw: "إعادة الرسم", delete: "حذف القطعة", more: "خيارات أخرى",
    confirm: "هل تريد حذف هذه القطعة؟", deleteHint: "ستُحذف الحدود والاسم المحفوظان. لا يمكن التراجع عن الحذف.",
    deleteError: "تعذّر حذف القطعة. حاول مرة أخرى.",
    probeTitle: "قراءة النقطة", probeSubtitle: "أقرب بكسل مُقاس من Sentinel-2",
    probeValue: "قيمة NDVI", probeCoords: "إحداثيات البكسل", probeNote: "النقطة المضغوطة غير مُقاسة (غيوم) — هذه أقرب قراءة حقيقية، على بُعد {m} م.",
    probeHere: "قراءة البكسل المضغوط مباشرة.", probePixel: "بكسل Sentinel-2 بدقة {res} م",
  },
  fr: {
    title: "Détails de la parcelle", analysisTitle: "Analyse de la parcelle", back: "Retour à la carte de tracé", backToConfirm: "Retour à la confirmation", saved: "Parcelle enregistrée", name: "Nom de la parcelle",
    edit: "Modifier le nom", save: "Enregistrer le nom", cancel: "Annuler", renameError: "Impossible de renommer. Réessayez.",
    outline: "Votre parcelle", shape: "La forme réelle de votre parcelle, orientée au nord", satellite: "Image satellite dans les limites",
    loading: "Chargement de l’image satellite…", fallback: "Limites seules · image satellite indisponible", north: "Nord",
    details: "Votre terrain en chiffres", area: "Superficie totale", ha: "hectares", sqm: "m²", perimeter: "Périmètre", metres: "mètres",
    center: "Coordonnées du centre", lat: "Latitude", lon: "Longitude", vertices: "Sommets", points: "points", date: "Date du tracé",
    approximate: "Mesures approximatives calculées à partir du tracé, et non un relevé cadastral.",
    techDetails: "Détails techniques",
    analyze: "Analyser la parcelle", analyzing: "Analyse en cours…", analyzeHint: "NDVI Sentinel-2 à 10 m",
    redraw: "Redessiner", delete: "Supprimer la parcelle", more: "Autres actions",
    confirm: "Supprimer cette parcelle ?", deleteHint: "Le nom et les limites enregistrés seront supprimés. Cette action est irréversible.",
    deleteError: "Impossible de supprimer. Réessayez.",
    probeTitle: "Lecture du point", probeSubtitle: "Pixel Sentinel-2 mesuré le plus proche",
    probeValue: "Valeur NDVI", probeCoords: "Coordonnées du pixel", probeNote: "Le point touché n'est pas mesuré (nuages) — voici la lecture réelle la plus proche, à {m} m.",
    probeHere: "Lecture directe du pixel touché.", probePixel: "Pixel Sentinel-2 de {res} m",
  },
};

export default function PlotView({ plot, lang, onBack, onRedraw, onDelete, onRename }: {
  plot: Plot;
  lang: Lang;
  onBack: () => void;
  onRedraw: () => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (plot: Plot) => void;
}) {
  const t = COPY[lang], rtl = lang === "ar";
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(plot.name);
  const [renaming, setRenaming] = useState(false);
  const renameLock = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteLock = useRef(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const geometry = useMemo(() => plotGeometry(plot.ring), [plot.ring]);
  const [textureState, setTextureState] = useState<{ geometry: typeof geometry; texture: PlotTexture | null } | null>(null);
  const texture = textureState?.geometry === geometry ? textureState.texture : null;
  const loading = textureState?.geometry !== geometry;

  /* ---------------- The analysis (real Sentinel-2 raster) ----------------
     A second `useFieldData` instance targeted at THIS plot. The module-level
     response cache and one in-flight promise per plot mean the dashboard's
     own instance and this one can never double-request: opening the details
     of the active plot reuses today's cached observation for free, and
     `manual` keeps this instance from asking before the farmer presses
     «تحليل القطعة». */
  const fieldData = useFieldData(plot.uid, plot.areaHa, { plotId: plot.id, manual: true });
  const [showAnalysis, setShowAnalysis] = useState(false);
  const analyzing = showAnalysis && fieldData.state === "loading";
  const raster = fieldData.observation?.raster ?? null;
  const rasterMask = useMemo(() => (raster ? measuredPixelMask(plot.ring, raster) : null), [plot.ring, raster]);
  const rasterDomain = useMemo(() => (raster ? ndviColorDomain(raster) : null), [raster]);

  /* The NDVI layer as one PNG: measured pixels in their ramp colour at 85 %
     over the imagery, everything else transparent (see `composeNdviLayer`).
     Stretched over the exact rect the satellite texture occupies, so pixel
     (x, y) of the raster lands on its own ground. */
  const ndviImage = useMemo(() => {
    if (!raster || !rasterMask || !rasterDomain || typeof document === "undefined") return null;
    const composed = composeNdviLayer(raster, rasterMask, rasterDomain);
    const canvas = document.createElement("canvas");
    canvas.width = composed.width;
    canvas.height = composed.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imageData = ctx.createImageData(composed.width, composed.height);
    imageData.data.set(composed.data);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  }, [raster, rasterMask, rasterDomain]);

  /* The drawn boundary in the figure's own coordinates, for tap hit-testing. */
  const shapeRing = useMemo(() => {
    const scale = geometry.width > 0 ? geometry.svgWidth / geometry.width : 1;
    return normalizeRing(plot.ring).map(([lon, lat]) => {
      const [mx, my] = mercator([lon, lat]);
      return [(mx - geometry.west) * scale, (my - geometry.north) * scale] as [number, number];
    });
  }, [geometry, plot.ring]);

  const [probe, setProbe] = useState<(PixelProbe & { tappedMeasured: boolean }) | null>(null);
  /* A cached record from before the raster path (deploy day) is upgraded to
     the per-pixel format once per visit — pressing again never re-buys it. */
  const upgradeAttempted = useRef(false);

  function startAnalysis() {
    setShowAnalysis(true);
    // One request per press at most: idle → start asking; a failed reading →
    // re-ask (bypasses the daily cache); loading and ready states already ARE
    // this press's answer, so they do nothing.
    if (fieldData.state === "idle") fieldData.ensure();
    else if (fieldData.state === "error") fieldData.refresh();
    else if (fieldData.state === "ready" && !raster && !upgradeAttempted.current) {
      upgradeAttempted.current = true;
      fieldData.refresh();
    }
  }

  /** One step back in the flow: the reading returns to the confirm screen,
      the confirm screen returns to the map. */
  function goBack() {
    if (showAnalysis) setShowAnalysis(false);
    else onBack();
  }

  function handleFigureTap(event: React.MouseEvent<SVGSVGElement>) {
    if (!raster || !rasterMask || !showAnalysis) return;
    const svg = event.currentTarget;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    if (!pointInRing(shapeRing, [point.x, point.y])) return;
    /* The raster <image> spans [0..svgWidth]×[0..svgHeight] linearly, which
       is exactly the raster's bbox in this figure — so the inverse mapping is
       linear too and the probe lands on the pixel the farmer tapped. */
    const lon = raster.bbox.west + (point.x / geometry.svgWidth) * (raster.bbox.east - raster.bbox.west);
    const lat = raster.bbox.north - (point.y / geometry.svgHeight) * (raster.bbox.north - raster.bbox.south);
    const found = nearestMeasuredPixel(raster, rasterMask, lon, lat);
    if (found) setProbe({ ...found, tappedMeasured: pixelAtIsMeasured(raster, rasterMask, lon, lat) });
  }

  const center = centroidOf(plot.ring) ?? plot.centroid;
  const area = ringAreaHa(plot.ring);

  useEffect(() => {
    const controller = new AbortController();
    composePlotTexture(geometry, controller.signal).then((texture) => {
      if (!controller.signal.aborted) setTextureState({ geometry, texture });
    }).catch(() => {
      if (!controller.signal.aborted) setTextureState({ geometry, texture: null });
    });
    return () => controller.abort();
  }, [geometry]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    // This is a new opaque screen, not an isolation overlay over Leaflet.
    // Keep every other app surface inert, including the mounted drawing map.
    const siblings = Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el !== root);
    const oldInert = siblings.map((el) => el.inert);
    siblings.forEach((el) => { el.inert = true; });
    backRef.current?.focus({ preventScroll: true });
    return () => {
      siblings.forEach((el, i) => { el.inert = oldInert[i]; });
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  /* The overflow menu closes on Escape and on any outside tap — it must never
     stay open over the sticky bar after the farmer moves on. */
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        menuRef.current && event.target instanceof Node &&
        !menuRef.current.contains(event.target) && event.target !== moreRef.current
      ) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [moreOpen]);

  const openMore = (open: boolean) => {
    setMoreOpen(open);
    if (open) {
      requestAnimationFrame(() => {
        menuRef.current?.querySelector<HTMLElement>("button")?.focus();
      });
    } else {
      moreRef.current?.focus({ preventScroll: true });
    }
  };

  /** Arrow keys walk the two secondary actions; Escape leaves the menu. */
  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      openMore(false);
    }
  }

  async function saveName() {
    if (renameLock.current) return;
    const value = name.trim();
    if (!value || value === plot.name) { setName(plot.name); setEditing(false); return; }
    renameLock.current = true; setRenaming(true); setError(null);
    try {
      // Existing metadata-only persistence: do not save a new boundary.
      const updated = await renamePlot(plot.uid, plot.id, value);
      if (!updated) throw new Error("missing plot");
      onRename(updated); setName(updated.name); setEditing(false);
    } catch { setError(t.renameError); }
    finally { renameLock.current = false; setRenaming(false); }
  }

  async function deleteConfirmed() {
    if (deleteLock.current) return;
    deleteLock.current = true; setDeleting(true); setError(null);
    try { await onDelete(plot.id); onBack(); }
    catch { setError(t.deleteError); }
    finally { deleteLock.current = false; setDeleting(false); }
  }

  const shapeCopy = {
    outline: t.outline,
    shape: t.shape,
    north: t.north,
    loading: t.loading,
    analyzing: t.analyzing,
    satellite: t.satellite,
    fallback: t.fallback,
    attribution: IMAGERY_ATTRIBUTION,
  };

  return createPortal(
    <motion.section
      ref={rootRef}
      role="dialog" aria-modal="true" aria-labelledby={titleId}
      dir={rtl ? "rtl" : "ltr"}
      className={`plot-view${showAnalysis ? " plot-view--analysis" : ""} ${rtl ? "font-arabic" : "font-latin"}`}
      data-testid="plot-view"
      data-step={showAnalysis ? 3 : 2}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.975 }}
      animate={{ opacity: 1, scale: 1 }} exit={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.985 }}
      transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.2, 0.8, 0.2, 1] }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (renaming || deleting) return;
          if (moreOpen) { openMore(false); return; }
          if (confirmDelete) setConfirmDelete(false);
          else if (editing) { setName(plot.name); setEditing(false); }
          else goBack();
        }
        if (event.key === "Tab") {
          const scope = confirmDelete ? rootRef.current?.querySelector("[data-delete-confirm]") : rootRef.current;
          const focusable = Array.from(scope?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]") ?? []).filter((el) => el.offsetParent !== null);
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}
    >
      <header className="plot-view__header" inert={confirmDelete}>
        <button ref={backRef} className="plot-view__icon-button" aria-label={showAnalysis ? t.backToConfirm : t.back} onClick={goBack} disabled={renaming || deleting}>
          {rtl ? <ArrowRight size={22} /> : <ArrowLeft size={22} />}
        </button>
        <h2 id={titleId}>{showAnalysis ? t.analysisTitle : t.title}</h2>
        <span className="plot-view__saved"><CheckCheck size={15} aria-hidden />{t.saved}</span>
      </header>

      <div className="plot-view__steps" inert={confirmDelete}>
        <StepHeader current={showAnalysis ? 3 : 2} lang={lang} />
      </div>

      {/* ---------------- Step 3 · the analysis screen -------------------- */}
      {showAnalysis && (
        <div className="plot-view__analysis" inert={confirmDelete}>
          <div className="plot-view__hero">
            <PlotShape
              copy={shapeCopy}
              geometry={geometry}
              texture={texture}
              loading={loading}
              analyzing={analyzing}
              ndviImage={ndviImage}
              probe
              onTap={handleFigureTap}
              mode="hero"
            />
          </div>
          <PlotAnalysisPanel
            lang={lang}
            state={fieldData.state}
            reason={fieldData.reason}
            technical={fieldData.technical}
            stale={fieldData.stale}
            observation={fieldData.observation}
            climate={fieldData.climate}
            ring={plot.ring}
            onRetry={fieldData.refresh}
          />
        </div>
      )}

      {/* ---------------- Step 2 · the confirm screen --------------------- */}
      {!showAnalysis && (
        <>
          <div className="plot-view__scroll" inert={confirmDelete}>
            <div className="plot-view__layout">
              <PlotShape
                copy={shapeCopy}
                geometry={geometry}
                texture={texture}
                loading={loading}
                analyzing={false}
                ndviImage={null}
                onTap={handleFigureTap}
                mode="preview"
              />

              <div className="plot-view__information">
                <section className="plot-view__identity">
                  <span className="plot-view__eyebrow">{t.name}</span>
                  {editing ? <form className="plot-view__name-form" onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
                    <input ref={nameRef} aria-label={t.name} value={name} maxLength={60} disabled={renaming} onChange={(e) => setName(e.target.value)} />
                    <button className="plot-view__icon-button" type="submit" aria-label={t.save} disabled={renaming}>{renaming ? <Loader2 size={20} className="plot-view__spinner" /> : <Check size={20} />}</button>
                    <button className="plot-view__icon-button" type="button" aria-label={t.cancel} disabled={renaming} onClick={() => { setName(plot.name); setEditing(false); }}><X size={19} /></button>
                  </form> : <div className="plot-view__name-row"><h3>{plot.name}</h3><button className="plot-view__icon-button" aria-label={t.edit} onClick={() => { setName(plot.name); setEditing(true); requestAnimationFrame(() => nameRef.current?.focus()); }}><Pencil size={18} /></button></div>}
                </section>
                {error && !confirmDelete && <p role="alert" className="plot-view__error">{error}</p>}

                {/* The two numbers a farmer actually checks: how big it is and
                    how far its edge runs. Everything else is a coordinate. */}
                <h3 className="plot-view__section-title">{t.details}</h3>
                <dl className="plot-view__metrics">
                  <div className="plot-view__area">
                    <dt><Expand size={17} aria-hidden />{t.area}</dt>
                    <dd><strong dir="ltr">{formatNumber(lang, area, 2)}</strong><span>{t.ha}</span></dd>
                    <dd className="plot-view__square-metres"><bdi>{formatNumber(lang, area * 10000)} {t.sqm}</bdi></dd>
                  </div>
                  <div className="plot-view__perimeter">
                    <dt><Ruler size={17} aria-hidden />{t.perimeter}</dt>
                    <dd><strong dir="ltr">{formatNumber(lang, perimeterMetres(plot.ring), 1)}</strong><span>{t.metres}</span></dd>
                  </div>
                </dl>

                {/* The rest is provenance: exact centre, vertex count, draw
                    date, and the honest caveat about the measurement. */}
                <div className="plot-view__disclosure">
                  <button
                    type="button"
                    className="plot-view__disclosure-button"
                    aria-expanded={techOpen}
                    aria-controls="plot-tech-details"
                    onClick={() => setTechOpen((open) => !open)}
                  >
                    {techOpen ? <ChevronDown size={17} aria-hidden /> : <ChevronDown size={17} aria-hidden className="rotate-[-90deg]" />}
                    {t.techDetails}
                  </button>
                  {techOpen && (
                    <div id="plot-tech-details" className="plot-view__disclosure-body">
                      <dl className="plot-view__tech">
                        <div className="plot-view__coordinates">
                          <dt><MapPin size={16} aria-hidden />{t.center}<span dir="ltr">WGS84</span></dt>
                          <dd>
                            <span>{t.lat}<bdi dir="ltr">{formatDegrees(center[1])}</bdi></span>
                            <span>{t.lon}<bdi dir="ltr">{formatDegrees(center[0])}</bdi></span>
                          </dd>
                        </div>
                        <div>
                          <dt><CornerDownLeft size={16} aria-hidden />{t.vertices}</dt>
                          <dd><strong>{geometry.vertices}</strong><span>{t.points}</span></dd>
                        </div>
                        <div>
                          <dt><CalendarDays size={16} aria-hidden />{t.date}</dt>
                          <dd className="plot-view__date">
                            <time dateTime={plot.createdAt}>
                              {new Intl.DateTimeFormat(rtl ? "ar-DZ" : "fr-FR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(plot.createdAt))}
                            </time>
                          </dd>
                        </div>
                      </dl>
                      <p className="plot-view__note">{t.approximate}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <footer className="plot-view__footer" inert={confirmDelete}>
            <div className="plot-view__actions">
              {/* The one primary action of this screen. */}
              <button type="button" className="plot-view__analyze plot-view__analyze--on" onClick={startAnalysis} disabled={renaming || deleting} aria-busy={analyzing}>
                {analyzing ? <Loader2 size={21} className="plot-view__spinner" aria-hidden /> : <ScanLine size={21} aria-hidden />}
                <span>{t.analyze}<small>{t.analyzeHint}</small></span>
              </button>
              {/* Everything else is secondary, and lives behind one icon. */}
              <div className="plot-view__overflow">
                <button
                  ref={moreRef}
                  type="button"
                  className="plot-view__more"
                  aria-label={t.more}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  aria-controls="plot-overflow"
                  onClick={() => openMore(!moreOpen)}
                  disabled={renaming || deleting}
                >
                  <MoreHorizontal size={20} aria-hidden />
                </button>
                {moreOpen && (
                  <div
                    id="plot-overflow"
                    ref={menuRef}
                    role="menu"
                    aria-label={t.more}
                    className="plot-view__menu"
                    onKeyDown={onMenuKeyDown}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => { openMore(false); onRedraw(); }}
                    >
                      <Undo2 size={17} aria-hidden />
                      {t.redraw}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="plot-view__menu-delete"
                      onClick={() => { openMore(false); setError(null); setConfirmDelete(true); requestAnimationFrame(() => deleteCancelRef.current?.focus()); }}
                    >
                      <Trash2 size={17} aria-hidden />
                      {t.delete}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </footer>
        </>
      )}

      {/* Tap-a-point probe: the value of the nearest REAL pixel and its
          coordinates — never an interpolated colour from the smoothed layer. */}
      <Sheet open={probe !== null} onClose={() => setProbe(null)} title={t.probeTitle} subtitle={t.probeSubtitle} lang={lang}>
        {probe && raster && rasterDomain && (
          <div className="plot-view__probe" data-testid="plot-pixel-probe">
            <div className="plot-view__probe-value">
              <span className="plot-view__probe-swatch" style={{ background: ndviCssColor(probe.ndvi, rasterDomain) }} aria-hidden />
              <div>
                <span className="plot-view__probe-label">{t.probeValue}</span>
                <strong dir="ltr">{formatNumber(lang, probe.ndvi, 3)}</strong>
                <small dir="ltr">NDVI</small>
              </div>
            </div>
            <dl className="plot-view__probe-coords">
              <div><dt>{t.lat}</dt><dd dir="ltr"><bdi>{formatDegrees(probe.lat)}</bdi></dd></div>
              <div><dt>{t.lon}</dt><dd dir="ltr"><bdi>{formatDegrees(probe.lon)}</bdi></dd></div>
            </dl>
            <p className="plot-view__probe-note" role="note">
              {probe.tappedMeasured ? t.probeHere : t.probeNote.replace("{m}", formatNumber(lang, Math.round(probe.distanceM)))}
            </p>
            <p className="plot-view__probe-pixel">{t.probePixel.replace("{res}", String(raster.resolutionM))}</p>
          </div>
        )}
      </Sheet>
      {confirmDelete && <div className="plot-view__confirm-backdrop"><section data-delete-confirm role="alertdialog" aria-modal="true" aria-labelledby={`${titleId}-delete`} aria-describedby={`${titleId}-delete-hint`} className="plot-view__confirm">
        <Trash2 size={24} aria-hidden /><h3 id={`${titleId}-delete`}>{t.confirm}</h3><p id={`${titleId}-delete-hint`}>{t.deleteHint}</p>
        {error && <p role="alert" className="plot-view__error">{error}</p>}
        <button className="plot-view__delete" disabled={deleting} onClick={() => void deleteConfirmed()}>{deleting ? <Loader2 size={18} className="plot-view__spinner" /> : <Trash2 size={18} />}{t.delete}</button>
        <button ref={deleteCancelRef} className="plot-view__redraw" disabled={deleting} onClick={() => { setConfirmDelete(false); backRef.current?.focus(); }}>{t.cancel}</button>
      </section></div>}
    </motion.section>, document.body,
  );
}
