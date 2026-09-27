"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useId, type ReactNode } from "react";
import { EASE_OUT, GPU, SPRING } from "@/components/auth/ui";

/**
 * PhytoScanLogo — Direction A: Solid Specimen Chip
 *
 * Single cohesive mark: soft teardrop/rounded leaf tilted ~45°,
 * one curved vein as negative-space cutout, subtle radial gradient
 * + hairline inner top highlight. No strokes, no brackets.
 *
 * Animation: gentle breathing scale + slow shimmer along vein.
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
  // Stable unique ids for gradients/masks when multiple logos render on same page
  const reactId = useId();
  const uid = reactId.replace(/[^a-zA-Z0-9]+/g, "");
  // strokeWidth kept for API compatibility (header/avatar/hero pass it) — visual is fill-only now
  void strokeWidth;

  const gradId = `phyto-grad-${uid}`;
  const maskId = `phyto-mask-${uid}`;
  const clipId = `phyto-clip-${uid}`;

  // Vertical soft teardrop — later rotated ~38° for the 45° tilt
  const leafD = "M12 2.7 C 15.05 4.9 19.1 10.05 12 21.5 C 4.9 10.05 8.95 4.9 12 2.7 Z";
  // Thin spindle following the leaf's central curve, slightly S-curved — becomes the negative cutout
  const veinShapeD =
    "M12 5.1 C 12.68 8.15 13.08 12.35 12.18 17.55 C 11.68 12.55 11.42 8.35 12 5.1 Z";
  // Centerline for the traveling shimmer, inside the cutout
  const veinCenterD = "M12 5.4 C 12.55 9.2 12.85 12.9 12.18 17.3";
  // Hairline highlight hugging the top edge inside the leaf
  const highlightD = "M10.55 5.15 Q 12 3.55 13.45 5.15";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      role="img"
    >
      <defs>
        {/* Lighter center, slightly darker edge — gives embossed chip depth while staying white at 17px */}
        <radialGradient id={gradId} cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="62%" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="100%" stopColor="#E8F6EC" stopOpacity="0.98" />
        </radialGradient>
        {/* Vein as negative space: white = keep leaf, black = cut hole */}
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect x="0" y="0" width="24" height="24" fill="white" />
          <path d={veinShapeD} fill="black" />
        </mask>
        <clipPath id={clipId}>
          <path d={veinShapeD} />
        </clipPath>
      </defs>

      {/* Lightweight CSS — only inside this mark */}
      <style>{`
        @keyframes phytoChipBreathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        @keyframes phytoChipShimmer {
          0% { stroke-dashoffset: 1; opacity: 0; }
          12% { opacity: 1; }
          88% { opacity: 1; }
          100% { stroke-dashoffset: -1; opacity: 0; }
        }
        .phyto-chip-breathe {
          transform-origin: 12px 12px;
          transform-box: fill-box;
          animation: phytoChipBreathe 3s ease-in-out infinite;
        }
        .phyto-chip-shimmer {
          stroke-dasharray: 0.22 0.78;
          stroke-dashoffset: 0;
          animation: phytoChipShimmer 2.35s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .phyto-chip-breathe,
          .phyto-chip-shimmer {
            animation: none !important;
          }
        }
      `}</style>

      {/* Tilt ~38° for the requested 45° feel, keeps mark compact */}
      <g transform="rotate(38 12 12)">
        <g className="phyto-chip-breathe">
          {/* Solid leaf chip with vein cutout */}
          <path d={leafD} fill={`url(#${gradId})`} mask={`url(#${maskId})`} />

          {/* Inner top hairline highlight — subtle emboss */}
          <path
            d={highlightD}
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="0.55"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.82"
          />

          {/* Shimmer traveling inside the vein gap — clipped to vein shape */}
          <g clipPath={`url(#${clipId})`}>
            <path
              d={veinCenterD}
              pathLength={1}
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="0.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity="0.96"
              className="phyto-chip-shimmer"
            />
          </g>
        </g>
      </g>
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
