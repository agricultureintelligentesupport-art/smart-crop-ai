"use client";

import { motion, useReducedMotion } from "framer-motion";
import { SHELL_COLUMN } from "@/components/app/shell";
import { AssistantAvatar } from "./ChatParts";

/**
 * Loading placeholder shown while the conversation is being restored —
 * shimmer bubbles in the SAME RTL layout the real conversation uses, so
 * nothing shifts once the real messages replace it. Purely presentational:
 * it owns no data, no timers, no persistence.
 */
export default function HistorySkeleton({ label }: { label: string }) {
  const reduce = useReducedMotion();
  const rows: Array<{ assistant: boolean; width: string }> = [
    { assistant: false, width: "62%" },
    { assistant: true, width: "78%" },
    { assistant: true, width: "48%" },
    { assistant: false, width: "40%" },
  ];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`${SHELL_COLUMN} flex flex-col gap-4 px-4 pb-12 pt-3`}
    >
      {rows.map((row, index) => (
        <div
          key={index}
          className={`flex items-end gap-2.5 ${row.assistant ? "justify-start" : "justify-end"}`}
        >
          {row.assistant && (
            <span className="chat-skeleton-avatar shrink-0 h-[30px] w-[30px] rounded-full" aria-hidden />
          )}
          <div
            className={`chat-skeleton-bubble ${row.assistant ? "chat-skeleton-assistant" : "chat-skeleton-user"}`}
            style={{ width: row.width, animationDelay: reduce ? undefined : `${index * 0.12}s` }}
            aria-hidden
          >
            <span className="chat-skeleton-line" style={{ width: "92%" }} />
            <span className="chat-skeleton-line" style={{ width: "64%" }} />
          </div>
        </div>
      ))}

      <motion.div
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.3 }}
        className="mt-1 flex items-center justify-center gap-2 text-[11.5px] font-bold text-emerald-900/50"
      >
        <AssistantAvatar size={20} />
        <span>{label}</span>
      </motion.div>
    </div>
  );
}
