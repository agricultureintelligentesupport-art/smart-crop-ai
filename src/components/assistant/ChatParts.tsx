"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { EASE_OUT, GPU, SPRING } from "@/components/auth/ui";

/**
 * Custom PhytoScan AI brand mark: a botanical P monogram with a leaf-shaped
 * counter and a quietly animated central vein.
 */
export function PhytoScanLogo({
  size = 20,
  strokeWidth = 2.2,
  className = "",
}: {
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <style>{`
        .phyto-logo__vein {
          stroke-dasharray: 7.2;
          stroke-dashoffset: 7.2;
          opacity: 0.18;
          animation: phyto-logo-vein-draw 4.2s ease-in-out infinite;
        }

        .phyto-logo__glint {
          opacity: 0;
          animation: phyto-logo-glint 5.8s ease-in-out infinite;
        }

        @keyframes phyto-logo-vein-draw {
          0%, 32%, 100% {
            stroke-dashoffset: 7.2;
            opacity: 0.18;
          }
          12%, 21% {
            stroke-dashoffset: 0;
            opacity: 0.96;
          }
        }

        @keyframes phyto-logo-glint {
          0%, 64%, 100% { opacity: 0; }
          70% { opacity: 0.95; }
          74% { opacity: 0.35; }
          78% { opacity: 0; }
        }

        @media (prefers-reduced-motion: reduce) {
          .phyto-logo__vein {
            animation: none !important;
            stroke-dashoffset: 0;
            opacity: 0.9;
          }

          .phyto-logo__glint {
            animation: none !important;
            opacity: 0.8;
          }
        }
      `}</style>
      {/* The outer P-shaped stroke keeps the monogram bold at small sizes. */}
      <path d="M5.5 20.5V5.4a2.1 2.1 0 0 1 2.1-2.1h5.1c3.8 0 5.9 1.85 5.9 4.8s-2.1 4.8-5.9 4.8H5.5" />
      {/* Soft leaf silhouette in the counter; the animated stroke is its vein. */}
      <path
        d="M8.45 10.55C9.65 7.9 11.85 6.6 15.2 6.4c-.15 2.95-1.6 5-4 5.65-1.1.3-2.2-.18-2.75-1.2Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeOpacity="0.72"
        strokeWidth={Math.max(1, strokeWidth * 0.58)}
      />
      <path
        className="phyto-logo__vein"
        d="M9.1 10.8c1.5-1.6 3.35-3.05 5.45-3.95"
        fill="none"
        stroke="currentColor"
        strokeWidth={Math.max(1.05, strokeWidth * 0.56)}
        strokeDasharray={7.2}
        strokeDashoffset={7.2}
      />
      {/* A restrained four-point sparkle, kept tiny in the header mark. */}
      <path
        className="phyto-logo__glint"
        d="M18.1 2.25c.12.7.34.92 1.04 1.04-.7.12-.92.34-1.04 1.04-.12-.7-.34-.92-1.04-1.04.7-.12.92-.34 1.04-1.04Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/**
 * Presentation-only building blocks for the assistant chat screen.
 * Every component here is stateless: it renders whatever the view already
 * knows (labels, flags) and never touches data flow or requests.
 */

/* ------------------------------------------------------------------ */
/*  Motion tokens shared by the chat screen                            */
/* ------------------------------------------------------------------ */

/** Slightly snappier spring for small elements (icons, chips, thumbnails). */
export const POP = { type: "spring", stiffness: 420, damping: 30, mass: 0.7 } as const;

/** Bubble entrance: rises from its own anchored corner. */
export const bubbleVariants = {
  hidden: { opacity: 0, y: 14, scale: 0.96 },
  show: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.16 } },
} as const;

/* ------------------------------------------------------------------ */
/*  Avatar orb                                                         */
/* ------------------------------------------------------------------ */

export function AssistantAvatar({ live = false, size = 30 }: { live?: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      className={`chat-avatar ${live ? "chat-avatar-live" : ""} relative grid shrink-0 place-items-center rounded-full text-white`}
      style={{ width: size, height: size }}
    >
      <PhytoScanLogo size={Math.round(size * 0.58)} strokeWidth={2.3} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Thinking indicator                                                 */
/* ------------------------------------------------------------------ */

/**
 * Three breathing dots + a shimmering phase label. The label cross-fades
 * whenever the caller passes a new string (detection → classification).
 */
export function TypingIndicator({ label }: { label: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.16 } }}
      transition={reduce ? { duration: 0 } : SPRING}
      className={`${GPU} flex items-end gap-2.5 origin-bottom-left rtl:origin-bottom-right`}
    >
      <AssistantAvatar live />
      <div className="chat-bubble-assistant flex items-center gap-3 px-4 py-3">
        <span className="flex items-center gap-1" aria-hidden>
          <span className="chat-dot" />
          <span className="chat-dot" />
          <span className="chat-dot" />
        </span>
        <span className="relative block min-h-[1.25rem] overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
              className="chat-shimmer block text-[12px] font-bold leading-5"
            >
              {label}
            </motion.span>
          </AnimatePresence>
        </span>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty-state hero                                                   */
/* ------------------------------------------------------------------ */

export function EmptyHero({ greeting, intro }: { greeting: ReactNode; intro: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reduce ? { duration: 0 } : { duration: 0.55, ease: EASE_OUT }}
      className={`chat-bubble-assistant ${GPU} relative mt-6 overflow-hidden !rounded-[1.75rem] p-6 sm:mt-10 sm:p-7`}
    >
      {/* Soft mesh wash, mirrored automatically by the gradient's start side */}
      <span
        aria-hidden
        className="pointer-events-none absolute -top-24 -end-24 h-56 w-56 rounded-full bg-emerald-300/25 blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -start-16 h-48 w-48 rounded-full bg-amber-200/30 blur-3xl"
      />

      <div className="relative mb-4 inline-grid place-items-center">
        <span aria-hidden className="chat-orb-ring" />
        <span className="chat-orb grid h-16 w-16 place-items-center rounded-full text-white">
          <span className="grid">
            <PhytoScanLogo size={30} strokeWidth={2.2} aria-hidden />
          </span>
        </span>
      </div>

      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12, duration: 0.45, ease: EASE_OUT }}
        className="relative text-[21px] font-black leading-8 tracking-tight text-emerald-950"
      >
        {greeting}
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.45, ease: EASE_OUT }}
        className="relative mt-2 max-w-[54ch] text-[13.5px] font-semibold leading-6 text-emerald-900/65"
      >
        {intro}
      </motion.p>
    </motion.section>
  );
}
