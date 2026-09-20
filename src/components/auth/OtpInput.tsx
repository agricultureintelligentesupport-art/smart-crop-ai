"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";

/**
 * Six-box OTP field built on the "one real input" pattern.
 *
 * Why: a hidden-but-focusable `<input>` owns the value, while the six boxes
 * are presentation only. That keeps native behaviour intact — mobile SMS
 * autofill (`autocomplete="one-time-code"`), paste, backspace, arrow keys,
 * IME and screen readers all work on a single control — instead of six
 * separate boxes that truncate an autofilled code to one digit each.
 */
export default function OtpInput({
  value,
  onChange,
  length = 6,
  label,
  describedBy,
  disabled = false,
  invalid = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  label: string;
  describedBy?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(value.length);

  useEffect(() => {
    if (autoFocus && !disabled) inputRef.current?.focus();
  }, [autoFocus, disabled]);

  // Keep the DOM caret and the visual highlight in sync after each change.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) return;
    const position = Math.min(caret, el.value.length);
    el.setSelectionRange(position, position);
  }, [caret, value]);

  const boxes = Array.from({ length }, (_, i) => value[i] ?? "");
  // The active box is where the caret sits (the last one once the code is full).
  const activeIndex = Math.min(caret, length - 1);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    const digits = raw.replace(/\D/g, "").slice(0, length);
    const caretBefore = event.target.selectionStart ?? digits.length;
    // Non-digits such as a stray space are dropped, which shifts the caret left.
    const removed = raw.length - digits.length;
    const nextCaret = Math.max(0, caretBefore - removed);
    onChange(digits);
    setCaret(nextCaret);
  };

  const focusBoxAt = (index: number) => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const position = Math.min(index, el.value.length);
    el.setSelectionRange(position, position);
    setCaret(position);
  };

  // The real input carries the accessible name; the boxes are decoration.
  return (
    <div dir="ltr" className="relative flex items-center justify-center gap-2">
      <input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        disabled={disabled}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        enterKeyHint="done"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        maxLength={length}
        className="absolute inset-0 z-10 w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0"
      />

      {boxes.map((digit, i) => (
        <span
          key={i}
          aria-hidden
          onMouseDown={(e) => {
            e.preventDefault();
            focusBoxAt(i);
          }}
          className={`field-input grid h-13 w-[46px] shrink-0 place-items-center py-3 text-center text-[22px] font-black tracking-widest sm:w-[50px] ${
            invalid ? "border-rose-400" : "border-[#D6ECE0]"
          } ${focused && i === activeIndex ? "border-emerald-500 bg-white shadow-[0_0_0_4px_rgba(16,185,129,0.22)]" : ""} ${
            digit ? "text-emerald-950" : "text-emerald-900/30"
          } ${disabled ? "opacity-60" : ""}`}
        >
          {digit}
        </span>
      ))}
    </div>
  );
}
