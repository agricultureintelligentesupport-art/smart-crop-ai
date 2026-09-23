"use client";

import { ArrowLeft, ArrowRight, Check, Sprout } from "lucide-react";
import { CROPS, DEFAULT_WILAYA_CODE, getWilaya, type CropKey } from "@/lib/wilayas";
import type { FlowController } from "./useAuthFlow";
import { FOCUS_RING, GhostButton, PrimaryButton, TextField } from "./ui";

/**
 * Step 4 — farm profile (optional, skippable). Collects the preferred crop
 * (single choice from the shared `CROPS` table, with the wilaya's own crops
 * surfaced first) and the plot size in hectares. Both feed the dashboard's
 * irrigation recommendations; skipping keeps the wilaya defaults.
 */
export default function FarmStep({ flow }: { flow: FlowController }) {
  const { t, lang } = flow;
  const rtl = lang === "ar";
  const wilaya = getWilaya(flow.wilayaCode ?? DEFAULT_WILAYA_CODE);
  const suggested = wilaya.crops;
  const others = (Object.keys(CROPS) as CropKey[]).filter((c) => !suggested.includes(c));

  return (
    <section aria-labelledby="farm-title" className="flex flex-col gap-3.5">
      <header className="text-center">
        <h1 id="farm-title" className="text-[20px] font-black leading-tight text-emerald-950">
          {t.farm.title}
        </h1>
        <p className="mx-auto mt-1 max-w-[38ch] text-[12.5px] font-semibold leading-6 text-emerald-900/75">
          {t.farm.subtitle}
        </p>
      </header>

      {/* Crop picker */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <p id="farm-crop-label" className="text-[12.5px] font-extrabold text-emerald-900">
            {t.farm.cropLabel}
          </p>
        </div>
        <p className="text-[11px] font-semibold text-emerald-800/70">{t.farm.cropHint}</p>

        <p className="mt-1 text-[11px] font-black tracking-wide text-emerald-800">
          {t.farm.suggestedLabel}
        </p>
        <div role="radiogroup" aria-labelledby="farm-crop-label" className="flex flex-wrap gap-1.5">
          {suggested.map((crop) => (
            <CropChip
              key={crop}
              crop={crop}
              selected={flow.crop === crop}
              label={CROPS[crop][lang]}
              onSelect={() => flow.handleCropSelect(crop)}
            />
          ))}
        </div>

        <p className="mt-1.5 text-[11px] font-black tracking-wide text-emerald-800">
          {t.farm.allLabel}
        </p>
        <div role="radiogroup" aria-label={t.farm.allLabel} className="flex max-h-[22vh] flex-wrap gap-1.5 overflow-y-auto overscroll-contain rounded-2xl border border-[#E2F1E8] bg-white/60 p-2">
          {others.map((crop) => (
            <CropChip
              key={crop}
              crop={crop}
              selected={flow.crop === crop}
              label={CROPS[crop][lang]}
              onSelect={() => flow.handleCropSelect(crop)}
            />
          ))}
        </div>
      </div>

      {/* Land size */}
      <TextField
        label={t.farm.landLabel}
        hint={t.farm.landHint}
        error={flow.landError}
        dir="ltr"
        inputMode="decimal"
        autoComplete="off"
        placeholder={t.farm.landPlaceholder}
        value={flow.landInput}
        onChange={(e) => flow.handleLandInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void flow.handleFarmConfirm(false);
        }}
        inputClassName="pe-20 text-center tracking-wide"
        trailing={
          <span className="pe-3 text-[12px] font-black text-emerald-700">{t.farm.landUnit}</span>
        }
      />

      <p className="flex items-center justify-center gap-1.5 text-center text-[11px] font-bold text-emerald-800/80">
        <Sprout size={13} strokeWidth={2.6} aria-hidden className="shrink-0 text-emerald-600" />
        {t.farm.encourage}
      </p>

      <div className="flex items-center gap-2">
        <GhostButton
          onClick={() => flow.goToStep("location")}
          block={false}
          className="h-12 shrink-0 px-4"
          icon={rtl ? <ArrowRight size={17} strokeWidth={2.6} aria-hidden /> : <ArrowLeft size={17} strokeWidth={2.6} aria-hidden />}
          aria-label={t.farm.back}
        >
          <span className="hidden min-[380px]:inline">{t.farm.back}</span>
        </GhostButton>
        <PrimaryButton
          onClick={() => void flow.handleFarmConfirm(false)}
          loading={flow.busy === "email"}
          loadingLabel={t.email.busy}
          icon={rtl ? <ArrowLeft size={17} strokeWidth={2.8} aria-hidden /> : <ArrowRight size={17} strokeWidth={2.8} aria-hidden />}
        >
          {t.farm.confirm}
        </PrimaryButton>
      </div>

      {/* Skip: the step is optional — the wilaya defaults carry the dashboard. */}
      <GhostButton onClick={() => void flow.handleFarmConfirm(true)} disabled={flow.busy === "email"}>
        {t.farm.skip}
      </GhostButton>
    </section>
  );
}

function CropChip({
  crop,
  selected,
  label,
  onSelect,
}: {
  crop: CropKey;
  selected: boolean;
  label: string;
  onSelect: (crop: CropKey) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(crop)}
      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-3 py-2 text-[12px] font-extrabold transition-colors ${FOCUS_RING} ${
        selected
          ? "border-emerald-500 bg-emerald-500 text-white shadow-[0_8px_20px_-12px_rgba(16,185,129,0.9)]"
          : "border-[#E2F1E8] bg-white/85 text-emerald-900 hover:border-emerald-300 hover:bg-white"
      }`}
    >
      {selected && <Check size={13} strokeWidth={3.4} aria-hidden />}
      {label}
    </button>
  );
}
