"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, FlaskConical, Sprout, TrendingUp, type LucideIcon } from "lucide-react";
import { useRef } from "react";
import type { AuthRole } from "@/lib/auth/types";
import type { FlowController } from "./useAuthFlow";
import { EASE_OUT, FOCUS_RING, GPU, GhostButton, PrimaryButton, SPRING } from "./ui";

const ROLE_ICONS: Record<AuthRole, LucideIcon> = {
  farmer: Sprout,
  agronomist: FlaskConical,
  investor: TrendingUp,
};

const ROLE_ORDER: AuthRole[] = ["farmer", "agronomist", "investor"];

/**
 * Step 2 — who is using the platform.
 * Stacked radio cards (not a 3-up grid): each row expands with its perks once
 * selected, so the choice reads as a decision, not a menu.
 */
export default function RoleStep({ flow }: { flow: FlowController }) {
  const { t, lang } = flow;
  const rtl = lang === "ar";
  const refs = useRef<Record<AuthRole, HTMLButtonElement | null>>({
    farmer: null,
    agronomist: null,
    investor: null,
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, role: AuthRole) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = ROLE_ORDER[(ROLE_ORDER.indexOf(role) + step + ROLE_ORDER.length) % ROLE_ORDER.length];
    flow.handleRoleSelect(next);
    refs.current[next]?.focus();
  };

  return (
    <section aria-labelledby="role-title" className="flex flex-col gap-3.5">
      <header className="text-center">
        <h1 id="role-title" className="text-[20px] font-black leading-tight text-emerald-950">
          {t.role.title}
        </h1>
        <p className="mx-auto mt-1 max-w-[38ch] text-[12.5px] font-semibold leading-6 text-emerald-900/75">
          {t.role.subtitle}
        </p>
      </header>

      <div role="radiogroup" aria-labelledby="role-title" className="flex flex-col gap-2.5">
        {ROLE_ORDER.map((id) => {
          const copy = t.role.options[id];
          const Icon = ROLE_ICONS[id];
          const selected = flow.role === id;
          return (
            <motion.button
              key={id}
              ref={(el) => {
                refs.current[id] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (!flow.role && id === "farmer") ? 0 : -1}
              onClick={() => flow.handleRoleSelect(id)}
              onKeyDown={(e) => onKeyDown(e, id)}
              whileTap={{ scale: 0.985 }}
              animate={{ borderColor: selected ? "#10b981" : "rgba(226,241,232,1)" }}
              transition={SPRING}
              className={`glass-card relative overflow-hidden rounded-3xl border p-3 text-start ${FOCUS_RING} ${
                selected
                  ? "shadow-[0_12px_30px_-18px_rgba(16,185,129,0.9)] ring-1 ring-emerald-400/60"
                  : "hover:border-emerald-300"
              }`}
            >
              {selected && (
                <motion.span
                  aria-hidden
                  layoutId={`role-glow-${id}`}
                  className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-50/80 via-white/0 to-emerald-100/60"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                />
              )}

              <div className="relative flex items-start gap-3">
                <span
                  aria-hidden
                  className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl shadow-sm transition-colors ${
                    selected
                      ? "bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 text-white"
                      : "border border-emerald-100 bg-white text-emerald-700"
                  }`}
                >
                  <Icon size={19} strokeWidth={2.3} />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="block text-[14.5px] font-black leading-6 text-emerald-950">
                      {copy.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="rounded-full border border-emerald-200/70 bg-white/80 px-2 py-[3px] text-[9.5px] font-black text-emerald-700">
                        {copy.tag}
                      </span>
                      <span
                        aria-hidden
                        className={`grid h-5 w-5 place-items-center rounded-full border transition-colors ${
                          selected
                            ? "border-emerald-500 bg-emerald-500 text-white"
                            : "border-emerald-900/20 bg-white text-transparent"
                        }`}
                      >
                        <Check size={12} strokeWidth={3.4} />
                      </span>
                    </span>
                  </span>

                  <span className="mt-0.5 block text-[11.5px] font-semibold leading-5 text-emerald-900/70">
                    {copy.description}
                  </span>

                  <AnimatePresence initial={false}>
                    {selected && (
                      <motion.span
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.24, ease: EASE_OUT }}
                        className={`mt-1.5 flex flex-col gap-1 overflow-hidden ${GPU}`}
                      >
                        {copy.perks.map((perk) => (
                          <span key={perk} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-800">
                            <Check size={11} strokeWidth={3.4} aria-hidden className="text-emerald-500" />
                            {perk}
                          </span>
                        ))}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              </div>
            </motion.button>
          );
        })}
      </div>

      <p className="text-center text-[10.5px] font-semibold text-emerald-900/60">{t.role.hint}</p>

      <div className="flex items-center gap-2">
        <GhostButton
          onClick={() => flow.goToStep("method")}
          block={false}
          className="h-12 shrink-0 px-4"
          icon={
            rtl ? <ArrowRight size={17} strokeWidth={2.6} aria-hidden /> : <ArrowLeft size={17} strokeWidth={2.6} aria-hidden />
          }
          aria-label={t.role.back}
        >
          <span className="hidden min-[380px]:inline">{t.role.back}</span>
        </GhostButton>
        <PrimaryButton
          onClick={flow.handleRoleConfirm}
          disabled={!flow.role}
          icon={
            rtl ? <ArrowLeft size={17} strokeWidth={2.8} aria-hidden /> : <ArrowRight size={17} strokeWidth={2.8} aria-hidden />
          }
        >
          {t.role.confirm}
        </PrimaryButton>
      </div>
    </section>
  );
}
