import type { User } from "firebase/auth";
import type { AuthMethod } from "./types";

/**
 * Google/redirect RETURN gate — pure and unit-testable.
 *
 * When the wizard loads there are three ways a sign-in can be waiting for
 * it, and they must resolve to exactly ONE completion:
 *
 *   1. `getRedirectResult()` — the credential that came back from Google's
 *      account chooser on this very page load (authoritative, always wins).
 *   2. `auth.currentUser` / `onAuthStateChanged` — a RESTORED session. The
 *      redirect payload can get lost while the Firebase user survives
 *      (the page reloaded mid-return, `sessionStorage` is partitioned in
 *      embedded previews, the handler came back on a slightly different
 *      URL, …). Without this safety net the wizard resets to step 1
 *      ("الطريقة") even though the user is genuinely signed in.
 *   3. The in-page popup — handled by `runGoogleSignIn` before this gate is
 *      ever consulted.
 *
 * The gate never signs anybody in: `complete` is only ever produced from a
 * real Firebase `User` carrying a `uid` — identical in spirit to the strict
 * entry gate in `googleFlow.ts`.
 */

export interface GoogleReturnInput {
  /** User returned by `getRedirectResult()` for this load, or null. */
  redirectUser: User | null;
  /** User Firebase Auth restored/holds (`auth.currentUser`), or null. */
  authedUser: User | null;
  /** uid already claimed/processed this mount (dedupes the competing paths). */
  handledUid: string | null;
  /** True while the e-mail/OTP handlers are mid sign-in: they own the session. */
  manualSignInActive: boolean;
  /** The wizard is still on step 1 ("method") — setup was never completed. */
  onMethodStep: boolean;
}

export type GoogleReturnDecision =
  | { kind: "complete"; user: User; source: "redirect" | "auth-state" }
  | {
      kind: "ignore";
      reason: "no-session" | "already-handled" | "manual-sign-in" | "not-method-step";
    };

export function resolveGoogleReturn(input: GoogleReturnInput): GoogleReturnDecision {
  // Strict: a "user" only counts when it carries a real uid.
  const redirectUser = input.redirectUser?.uid ? input.redirectUser : null;
  const authedUser = input.authedUser?.uid ? input.authedUser : null;

  const user = redirectUser ?? authedUser;
  if (!user) return { kind: "ignore", reason: "no-session" };
  if (user.uid === input.handledUid) return { kind: "ignore", reason: "already-handled" };

  // The redirect payload is a live, one-shot credential: capture it no
  // matter what the wizard is doing. Adopting a RESTORED session instead
  // must never hijack the e-mail/OTP forms, and only makes sense while the
  // wizard is still sitting on step 1.
  if (!redirectUser) {
    if (input.manualSignInActive) return { kind: "ignore", reason: "manual-sign-in" };
    if (!input.onMethodStep) return { kind: "ignore", reason: "not-method-step" };
  }

  return { kind: "complete", user, source: redirectUser ? "redirect" : "auth-state" };
}

/** Which sign-in method a Firebase user came from, based on its provider data. */
export function methodForFirebaseUser(user: Pick<User, "providerData" | "phoneNumber">): AuthMethod {
  const ids = user.providerData?.map((p) => p.providerId) ?? [];
  if (ids.includes("google.com")) return "google";
  if (ids.includes("phone") || user.phoneNumber) return "phone";
  return "email";
}
