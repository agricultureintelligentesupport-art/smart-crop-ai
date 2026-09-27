"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Bot, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { EASE_OUT, GPU, SPRING } from "@/components/auth/ui";

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
      <Bot size={Math.round(size * 0.53)} strokeWidth={2.5} />
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
          <motion.span
            animate={reduce ? undefined : { rotate: [0, 12, -8, 0], scale: [1, 1.08, 1] }}
            transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut", repeatDelay: 1.4 }}
            className="grid"
          >
            <Sparkles size={26} strokeWidth={2.2} aria-hidden />
          </motion.span>
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
