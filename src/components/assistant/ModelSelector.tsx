"use client";

/**
 * The chat's manual model picker — the pill that sits above the composer and
 * lets the farmer choose which Gemini model answers.
 *
 * WHY A NATIVE `<select>`
 * On a phone this becomes the OS picker (thumb-friendly, RTL-correct, with the
 * platform's own a11y), it needs no focus trap or outside-click handling, and it
 * degrades to a keyboard list on the desktop. The catalog itself lives in
 * `@/lib/assistant/model-choice`, the SAME module the API route reads, so a new
 * model is added in one place and both sides pick it up.
 *
 * The pill shows the model's friendly name (`phyto 3.8`); the request carries
 * the stable id, so renaming a label never breaks a stored preference.
 */

import { ChevronDown, Sparkles } from "lucide-react";
import { GPU } from "@/components/auth/ui";
import type { AssistantCopy } from "@/lib/assistant/copy";
import {
  PHYTO_MODEL_CHOICES,
  phytoModelFor,
  type PhytoModelChoice,
} from "@/lib/assistant/model-choice";
import type { Lang } from "@/lib/wilayas";

export default function ModelSelector({
  value,
  onChange,
  copy,
  lang,
  disabled = false,
  className = "",
}: {
  /** Selected catalog id; an unknown value falls back to the default choice. */
  value: string;
  onChange: (choice: PhytoModelChoice) => void;
  copy: AssistantCopy["model"];
  lang: Lang;
  disabled?: boolean;
  className?: string;
}) {
  const selected = phytoModelFor(value) ?? PHYTO_MODEL_CHOICES[0];
  const note = copy.notes[selected.note];

  return (
    <label
      // The focus ring is drawn by `.chat-model-pill:focus-within`, so the
      // native `<select>` can stay outline-free without losing keyboard focus.
      className={`chat-model-pill ${GPU} flex min-w-0 items-center gap-1.5 rounded-full py-1 pe-2 ps-2.5 transition-colors ${
        disabled ? "opacity-60" : ""
      } ${className}`}
      title={`${copy.selected}: ${selected.label} — ${note}`}
    >
      <Sparkles size={12} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-600" />

      <span className="sr-only">
        {copy.label} — {copy.aria}
      </span>

      <select
        value={selected.id}
        onChange={(event) => {
          const choice = phytoModelFor(event.target.value);
          if (choice) onChange(choice);
        }}
        disabled={disabled}
        aria-label={`${copy.label}: ${selected.label}. ${note}`}
        className="max-w-[9.5rem] cursor-pointer appearance-none truncate bg-transparent pe-0.5 text-[11.5px] font-extrabold text-emerald-900 outline-none disabled:cursor-not-allowed [&>option]:text-emerald-950"
      >
        {PHYTO_MODEL_CHOICES.map((choice) => (
          <option key={choice.id} value={choice.id} title={copy.notes[choice.note]}>
            {choice.label}
          </option>
        ))}
      </select>

      <ChevronDown
        size={13}
        strokeWidth={2.8}
        aria-hidden
        className="shrink-0 text-emerald-700/70"
      />

      {/* The chosen model's characterisation, on the widths that can afford it. */}
      <span
        aria-hidden
        className="hidden max-w-[13rem] truncate border-s border-emerald-900/10 ps-2 text-[10.5px] font-bold text-emerald-900/45 sm:inline"
        lang={lang}
      >
        {note}
      </span>
    </label>
  );
}
