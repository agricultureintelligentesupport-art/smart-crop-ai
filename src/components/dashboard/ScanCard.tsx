"use client";

import { motion } from "framer-motion";
import { Camera, CircleCheck, ImageUp, Microscope, ScanLine, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { diagnoseImage, type Diagnosis } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { GPU, PrimaryButton } from "@/components/auth/ui";
import { Card, Chip, Progress } from "./parts";

interface PickedFile {
  name: string;
  size: number;
  url: string;
}

/**
 * On-device leaf scan. Real interaction (file picker, drag & drop, preview,
 * progress, reset) with a deterministic demo classifier standing in for the
 * trained model — the UI labels that honestly instead of faking a backend.
 */
export default function ScanCard({ t, wilayaCode }: { t: DashboardCopy; wilayaCode: string }) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [analysis, setAnalysis] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const timer = useRef<number | null>(null);

  const url = file?.url;
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [url]);

  const pick = (input: File | null | undefined) => {
    if (!input || !input.type.startsWith("image/")) return;
    if (file) URL.revokeObjectURL(file.url);
    setAnalysis(null);
    setFile({ name: input.name, size: input.size, url: URL.createObjectURL(input) });
  };

  const analyze = () => {
    if (!file) return;
    setBusy(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setAnalysis(diagnoseImage({ name: file.name, size: file.size }, wilayaCode));
      setBusy(false);
    }, 900);
  };

  const reset = () => {
    if (file) URL.revokeObjectURL(file.url);
    setFile(null);
    setAnalysis(null);
  };

  const severityIndex = analysis ? Math.min(3, Math.round(analysis.severity * 3)) : 0;
  const copy = analysis ? t.diagnoses[analysis.key] : null;

  return (
    <Card
      title={t.scan.title}
      subtitle={t.scan.subtitle}
      icon={<ScanLine size={17} strokeWidth={2.4} aria-hidden />}
      aside={
        analysis ? (
          <Chip tone={analysis.key === "healthy" ? "emerald" : "amber"}>
            {Math.round(analysis.confidence * 100)}%
          </Chip>
        ) : undefined
      }
    >
      {!file ? (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files?.[0]);
          }}
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-3xl border-2 border-dashed px-4 py-7 text-center transition-colors ${
            dragging ? "border-emerald-400 bg-emerald-50/80" : "border-emerald-300/70 bg-white/60 hover:border-emerald-400"
          }`}
        >
          <span
            aria-hidden
            className="relative grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 text-white shadow-[0_10px_26px_-12px_rgba(16,185,129,0.85)]"
          >
            <motion.span
              className="absolute inset-0 rounded-2xl border border-emerald-400/60"
              animate={{ scale: [1, 1.5], opacity: [0.55, 0] }}
              transition={{ duration: 1.9, repeat: Infinity, ease: "easeOut" }}
            />
            <motion.span
              className="absolute inset-0 rounded-2xl border border-emerald-400/40"
              animate={{ scale: [1, 1.5], opacity: [0.4, 0] }}
              transition={{ duration: 1.9, repeat: Infinity, ease: "easeOut", delay: 0.9 }}
            />
            <ImageUp size={22} strokeWidth={2.3} />
          </span>
          <span className="text-[13px] font-black text-emerald-950">{t.scan.pick}</span>
          <span className="text-[10.5px] font-semibold text-emerald-900/60">{t.scan.pickHint}</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] font-bold text-emerald-700">
            <Camera size={12} strokeWidth={2.6} aria-hidden />
            {t.scan.pickHint}
          </span>
        </label>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative overflow-hidden rounded-3xl ring-1 ring-[#E2F1E8]">
            {/* Local object URL preview: plain <img> is correct here, next/image cannot optimise blobs. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={file.url} alt={file.name} className="h-44 w-full object-cover" />
            {busy && (
              <>
                <motion.div
                  aria-hidden
                  className={`absolute inset-0 bg-gradient-to-b from-emerald-500/10 via-emerald-400/25 to-emerald-500/10 ${GPU}`}
                  animate={{ opacity: [0.35, 0.85, 0.35] }}
                  transition={{ duration: 1.4, repeat: Infinity }}
                />
                {/* Radar scanner: a luminous line sweeps the leaf top-to-bottom */}
                <motion.div
                  aria-hidden
                  className={`absolute inset-x-2 h-10 rounded-full bg-gradient-to-b from-transparent via-emerald-200/70 to-transparent ${GPU}`}
                  animate={{ y: [-44, 190] }}
                  transition={{ duration: 1.25, repeat: Infinity, ease: "linear" }}
                />
              </>
            )}
          </div>

          {!analysis ? (
            <PrimaryButton
              onClick={analyze}
              loading={busy}
              loadingLabel={t.scan.analyzing}
              icon={<Sparkles size={17} strokeWidth={2.6} aria-hidden />}
            >
              {t.scan.title}
            </PrimaryButton>
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className={`${GPU} flex flex-col gap-3`}
            >
              <div className="rounded-3xl border border-emerald-200/70 bg-emerald-50/60 p-3">
                <p className="text-[10.5px] font-black tracking-wide text-emerald-800">{t.scan.result}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[15px] font-black text-emerald-950">
                  {analysis.key === "healthy" ? (
                    <CircleCheck size={16} strokeWidth={2.8} aria-hidden className="text-emerald-600" />
                  ) : (
                    <Microscope size={16} strokeWidth={2.6} aria-hidden className="text-amber-600" />
                  )}
                  {copy?.name}
                </p>
                <p className="mt-1 text-[11px] font-semibold leading-5 text-emerald-900/75">{copy?.summary}</p>

                <div className="mt-2.5 flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[10.5px] font-bold text-emerald-800">
                    <span>{t.scan.confidence}</span>
                    <span dir="ltr">{Math.round(analysis.confidence * 100)}%</span>
                  </div>
                  <Progress value={analysis.confidence * 100} />
                </div>

                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <span className="text-[10.5px] font-bold text-emerald-800">{t.scan.severity}</span>
                  <Chip tone={severityIndex >= 2 ? "amber" : "emerald"}>{t.scan.severityLabels[severityIndex]}</Chip>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-black text-emerald-800">{t.scan.treatment}</p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {copy?.steps.map((step, i) => (
                    <li
                      key={step}
                      className="flex items-start gap-2 rounded-2xl bg-white/70 px-2.5 py-2 text-[11.5px] font-semibold leading-5 text-emerald-900 ring-1 ring-[#E2F1E8]"
                    >
                      <span
                        aria-hidden
                        className="mt-[1px] grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-500 text-[9px] font-black text-white"
                      >
                        {i + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ul>
              </div>

              <button
                type="button"
                onClick={reset}
                className="mx-auto inline-flex items-center gap-1.5 rounded-2xl px-3 py-2 text-[11.5px] font-extrabold text-emerald-800 transition-all duration-150 hover:bg-white/70 active:scale-95"
              >
                <Camera size={13} strokeWidth={2.6} aria-hidden />
                {t.scan.retake}
              </button>
            </motion.div>
          )}
        </div>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-[10px] font-semibold leading-4 text-emerald-900/60">
        <ShieldCheck size={12} strokeWidth={2.6} aria-hidden className="mt-[2px] shrink-0 text-emerald-500" />
        {t.scan.privacy} {t.scan.engineNote}
      </p>
    </Card>
  );
}
