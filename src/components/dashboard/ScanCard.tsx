"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import {
  containedImageRect,
  isLeafFailure,
  leafMotionTiming,
  leafZoomTransform,
  LeafDiagnosisError,
  parseLeafDiagnosis,
  resizedLeafDimensions,
  validateLeafImage,
  type ImageSize,
  type LeafDiagnosis,
  type LeafFailure,
  type LeafFinding,
} from "@/lib/leaf-diagnose";
import { demoScanToDiagnosis } from "@/lib/leaf-scan-demo";
import styles from "./scan-card.module.css";

type Phase = "idle" | "preparing" | "ready" | "scanning" | "revealing" | "complete" | "error";
interface PickedImage extends ImageSize { blob: Blob; url: string }
const SCAN_WORDS = ["يحلل الورقة…", "يفحص الأنسجة…"];
const ERROR_COPY: Record<LeafFailure, { title: string; hint: string }> = {
  "invalid-input": { title: "تعذّر قراءة هذه الصورة", hint: "اختر صورة JPEG أو PNG أو WebP واضحة." },
  "too-large": { title: "الصورة أكبر من 4 ميغابايت", hint: "اختر نسخة أصغر ثم أعد الفحص." },
  "provider-busy": { title: "خدمة التحليل مشغولة الآن", hint: "صورتك جاهزة. جرّب مجددًا بعد قليل." },
  malformed: { title: "لم تصل قراءة واضحة", hint: "أعد المحاولة أو اختر صورة أوضح للورقة." },
  "not-a-plant": { title: "لا يظهر نبات في هذه الصورة", hint: "جرّب صورة قريبة لورقة نبات." },
  network: { title: "تعذّر الاتصال بخدمة التحليل", hint: "تحقق من اتصالك ثم أعد المحاولة." },
};

function motionSnapshot() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
function subscribeMotion(notify: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}
const serverMotionSnapshot = () => false;

/** Native CSS/SVG motion, as requested; no new icon or animation dependencies. */
function Icon({ name, size = 18 }: { name: "scan" | "upload" | "shield" | "check" | "leaf" | "retry" | "zoom"; size?: number }) {
  const paths = {
    scan: <><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3M3 12h18" /><path d="M9 9c0-3 5-4 7-3 0 4-2 7-5 7" /></>,
    upload: <><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M12 16V3m-5 5 5-5 5 5" /><path d="M5 13H3V5a2 2 0 0 1 2-2h2" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
    leaf: <><path d="M20 3c-8-1-15 3-15 9a6 6 0 0 0 6 6c6 0 9-7 9-15Z" /><path d="M3 21 16 8m-9 9v-6m4 2h5" /></>,
    retry: <><path d="M4 9a8 8 0 1 1 0 7M4 4v5h5" /></>,
    zoom: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6M7 10h6m-3-3v6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function prepareImage(input: File): Promise<Omit<PickedImage, "url">> {
  const invalid = validateLeafImage(input, new Uint8Array(await input.slice(0, 12).arrayBuffer()));
  if (invalid) throw new LeafDiagnosisError(invalid);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(input, { imageOrientation: "from-image" }); }
  catch { throw new LeafDiagnosisError("invalid-input"); }
  try {
    const dimensions = resizedLeafDimensions(bitmap);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new LeafDiagnosisError("invalid-input");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new LeafDiagnosisError("invalid-input")), "image/jpeg", 0.82,
    ));
    const compressedError = validateLeafImage(blob);
    if (compressedError) throw new LeafDiagnosisError(compressedError);
    return { blob, ...dimensions };
  } finally { bitmap.close(); }
}

function findingBrackets(finding: LeafFinding) {
  const [top, left, bottom, right] = finding.box;
  const corner = Math.min(40, (right - left) / 3, (bottom - top) / 3);
  return `M${left},${top + corner}V${top}H${left + corner} M${right - corner},${top}H${right}V${top + corner} M${right},${bottom - corner}V${bottom}H${right - corner} M${left + corner},${bottom}H${left}V${bottom - corner}`;
}

/** Chips stay at readable size while the image plane zooms underneath them. */
function annotation(finding: LeafFinding, index: number, frame: ImageSize,
  rect: ReturnType<typeof containedImageRect>, zoom: ReturnType<typeof leafZoomTransform>) {
  const width = Math.min(142, (frame.width - 36) / 2);
  const left = index % 2 === 0 ? frame.width - width - 12 : 12;
  const top = index === 1 || index === 2 ? frame.height - 56 : index === 4 ? frame.height / 2 - 22 : 12;
  const targetX = index % 2 === 0 ? left : left + width;
  const targetY = top + 22;
  const [ymin, xmin, ymax, xmax] = finding.box;
  const centerX = rect.x + zoom.translateX + (xmin + xmax) / 2000 * rect.width * zoom.scale;
  const edgeX = targetX >= centerX ? xmax : xmin;
  const sourceX = Math.min(frame.width - 8, Math.max(8, rect.x + zoom.translateX + edgeX / 1000 * rect.width * zoom.scale));
  const sourceY = Math.min(frame.height - 8, Math.max(8, rect.y + zoom.translateY + (ymin + ymax) / 2000 * rect.height * zoom.scale));
  const elbowX = (sourceX + targetX) / 2;
  const direction = Math.sign(elbowX - sourceX) || 1;
  return {
    left, top, width,
    line: `M${sourceX},${sourceY}H${elbowX}L${targetX},${targetY}`,
    arrow: `M${sourceX + direction * 5},${sourceY - 4}L${sourceX},${sourceY}L${sourceX + direction * 5},${sourceY + 4}`,
  };
}

/** The prop contract stays unchanged; diagnosis does not use wilaya/name-based demo priors. */
export default function ScanCard({ t }: { t: DashboardCopy; wilayaCode: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<PickedImage | null>(null);
  const [result, setResult] = useState<LeafDiagnosis | null>(null);
  const [error, setError] = useState<LeafFailure | null>(null);
  const [dragging, setDragging] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [frameSize, setFrameSize] = useState<ImageSize>({ width: 320, height: 240 });
  const [inView, setInView] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const reducedMotion = useSyncExternalStore(subscribeMotion, motionSnapshot, serverMotionSnapshot);
  const gridId = useId();
  const url = file?.url;

  useEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    if (reducedMotion || typeof IntersectionObserver === "undefined") {
      const id = window.requestAnimationFrame(() => setInView(true));
      return () => window.cancelAnimationFrame(id);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.08 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [reducedMotion]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => { revision.current += 1; controller.current?.abort(); }, []);
  useEffect(() => {
    if (!url || !frame.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setFrameSize((old) => old.width === width && old.height === height ? old : { width, height });
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [url]);
  useEffect(() => {
    if (phase !== "scanning" || reducedMotion) return;
    const timer = window.setInterval(() => setStatusIndex((old) => (old + 1) % SCAN_WORDS.length), 1700);
    return () => window.clearInterval(timer);
  }, [phase, reducedMotion]);

  const reset = () => {
    revision.current += 1;
    controller.current?.abort();
    controller.current = null;
    setFile(null);
    setResult(null);
    setError(null);
    setRevealed(0);
    setSelected(null);
    setDragging(false);
    setPhase("idle");
  };

  const pick = async (picked?: File) => {
    if (!picked) return;
    reset();
    const current = revision.current;
    setPhase("preparing");
    try {
      const image = await prepareImage(picked);
      if (revision.current !== current) return;
      setFile({ ...image, url: URL.createObjectURL(image.blob) });
      setPhase("ready");
    } catch (failure) {
      if (revision.current !== current) return;
      setError(failure instanceof LeafDiagnosisError ? failure.reason : "invalid-input");
      setPhase("error");
    }
  };

  const analyze = async () => {
    if (!file || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    const current = ++revision.current;
    setPhase("scanning");
    setError(null);
    setResult(null);
    setSelected(null);
    setRevealed(0);
    setStatusIndex(0);
    const guard = window.setTimeout(() => request.abort(), 30_000);
    try {
      const upload = async (): Promise<LeafDiagnosis | LeafFailure> => {
        try {
          const body = new FormData();
          body.append("image", file.blob, "leaf.jpg");
          // Demo quick-scan FIRST (see /api/scan): it answers only while the
          // demo mock is enabled, with a scripted diagnosis the card renders
          // exactly like a real one. While the flag is off — i.e. production —
          // it answers 404 instantly and the real pipeline below runs
          // unchanged; a malformed envelope is likewise ignored.
          try {
            const demo = await fetch("/api/scan", { method: "POST", body, signal: request.signal });
            if (demo.ok) {
              const envelope: unknown = await demo.json().catch(() => null);
              const scripted = demoScanToDiagnosis(envelope);
              if (scripted) return scripted;
            }
          } catch (demoFailure) {
            // Abort (component unmount / 30 s guard) must still propagate.
            if (request.signal.aborted) throw demoFailure;
          }
          const response = await fetch("/api/leaf-diagnose", { method: "POST", body, signal: request.signal });
          let data: unknown;
          try { data = await response.json(); } catch { return "malformed"; }
          if (!response.ok) {
            const reason = typeof data === "object" && data !== null && "error" in data ? data.error : null;
            return isLeafFailure(reason) ? reason : "network";
          }
          return parseLeafDiagnosis(data);
        } catch (failure) {
          return failure instanceof LeafDiagnosisError ? failure.reason : "network";
        }
      };
      // Settle errors as values, so an instant failure cannot bypass the minimum scan.
      const [diagnosis] = await Promise.all([
        upload(), pause(leafMotionTiming(reducedMotion).minimumScanMs, request.signal),
      ]);
      window.clearTimeout(guard);
      if (revision.current !== current) return;
      if (typeof diagnosis === "string" || !diagnosis.isPlant) {
        setError(typeof diagnosis === "string" ? diagnosis : "not-a-plant");
        setPhase("error");
        return;
      }
      setResult(diagnosis);
      setPhase("revealing");
      await pause(leafMotionTiming(motionSnapshot()).dimFadeMs, request.signal);
      if (motionSnapshot()) {
        setRevealed(diagnosis.findings.length);
      } else {
        for (let count = 1; count <= diagnosis.findings.length; count += 1) {
          if (revision.current !== current) return;
          setRevealed(count);
          await pause(leafMotionTiming(motionSnapshot()).findingStaggerMs, request.signal);
          if (motionSnapshot()) { setRevealed(diagnosis.findings.length); break; }
        }
      }
      if (revision.current === current) setPhase("complete");
    } catch {
      if (revision.current === current) { setError("network"); setPhase("error"); }
    } finally {
      window.clearTimeout(guard);
      if (revision.current === current) controller.current = null;
    }
  };

  const toggleFinding = (index: number) => setSelected((old) => old === index ? null : index);
  const rect = containedImageRect(file ?? frameSize, frameSize);
  const zoom = leafZoomTransform(selected === null ? null : result?.findings[selected]?.box ?? null, file ?? frameSize, frameSize);
  const findings = result?.findings.slice(0, revealed) ?? [];
  const scanning = phase === "scanning";
  const healthy = result?.verdict === "healthy";
  const confidence = Math.round((result?.confidence ?? 0) * 100);
  const verdictAr = result?.verdict === "healthy" ? "سليمة" : result?.verdict === "diseased" ? "مصابة" : "غير مؤكد";
  const active = selected ?? (phase === "revealing" ? revealed - 1 : null);

  return (
    <section
      ref={cardRef}
      aria-label={t.scan.title}
      className={styles.card}
      data-in-view={inView || reducedMotion}
    >
      <header className={styles.header}>
        <span aria-hidden="true" className={styles.iconTile}>
          <Icon name="scan" />
        </span>
        <div className={styles.headerText}>
          <h2 className={styles.title}>{t.scan.title}</h2>
          <span className={styles.chip}>جاهز للفحص</span>
          <p className={styles.subtitle}>صورة واحدة، قراءة بصرية لصحة الورقة.</p>
        </div>
      </header>
      <div className={styles.content} dir="rtl" data-testid="leaf-diagnose-card" data-state={phase} data-reduced-motion={reducedMotion}>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden tabIndex={-1} aria-label="ملف صورة للفحص"
          onChange={(event) => { void pick(event.target.files?.[0]); event.target.value = ""; }} />

        {!file ? (
          <button type="button" className={styles.upload} data-dragging={dragging} disabled={phase === "preparing"}
            onClick={() => input.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void pick(event.dataTransfer.files?.[0]); }}>
            <span className={styles.uploadIcon}><Icon name="upload" size={25} /></span>
            <span className={styles.uploadTitle}>{phase === "preparing" ? "تجهيز الصورة…" : "اختر صورة الورقة"}</span>
            <span className={styles.uploadHint}><bdi dir="ltr">JPEG / PNG / WebP</bdi> · حتى 4 ميغابايت</span>
          </button>
        ) : (
          <>
            <div ref={frame} className={styles.frame} data-scanning={scanning} data-zoomed={selected !== null} data-testid="leaf-image-frame"
              style={{ "--leaf-zoom-ms": `${leafMotionTiming(reducedMotion).zoomMs}ms` } as CSSProperties}>
              <div className={styles.imagePlane} data-testid="leaf-image-plane" style={{
                left: rect.x, top: rect.y, width: rect.width, height: rect.height,
                transform: `translate(${zoom.translateX}px, ${zoom.translateY}px) scale(${zoom.scale})`,
              }}>
                {/* Blob previews cannot be optimized by next/image. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={file.url} alt="صورة الورقة المختارة للفحص" className={styles.photo} width={file.width} height={file.height} />
                {findings.length > 0 && (
                  <svg className={styles.boxes} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
                    {findings.map((finding, index) => {
                      const [ymin, xmin, ymax, xmax] = finding.box;
                      return <g key={index} className={styles.finding} data-severity={finding.severity} data-active={active === index} data-dimmed={selected !== null && selected !== index}>
                        <ellipse className={styles.findingRing} style={{ strokeWidth: 1.2 / zoom.scale }} cx={(xmin + xmax) / 2} cy={(ymin + ymax) / 2} rx={(xmax - xmin) / 2 + 14} ry={(ymax - ymin) / 2 + 14} />
                        <ellipse className={styles.findingEllipse} style={{ strokeWidth: 1.3 / zoom.scale }} pathLength="1" cx={(xmin + xmax) / 2} cy={(ymin + ymax) / 2} rx={(xmax - xmin) / 2} ry={(ymax - ymin) / 2} />
                        <path className={styles.findingBracket} style={{ strokeWidth: 2.2 / zoom.scale }} pathLength="1" d={findingBrackets(finding)} />
                      </g>;
                    })}
                  </svg>
                )}
              </div>

              {scanning && <div className={styles.scanner} aria-hidden="true" data-testid="leaf-scanner">
                <svg className={styles.mesh} viewBox="0 0 1000 1000" preserveAspectRatio="none">
                  <defs><pattern id={gridId} width="100" height="100" patternUnits="userSpaceOnUse"><path d="M100 0H0V100" fill="none" stroke="currentColor" strokeWidth="1.4" /></pattern></defs>
                  <rect width="1000" height="1000" fill={`url(#${gridId})`} />
                  <g className={styles.contours} fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M-40 300C100 40 230 530 390 260S630 70 790 300 970 420 1080 180" />
                    <path d="M-40 550C100 290 230 780 390 510S630 320 790 550 970 670 1080 430" />
                    <path d="M-40 780C100 520 230 1010 390 740S630 550 790 780 970 900 1080 660" />
                  </g>
                </svg>
                <div className={styles.scanSweep} />
                <span className={styles.scanCorner} data-corner="tl" /><span className={styles.scanCorner} data-corner="tr" />
                <span className={styles.scanCorner} data-corner="bl" /><span className={styles.scanCorner} data-corner="br" />
                <span className={styles.scanBadge}><Icon name="scan" size={12} /> فحص بصري</span>
              </div>}

              {findings.length > 0 && <>
                <svg className={styles.leaders} viewBox={`0 0 ${frameSize.width} ${frameSize.height}`} aria-label="أسهم مواضع العلامات">
                  {findings.map((finding, index) => {
                    const item = annotation(finding, index, frameSize, rect, zoom);
                    return <g key={index} className={styles.leader} data-severity={finding.severity} data-dimmed={selected !== null && selected !== index}
                      role="button" tabIndex={0} aria-label={`تكبير موضع: ${finding.labelAr}`} aria-pressed={selected === index}
                      onClick={() => toggleFinding(index)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleFinding(index); } }}>
                      <path className={styles.leaderHit} d={item.line} />
                      <path className={styles.leaderLine} pathLength="1" d={item.line} /><path className={styles.arrowHead} d={item.arrow} />
                    </g>;
                  })}
                </svg>
                {findings.map((finding, index) => {
                  const item = annotation(finding, index, frameSize, rect, zoom);
                  return <button type="button" key={index} className={styles.label} data-severity={finding.severity} data-active={active === index || selected === index}
                    data-dimmed={selected !== null && selected !== index} data-testid="leaf-finding-label" aria-pressed={selected === index} aria-label={finding.labelAr} title={finding.labelAr}
                    style={{ left: item.left, top: item.top, width: item.width }} onClick={() => toggleFinding(index)}>
                    <span className={styles.labelNumber} aria-hidden="true">{index + 1}</span><span className={styles.labelText}>{finding.labelAr}</span>
                  </button>;
                })}
              </>}
              {phase === "complete" && healthy && <span className={styles.healthyBadge}><Icon name="check" size={20} /> سليمة بصريًا</span>}
            </div>

            {findings.length > 0 && <div className={styles.frameTools}>
              <span>{selected === null ? "اضغط على علامة لتكبيرها" : "تفاصيل الموضع المحدد"}</span>
              <button type="button" className={styles.showAll} onClick={() => setSelected(null)} disabled={selected === null}><Icon name="zoom" size={14} /> عرض الكل</button>
            </div>}
            {phase === "ready" && <div className={styles.readyLine}><Icon name="check" size={14} /> الصورة جاهزة للفحص <span dir="ltr">{file.width} × {file.height}</span></div>}
          </>
        )}

        {(scanning || phase === "revealing" || phase === "preparing") && <div className={styles.status} role="status">
          <span className={styles.statusDot} aria-hidden="true" />
          <span>{phase === "preparing" ? "تجهيز الصورة…" : scanning ? SCAN_WORDS[statusIndex] : "تحديد العلامات المرئية…"}</span>
          {phase === "revealing" && result && result.findings.length > 0 && <span className={styles.statusCount} dir="ltr">{revealed} / {result.findings.length}</span>}
        </div>}

        {phase === "ready" && <button type="button" className={styles.primary} onClick={() => void analyze()}><Icon name="scan" /> بدء الفحص</button>}

        {phase === "complete" && result && <div className={styles.result} data-verdict={result.verdict} data-testid="leaf-result-sheet" role="status">
          <div className={styles.resultTop}><span className={styles.eyebrow}>نتيجة الفحص</span><span className={styles.verdict}>{healthy && <Icon name="check" size={13} />}{verdictAr}</span></div>
          <h3 className={styles.resultName}>{healthy ? "ورقة تبدو سليمة" : result.diseaseNameAr || "لم تتضح الإصابة"}</h3>
          <div className={styles.plantName}><Icon name="leaf" size={14} />{result.plantNameAr || "نبات غير محدد"}</div>
          <div className={styles.confidenceLabel}><span>درجة الثقة</span><strong dir="ltr">{confidence}%</strong></div>
          <div className={styles.confidenceTrack} role="meter" aria-label="درجة الثقة البصرية" aria-valuemin={0} aria-valuemax={100} aria-valuenow={confidence}>
            <span style={{ width: `${confidence}%` }} />
          </div>
        </div>}

        {phase === "error" && error && <div className={styles.error} role="alert" data-testid="leaf-error">
          <span className={styles.errorIcon}><Icon name={error === "not-a-plant" ? "leaf" : "retry"} size={20} /></span>
          <div className={styles.errorText}><strong>{ERROR_COPY[error].title}</strong><span>{ERROR_COPY[error].hint}</span><small dir="ltr">{error}</small></div>
          <button type="button" className={styles.retry} onClick={() => {
            if (file && error !== "not-a-plant" && error !== "invalid-input" && error !== "too-large") void analyze();
            else { reset(); input.current?.click(); }
          }}><Icon name="retry" size={14} /> إعادة المحاولة</button>
        </div>}

        {file && <button type="button" className={styles.another} onClick={reset}><Icon name="upload" size={15} /> فحص صورة أخرى</button>}
        <p className={styles.privacy}><Icon name="shield" size={13} /><span>تُرسل الصورة إلى خدمة التحليل لحظة الفحص ولا تُحفظ</span></p>
        {(phase === "complete" || phase === "error") && <p className={styles.disclaimer}>تقدير بصري لا يغني عن مهندس زراعي</p>}
      </div>
    </section>
  );
}
