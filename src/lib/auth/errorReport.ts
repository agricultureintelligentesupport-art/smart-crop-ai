/**
 * Provider error → on-screen report.
 *
 * Firebase Auth throws `FirebaseError`s whose `code` (e.g.
 * `auth/unauthorized-domain`) and `message` (the exact SDK sentence) are the
 * two facts that make a failed sign-in diagnosable. The app-level `AuthError`
 * only carries a localisable code, so this module keeps BOTH: the localized
 * copy stays the primary message, and the raw `code` + `message` are rendered
 * underneath it (and copied by the "copy details" button).
 */

import { hintForCode } from "./logging";
import { AuthError, toAuthErrorCode, type AuthErrorCode } from "./types";

export interface AuthErrorReport {
  /** Raw provider code, e.g. `auth/popup-blocked` (`app/<code>` / `unknown-code` fallbacks). */
  code: string;
  /** Exact provider message, whitespace-normalised, redacted and shortened. */
  message: string;
  /** App-level code that selects the localised copy. */
  appCode: AuthErrorCode;
  /** Actionable next step (see the `HINTS` table in `logging.ts`). */
  hint?: string;
  /** Where it failed: `signInWithPopup`, `signInWithRedirect`, `getRedirectResult`, … */
  scope?: string;
}

const MAX_MESSAGE_LENGTH = 240;

/** Collapses whitespace, redacts API keys and caps the length for display. */
export function sanitizeAuthMessage(value: unknown): string {
  const raw =
    typeof value === "string" ? value : value instanceof Error ? value.message : "";
  const text = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/AIza[0-9A-Za-z_-]{6,}/g, "AIza…(redacted)");
  if (!text) return "no message supplied by the provider";
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

/** The provider's own error code, when the value carries one. */
export function rawAuthCode(error: unknown): string | undefined {
  if (error instanceof AuthError) return error.firebaseCode;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return undefined;
  const trimmed = code.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalises anything thrown by the Firebase SDK (or by the app) into a
 * renderable report. Never throws and never returns undefined.
 */
export function describeAuthError(error: unknown, scope?: string): AuthErrorReport {
  const appCode = toAuthErrorCode(error);
  const providerCode = rawAuthCode(error);
  const code = providerCode ?? (error instanceof AuthError ? `app/${error.code}` : "unknown-code");
  const message = sanitizeAuthMessage(error instanceof AuthError ? error.message : error);
  return { code, message, appCode, hint: hintForCode(code), scope };
}

/** One-line summary used in headings and logs: `auth/popup-blocked — message`. */
export function reportSummary(report: AuthErrorReport): string {
  return `${report.code} — ${report.message}`;
}

/**
 * Multi-line block for the clipboard / console: everything a maintainer needs
 * to reproduce the failure, including the diagnostics table when provided.
 */
export function formatAuthReport(options: {
  report: AuthErrorReport;
  localizedMessage?: string | null;
  diagnostics?: string[];
}): string {
  const { report, localizedMessage, diagnostics } = options;
  const lines = [
    "Smart Crop AI — Firebase Auth failure",
    `code: ${report.code}`,
    `message: ${report.message}`,
  ];
  if (report.scope) lines.push(`scope: ${report.scope}`);
  if (report.hint) lines.push(`hint: ${report.hint}`);
  if (localizedMessage) lines.push(`ui: ${localizedMessage}`);
  if (diagnostics?.length) lines.push("", "diagnostics:", ...diagnostics);
  return lines.join("\n");
}
