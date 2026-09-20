import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

/**
 * Firebase web config is not a secret, but it still must describe the same
 * project as the Firebase Console. In particular, silently swapping to a
 * second project makes a successful Google flow look like "no users" in the
 * console the developer is watching.
 *
 * These values mirror .env.example and exist only as a development fallback
 * for the repository's local demo/e2e server. The fallback is reported by
 * `firebaseRuntimeConfig`; production never uses it.
 */
export const BUNDLED_DEVELOPMENT_CONFIG = {
  apiKey: "AIzaSyAbb9aCsOfMkw9G5H0L58LSkbsONhix51k",
  authDomain: "agriculture-intelligente-7873e.firebaseapp.com",
  projectId: "agriculture-intelligente-7873e",
  storageBucket: "agriculture-intelligente-7873e.firebasestorage.app",
  messagingSenderId: "213483282746",
  appId: "1:213483282746:web:badde539687095497a7003",
  measurementId: "G-VKD4SWJLNJ",
} as const;

/** Kept as a compatibility alias for callers that imported the old constant. */
export const DEFAULT_FIREBASE_CONFIG = BUNDLED_DEVELOPMENT_CONFIG;

const environmentConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim() ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim() ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET?.trim() ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID?.trim() ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim() ?? "",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID?.trim() ?? "",
};

const requiredEnvironmentKeys = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

const requiredEnvironmentValues: Record<(typeof requiredEnvironmentKeys)[number], string> = {
  NEXT_PUBLIC_FIREBASE_API_KEY: environmentConfig.apiKey,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: environmentConfig.authDomain,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: environmentConfig.projectId,
  NEXT_PUBLIC_FIREBASE_APP_ID: environmentConfig.appId,
};
const missingEnvironmentKeys = requiredEnvironmentKeys.filter(
  (key) => !requiredEnvironmentValues[key],
);
const allEnvironmentValuesMissing = missingEnvironmentKeys.length === requiredEnvironmentKeys.length;

/**
 * Never use the development fallback in a production build. A partially
 * configured environment is also never completed with fallback values: that
 * would silently point Auth at the wrong Firebase project.
 */
const useDevelopmentFallback = allEnvironmentValuesMissing && process.env.NODE_ENV !== "production";
const hasCompleteEnvironmentConfig = missingEnvironmentKeys.length === 0;
const hasUsableConfig = hasCompleteEnvironmentConfig || useDevelopmentFallback;

const firebaseConfig = useDevelopmentFallback
  ? BUNDLED_DEVELOPMENT_CONFIG
  : {
      ...environmentConfig,
      // Keep the FirebaseOptions shape stable while the diagnostics explain
      // which required values are missing.
      apiKey: environmentConfig.apiKey,
      authDomain: environmentConfig.authDomain,
      projectId: environmentConfig.projectId,
      appId: environmentConfig.appId,
    };

function makeConfigurationError(): Error & { code: string } {
  const error = new Error(
    `Firebase runtime configuration is incomplete. Set ${missingEnvironmentKeys.join(", ")} before starting the app.`,
  ) as Error & { code: string };
  error.code = "auth/configuration-missing";
  return error;
}

function errorDetails(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  const message = (error as { message?: unknown } | null)?.message;
  return {
    code: typeof code === "string" && code ? code : "auth/initialization-failed",
    message:
      typeof message === "string" && message
        ? message
        : error instanceof Error
          ? error.message
          : String(error),
  };
}

/**
 * One Google provider for every sign-in entry point (popup AND redirect).
 * `prompt=select_account` also makes it clear which account was selected
 * while diagnosing a project mismatch.
 */
function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

let app: FirebaseApp = {} as FirebaseApp;
let auth: Auth = {} as Auth;
let db: Firestore = {} as Firestore;
let initializationError: { code: string; message: string } | null = null;

try {
  if (!hasUsableConfig) throw makeConfigurationError();
  app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} catch (error) {
  // Do not retry with another project. The previous implementation did that,
  // which hid invalid/missing deployment configuration and sent developers to
  // the wrong Firebase Console project.
  initializationError = errorDetails(error);
}

const effectiveSource = hasCompleteEnvironmentConfig
  ? "environment"
  : useDevelopmentFallback
    ? "development-fallback"
    : "incomplete";

/** Safe-to-render diagnostics: API keys are never included in this object. */
export const firebaseRuntimeConfig = Object.freeze({
  source: effectiveSource as "environment" | "development-fallback" | "incomplete",
  configured: hasCompleteEnvironmentConfig,
  ready: Boolean((auth as { app?: unknown }).app),
  missingEnvironmentKeys: [...missingEnvironmentKeys],
  apiKeyLoaded: Boolean(environmentConfig.apiKey),
  authDomain: firebaseConfig.authDomain || null,
  projectId: firebaseConfig.projectId || null,
  initializationError,
});

const googleProvider = createGoogleProvider();

export {
  app,
  auth,
  db,
  db as firestore,
  googleProvider,
  GoogleAuthProvider,
  initializeApp,
  getAuth,
  getFirestore,
  firebaseConfig,
};

export default app;
