"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Microscope, ShieldCheck, TriangleAlert } from "lucide-react";
import { EASE_OUT } from "@/components/auth/ui";
import type { AssistantCopy } from "@/lib/assistant/copy";
import { confidenceBucket, parsePlantLabel } from "@/lib/assistant/plantvillage";
import type { AssistantDiagnosis } from "@/lib/assistant/types";

/**
 * Open editorial card for the PlantVillage vision verdict: prominent headline
 * for the disease name, dedicated visual treatment for the confidence metric
 * with a red → yellow → green spectrum meter, runner-up chips, and a subtle
 * model label.
 */
export default function DiagnosisCard({
  diagnosis,
  copy,
}: {
  diagnosis: AssistantDiagnosis;
  copy: AssistantCopy["diagnosis"];
}) {
  const pct = Math.max(0, Math.min(100, Math.round(diagnosis.confidence * 100)));
  const bucket = confidenceBucket(diagnosis.confidence);
  const bucketLabel =
    bucket === "high" ? copy.confidenceHigh : bucket === "medium" ? copy.confidenceMedium : copy.confidenceLow;
  const alternates = diagnosis.candidates.slice(1);
  const reduce = useReducedMotion();

  return (
    <div className="space-y-3.5 py-1 text-emerald-950">
      {/* 1. Category Eyebrow Badge */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100/70 px-2.5 py-0.5 text-[11px] font-black tracking-wide text-emerald-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ring-1 ring-emerald-300/50">
          {diagnosis.healthy ? (
            <ShieldCheck size={12} strokeWidth={2.8} className="text-emerald-700" aria-hidden />
          ) : (
            <Microscope size={12} strokeWidth={2.8} className="text-emerald-800" aria-hidden />
          )}
          <span>{copy.title}</span>
        </span>
      </div>

      {/* 2. Headline: Disease Name (Distinct, prominent typography — NOT in a flat box) */}
      <div className="relative">
        <h3 className="text-[21px] sm:text-[23px] font-black leading-tight tracking-tight text-emerald-950 [text-shadow:0_1px_2px_rgba(6,78,59,0.12)]">
          {diagnosis.healthy ? (
            <span className="inline-flex items-center gap-2">
              <span>{copy.healthy}</span>
              <span className="text-xl">✅</span>
            </span>
          ) : (
            <span>{diagnosis.labelAr}</span>
          )}
        </h3>
        {/* Subtle accent underline */}
        <div
          aria-hidden
          className="mt-2 h-[3px] w-14 rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-transparent shadow-[0_1px_4px_rgba(16,185,129,0.3)]"
        />
      </div>

      {/* 3. Confidence Section: Distinct visual treatment separated from headline */}
      <div className="rounded-2xl border border-emerald-900/10 bg-white/85 p-3.5 shadow-[0_4px_14px_-4px_rgba(6,78,59,0.07)] backdrop-blur-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11.5px] font-bold text-emerald-900/70">{copy.confidence}</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-950/[0.04] px-2.5 py-0.5 text-[11px] font-black text-emerald-950">
            {bucket === "low" && (
              <TriangleAlert size={12} strokeWidth={2.8} className="text-amber-500" aria-hidden />
            )}
            <span className="font-mono text-[12px]">{pct}%</span>
            <span className="text-emerald-900/30">·</span>
            <span
              className={`font-bold ${
                bucket === "high"
                  ? "text-emerald-700"
                  : bucket === "medium"
                    ? "text-amber-700"
                    : "text-rose-600"
              }`}
            >
              {bucketLabel}
            </span>
          </span>
        </div>

        {/* Confidence Meter Bar: Red → Yellow → Green spectrum that fills & stops at pct% */}
        <div
          dir="ltr"
          role="meter"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={copy.confidence}
          className="@container relative h-2.5 w-full overflow-hidden rounded-full bg-emerald-950/10 shadow-[inset_0_1px_2px_rgba(6,78,59,0.14)]"
        >
          <motion.div
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.2 }}
            className="relative h-full overflow-hidden rounded-full shadow-[0_0_10px_rgba(16,185,129,0.3)]"
          >
            <div
              className="absolute inset-y-0 left-0 h-full w-[100cqw] min-w-full rounded-full"
              style={{
                width: pct > 0 ? `${(100 / pct) * 100}%` : "100%",
                background: "linear-gradient(90deg, #ef4444 0%, #f59e0b 45%, #10b981 80%, #059669 100%)",
              }}
            />
          </motion.div>
        </div>
      </div>

      {/* 4. Alternative Candidates (if any) */}
      {alternates.length > 0 && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-[10.5px] font-bold text-emerald-900/60">{copy.alternatives}</p>
          <div className="flex flex-wrap gap-1.5">
            {alternates.map((c, i) => (
              <motion.span
                key={c.label}
                initial={reduce ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + i * 0.05, duration: 0.28, ease: EASE_OUT }}
                className="inline-flex items-center rounded-full bg-emerald-50/90 px-2.5 py-0.5 text-[10.5px] font-bold text-emerald-800 shadow-[0_1px_2px_rgba(6,78,59,0.05)] ring-1 ring-emerald-200/60"
              >
                {parsePlantLabel(c.label).labelAr} · {Math.round(c.score * 100)}%
              </motion.span>
            ))}
          </div>
        </div>
      )}

      {/* 5. Classification Model Caption: Subtle, delicate label */}
      <div dir="ltr" className="flex items-center gap-1.5 pt-0.5 text-[9.5px] font-medium tracking-wide text-emerald-900/45">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/60" aria-hidden />
        <span>{copy.model}:</span>
        <span className="font-mono font-semibold text-emerald-900/70">{diagnosis.model.split("/").pop()}</span>
      </div>
    </div>
  );
}
