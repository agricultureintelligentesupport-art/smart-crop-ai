/**
 * Validation + normalisation helpers for the auth forms.
 * Pure functions only, so they are equally usable from the UI, the gateway
 * and Playwright specs.
 */

/* ------------------------------------------------------------------ */
/*  Email                                                              */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/* ------------------------------------------------------------------ */
/*  Algerian phone numbers                                             */
/* ------------------------------------------------------------------ */

/**
 * Mobile prefixes in Algeria: 5 (Ooredoo), 6 (Mobilis), 7 (Djezzy).
 * The national significant number is 9 digits; the trunk "0" is dropped when
 * the +213 country code is used.
 */
export const DZ_MOBILE_PREFIXES = ["5", "6", "7"] as const;
export const DZ_COUNTRY_CODE = "+213";

/** Keeps digits only and drops a leading 0 / 213 / +213. */
export function normalizeDzPhone(raw: string): string {
  let digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("213")) digits = digits.slice(3);
  while (digits.startsWith("0")) digits = digits.slice(1);
  return digits.slice(0, 9);
}

export function isValidDzMobile(digits: string): boolean {
  return /^[567]\d{8}$/.test(normalizeDzPhone(digits));
}

export function toE164(digits: string): string {
  return `${DZ_COUNTRY_CODE}${normalizeDzPhone(digits)}`;
}

/** Human display: "6 61 22 33 44" (national format without the trunk 0). */
export function formatDzPhone(digits: string): string {
  const d = normalizeDzPhone(digits);
  const groups = [d.slice(0, 1), d.slice(1, 3), d.slice(3, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean);
  return groups.join(" ");
}

/* ------------------------------------------------------------------ */
/*  Password                                                           */
/* ------------------------------------------------------------------ */

export const PASSWORD_MIN_LENGTH = 8;

export interface PasswordRuleState {
  length: boolean;
  letter: boolean;
  number: boolean;
}

export interface PasswordStrength {
  /** 0 (empty) → 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  rules: PasswordRuleState;
  acceptable: boolean;
}

export function passwordStrength(value: string): PasswordStrength {
  const rules: PasswordRuleState = {
    length: value.length >= PASSWORD_MIN_LENGTH,
    letter: /[a-zA-Z\u0600-\u06FF]/.test(value),
    number: /\d/.test(value),
  };
  if (!value) return { score: 0, rules, acceptable: false };

  let score = 0;
  if (rules.length) score += 1;
  if (rules.letter) score += 1;
  if (rules.number) score += 1;
  if (value.length >= 12 && /[^a-zA-Z0-9]/.test(value)) score += 1;

  const clamped = Math.min(score, 4) as PasswordStrength["score"];
  return { score: clamped, rules, acceptable: rules.length && rules.letter && rules.number };
}

/* ------------------------------------------------------------------ */
/*  OTP                                                                */
/* ------------------------------------------------------------------ */

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_RESEND_MS = 30 * 1000;

export function isCompleteOtp(code: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code);
}

/** Splits a pasted string into individual digits, ignoring separators. */
export function otpDigits(raw: string): string[] {
  return raw.replace(/\D/g, "").slice(0, OTP_LENGTH).split("");
}
