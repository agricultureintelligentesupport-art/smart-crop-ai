"use client";

import { AnimatePresence, motion, useDragControls, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { FOCUS_RING } from "@/components/auth/ui";
import { APP_SHELL } from "@/lib/app/copy";
import type { Lang } from "@/lib/wilayas";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet: the app's modal surface for contextual tasks (account,
 * personalisation). Rises from the bottom edge, drags down to dismiss, keeps
 * focus inside while open and hands it back on close.
 *
 * Only the grabber + header start the drag, so the body keeps native
 * momentum scrolling.
 */
export default function Sheet({
  open,
  onClose,
  title,
  subtitle,
  lang,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  lang: Lang;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const controls = useDragControls();
  const reduce = useReducedMotion();
  const t = APP_SHELL[lang];

  // Remember what had focus, move focus into the sheet, hand it back on close.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const id = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(id);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        // A nested popover (e.g. the wilaya picker) owns Escape while it is
        // open — close the sheet only when nothing is layered on top of it.
        if (event.target instanceof Element && event.target.closest("[data-nested-popover]")) return;
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const nodes = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50" role="presentation">
          <motion.div
            aria-hidden
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-emerald-950/35 backdrop-blur-[3px]"
          />

          <motion.section
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            initial={{ y: "104%" }}
            animate={{ y: 0 }}
            exit={{ y: "104%" }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 340, damping: 36, mass: 0.9 }}
            drag="y"
            dragListener={false}
            dragControls={controls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 850) onClose();
            }}
            onKeyDown={onKeyDown}
            className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[88dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-[1.75rem] bg-white shadow-[0_-20px_60px_-30px_rgba(6,78,59,0.6)] outline-none"
          >
            <div
              onPointerDown={(event) => controls.start(event)}
              className="flex cursor-grab touch-none flex-col items-center pt-2.5 active:cursor-grabbing"
            >
              <span aria-hidden className="h-1.5 w-11 rounded-full bg-emerald-900/15" />
            </div>

            <header className="flex items-start gap-2 px-4 pt-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-[17px] font-black leading-6 text-emerald-950">{title}</h2>
                {subtitle && (
                  <p className="mt-0.5 text-[12px] font-semibold leading-5 text-emerald-900/60">{subtitle}</p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t.actions.close}
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#f6faf7] text-emerald-800 transition-colors hover:bg-emerald-50 ${FOCUS_RING}`}
              >
                <X size={17} strokeWidth={2.6} aria-hidden />
              </button>
            </header>

            <div className="scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))] pt-3.5">
              {children}
            </div>
          </motion.section>
        </div>
      )}
    </AnimatePresence>
  );
}
