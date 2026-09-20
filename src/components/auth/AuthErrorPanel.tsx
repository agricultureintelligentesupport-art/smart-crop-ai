"use client";

import { motion } from "framer-motion";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
  formatAuthReport,
  type AuthErrorReport,
} from "@/lib/auth/errorReport";
import { formatDiagnostics, type FirebaseDiagnosticLine } from "@/lib/firebase-env";
import { FOCUS_RING, SPRING } from "./ui";

/**
 * On-screen failure report for the Google/Firebase sign-in paths.
 *
 * Every rejection from `signInWithPopup`, `signInWithRedirect` and
 * `getRedirectResult` ends up here, so nothing is only visible in the console:
 * the localized sentence stays the primary message, and the raw
 * `error.code` + `error.message` from the SDK are printed underneath, together
 * with the actionable hint and the Firebase diagnostics table (backend,
 * project, authDomain, origin, authorized-domain check, iframe warning,
 * persistence state, which `NEXT_PUBLIC_FIREBASE_*` keys fell back).
 */

export interface AuthErrorPanelLabels {
  code: string;
  message: string;
  hint: string;
  diagnostics: string;
  copy: string;
  copied: string;
}

interface AuthErrorPanelProps {
  report: AuthErrorReport;
  /** Localized copy (already resolved by the flow). */
  message?: string | null;
  labels: AuthErrorPanelLabels;
  diagnostics?: FirebaseDiagnosticLine[];
}

/** Tone → text colour for the diagnostics rows (AA contrast on rose-50). */
const TONES: Record<FirebaseDiagnosticLine["tone"], string> = {
  ok: "text-emerald-700",
  info: "text-emerald-900/80",
  warn: "text-amber-700",
  error: "text-rose-700",
};

export default function AuthErrorPanel({
  report,
  message,
  labels,
  diagnostics = [],
}: AuthErrorPanelProps) {
  const [copied, setCopied] = useState(false);

  const diagnosticsText = useMemo(
    () => (diagnostics.length ? formatDiagnostics(diagnostics) : ""),
    [diagnostics],
  );

  const copyDetails = async () => {
    const text = formatAuthReport({
      report,
      localizedMessage: message ?? null,
      diagnostics: diagnosticsText ? diagnosticsText.split("\n") : [],
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard blocked (insecure context / permissions): the panel already
      // shows every field, so there is nothing else to do.
      setCopied(false);
    }
  };

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-2xl border border-rose-300/70 bg-rose-50/85 p-3 text-start"
    >
      <p className="flex items-start gap-1.5 text-[12px] font-black leading-5 text-rose-800">
        <TriangleAlert size={14} strokeWidth={2.6} className="mt-[3px] shrink-0" aria-hidden />
        <span>{message ?? report.message}</span>
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 border-t border-rose-200/80 pt-2">
        <dt className="text-[10.5px] font-black uppercase tracking-wide text-rose-900/70">
          {labels.code}
        </dt>
        <dd dir="ltr" className="break-words font-mono text-[11px] font-bold text-rose-800">
          {report.code}
        </dd>
        <dt className="text-[10.5px] font-black uppercase tracking-wide text-rose-900/70">
          {labels.message}
        </dt>
        <dd dir="ltr" className="break-words font-mono text-[11px] text-rose-900/85">
          {report.message}
        </dd>
        {report.hint && (
          <>
            <dt className="text-[10.5px] font-black uppercase tracking-wide text-rose-900/70">
              {labels.hint}
            </dt>
            <dd className="text-[11px] font-semibold leading-5 text-amber-800">{report.hint}</dd>
          </>
        )}
      </dl>

      {diagnostics.length > 0 && (
        <details className="group rounded-xl border border-rose-200/80 bg-white/70 px-2.5 py-2">
          <summary
            className={`cursor-pointer list-none text-[11px] font-black text-emerald-900/80 ${FOCUS_RING}`}
          >
            {labels.diagnostics}
          </summary>
          <dl className="mt-1.5 flex flex-col gap-1" dir="ltr">
            {diagnostics.map((line) => (
              <div key={`${line.label}-${line.value}`} className="flex flex-col">
                <dt className="font-mono text-[10px] font-black uppercase tracking-wide text-emerald-900/60">
                  {line.label}
                </dt>
                <dd className={`break-words font-mono text-[10.5px] ${TONES[line.tone]}`}>
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <motion.button
        type="button"
        onClick={() => void copyDetails()}
        whileTap={{ scale: 0.97 }}
        transition={SPRING}
        aria-live="polite"
        className={`inline-flex w-fit items-center gap-1.5 rounded-xl border border-rose-300/70 bg-white/80 px-2.5 py-1.5 text-[11px] font-extrabold text-rose-800 transition-colors hover:bg-white ${FOCUS_RING}`}
      >
        {copied ? (
          <Check size={12} strokeWidth={3} aria-hidden />
        ) : (
          <Copy size={12} strokeWidth={2.6} aria-hidden />
        )}
        {copied ? labels.copied : labels.copy}
      </motion.button>
    </div>
  );
}
