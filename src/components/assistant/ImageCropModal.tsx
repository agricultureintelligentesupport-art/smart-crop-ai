"use client";

/**
 * Pre-submit interactive leaf cropper — **polygonal masking edition**.
 *
 * Opens right after an image is attached/captured. The farmer draws a
 * freehand LOOP (or line/drag) around the leaf; on release the drawn path
 * becomes a polygon that is edge-snapped by the contour detector in
 * `src/lib/assistant/user-crop.ts`:
 *
 *   1. the loop is densified, every vertex gets an outward normal, and it
 *      walks along that normal looking for the strongest colour gradient
 *      (boosted on green-mask crossings) within `searchRadius` px — the
 *      vertices land ON the physical foliage boundary, so the outline
 *      tightens onto the leaf automatically;
 *   2. the polygon is used as a Canvas Clipping Path (`ctx.clip()`): the
 *      preview tensor is painted white-first, then only the region INSIDE
 *      the loop is drawn — everything outside is erased to clean white.
 *
 * The preview ("معاينة الورقة المحددة") is the exact background-masked
 * tensor Step 1 receives: **Confirm & Analyze** ships it with
 * `isUserCropped: true` (the server bypasses Step 0 and routes it
 * straight to MobileNetV2), **Redo Crop** resets the canvas.
 *
 * Touch-first: pointer events + `touch-action: none` (no scroll-stealing
 * while drawing), 44 px minimum targets, inherits the chat's `dir` (RTL)
 * for its chrome — the canvas itself always draws in physical pixel space.
 */

import { motion } from "framer-motion";
import { Check, RotateCcw, Scissors, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { EASE_OUT, FOCUS_RING, GPU } from "@/components/auth/ui";
import type { AssistantCopy } from "@/lib/assistant/copy";
import {
  boxFromPath,
  CONTOUR_DEFAULTS,
  polygonArea,
  polygonBounds,
  rectPolygonFromBox,
  snapPolygonToEdges,
  type CropPoint,
} from "@/lib/assistant/user-crop";

/** What the composer attached (full image). */
export interface CropSourceImage {
  previewUrl: string;
  data: string;
  mimeType: string;
}

/** What Confirm hands back: the background-masked tensor + bypass flag. */
export interface CroppedLeafImage extends CropSourceImage {
  isUserCropped: true;
}

interface ImageCropModalProps {
  image: CropSourceImage;
  copy: AssistantCopy["cropper"];
  onCancel: () => void;
  onConfirm: (cropped: CroppedLeafImage) => void;
}

/** Canvas→image scaling helper (display px → natural px). */
const toImagePoint = (
  event: ReactPointerEvent<HTMLCanvasElement>,
  naturalWidth: number,
  naturalHeight: number,
): CropPoint => {
  const rect = event.currentTarget.getBoundingClientRect();
  const ratioX = rect.width > 0 ? naturalWidth / rect.width : 1;
  const ratioY = rect.height > 0 ? naturalHeight / rect.height : 1;
  const x = (event.clientX - rect.left) * ratioX;
  const y = (event.clientY - rect.top) * ratioY;
  return {
    x: Math.min(Math.max(x, 0), naturalWidth),
    y: Math.min(Math.max(y, 0), naturalHeight),
  };
};

/** Trace a polygon onto an existing canvas path (image/display space). */
const tracePolygon = (
  ctx: CanvasRenderingContext2D | Path2D,
  polygon: readonly CropPoint[],
  scaleX: number,
  scaleY: number,
): void => {
  ctx.moveTo(polygon[0].x * scaleX, polygon[0].y * scaleY);
  for (let i = 1; i < polygon.length; i++) {
    ctx.lineTo(polygon[i].x * scaleX, polygon[i].y * scaleY);
  }
  ctx.closePath();
};

export default function ImageCropModal({
  image,
  copy,
  onCancel,
  onConfirm,
}: ImageCropModalProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  /**
   * Full-resolution pixel snapshot (natural size) — the contour-snap
   * input. Read once at decode time so the gesture handler never pays.
   */
  const gridRef = useRef<{
    canvas: HTMLCanvasElement;
    data: Uint8ClampedArray;
    width: number;
    height: number;
  } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<CropPoint[]>([]);
  /** Edge-snapped selection loop (image space) — the clipping polygon. */
  const polygonRef = useRef<CropPoint[] | null>(null);
  const drawingRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [view, setView] = useState({ width: 0, height: 0 });
  const [polygon, setPolygonState] = useState<CropPoint[] | null>(null);
  const [preview, setPreview] = useState<CroppedLeafImage | null>(null);

  const setPolygon = useCallback((next: CropPoint[] | null) => {
    polygonRef.current = next;
    setPolygonState(next);
  }, []);

  /* ---- Decode the image + build the pixel grid (once) -------------- */
  useEffect(() => {
    let cancelled = false;
    const element = new Image();
    element.onload = () => {
      if (cancelled) return;
      imgRef.current = element;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = element.naturalWidth;
        canvas.height = element.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(element, 0, 0);
          // Data-URL sources are same-origin → getImageData never taints.
          gridRef.current = {
            canvas,
            data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
            width: canvas.width,
            height: canvas.height,
          };
        }
      } catch {
        gridRef.current = null;
      }
      setReady(true);
    };
    element.src = image.previewUrl;
    return () => {
      cancelled = true;
      element.onload = null;
    };
  }, [image.previewUrl]);

  /* ---- Display size: fit stage width × ≤40 vh, keep aspect --------- */
  useEffect(() => {
    if (!ready) return;
    const element = imgRef.current;
    const stage = stageRef.current;
    if (!element || !stage) return;
    const compute = () => {
      const availableWidth = stage.clientWidth || 320;
      const availableHeight = Math.max(180, Math.round(window.innerHeight * 0.4));
      const scale = Math.min(
        1,
        availableWidth / element.naturalWidth,
        availableHeight / element.naturalHeight,
      );
      setView({
        width: Math.max(1, Math.round(element.naturalWidth * scale)),
        height: Math.max(1, Math.round(element.naturalHeight * scale)),
      });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [ready]);

  /* ---- Paint: image + dim-outside-polygon + contour outline -------- */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const element = imgRef.current;
    if (!canvas || !element || view.width < 1 || view.height < 1) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { width, height } = view;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(element, 0, 0, width, height);

    const scaleX = width / element.naturalWidth;
    const scaleY = height / element.naturalHeight;

    const selected = polygonRef.current;
    if (selected && selected.length >= 3) {
      // Dim everything OUTSIDE the polygon (outer rect + loop, even-odd).
      ctx.save();
      ctx.fillStyle = "rgba(6, 44, 35, 0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      tracePolygon(ctx, selected, scaleX, scaleY);
      ctx.fill("evenodd");
      ctx.restore();

      // The edge-snapped contour itself: bright dashed outline.
      ctx.save();
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.lineJoin = "round";
      ctx.beginPath();
      tracePolygon(ctx, selected, scaleX, scaleY);
      ctx.stroke();
      ctx.restore();

      // Snapped vertices as small dots — visible proof the contour locked on.
      ctx.save();
      ctx.fillStyle = "#ecfdf5";
      ctx.strokeStyle = "#059669";
      ctx.lineWidth = 1.5;
      for (const vertex of selected) {
        ctx.beginPath();
        ctx.arc(vertex.x * scaleX, vertex.y * scaleY, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    const path = pathRef.current;
    if (path.length > 1) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.shadowColor = "rgba(16, 185, 129, 0.9)";
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.moveTo(path[0].x * scaleX, path[0].y * scaleY);
      for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x * scaleX, path[i].y * scaleY);
      }
      ctx.stroke();
      ctx.restore();
    }
  }, [view]);

  useEffect(() => {
    redraw();
  }, [redraw, polygon, ready]);

  /**
   * Build the background-masked preview tensor: white background →
   * `ctx.clip()` to the polygon → paint the source through the clip.
   * Output is the polygon's bounding box, exactly the isolated leaf shape.
   */
  const buildPreview = useCallback(
    (loop: readonly CropPoint[]) => {
      const bounds = polygonBounds(loop);
      const element = imgRef.current;
      if (!bounds || !element) return;
      const x0 = Math.max(0, bounds.xmin);
      const y0 = Math.max(0, bounds.ymin);
      const x1 = Math.min(element.naturalWidth, bounds.xmax);
      const y1 = Math.min(element.naturalHeight, bounds.ymax);
      const width = x1 - x0;
      const height = y1 - y0;
      if (width < 1 || height < 1) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const source = gridRef.current?.canvas ?? element;
        // 1. Neutral mask: every pixel starts clean white…
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        // 2. …clip to the drawn polygon (the Canvas Clipping Path)…
        ctx.save();
        ctx.translate(-x0, -y0);
        ctx.beginPath();
        tracePolygon(ctx, loop, 1, 1);
        ctx.clip();
        // 3. …and paint ONLY the region inside the loop.
        ctx.drawImage(source, 0, 0);
        ctx.restore();
        const dataUrl = canvas.toDataURL("image/jpeg", 0.94);
        setPreview({
          previewUrl: dataUrl,
          data: dataUrl.split(",", 2)[1] ?? "",
          mimeType: "image/jpeg",
          isUserCropped: true,
        });
      } catch {
        setPreview(null);
      }
    },
    [],
  );

  /* ---- Gesture: loop OR drag/tap — one path, contour snap on release */
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || event.button === 2) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const element = imgRef.current;
    if (!element) return;
    pathRef.current = [toImagePoint(event, element.naturalWidth, element.naturalHeight)];
    setPolygon(null);
    setPreview(null);
    redraw();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const element = imgRef.current;
    if (!element) return;
    const point = toImagePoint(event, element.naturalWidth, element.naturalHeight);
    const path = pathRef.current;
    const last = path[path.length - 1];
    // Skip sub-pixel duplicates (cheap throttle for high-frequency moves).
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.5) return;
    path.push(point);
    redraw();
  };

  const finalize = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const element = imgRef.current;
    if (!element) return;
    const path = pathRef.current;
    if (path.length === 0) {
      redraw();
      return;
    }

    // A closed-ish loop (real area) is used as drawn; a drag or a bare tap
    // (≈zero area) becomes the min-size bounding rectangle polygon.
    const isLoop =
      path.length >= 3 && Math.abs(polygonArea(path)) >= CONTOUR_DEFAULTS.degenerateArea;
    let loop: CropPoint[];
    if (isLoop) {
      loop = path.map((p) => ({ ...p }));
    } else {
      const box = boxFromPath(path, element.naturalWidth, element.naturalHeight);
      if (!box) {
        redraw();
        return;
      }
      loop = rectPolygonFromBox(box);
    }

    // Edge-snapped contour: pull every vertex onto the foliage boundary.
    const grid = gridRef.current;
    if (grid && grid.data.length >= grid.width * grid.height * 4) {
      loop = snapPolygonToEdges(
        loop,
        { width: grid.width, height: grid.height, data: grid.data },
        {},
      );
    }
    setPolygon(loop);
    buildPreview(loop);
  }, [buildPreview, redraw, setPolygon]);

  const onPointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finalize();
  };

  /* ---- Redo / Confirm / dismiss ------------------------------------ */
  const redo = useCallback(() => {
    pathRef.current = [];
    setPolygon(null);
    setPreview(null);
    redraw();
  }, [redraw, setPolygon]);
  const confirm = useCallback(() => {
    if (!preview) return;
    onConfirm(preview);
  }, [onConfirm, preview]);

  // Escape dismisses without sending (back to the composer, image dropped).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-emerald-950/45 p-3 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.26, ease: EASE_OUT }}
        className={`app-surface ${GPU} flex max-h-[94vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-[1.5rem] p-4 shadow-2xl`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[14px] font-black leading-6 text-emerald-950">{copy.title}</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label={copy.close}
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 transition-colors hover:bg-emerald-100 ${FOCUS_RING}`}
          >
            <X size={15} strokeWidth={3} aria-hidden />
          </button>
        </div>

        <p className="text-[11.5px] font-bold leading-5 text-emerald-900/65">{copy.hint}</p>

        {/* Drawing stage */}
        <div
          ref={stageRef}
          className="relative flex w-full items-center justify-center overflow-hidden rounded-2xl bg-[#0b3b2e]/10 ring-1 ring-emerald-100"
        >
          <canvas
            ref={canvasRef}
            className="max-w-full cursor-crosshair rounded-2xl select-none"
            style={{ touchAction: "none" }}
            aria-label={copy.hint}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          />
          {!ready && (
            <span className="absolute inset-0 grid place-items-center text-[12px] font-bold text-emerald-900/50">
              …
            </span>
          )}
        </div>

        {/* Pre-submit preview — the exact masked tensor Step 1 will evaluate */}
        <div className="rounded-2xl bg-emerald-50/70 p-2.5 ring-1 ring-emerald-100">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-black text-emerald-800">
            <Scissors size={12} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-600" />
            {copy.previewTitle}
          </p>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- local data-URL preview of the masked crop
            <img
              src={preview.previewUrl}
              alt={copy.previewTitle}
              className="max-h-36 w-auto max-w-full rounded-xl bg-white object-contain ring-2 ring-emerald-200"
            />
          ) : (
            <p className="grid min-h-16 place-items-center rounded-xl bg-white/60 px-3 py-3 text-center text-[11px] font-bold text-emerald-900/50">
              {copy.previewEmpty}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={redo}
            disabled={!polygon && !preview}
            className={`flex h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-emerald-100 text-[12.5px] font-black text-emerald-800 transition-colors hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS_RING}`}
          >
            <RotateCcw size={15} strokeWidth={2.6} aria-hidden />
            {copy.redo}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!preview}
            className={`glow-emerald flex h-11 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-br from-emerald-500 via-emerald-500 to-green-600 text-[12.5px] font-black text-white transition-all hover:from-emerald-400 hover:to-green-500 disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS_RING}`}
          >
            <Check size={15} strokeWidth={3} aria-hidden />
            {copy.confirm}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
