"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Microscope, ShieldCheck, TriangleAlert } from "lucide-react";
import { EASE_OUT } from "@/components/auth/ui";
import type { AssistantCopy } from "@/lib/assistant/copy";
import { confidenceBucket, parsePlantLabel } from "@/lib/assistant/plantvillage";
import type { AssistantDiagnosis } from "@/lib/assistant/types";

/**
 * Structured card for the PlantVillage vision verdict: localized disease
 * name, a confidence meter with color-coded buckets and the runner-up
 * candidates — displayed above the LLM treatment plan.
 */
export default function DiagnosisCard({
  diagnosis,
  copy,
}: {
  diagnosis: AssistantDiagnosis;
  copy: AssistantCopy["diagnosis"];
}) {
  const pct = Math.round(diagnosis.confidence * 100);
  const bucket = confidenceBucket(diagnosis.confidence);
  const bucketLabel =
    bucket === "high" ? copy.confidenceHigh : bucket === "medium" ? copy.confidenceMedium : copy.confidenceLow;
  const barColor =
    bucket === "high" ? "bg-emerald-500" : bucket === "medium" ? "bg-amber-400" : "bg-orange-500";
  const alternates = diagnosis.candidates.slice(1);
  const reduce = useReducedMotion();
  const barGlow =
    bucket === "high"
      ? "shadow-[0_0_12px_rgba(16,185,129,0.55)]"
      : bucket === "medium"
        ? "shadow-[0_0_12px_rgba(251,191,36,0.55)]"
        : "shadow-[0_0_12px_rgba(249,115,22,0.5)]";

  return (
    <div className="overflow-hidden rounded-2xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50/90 via-white to-teal-50/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
      <div className="flex items-center gap-2 border-b border-emerald-100/80 bg-white/70 px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-100 to-emerald-200/70 text-emerald-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
          {diagnosis.healthy ? (
            <ShieldCheck size={14} strokeWidth={2.6} aria-hidden />
          ) : (
            <Microscope size={14} strokeWidth={2.6} aria-hidden />
          )}
        </span>
        <p className="text-[10.5px] font-black uppercase tracking-[0.08em] text-emerald-800/75">{copy.title}</p>
      </div>

      <div className="space-y-2.5 px-3 py-2.5">
        <p className="text-[15px] font-black leading-6 tracking-tight text-emerald-950">
          {diagnosis.healthy ? `${copy.healthy} ✅` : diagnosis.labelAr}
        </p>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[10.5px] font-bold text-emerald-900/60">{copy.confidence}</span>
            <span className="inline-flex items-center gap-1 text-[11px] font-black text-emerald-900">
              {bucket === "low" && (
                <TriangleAlert size={11} strokeWidth={2.8} className="text-orange-500" aria-hidden />
              )}
              {pct}% · {bucketLabel}
            </span>
          </div>
          <div
            role="meter"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={copy.confidence}
            className="h-2 overflow-hidden rounded-full bg-emerald-900/10 shadow-[inset_0_1px_2px_rgba(6,78,59,0.12)]"
          >
            <motion.div
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.25 }}
              className={`h-full rounded-full ${barColor} ${barGlow}`}
            />
          </div>
        </div>

        {alternates.length > 0 && (
          <div>
            <p className="mb-1 text-[10.5px] font-bold text-emerald-900/60">{copy.alternatives}</p>
            <div className="flex flex-wrap gap-1.5">
              {alternates.map((c, i) => (
                <motion.span
                  key={c.label}
                  initial={reduce ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.35 + i * 0.06, duration: 0.32, ease: EASE_OUT }}
                  className="rounded-full bg-white/90 px-2.5 py-1 text-[10.5px] font-bold text-emerald-800 shadow-[0_1px_2px_rgba(6,78,59,0.05)] ring-1 ring-emerald-100"
                >
                  {parsePlantLabel(c.label).labelAr} · {Math.round(c.score * 100)}%
                </motion.span>
              ))}
            </div>
          </div>
        )}

        <p dir="ltr" className="truncate text-start text-[9.5px] font-semibold text-emerald-900/40">
          {copy.model}: {diagnosis.model.split("/").pop()}
        </p>
      </div>
    </div>
  );
}
