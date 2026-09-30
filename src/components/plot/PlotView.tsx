"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ArrowRight, CalendarDays, Check, CheckCheck, CornerDownLeft, Expand, Loader2, MapPin, Pencil, Ruler, ScanLine, Trash2, Undo2, X } from "lucide-react";
import type { Plot } from "@/lib/field-data/types";
import { renamePlot } from "@/lib/field-data/plots";
import { centroidOf, ringAreaHa } from "@/lib/geo/polygon";
import { perimeterMetres, plotGeometry } from "@/lib/plot/geometry";
import { composePlotTexture, type PlotTexture } from "@/lib/plot/imagery";
import type { Lang } from "@/lib/wilayas";
import "./plot-view.css";

const COPY = {
  ar: {
    title: "تفاصيل القطعة", back: "العودة إلى خريطة الرسم", saved: "قطعة محفوظة", name: "اسم القطعة",
    edit: "تعديل اسم القطعة", save: "حفظ الاسم", cancel: "إلغاء", renameError: "تعذّر حفظ الاسم. حاول مرة أخرى.",
    outline: "حدود قطعتك", shape: "الشكل الحقيقي لقطعتك، باتجاه الشمال", satellite: "صورة فضائية داخل حدود القطعة",
    loading: "جارٍ تحميل الصورة الفضائية…", fallback: "عرض الحدود · الصورة الفضائية غير متاحة", north: "شمال",
    details: "الأرض بالأرقام", area: "المساحة الإجمالية", ha: "هكتار", sqm: "م²", perimeter: "محيط القطعة", metres: "متر",
    center: "إحداثيات المركز", lat: "خط العرض", lon: "خط الطول", vertices: "نقاط الحدود", points: "نقاط", date: "تاريخ الرسم",
    approximate: "قياسات تقريبية محسوبة من الحدود المرسومة، وليست مسحًا عقاريًا.",
    analyze: "تحليل القطعة", soon: "قادم في الخطوة التالية", redraw: "إعادة الرسم", delete: "حذف القطعة",
    confirm: "هل تريد حذف هذه القطعة؟", deleteHint: "ستُحذف الحدود والاسم المحفوظان. لا يمكن التراجع عن الحذف.",
    deleteError: "تعذّر حذف القطعة. حاول مرة أخرى.",
  },
  fr: {
    title: "Détails de la parcelle", back: "Retour à la carte de tracé", saved: "Parcelle enregistrée", name: "Nom de la parcelle",
    edit: "Modifier le nom", save: "Enregistrer le nom", cancel: "Annuler", renameError: "Impossible de renommer. Réessayez.",
    outline: "Votre parcelle", shape: "La forme réelle de votre parcelle, orientée au nord", satellite: "Image satellite dans les limites",
    loading: "Chargement de l’image satellite…", fallback: "Limites seules · image satellite indisponible", north: "Nord",
    details: "Votre terrain en chiffres", area: "Superficie totale", ha: "hectares", sqm: "m²", perimeter: "Périmètre", metres: "mètres",
    center: "Coordonnées du centre", lat: "Latitude", lon: "Longitude", vertices: "Sommets", points: "points", date: "Date du tracé",
    approximate: "Mesures approximatives calculées à partir du tracé, et non un relevé cadastral.",
    analyze: "Analyser la parcelle", soon: "À la prochaine étape", redraw: "Redessiner", delete: "Supprimer la parcelle",
    confirm: "Supprimer cette parcelle ?", deleteHint: "Le nom et les limites enregistrés seront supprimés. Cette action est irréversible.",
    deleteError: "Impossible de supprimer. Réessayez.",
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
  const titleId = useId(), clipId = useId(), gradientId = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(plot.name);
  const [renaming, setRenaming] = useState(false);
  const renameLock = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteLock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const geometry = useMemo(() => plotGeometry(plot.ring), [plot.ring]);
  const [textureState, setTextureState] = useState<{ geometry: typeof geometry; texture: PlotTexture | null } | null>(null);
  const texture = textureState?.geometry === geometry ? textureState.texture : null;
  const loading = textureState?.geometry !== geometry;
  const center = centroidOf(plot.ring) ?? plot.centroid;
  const area = ringAreaHa(plot.ring);
  const number = (value: number, decimals = 0) => new Intl.NumberFormat(rtl ? "ar-DZ-u-nu-latn" : "fr-FR", {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(value);

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

  return createPortal(
    <motion.section
      ref={rootRef}
      role="dialog" aria-modal="true" aria-labelledby={titleId}
      dir={rtl ? "rtl" : "ltr"} className="plot-view" data-testid="plot-view"
      initial={reduceMotion ? false : { opacity: 0, scale: 0.975 }}
      animate={{ opacity: 1, scale: 1 }} exit={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: 0.985 }}
      transition={{ duration: reduceMotion ? 0 : 0.26, ease: [0.2, 0.8, 0.2, 1] }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (renaming || deleting) return;
          if (confirmDelete) setConfirmDelete(false);
          else if (editing) { setName(plot.name); setEditing(false); }
          else onBack();
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
        <button ref={backRef} className="plot-view__icon-button" aria-label={t.back} onClick={onBack} disabled={renaming || deleting}>
          {rtl ? <ArrowRight size={22} /> : <ArrowLeft size={22} />}
        </button>
        <h2 id={titleId}>{t.title}</h2>
        <span className="plot-view__saved"><CheckCheck size={15} aria-hidden />{t.saved}</span>
      </header>

      <div className="plot-view__scroll" inert={confirmDelete}>
        <div className="plot-view__layout">
          <figure className="plot-view__figure" aria-label={t.outline}>
            <div className="plot-view__figure-heading"><span>{t.outline}</span><span className="plot-view__north"><ArrowRight size={15} aria-hidden />{t.north}</span></div>
            <div className="plot-view__art" data-testid="plot-art" data-imagery={loading ? "loading" : texture ? "satellite" : "fallback"} data-min-zoom={texture?.minZoom} data-max-zoom={texture?.maxZoom}>
              <svg viewBox={`-20 -20 ${geometry.svgWidth + 40} ${geometry.svgHeight + 40}`} role="img" aria-label={t.shape} preserveAspectRatio="xMidYMid meet">
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#65b991" /><stop offset="48%" stopColor="#168367" /><stop offset="100%" stopColor="#064e3b" />
                  </linearGradient>
                  <clipPath id={clipId}><polygon points={geometry.points} /></clipPath>
                </defs>
                <polygon points={geometry.points} fill={`url(#${gradientId})`} />
                {texture && <image href={texture.url} x="0" y="0" width={geometry.svgWidth} height={geometry.svgHeight} preserveAspectRatio="none" clipPath={`url(#${clipId})`} />}
                <polygon points={geometry.points} fill="none" stroke="#fff" strokeWidth="5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                <polygon points={geometry.points} fill="none" stroke="#08765b" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              </svg>
            </div>
            <figcaption>
              <span role="status">{loading ? <><Loader2 size={13} className="plot-view__spinner" aria-hidden />{t.loading}</> : texture ? t.satellite : t.fallback}</span>
              {texture && <small dir="ltr">Esri · Maxar · Earthstar Geographics · GIS User Community</small>}
            </figcaption>
          </figure>

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
            <h3 className="plot-view__section-title">{t.details}</h3>
            <dl className="plot-view__metrics">
              <div className="plot-view__area">
                <dt><Expand size={17} aria-hidden />{t.area}</dt>
                <dd><strong dir="ltr">{number(area, 2)}</strong><span>{t.ha}</span></dd>
                <dd className="plot-view__square-metres"><bdi>{number(area * 10000)}</bdi> {t.sqm}</dd>
              </div>
              <div className="plot-view__perimeter"><dt><Ruler size={17} aria-hidden />{t.perimeter}</dt><dd><strong dir="ltr">{number(perimeterMetres(plot.ring), 1)}</strong><span>{t.metres}</span></dd></div>
              <div className="plot-view__coordinates"><dt><MapPin size={17} aria-hidden />{t.center}<span dir="ltr">WGS84</span></dt><dd><span>{t.lat}<bdi>{center[1].toFixed(6)}°</bdi></span><span>{t.lon}<bdi>{center[0].toFixed(6)}°</bdi></span></dd></div>
              <div><dt><CornerDownLeft size={17} aria-hidden />{t.vertices}</dt><dd><strong>{geometry.vertices}</strong><span>{t.points}</span></dd></div>
              <div><dt><CalendarDays size={17} aria-hidden />{t.date}</dt><dd className="plot-view__date"><time dateTime={plot.createdAt}>{new Intl.DateTimeFormat(rtl ? "ar-DZ" : "fr-FR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(plot.createdAt))}</time></dd></div>
            </dl>
            <p className="plot-view__note">{t.approximate}</p>
          </div>
        </div>
      </div>

      <footer className="plot-view__footer" inert={confirmDelete}>
        <div className="plot-view__actions">
          <button className="plot-view__analyze" disabled><ScanLine size={21} aria-hidden /><span>{t.analyze}<small>{t.soon}</small></span></button>
          <div className="plot-view__secondary-actions">
            <button className="plot-view__redraw" disabled={renaming || deleting} onClick={onRedraw}><Undo2 size={18} aria-hidden />{t.redraw}</button>
            <button className="plot-view__delete" disabled={renaming || deleting} onClick={() => { setError(null); setConfirmDelete(true); requestAnimationFrame(() => deleteCancelRef.current?.focus()); }}><Trash2 size={18} aria-hidden /><span>{t.delete}</span></button>
          </div>
        </div>
      </footer>
      {confirmDelete && <div className="plot-view__confirm-backdrop"><section data-delete-confirm role="alertdialog" aria-modal="true" aria-labelledby={`${titleId}-delete`} aria-describedby={`${titleId}-delete-hint`} className="plot-view__confirm">
        <Trash2 size={24} aria-hidden /><h3 id={`${titleId}-delete`}>{t.confirm}</h3><p id={`${titleId}-delete-hint`}>{t.deleteHint}</p>
        {error && <p role="alert" className="plot-view__error">{error}</p>}
        <button className="plot-view__delete" disabled={deleting} onClick={() => void deleteConfirmed()}>{deleting ? <Loader2 size={18} className="plot-view__spinner" /> : <Trash2 size={18} />}{t.delete}</button>
        <button ref={deleteCancelRef} className="plot-view__redraw" disabled={deleting} onClick={() => { setConfirmDelete(false); backRef.current?.focus(); }}>{t.cancel}</button>
      </section></div>}
    </motion.section>, document.body,
  );
}
