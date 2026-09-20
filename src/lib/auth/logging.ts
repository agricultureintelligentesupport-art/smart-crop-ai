/**
 * Central, developer-facing auth logging.
 *
 * Every auth failure (popup blocked, unauthorized domain, cancelled sign-in,
 * network drop…) is logged with its exact Firebase code plus an actionable
 * hint, so the browser console alone is enough to diagnose what happened —
 * e.g. `auth/unauthorized-domain` tells you exactly which console setting to
 * change. The user-facing copy lives in `copy.ts` and is chosen separately.
 */

const HINTS: Record<string, string> = {
  "auth/unauthorized-domain":
    "This site's domain is not authorized for Firebase Auth. Add it — the exact origin you are browsing from, including http://localhost for local dev — under Firebase Console → Authentication → Settings → Authorized domains, then retry.",
  "auth/popup-blocked":
    "The browser blocked the Google sign-in popup (popup blocker, kiosk mode or a mobile web view). The flow falls back to signInWithRedirect().",
  "auth/operation-not-supported-in-this-environment":
    "This environment cannot open the Google popup (headless browser, sandboxed iframe, some mobile web views). The flow falls back to signInWithRedirect().",
  "auth/popup-closed-by-user":
    "The user closed the Google popup before finishing sign-in. Nothing to fix — the UI offers a retry.",
  "auth/cancelled-popup-request":
    "The user dismissed the Google account chooser. Nothing to fix — the UI offers a retry.",
  "auth/cancelled-redirect":
    "The user cancelled the Google sign-in redirect. Nothing to fix — the UI offers a retry.",
  "auth/redirect-operation-in-progress":
    "Another redirect sign-in is still pending; wait for it to finish before retrying.",
  "auth/network-request-failed":
    "The request to the Google/Firebase endpoint failed (offline, DNS, CORS or an ad/tracker blocker).",
  "auth/invalid-credential":
    "The Google credential was rejected (expired, or from a different Firebase project).",
  "auth/iframe-parent-unsupported":
    "The app is embedded in an iframe that Google does not allow popups/redirects from.",
};

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "unknown-code";
}

/**
 * Logs an auth failure with its code and an actionable hint.
 *
 * @param scope short label of the failing step, e.g. `signInWithPopup`,
 *              `signInWithRedirect`, `getRedirectResult`, `userDoc users/{uid}`.
 */
export function logAuthError(scope: string, error: unknown): void {
  const code = codeOf(error);
  const hint = HINTS[code];
  const origin = typeof window !== "undefined" ? window.location.origin : "server";
  console.error(`[auth] ${scope} failed — ${code} (origin: ${origin})`, hint ? `Hint: ${hint}` : "", error);
}

/** Informational auth step logging (sign-in complete, fallback started…). */
export function logAuthInfo(scope: string, message: string): void {
  console.info(`[auth] ${scope}: ${message}`);
}
