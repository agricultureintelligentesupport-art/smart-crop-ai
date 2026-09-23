"use client";

import { motion } from "framer-motion";
import { Camera, CircleCheck, ImageUp, Microscope, ScanLine, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { diagnoseImage, type Diagnosis } from "@/lib/agronomy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import { FOCUS_RING, GPU, PrimaryButton } from "@/components/auth/ui";
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
      icon={<ScanLine size={18} strokeWidth={2.4} aria-hidden />}
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
          className={`flex min-h-[11rem] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-[1.25rem] border-2 border-dashed px-4 py-7 text-center transition-colors ${
            dragging ? "border-emerald-400 bg-emerald-50" : "border-emerald-300/70 bg-[#f6faf7] hover:border-emerald-400"
          }`}
        >
          <span
            aria-hidden
            className="grid h-14 w-14 place-items-center rounded-[1.1rem] bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 text-white shadow-[0_12px_28px_-12px_rgba(16,185,129,0.9)]"
          >
            <ImageUp size={24} strokeWidth={2.3} />
          </span>
          <span className="text-[14px] font-black text-emerald-950">{t.scan.pick}</span>
          <span className="text-[11.5px] font-semibold text-emerald-900/60">{t.scan.pickHint}</span>
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
        </label>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative overflow-hidden rounded-[1.25rem] ring-1 ring-[rgba(6,78,59,0.08)]">
            {/* Local object URL preview: plain <img> is correct here, next/image cannot optimise blobs. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={file.url} alt={file.name} className="h-48 w-full object-cover" />
            {busy && (
              <motion.div
                aria-hidden
                className={`absolute inset-0 bg-gradient-to-b from-emerald-500/10 via-emerald-400/25 to-emerald-500/10 ${GPU}`}
                animate={{ opacity: [0.35, 0.85, 0.35] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
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
              <div className="rounded-[1.25rem] border border-emerald-200/70 bg-emerald-50/70 p-3.5">
                <p className="text-[11.5px] font-black tracking-wide text-emerald-800/70">{t.scan.result}</p>
                <p className="mt-1 flex items-center gap-1.5 text-[16px] font-black text-emerald-950">
                  {analysis.key === "healthy" ? (
                    <CircleCheck size={16} strokeWidth={2.8} aria-hidden className="text-emerald-600" />
                  ) : (
                    <Microscope size={16} strokeWidth={2.6} aria-hidden className="text-amber-600" />
                  )}
                  {copy?.name}
                </p>
                <p className="mt-1.5 text-[11.5px] font-semibold leading-[1.75] text-emerald-900/75">{copy?.summary}</p>

                <div className="mt-2.5 flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[11.5px] font-bold text-emerald-800/85">
                    <span>{t.scan.confidence}</span>
                    <span dir="ltr">{Math.round(analysis.confidence * 100)}%</span>
                  </div>
                  <Progress value={analysis.confidence * 100} />
                </div>

                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <span className="text-[11.5px] font-bold text-emerald-800/85">{t.scan.severity}</span>
                  <Chip tone={severityIndex >= 2 ? "amber" : "emerald"}>{t.scan.severityLabels[severityIndex]}</Chip>
                </div>
              </div>

              <div>
                <p className="text-[12px] font-black tracking-wide text-emerald-800/70">{t.scan.treatment}</p>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {copy?.steps.map((step, i) => (
                    <li
                      key={step}
                      className="flex min-h-[2.75rem] items-start gap-2.5 rounded-[1rem] bg-[#f6faf7] px-3 py-2.5 text-[12px] font-semibold leading-[1.7] text-emerald-900 ring-1 ring-[rgba(6,78,59,0.07)]"
                    >
                      <span
                        aria-hidden
                        className="mt-[2px] grid h-[1.1rem] w-[1.1rem] shrink-0 place-items-center rounded-full bg-emerald-500 text-[10px] font-black text-white"
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
                className={`mx-auto inline-flex h-11 items-center gap-1.5 rounded-full bg-[#f6faf7] px-4 text-[12.5px] font-extrabold text-emerald-800 ring-1 ring-[rgba(6,78,59,0.07)] transition-colors hover:bg-emerald-50 ${FOCUS_RING}`}
              >
                <Camera size={13} strokeWidth={2.6} aria-hidden />
                {t.scan.retake}
              </button>
            </motion.div>
          )}
        </div>
      )}

      <p className="mt-3.5 flex items-start gap-1.5 text-[10.5px] font-semibold leading-5 text-emerald-900/50">
        <ShieldCheck size={13} strokeWidth={2.6} aria-hidden className="mt-[2px] shrink-0 text-emerald-500" />
        {t.scan.privacy} {t.scan.engineNote}
      </p>
    </Card>
  );
}
