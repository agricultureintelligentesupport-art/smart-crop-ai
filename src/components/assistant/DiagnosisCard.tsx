"use client";

import { Microscope, ShieldCheck, TriangleAlert } from "lucide-react";
import type { AssistantCopy } from "@/lib/assistant/copy";
import { confidenceBucket, parsePlantLabel } from "@/lib/assistant/plantvillage";
import type { AssistantDiagnosis } from "@/lib/assistant/types";

/**
 * Structured card for the PlantVillage vision verdict: localized disease
 * name, a confidence meter with color-coded buckets and the runner-up
 * candidates — displayed above the Gemini treatment plan.
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

  return (
    <div className="overflow-hidden rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/90 to-teal-50/60">
      <div className="flex items-center gap-2 border-b border-emerald-100 bg-white/60 px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-xl bg-emerald-100 text-emerald-700">
          {diagnosis.healthy ? (
            <ShieldCheck size={14} strokeWidth={2.6} aria-hidden />
          ) : (
            <Microscope size={14} strokeWidth={2.6} aria-hidden />
          )}
        </span>
        <p className="text-[11px] font-black text-emerald-800/80">{copy.title}</p>
      </div>

      <div className="space-y-2.5 px-3 py-2.5">
        <p className="text-[14.5px] font-black leading-6 text-emerald-950">
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
            className="h-2 overflow-hidden rounded-full bg-emerald-900/10"
          >
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        {alternates.length > 0 && (
          <div>
            <p className="mb-1 text-[10.5px] font-bold text-emerald-900/60">{copy.alternatives}</p>
            <div className="flex flex-wrap gap-1.5">
              {alternates.map((c) => (
                <span
                  key={c.label}
                  className="rounded-full bg-white/80 px-2.5 py-1 text-[10.5px] font-bold text-emerald-800 ring-1 ring-emerald-100"
                >
                  {parsePlantLabel(c.label).labelAr} · {Math.round(c.score * 100)}%
                </span>
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
