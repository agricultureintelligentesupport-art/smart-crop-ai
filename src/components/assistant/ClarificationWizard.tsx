"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Check, Sprout } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import { EASE_OUT, FOCUS_RING, GPU, PrimaryButton } from "@/components/auth/ui";
import type { AssistantCopy } from "@/lib/assistant/copy";
import {
  resolveCropKey,
  type ClarificationQuestion,
  type DiagnosisUserAnswers,
} from "@/lib/vision/taxonomyFilter";

/**
 * Interactive diagnosis wizard (first pass of `/api/assistant` returned
 * `requiresClarification`).
 *
 * MobileNetV2 is the diagnostic authority, but below 60% Top-1 confidence it
 * cannot tell a tomato from a potato on that photo. So the farmer is asked
 * exactly one question — which plant is this — and the answer is sent back
 * with the original image and the raw logit vector. The server then drops
 * every class that cannot grow on that crop and recalculates the surviving
 * probabilities (15% tomato behind 45% potato → 100% tomato).
 *
 * Native radio semantics: arrow keys move inside the group, Enter/Space
 * selects, the whole card is a ≥44px touch target, and the chosen option is
 * the only thing announced. Renders as history once answered.
 */
export default function ClarificationWizard({
  questions,
  copy,
  busy,
  answered,
  defaultCrop,
  onSubmit,
}: {
  questions: ClarificationQuestion[];
  copy: AssistantCopy["clarification"];
  /** True while the answered request (second pass) is in flight. */
  busy: boolean;
  /** The label the farmer picked, once the answer was sent. */
  answered: string | null;
  /** Profile crop (Arabic, definite form) pre-selected when it matches. */
  defaultCrop?: string | null;
  onSubmit: (answers: DiagnosisUserAnswers) => void;
}) {
  const question = questions[0];
  const options = useMemo(() => question?.options ?? [], [question]);
  const groupName = useId();
  const questionId = `${groupName}-question`;
  const reduceMotion = useReducedMotion();

  /** Pre-select the crop stored on the farmer's profile, when it is an option. */
  const suggested = useMemo(() => {
    if (!defaultCrop) return null;
    const key = resolveCropKey(defaultCrop);
    if (!key) return null;
    return options.find((option) => resolveCropKey(option) === key) ?? null;
  }, [defaultCrop, options]);

  const [selected, setSelected] = useState<string | null>(suggested);

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || answered) return;
    onSubmit({ [question?.id ?? "crop"]: selected });
  };

  // Answered: the wizard collapses into a receipt so the conversation keeps
  // the full audit trail without re-asking anything.
  if (answered) {
    return (
      <p className="flex items-center gap-2 rounded-2xl bg-emerald-50/80 px-3 py-2 text-[12px] font-black text-emerald-800 ring-1 ring-emerald-200/70">
        <Check size={13} strokeWidth={3.2} aria-hidden className="shrink-0 text-emerald-600" />
        {copy.answerPrefix}: {answered}
      </p>
    );
  }

  return (
    <motion.form
      onSubmit={onFormSubmit}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.34, ease: EASE_OUT }}
      className={`${GPU} mt-1 rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-white/90 to-emerald-50/70 p-3`}
    >
      <p className="flex items-center gap-1.5 text-[10px] font-black text-emerald-700/80">
        <Sprout size={12} strokeWidth={2.8} aria-hidden />
        {copy.title}
      </p>

      <p id={questionId} className="mt-1.5 text-[13.5px] font-black leading-6 text-emerald-950">
        {question?.question ?? copy.question}
      </p>
      <p className="mt-1 text-[11px] font-semibold leading-5 text-emerald-900/60">{copy.hint}</p>

      <div
        role="radiogroup"
        aria-labelledby={questionId}
        className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {options.map((option) => {
          const active = selected === option;
          return (
            <label
              key={option}
              className={`relative flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-2xl border px-3 py-2 text-center text-[12.5px] font-black transition-colors has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-emerald-400/45 ${FOCUS_RING} ${
                active
                  ? "border-emerald-500 bg-emerald-50 text-emerald-900 shadow-[0_4px_14px_rgba(16,185,129,0.18)]"
                  : "border-emerald-900/10 bg-white/75 text-emerald-900/75 hover:border-emerald-300 hover:bg-white"
              }`}
            >
              <input
                type="radio"
                name={groupName}
                value={option}
                checked={active}
                onChange={() => setSelected(option)}
                disabled={busy}
                className="sr-only"
              />
              {copy.optionLabels[option] ?? option}
              {active && (
                <motion.span
                  layout={!reduceMotion}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-500 text-white"
                  aria-hidden
                >
                  <Check size={10} strokeWidth={4} />
                </motion.span>
              )}
            </label>
          );
        })}
      </div>

      <div className="mt-3">
        <PrimaryButton
          type="submit"
          disabled={!selected}
          loading={busy}
          loadingLabel={copy.submitting}
          icon={<Sprout size={16} strokeWidth={2.6} aria-hidden />}
        >
          {copy.submit}
        </PrimaryButton>
      </div>
    </motion.form>
  );
}
