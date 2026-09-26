"use client";

/**
 * Pre-submit interactive leaf cropper.
 *
 * Opens right after an image is attached/captured. The farmer either draws
 * a freehand STROKE over the leaf or drags a BOUNDING BOX around it; on
 * release the Smart Snap (`src/lib/assistant/user-crop.ts`) expands the
 * path's box outward over the green/foliage pixels so the selection hugs
 * the leaf without pixel-perfect drawing. The modal then shows the exact
 * cropped tensor that will be analysed ("معاينة الورقة المحددة") and two
 * actions: **Redo Crop** resets the canvas, **Confirm & Analyze** ships the
 * crop with `isUserCropped: true` (the server bypasses Step 0 and routes it
 * straight to MobileNetV2).
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
import type { LeafBox } from "@/lib/assistant/leaf-detect";
import {
  boxFromPath,
  smartSnapBox,
  toCropRect,
  type CropPoint,
} from "@/lib/assistant/user-crop";

/** What the composer attached (full image). */
export interface CropSourceImage {
  previewUrl: string;
  data: string;
  mimeType: string;
}

/** What Confirm hands back: the isolated tensor + the bypass flag. */
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

export default function ImageCropModal({
  image,
  copy,
  onCancel,
  onConfirm,
}: ImageCropModalProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  /**
   * Full-resolution pixel snapshot (natural size) — the Smart Snap input.
   * Read once at decode time so the gesture handler never pays for it.
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
  const selectionRef = useRef<LeafBox | null>(null);
  const drawingRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [view, setView] = useState({ width: 0, height: 0 });
  const [selection, setSelectionState] = useState<LeafBox | null>(null);
  const [preview, setPreview] = useState<CroppedLeafImage | null>(null);

  const setSelection = useCallback((box: LeafBox | null) => {
    selectionRef.current = box;
    setSelectionState(box);
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

  /* ---- Paint: image + dim-outside-selection + dashed box + path ---- */
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

    const box = selectionRef.current;
    if (box) {
      const sx = box.xmin * scaleX;
      const sy = box.ymin * scaleY;
      const sw = (box.xmax - box.xmin) * scaleX;
      const sh = (box.ymax - box.ymin) * scaleY;
      // Dim everything OUTSIDE the selection (even-odd hole fill).
      ctx.save();
      ctx.fillStyle = "rgba(6, 44, 35, 0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.rect(sx, sy, sw, sh);
      ctx.fill("evenodd");
      ctx.restore();
      // Bright dashed frame around the kept region.
      ctx.save();
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.strokeRect(sx, sy, sw, sh);
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
  }, [redraw, selection, ready]);

  /* ---- Build the exact preview tensor from the confirmed box ------- */
  const buildPreview = useCallback((box: LeafBox) => {
    const rect = toCropRect(box);
    if (rect.width < 1 || rect.height < 1) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const source = gridRef.current?.canvas ?? imgRef.current;
      if (!source) return;
      ctx.drawImage(
        source,
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height,
      );
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      setPreview({
        previewUrl: dataUrl,
        data: dataUrl.split(",", 2)[1] ?? "",
        mimeType: "image/jpeg",
        isUserCropped: true,
      });
    } catch {
      setPreview(null);
    }
  }, []);

  /* ---- Gesture: stroke OR box — one path, bounds + smart snap ------ */
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || event.button === 2) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const element = imgRef.current;
    if (!element) return;
    pathRef.current = [toImagePoint(event, element.naturalWidth, element.naturalHeight)];
    setSelection(null);
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
    const raw = boxFromPath(pathRef.current, element.naturalWidth, element.naturalHeight);
    if (!raw) {
      redraw();
      return;
    }
    const grid = gridRef.current;
    const snapped =
      grid && grid.data.length >= grid.width * grid.height * 4
        ? smartSnapBox(
            { width: grid.width, height: grid.height, data: grid.data },
            raw,
          )
        : null;
    const box = snapped ?? raw;
    setSelection(box);
    buildPreview(box);
  }, [buildPreview, redraw, setSelection]);

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
    setSelection(null);
    setPreview(null);
    redraw();
  }, [redraw, setSelection]);
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

        {/* Pre-submit preview — the exact tensor Step 1 will evaluate */}
        <div className="rounded-2xl bg-emerald-50/70 p-2.5 ring-1 ring-emerald-100">
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-black text-emerald-800">
            <Scissors size={12} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-600" />
            {copy.previewTitle}
          </p>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- local data-URL preview of the isolated crop
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
            disabled={!selection && !preview}
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
