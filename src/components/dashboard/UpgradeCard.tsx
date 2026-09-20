"use client";

import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Sparkles } from "lucide-react";
import Link from "next/link";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { Lang } from "@/lib/wilayas";
import { EASE_OUT, FOCUS_RING, GPU, PrimaryButton } from "@/components/auth/ui";
import { Card } from "./parts";

/** Guest → account conversion card. The CTA is a real route, not a modal. */
export default function UpgradeCard({ t, lang }: { t: DashboardCopy; lang: Lang }) {
  const rtl = lang === "ar";
  return (
    <Card
      title={t.upgrade.title}
      subtitle={t.upgrade.subtitle}
      className="border-emerald-300/70 bg-gradient-to-br from-white/90 via-emerald-50/80 to-white/90"
      icon={<Sparkles size={17} strokeWidth={2.4} aria-hidden />}
    >
      <ul className="flex flex-col gap-1.5">
        {t.upgrade.benefits.map((benefit, i) => (
          <motion.li
            key={benefit}
            initial={{ opacity: 0, x: rtl ? 8 : -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.06, duration: 0.3, ease: EASE_OUT }}
            className={`${GPU} flex items-start gap-2 text-[11.5px] font-bold leading-5 text-emerald-900/85`}
          >
            <span
              aria-hidden
              className="mt-[2px] grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-500 text-white"
            >
              <Check size={10} strokeWidth={3.6} />
            </span>
            {benefit}
          </motion.li>
        ))}
      </ul>

      <div className="mt-3.5 flex flex-col gap-2">
        <Link href="/register" className="block">
          <PrimaryButton
            block
            icon={rtl ? <ArrowLeft size={17} strokeWidth={2.8} aria-hidden /> : <ArrowRight size={17} strokeWidth={2.8} aria-hidden />}
          >
            {t.upgrade.cta}
          </PrimaryButton>
        </Link>

        <Link
          href="/login"
          className={`glass inline-flex h-11 items-center justify-center rounded-2xl text-[13px] font-extrabold text-emerald-900 transition-colors hover:bg-white/95 ${FOCUS_RING}`}
        >
          {t.upgrade.signIn}
        </Link>

        <p className="text-center text-[10.5px] font-semibold text-emerald-900/60">{t.upgrade.note}</p>
      </div>
    </Card>
  );
}
