"use client";

import { motion } from "framer-motion";
import { Check, CircleAlert, Eye, EyeOff, LoaderCircle } from "lucide-react";
import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import type { HTMLMotionProps } from "framer-motion";

/* ------------------------------------------------------------------ */
/*  Motion tokens — one spring language across the whole flow          */
/* ------------------------------------------------------------------ */

export const SPRING = { type: "spring", stiffness: 330, damping: 34, mass: 0.9 } as const;
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** GPU-isolated wrapper class used by every animating panel. */
export const GPU = "transform-gpu backface-hidden will-change-transform";

export const CARD = "glass-card rounded-3xl";
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/45";

/* ------------------------------------------------------------------ */
/*  Buttons                                                            */
/* ------------------------------------------------------------------ */

type ButtonProps = Omit<HTMLMotionProps<"button">, "children"> & {
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  /** Announced while `loading` is true. */
  loadingLabel?: string;
};

export const PrimaryButton = forwardRef<HTMLButtonElement, ButtonProps>(function PrimaryButton(
  { loading = false, block = true, icon, loadingLabel, children, className = "", disabled, ...rest },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      type="button"
      whileHover={disabled || loading ? undefined : { y: -1 }}
      whileTap={disabled || loading ? undefined : { scale: 0.975 }}
      transition={SPRING}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-live={loading ? "polite" : undefined}
      className={`glow-emerald ${GPU} ${FOCUS_RING} grid h-12 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 via-emerald-500 to-green-600 text-[15px] font-black text-white transition-colors hover:from-emerald-400 hover:to-green-500 disabled:cursor-not-allowed disabled:opacity-60 ${
        block ? "w-full" : "px-5"
      } ${className}`}
      {...rest}
    >
      <span className="inline-flex items-center gap-2">
        {loading ? <LoaderCircle size={18} strokeWidth={2.8} className="animate-spin" /> : icon}
        {loading ? (loadingLabel ?? children) : children}
      </span>
    </motion.button>
  );
});

export const GhostButton = forwardRef<HTMLButtonElement, ButtonProps>(function GhostButton(
  { loading = false, block = true, icon, loadingLabel, children, className = "", disabled, ...rest },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      type="button"
      whileHover={disabled || loading ? undefined : { y: -1 }}
      whileTap={disabled || loading ? undefined : { scale: 0.975 }}
      transition={SPRING}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`glass ${GPU} ${FOCUS_RING} grid h-12 place-items-center rounded-2xl text-[15px] font-extrabold text-emerald-900 transition-colors hover:bg-white/95 disabled:cursor-not-allowed disabled:opacity-60 ${
        block ? "w-full" : "px-5"
      } ${className}`}
      {...rest}
    >
      <span className="inline-flex items-center gap-2">
        {loading ? <LoaderCircle size={18} strokeWidth={2.6} className="animate-spin" /> : icon}
        {loading ? (loadingLabel ?? children) : children}
      </span>
    </motion.button>
  );
});

/* ------------------------------------------------------------------ */
/*  Fields                                                             */
/* ------------------------------------------------------------------ */

interface FieldFrameProps {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  adornment?: ReactNode;
  children: ReactNode;
  className?: string;
}

function FieldFrame({ id, label, hint, error, adornment, children, className = "" }: FieldFrameProps) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[12.5px] font-extrabold text-emerald-900">
          {label}
        </label>
        {adornment}
      </div>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[11.5px] font-medium leading-5 text-emerald-800/70">
          {hint}
        </p>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </div>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="flex items-start gap-1.5 text-[11.5px] font-bold leading-5 text-rose-700"
    >
      <CircleAlert size={13} strokeWidth={2.6} className="mt-[3px] shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className"> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Rendered on the label row (e.g. a "forgot password" action). */
  adornment?: ReactNode;
  /** Rendered inside the field, at the trailing edge (e.g. show/hide). */
  trailing?: ReactNode;
  containerClassName?: string;
  inputClassName?: string;
  leading?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, adornment, trailing, containerClassName, inputClassName = "", leading, ...rest },
  ref,
) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} adornment={adornment} className={containerClassName}>
      <div className="relative">
        {leading && <span className="absolute inset-y-0 start-0 grid w-12 place-items-center">{leading}</span>}
        <input
          ref={ref}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={`field-input h-12 px-4 ${leading ? "ps-12" : ""} ${inputClassName}`}
          {...rest}
        />
        {trailing && (
          <span className="absolute inset-y-0 end-1 grid w-11 place-items-center">{trailing}</span>
        )}
      </div>
    </FieldFrame>
  );
});

interface PasswordFieldProps extends TextFieldProps {
  showLabel: string;
  hideLabel: string;
}

export function PasswordField({ showLabel, hideLabel, ...rest }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...rest}
      type={visible ? "text" : "password"}
      autoComplete={rest.autoComplete ?? "current-password"}
      inputClassName={`pe-12 ${rest.inputClassName ?? ""}`}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? hideLabel : showLabel}
          aria-pressed={visible}
          className={`grid h-9 w-9 place-items-center rounded-xl text-emerald-700 transition-colors hover:bg-emerald-50 ${FOCUS_RING}`}
        >
          {visible ? <EyeOff size={16} strokeWidth={2.2} aria-hidden /> : <Eye size={16} strokeWidth={2.2} aria-hidden />}
        </button>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Strength meter                                                     */
/* ------------------------------------------------------------------ */

export function StrengthMeter({
  score,
  labels,
  ariaLabel,
}: {
  score: 0 | 1 | 2 | 3 | 4;
  labels: [string, string, string, string, string];
  ariaLabel: string;
}) {
  const tone = ["bg-emerald-900/12", "bg-rose-500", "bg-amber-500", "bg-lime-500", "bg-emerald-500"][score];
  const text = ["text-emerald-800/60", "text-rose-700", "text-amber-700", "text-lime-700", "text-emerald-700"][score];
  return (
    <div className="flex items-center gap-2" aria-label={ariaLabel} role="group">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <motion.span
            key={i}
            layout
            className={`h-1.5 flex-1 rounded-full ${i <= score ? tone : "bg-emerald-900/10"}`}
            transition={SPRING}
          />
        ))}
      </div>
      <span className={`min-w-[62px] text-end text-[11px] font-black ${text}`}>{labels[score]}</span>
    </div>
  );
}

export function RuleCheck({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10.5px] font-bold ${
        ok ? "text-emerald-700" : "text-emerald-900/45"
      }`}
    >
      <span
        aria-hidden
        className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${
          ok ? "border-emerald-500 bg-emerald-500 text-white" : "border-emerald-900/25 bg-white"
        }`}
      >
        {ok && <Check size={9} strokeWidth={4} />}
      </span>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Misc                                                               */
/* ------------------------------------------------------------------ */

export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-emerald-900/15" />
      <span className="text-[11px] font-black tracking-wide text-emerald-900/55">{label}</span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-emerald-900/15" />
    </div>
  );
}

export function Badge({
  children,
  tone = "emerald",
  className = "",
}: {
  children: ReactNode;
  tone?: "emerald" | "amber" | "slate";
  className?: string;
}) {
  const tones = {
    emerald: "border-emerald-300/60 bg-emerald-50/90 text-emerald-800",
    amber: "border-amber-300/60 bg-amber-50/90 text-amber-800",
    slate: "border-emerald-900/12 bg-white/80 text-emerald-900/80",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-black ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
  icon,
}: {
  tone?: "info" | "demo";
  title: string;
  children: ReactNode;
  icon?: ReactNode;
}) {
  const tones = {
    info: "border-emerald-300/50 bg-emerald-50/70 text-emerald-900",
    demo: "border-amber-300/60 bg-amber-50/80 text-amber-900",
  } as const;
  return (
    <div role="note" className={`flex items-start gap-2.5 rounded-2xl border p-3 ${tones[tone]}`}>
      {icon && <span className="mt-[2px] shrink-0">{icon}</span>}
      <div className="min-w-0">
        <p className="text-[12px] font-black">{title}</p>
        <p className="mt-0.5 text-[11.5px] font-medium leading-5 opacity-90">{children}</p>
      </div>
    </div>
  );
}

export function LiveRegion({ message }: { message: string | null }) {
  return (
    <p aria-live="polite" role="status" className="min-h-[1rem] text-[11.5px] font-bold text-emerald-800">
      {message ?? ""}
    </p>
  );
}
