"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Droplets, ScanLine, SquareCheckBig } from "lucide-react";
import { FOCUS_RING, SPRING } from "@/components/auth/ui";
import type { DashboardCopy } from "@/lib/dashboard/copy";

export type QuickTarget = "scan" | "irrigation" | "tasks";

/**
 * Thumb-zone quick actions: three tiles that scroll straight to the part of
 * the screen each one is about. Pure presentation — no logic, no data — they
 * just save the user a long scroll on a phone.
 */
export default function QuickActions({
  t,
  onJump,
}: {
  t: DashboardCopy;
  onJump: (target: QuickTarget) => void;
}) {
  const reduce = useReducedMotion();
  const actions: { id: QuickTarget; label: string; icon: typeof Droplets }[] = [
    { id: "scan", label: t.quick.scan, icon: ScanLine },
    { id: "irrigation", label: t.quick.irrigation, icon: Droplets },
    { id: "tasks", label: t.quick.tasks, icon: SquareCheckBig },
  ];

  return (
    <section aria-label={t.quick.title} className="flex flex-col gap-2">
      <h2 className="px-1 text-[12px] font-black tracking-wide text-emerald-800/65">{t.quick.title}</h2>
      <ul className="grid grid-cols-3 gap-2">
        {actions.map((action, index) => {
          const Icon = action.icon;
          return (
            <li key={action.id} className="min-w-0">
              <motion.button
                type="button"
                onClick={() => onJump(action.id)}
                aria-label={t.quick.goTo.replace("{target}", action.label)}
                initial={reduce ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...SPRING, delay: reduce ? 0 : 0.04 * index }}
                whileTap={reduce ? undefined : { scale: 0.96 }}
                className={`app-surface flex h-[4.6rem] w-full flex-col items-center justify-center gap-1.5 px-1.5 transition-colors hover:border-emerald-300/70 ${FOCUS_RING}`}
              >
                <span
                  aria-hidden
                  className="grid h-9 w-9 place-items-center rounded-[0.8rem] bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100"
                >
                  <Icon size={17} strokeWidth={2.5} />
                </span>
                <span className="text-center text-[10.5px] font-black leading-tight text-emerald-900">
                  {action.label}
                </span>
              </motion.button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
