"use client";

import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Gauge, MapPin, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { DEFAULT_WILAYA_CODE, getWilaya, wilayaName } from "@/lib/wilayas";
import type { FlowController } from "./useAuthFlow";
import { EASE_OUT, GPU, GhostButton, PrimaryButton, SPRING } from "./ui";

/**
 * Final panel — confirms exactly what was configured, then hands the user to
 * the dashboard. Nothing here is a placeholder: every line is read back from
 * the state the flow just persisted.
 */
export default function SuccessStep({ flow }: { flow: FlowController }) {
  const { t, lang } = flow;
  const rtl = lang === "ar";
  const wilaya = getWilaya(flow.wilayaCode ?? DEFAULT_WILAYA_CODE);
  const roleLabel = flow.role ? t.role.options[flow.role].label : "—";
  const methodLabel =
    flow.user?.method === "google"
      ? "Google"
      : flow.user?.method === "phone"
        ? t.method.channelPhone
        : t.method.channelEmail;

  const rows = [
    { icon: ShieldCheck, label: t.success.summaryMethod, value: methodLabel },
    { icon: UserRound, label: t.success.summaryRole, value: roleLabel },
    { icon: MapPin, label: t.success.summaryWilaya, value: `${wilayaName(wilaya, lang)} (${wilaya.code})` },
  ];

  return (
    <section aria-labelledby="success-title" className="flex flex-col items-center gap-3.5 text-center">
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ ...SPRING, stiffness: 260 }}
        className={`glow-emerald ${GPU} grid h-16 w-16 place-items-center rounded-3xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 text-white`}
      >
        <motion.span
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.12, duration: 0.28, ease: EASE_OUT }}
        >
          <Check size={30} strokeWidth={3.4} aria-hidden />
        </motion.span>
      </motion.span>

      <header>
        <h1 id="success-title" className="text-[21px] font-black leading-tight text-emerald-950">
          {t.success.title}
        </h1>
        <p className="mx-auto mt-1 max-w-[38ch] text-[12.5px] font-semibold leading-6 text-emerald-900/75">
          {t.success.subtitle}
        </p>
      </header>

      <div className="w-full rounded-3xl border border-emerald-200/70 bg-emerald-50/50 p-3 text-start">
        <p className="text-[11px] font-black tracking-wide text-emerald-800">{t.success.summaryTitle}</p>
        <dl className="mt-2 flex flex-col gap-1.5">
          {rows.map((row, i) => (
            <motion.div
              key={row.label}
              initial={{ opacity: 0, x: rtl ? 10 : -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.16 + i * 0.07, duration: 0.3, ease: EASE_OUT }}
              className={`${GPU} flex items-center justify-between gap-3 rounded-xl bg-white/80 px-2.5 py-2`}
            >
              <dt className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-800/80">
                <row.icon size={13} strokeWidth={2.6} aria-hidden className="text-emerald-600" />
                {row.label}
              </dt>
              <dd className="truncate text-[12px] font-black text-emerald-950">{row.value}</dd>
            </motion.div>
          ))}
        </dl>
      </div>

      <ul className="w-full text-start">
        {t.success.perks.map((perk, i) => (
          <motion.li
            key={perk}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.06, duration: 0.28, ease: EASE_OUT }}
            className={`${GPU} flex items-start gap-2 py-1 text-[11.5px] font-bold text-emerald-900/85`}
          >
            {i === 0 ? (
              <Gauge size={13} strokeWidth={2.6} aria-hidden className="mt-[2px] shrink-0 text-emerald-500" />
            ) : (
              <Sparkles size={13} strokeWidth={2.6} aria-hidden className="mt-[2px] shrink-0 text-emerald-500" />
            )}
            {perk}
          </motion.li>
        ))}
      </ul>

      <div className="flex w-full flex-col gap-2">
        <PrimaryButton
          onClick={flow.handleGoToDashboard}
          icon={rtl ? <ArrowLeft size={17} strokeWidth={2.8} aria-hidden /> : <ArrowRight size={17} strokeWidth={2.8} aria-hidden />}
        >
          {t.success.cta}
        </PrimaryButton>
        <GhostButton onClick={() => flow.goToStep("role")}>{t.success.secondary}</GhostButton>
      </div>
    </section>
  );
}
