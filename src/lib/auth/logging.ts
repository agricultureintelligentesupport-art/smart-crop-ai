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
    "This site's domain is not authorized for Firebase Auth. Add it — the exact origin you are browsing from, including the Arena preview host (*.e2b.app) and http://localhost for local dev — under Firebase Console → Authentication → Settings → Authorized domains, then retry.",
  "auth/popup-blocked":
    "The browser blocked the Google sign-in popup (popup blocker, kiosk mode or a mobile web view). The flow falls back to signInWithRedirect().",
  "auth/popup-blocked-by-browser":
    "The browser blocked the Google sign-in popup. The flow falls back to signInWithRedirect().",
  "auth/web-storage-unsupported":
    "This browser (or private mode) blocks cookies/IndexedDB, so browserLocalPersistence cannot be enabled. Sign-in may still work, but the session will not survive a reload — allow site data for this origin.",
  "auth/operation-not-allowed":
    "This sign-in provider is disabled in the Firebase project. Enable it under Firebase Console → Authentication → Sign-in method (Google / Phone / Email-Password).",
  "auth/configuration-not-found":
    "Firebase Auth has no configuration for this project/domain: check NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN and NEXT_PUBLIC_FIREBASE_PROJECT_ID (they must all belong to the same Firebase project).",
  "auth/invalid-api-key":
    "The API key was rejected: NEXT_PUBLIC_FIREBASE_API_KEY does not belong to the configured project, or the key is restricted in Google Cloud Console.",
  "auth/invalid-auth-domain":
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN is malformed (expected something like <project>.firebaseapp.com).",
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
    "The app is embedded in an iframe that Google does not allow popups/redirects from. Open the app in its own tab.",
  "auth/internal-error":
    "Firebase returned an internal error. Re-check the Firebase config (apiKey, authDomain, projectId) and the authorized domains, then retry.",
};

/** Actionable hint for a provider code, when one is known. */
export function hintForCode(code: string | undefined): string | undefined {
  return code ? HINTS[code] : undefined;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "unknown-code";
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) return "(no message)";
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

/**
 * Logs an auth failure with its code, its provider message and an actionable
 * hint — the console alone then explains what happened.
 *
 * @param scope short label of the failing step, e.g. `signInWithPopup`,
 *              `signInWithRedirect`, `getRedirectResult`, `userDoc users/{uid}`.
 */
export function logAuthError(scope: string, error: unknown): void {
  const code = codeOf(error);
  const hint = HINTS[code];
  const origin = typeof window !== "undefined" ? window.location.origin : "server";
  console.error(
    `[auth] ${scope} failed — ${code}: ${messageOf(error)} (origin: ${origin})`,
    hint ? `Hint: ${hint}` : "",
    error,
  );
}

/** Informational auth step logging (sign-in complete, fallback started…). */
export function logAuthInfo(scope: string, message: string): void {
  console.info(`[auth] ${scope}: ${message}`);
}
