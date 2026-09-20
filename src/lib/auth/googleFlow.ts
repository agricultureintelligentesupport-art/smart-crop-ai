import type { User } from "firebase/auth";
import { describeAuthError, type AuthErrorReport } from "./errorReport";
import { logAuthError, logAuthInfo } from "./logging";

import { AuthError, type AuthErrorCode } from "./types";

/**
 * Strict Google sign-in decision logic — pure and unit-testable.
 *
 * The onboarding wizard may advance ONLY with the `signed-in` outcome, and
 * that outcome is produced exclusively from a valid Firebase `user` object
 * returned by `signInWithPopup` (or, after a redirect, by
 * `getRedirectResult`). There is deliberately no mock/dummy path here:
 * cancelled popups, blocked popups and setup errors all resolve to
 * "stay on step 1 + show the user what happened" outcomes.
 */

export interface GoogleAuthRunner {
  /**
   * Session persistence, awaited BEFORE the popup/redirect is initiated:
   * `setPersistence(auth, browserLocalPersistence)`. Without it a full-page
   * redirect comes back to an auth instance that cannot store the session and
   * the user silently lands on step 1 again.
   */
  ensurePersistence?: () => Promise<boolean | void>;
  /** Desktop popup. Resolves with the Firebase user credential or rejects. */
  signInWithPopup: () => Promise<{ user: User }>;
  /**
   * Full-page fallback / mobile path. Resolves once the browser has been
   * navigated to Google — the session itself arrives later via
   * `getRedirectResult(auth)`.
   */
  signInWithRedirect: () => Promise<void>;
  /** Pre-computed in unit tests; defaults to the real UA check. */
  isMobile?: boolean;
  /** UI feedback hook, called right before any redirect is initiated. */
  onRedirectStart?: () => void;
}

export type GoogleAuthOutcome =
  | { kind: "signed-in"; user: User }
  /**
   * The browser is navigating to Google's account chooser. The wizard must
   * NOT advance yet — the real session arrives on the way back, via
   * `getRedirectResult()`.
   */
  | { kind: "redirect-started" }
  /** The user closed or cancelled the account chooser: retry offered, never advance. */
  | { kind: "user-cancelled"; report: AuthErrorReport }
  /** Firebase console setup problem (Authorized domains): surfaced, never retried. */
  | { kind: "unauthorized-domain"; report: AuthErrorReport }
  | { kind: "failed"; code: AuthErrorCode; report: AuthErrorReport };

const CANCELLED_CODES = [
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/cancelled-redirect",
  "auth/redirect-cancelled-by-user",
];

function fbCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

/**
 * Runs the persistence hook (when the caller provides one) before touching the
 * SDK. A persistence failure is logged but never blocks sign-in: the session
 * then lives in memory for this page load, and the UI shows the reason in its
 * diagnostics block.
 */
async function ensurePersistenceBeforeSignIn(runner: GoogleAuthRunner, scope: string): Promise<void> {
  if (!runner.ensurePersistence) return;
  try {
    const ok = await runner.ensurePersistence();
    if (ok === false) logAuthInfo(scope, "browserLocalPersistence unavailable — continuing in-memory");
  } catch (error) {
    logAuthError(`${scope}/setPersistence`, error);
  }
}

async function startRedirect(runner: GoogleAuthRunner): Promise<GoogleAuthOutcome> {
  await ensurePersistenceBeforeSignIn(runner, "signInWithRedirect");
  runner.onRedirectStart?.();
  try {
    await runner.signInWithRedirect();
    return { kind: "redirect-started" };
  } catch (error) {
    logAuthError("signInWithRedirect", error);
    const report = describeAuthError(error, "signInWithRedirect");
    return { kind: "failed", code: report.appCode, report };
  }
}

/**
 * Popup-blocking / unsupported-environment codes that SHOULD trigger the
 * full-page redirect fallback. User-closed codes are deliberately NOT here —
 * dragging a user into a redirect after they already cancelled the chooser is
 * poor UX; those stay on step 1 with a retry offer.
 */
const POPUP_FALLBACK_CODES: readonly string[] = [
  "auth/popup-blocked",
  "auth/popup-blocked-by-browser",
  "auth/operation-not-supported-in-this-environment",
];

/**
 * Runs the Google sign-in flow with `signInWithPopup` as the primary method
 * on every browser (desktop and mobile). The old mobile-first redirect bypass
 * is removed: cross-domain storage partitioning between `vercel.app` and
 * `firebaseapp.com` was causing `getRedirectResult(auth)` to resolve to `null`
 * on mobile, so the popup path is now always tried first and only falls back
 * to `signInWithRedirect` when the popup is actually blocked.
 */
export async function runGoogleSignIn(runner: GoogleAuthRunner): Promise<GoogleAuthOutcome> {
  // 1. Always try the popup first — on desktop AND mobile.
  await ensurePersistenceBeforeSignIn(runner, "signInWithPopup");

  let cred: { user: User } | undefined;
  try {
    cred = await runner.signInWithPopup();
  } catch (popupErr: unknown) {
    logAuthError("signInWithPopup", popupErr);
    const report = describeAuthError(popupErr, "signInWithPopup");
    const errCode = fbCode(popupErr);

    // The user deliberately closed/cancelled the account chooser: never drag
    // them into a full-page redirect — stay on step 1 and offer a retry.
    if (CANCELLED_CODES.includes(errCode ?? "")) {
      return { kind: "user-cancelled", report };
    }

    // Firebase console setup problem (Authorized domains): surface, don't retry.
    if (errCode === "auth/unauthorized-domain") {
      return { kind: "unauthorized-domain", report };
    }

    // Popup was blocked by the browser / unsupported environment: fall back to
    // the full-page redirect, which still works on mobile (the shared provider
    // carries `prompt=select_account` so Google still shows its account chooser).
    if (POPUP_FALLBACK_CODES.includes(errCode ?? "")) {
      logAuthInfo("google", "popup blocked/unsupported → falling back to signInWithRedirect");
      return startRedirect(runner);
    }

    // Any other unexpected popup error: surface it rather than silently
    // redirecting (which would lose the original error context).
    logAuthInfo("google", `popup failed with unexpected code ${errCode ?? "unknown"} — surfacing`);
    return { kind: "failed", code: report.appCode, report };
  }

  // Strict gate: the wizard only advances with a valid Firebase user object.
  if (!cred?.user?.uid) {
    const error = new AuthError(
      "unknown",
      "Google sign-in resolved without a Firebase user (no uid)",
      "auth/internal-error",
    );
    logAuthError("signInWithPopup (no user)", error);
    return { kind: "failed", code: "unknown", report: describeAuthError(error, "signInWithPopup") };
  }

  return { kind: "signed-in", user: cred.user };
}
