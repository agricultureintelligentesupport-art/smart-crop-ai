import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  type Auth,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { logAuthError, logAuthInfo } from "./auth/logging";
import {
  FALLBACK_FIREBASE_CONFIG,
  firebaseDiagnostics,
  formatDiagnostics,
  logFirebaseDiagnostics,
  readAuthBackendRaw,
  readFirebaseEnv,
  resolveFirebaseEnv,
  type FirebaseBackend,
  type FirebaseDiagnosticLine,
  type FirebaseEnvResolution,
  type FirebaseRuntimeInfo,
} from "./firebase-env";

/* ------------------------------------------------------------------ */
/*  Environment (NEXT_PUBLIC_FIREBASE_* + NEXT_PUBLIC_AUTH_BACKEND)    */
/* ------------------------------------------------------------------ */

/**
 * Resolution of the runtime environment, computed once per process/bundle.
 * `process.env.NEXT_PUBLIC_*` is inlined statically by Next.js, so this is the
 * same config on the server and in the browser — exactly what Firebase needs
 * (otherwise Auth replays its redirect with a different project and the
 * credential is rejected).
 */
export const firebaseEnv: FirebaseEnvResolution = resolveFirebaseEnv(
  readFirebaseEnv(),
  readAuthBackendRaw(),
);

/** Config handed to `initializeApp()` — env values with documented fallbacks. */
export const firebaseConfig = firebaseEnv.config;

/** Kept for backwards compatibility; identical to `FALLBACK_FIREBASE_CONFIG`. */
export const DEFAULT_FIREBASE_CONFIG = FALLBACK_FIREBASE_CONFIG;

/** Which gateway the app should use: real Firebase Auth or the demo one. */
export const authBackend: FirebaseBackend = firebaseEnv.backend;
export const isFirebaseBackend = authBackend === "firebase";

/* ------------------------------------------------------------------ */
/*  SDK singletons                                                     */
/* ------------------------------------------------------------------ */

let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let firestoreInstance: Firestore | null = null;

try {
  if (getApps().length > 0) {
    appInstance = getApp();
  } else if (firebaseConfig.apiKey) {
    appInstance = initializeApp(firebaseConfig);
  }
} catch (error) {
  // Never let a bad environment break rendering: the auth UI reports the
  // missing configuration instead (see the diagnostics panel).
  appInstance = null;
  logAuthError("initializeApp", error);
}

if (appInstance) {
  try {
    authInstance = getAuth(appInstance);
  } catch (error) {
    authInstance = null;
    logAuthError("getAuth", error);
  }
  try {
    firestoreInstance = getFirestore(appInstance);
  } catch (error) {
    firestoreInstance = null;
    logAuthError("getFirestore", error);
  }
}

/**
 * The real SDK handles, or inert placeholders when the environment could not
 * produce an app (SSR with an empty config, malformed values…). Consumers
 * guard with `isAuthReady()` / `isFirestoreReady()` before every call.
 */
export const app = (appInstance ?? {}) as FirebaseApp;
export const auth = (authInstance ?? {}) as Auth;
export const db = (firestoreInstance ?? {}) as Firestore;

/** True when `auth` is a live Firebase Auth instance (not the empty stand-in). */
export function isAuthReady(candidate: unknown = auth): boolean {
  return Boolean(candidate && (candidate as { app?: unknown }).app);
}

/** True when `db` is a live Firestore instance (not the empty stand-in). */
export function isFirestoreReady(candidate: unknown = db): boolean {
  return Boolean(candidate && (candidate as { app?: unknown }).app);
}

/**
 * One Google provider for every sign-in entry point (popup AND redirect).
 *
 * `prompt: select_account` forces Google's account chooser, so clicking
 * "Continue with Google" always shows the account selection screen instead of
 * silently re-using the previously signed-in account.
 */
function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

export const googleProvider = createGoogleProvider();

/* ------------------------------------------------------------------ */
/*  Session persistence                                                */
/* ------------------------------------------------------------------ */

export type PersistenceState = "idle" | "pending" | "enabled" | "failed" | "unsupported";

let persistenceState: PersistenceState = "idle";
let persistenceError: string | null = null;
let persistenceTask: Promise<boolean> | null = null;

export interface PersistenceReport {
  state: PersistenceState;
  error: string | null;
}

/** Snapshot for the diagnostics panel. */
export function authPersistenceReport(): PersistenceReport {
  return { state: persistenceState, error: persistenceError };
}

/**
 * `setPersistence(auth, browserLocalPersistence)` — awaited before every
 * `signInWithPopup` / `signInWithRedirect`, because a redirect that leaves the
 * page with the default (in-memory) persistence loses the session on the way
 * back: Firebase then replays the credential into an auth instance that cannot
 * store it and the user lands back on step 1 silently.
 *
 * Cached after the first success; a failure clears the cache so the next
 * attempt retries (Safari private mode, blocked IndexedDB…). Never throws:
 * sign-in is still possible in-memory, it just will not survive a reload.
 */
export function ensureAuthPersistence(scope = "auth/setPersistence"): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false); // server: nothing to persist
  if (!isAuthReady()) {
    persistenceState = "unsupported";
    persistenceError = "Firebase Auth is not initialised";
    return Promise.resolve(false);
  }
  if (persistenceState === "enabled") return Promise.resolve(true);

  if (!persistenceTask) {
    persistenceState = "pending";
    persistenceTask = setPersistence(auth, browserLocalPersistence)
      .then(() => {
        persistenceState = "enabled";
        persistenceError = null;
        logAuthInfo(scope, "browserLocalPersistence enabled before the sign-in attempt");
        return true;
      })
      .catch((error: unknown) => {
        persistenceState = "failed";
        persistenceError = error instanceof Error ? error.message : String(error);
        logAuthError(`${scope} browserLocalPersistence`, error);
        persistenceTask = null; // allow a retry on the next attempt
        return false;
      });
  }
  return persistenceTask;
}

/* ------------------------------------------------------------------ */
/*  Diagnostics                                                        */
/* ------------------------------------------------------------------ */

/** Browser facts the diagnostics need (empty object during SSR). */
export function firebaseRuntimeInfo(): FirebaseRuntimeInfo {
  if (typeof window === "undefined") return {};
  let inIframe = false;
  try {
    inIframe = window.self !== window.top;
  } catch {
    inIframe = true; // cross-origin parent: definitely framed
  }
  return {
    origin: window.location.origin,
    hostname: window.location.hostname,
    inIframe,
  };
}

/**
 * Everything needed to explain a failed sign-in on screen: which backend is
 * active, which project/authDomain/origin are in play, whether the origin is
 * likely authorized, whether the page is framed, which env keys fell back and
 * whether local session persistence could be enabled.
 */
export function firebaseDiagnosticLines(scope = "runtime"): FirebaseDiagnosticLine[] {
  const lines = firebaseDiagnostics(firebaseEnv, firebaseRuntimeInfo());
  const persistence = authPersistenceReport();
  lines.push({
    label: "persistence",
    value:
      persistence.state === "enabled"
        ? "browserLocalPersistence enabled"
        : persistence.state === "failed"
          ? `browserLocalPersistence failed: ${persistence.error ?? "unknown error"}`
          : persistence.state === "unsupported"
            ? "browserLocalPersistence not attempted (Firebase Auth unavailable)"
            : "browserLocalPersistence not attempted yet",
    tone: persistence.state === "failed" || persistence.state === "unsupported" ? "warn" : "info",
  });
  if (scope) lines.push({ label: "scope", value: scope, tone: "info" });
  return lines;
}

/** `formatDiagnostics` re-export so the UI does not import two modules. */
export { formatDiagnostics, logFirebaseDiagnostics };

let diagnosticsLogged = false;

/**
 * Logs the diagnostics table exactly once per page load. Safe during render
 * effects and in dev — uses `console.info`/`console.warn`, never
 * `console.error`, so a healthy app keeps a clean console.
 */
export function logFirebaseDiagnosticsOnce(scope = "startup"): void {
  if (diagnosticsLogged) return;
  diagnosticsLogged = true;
  logFirebaseDiagnostics(firebaseEnv, firebaseRuntimeInfo(), scope);
}

/* ------------------------------------------------------------------ */
/*  Re-exports (SDK surface used across the app)                       */
/* ------------------------------------------------------------------ */

export {
  GoogleAuthProvider,
  initializeApp,
  getAuth,
  getFirestore,
  readFirebaseEnv,
  resolveFirebaseEnv,
  firebaseDiagnostics,
};

export default app;
