import type { User } from "firebase/auth";
import { logAuthError, logAuthInfo } from "./logging";
import { isMobileBrowser } from "./platform";
import { toAuthErrorCode, type AuthErrorCode } from "./types";

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
  /** Keep the unmodified SDK error available to the interface. */
  onError?: (operation: "signInWithPopup" | "signInWithRedirect", error: unknown) => void;
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
  | { kind: "user-cancelled" }
  /** Firebase console setup problem (Authorized domains): surfaced, never retried. */
  | { kind: "unauthorized-domain" }
  | { kind: "failed"; code: AuthErrorCode };

const CANCELLED_CODES = [
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/cancelled-redirect",
  "auth/redirect-cancelled-by-user",
];

function fbCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

async function startRedirect(runner: GoogleAuthRunner): Promise<GoogleAuthOutcome> {
  runner.onRedirectStart?.();
  try {
    await runner.signInWithRedirect();
    return { kind: "redirect-started" };
  } catch (error) {
    logAuthError("signInWithRedirect", error);
    runner.onError?.("signInWithRedirect", error);
    return { kind: "failed", code: toAuthErrorCode(error) };
  }
}

export async function runGoogleSignIn(runner: GoogleAuthRunner): Promise<GoogleAuthOutcome> {
  const mobile = runner.isMobile ?? isMobileBrowser();

  // Mobile browsers block or botch OAuth popups: use the full-page redirect
  // from the start. Google still shows its account chooser there (the shared
  // provider carries prompt=select_account); the `getRedirectResult` effect
  // in useAuthFlow finishes the sign-in on the way back.
  if (mobile) {
    logAuthInfo("google", "mobile browser → using signInWithRedirect instead of a popup");
    return startRedirect(runner);
  }

  let cred: { user: User } | undefined;
  try {
    cred = await runner.signInWithPopup();
  } catch (popupErr: unknown) {
    logAuthError("signInWithPopup", popupErr);
    runner.onError?.("signInWithPopup", popupErr);
    const errCode = fbCode(popupErr);

    // The user deliberately closed/cancelled the account chooser: never drag
    // them into a full-page redirect — stay on step 1 and offer a retry.
    if (CANCELLED_CODES.includes(errCode ?? "")) {
      return { kind: "user-cancelled" };
    }

    // A redirect would fail identically: this is a Firebase-console setup
    // problem (Authorized domains), so surface it instead of retrying.
    if (errCode === "auth/unauthorized-domain") {
      return { kind: "unauthorized-domain" };
    }

    // Popup blocked or unsupported environment (mobile web view, headless,
    // pop-up blocker): fall back to the full-page redirect.
    logAuthInfo("google", "popup blocked/unsupported → falling back to signInWithRedirect");
    return startRedirect(runner);
  }

  // Strict gate: the wizard only advances with a valid Firebase user object.
  if (!cred?.user?.uid) {
    const error = new Error("Google sign-in resolved without a Firebase user");
    (error as { code?: string }).code = "auth/internal-error";
    logAuthError("signInWithPopup (no user)", error);
    runner.onError?.("signInWithPopup", error);
    return { kind: "failed", code: "unknown" };
  }

  return { kind: "signed-in", user: cred.user };
}
