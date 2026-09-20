/**
 * Firebase runtime environment resolution — the single place where
 * `NEXT_PUBLIC_FIREBASE_*` and `NEXT_PUBLIC_AUTH_BACKEND` are read, validated
 * and turned into (a) the `initializeApp()` config and (b) a human-readable
 * diagnostic report shown in the console and in the auth UI.
 *
 * Why a dedicated, dependency-free module:
 * - Next.js inlines `process.env.NEXT_PUBLIC_*` only for *static* property
 *   access, so every variable is read literally, once, in `readFirebaseEnv()`.
 * - Resolution is a pure function (`resolveFirebaseEnv`), so unit tests pin
 *   every branch (all-from-env, partial env, empty env, bad backend value)
 *   without touching the real process environment.
 * - `firebase.ts`, `gateway.ts` and the auth UI all consume the same report,
 *   instead of each re-implementing the "env first, documented fallback
 *   second" rule with slightly different semantics.
 *
 * Nothing here imports the Firebase SDK, so it stays loadable from plain Node
 * unit tests (`npm run test:unit`).
 */

/** Every runtime variable this app understands, in diagnostic order. */
export const FIREBASE_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
] as const;

export type FirebaseEnvKey = (typeof FIREBASE_ENV_KEYS)[number];

/** Raw environment snapshot (`undefined`/blank = "not provided"). */
export type FirebaseEnv = Partial<Record<FirebaseEnvKey, string | undefined>>;

/** The web config `initializeApp()` receives. */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId: string;
}

/**
 * Documented fallback project. It keeps `next build`, SSR and the Arena
 * preview alive when the runtime environment is incomplete; every value is
 * overridden by the matching `NEXT_PUBLIC_FIREBASE_*` variable, and the
 * diagnostics mark exactly which keys came from here instead of the env.
 */
export const FALLBACK_FIREBASE_CONFIG: FirebaseWebConfig = {
  apiKey: "AIzaSyAbb9aCsOfMkw9G5H0L58LSkbsONhix51k",
  authDomain: "agriculture-intelligente-7873e.firebaseapp.com",
  projectId: "agriculture-intelligente-7873e",
  storageBucket: "agriculture-intelligente-7873e.firebasestorage.app",
  messagingSenderId: "213483282746",
  appId: "1:213483282746:web:badde539687095497a7003",
  measurementId: "G-VKD4SWJLNJ",
};

interface EnvMeta {
  /** Short label used in the diagnostics table. */
  label: string;
  /** Key on `FirebaseWebConfig`. */
  field: keyof FirebaseWebConfig;
  /** Auth + Firestore cannot work without it. */
  required: boolean;
}

const ENV_META: Record<FirebaseEnvKey, EnvMeta> = {
  NEXT_PUBLIC_FIREBASE_API_KEY: { label: "apiKey", field: "apiKey", required: true },
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: { label: "authDomain", field: "authDomain", required: true },
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: { label: "projectId", field: "projectId", required: true },
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: {
    label: "storageBucket",
    field: "storageBucket",
    required: false,
  },
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: {
    label: "messagingSenderId",
    field: "messagingSenderId",
    required: false,
  },
  NEXT_PUBLIC_FIREBASE_APP_ID: { label: "appId", field: "appId", required: true },
  NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: {
    label: "measurementId",
    field: "measurementId",
    required: false,
  },
};

export type FirebaseEnvSource = "env" | "fallback" | "missing";

export interface FirebaseEnvEntry {
  key: FirebaseEnvKey;
  label: string;
  field: keyof FirebaseWebConfig;
  required: boolean;
  /** Trimmed value actually handed to the SDK. */
  value: string;
  source: FirebaseEnvSource;
}

export type FirebaseBackend = "firebase" | "demo";

export type FirebaseBackendSource = "env" | "auto" | "default" | "unknown";

export interface FirebaseEnvResolution {
  /** One row per variable — the diagnostics table. */
  entries: FirebaseEnvEntry[];
  /** Config handed to `initializeApp()` (fallbacks already merged in). */
  config: FirebaseWebConfig;
  /** Required variables that are NOT coming from the environment. */
  missingRequired: FirebaseEnvKey[];
  /** Variables that are not coming from the environment (required or not). */
  missingAll: FirebaseEnvKey[];
  /** True when every variable came from the runtime environment. */
  allFromEnv: boolean;
  /** True when the resolved project differs from the fallback project. */
  customProject: boolean;
  backend: FirebaseBackend;
  backendSource: FirebaseBackendSource;
  /** Human sentence explaining the backend decision (logged + shown in the UI). */
  backendNote: string;
  /** Auth + Firestore can be attempted (apiKey + authDomain + projectId + appId). */
  ready: boolean;
}

function clean(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Static reads — the exact shape Next.js can inline at build time. Never
 * replace these with `process.env[key]` (dynamic access is not inlined).
 */
export function readFirebaseEnv(): FirebaseEnv {
  return {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
  };
}

/** The raw `NEXT_PUBLIC_AUTH_BACKEND` value (inlined by Next.js). */
export function readAuthBackendRaw(): string | undefined {
  return process.env.NEXT_PUBLIC_AUTH_BACKEND;
}

/**
 * `NEXT_PUBLIC_AUTH_BACKEND` → gateway choice.
 *
 * - `firebase` → real Firebase Auth (recommended in production),
 * - `demo` (default when unset) → on-device gateway,
 * - `auto` → Firebase when a usable `NEXT_PUBLIC_FIREBASE_*` config exists,
 * - anything else → demo + a loud "unrecognised value" diagnostic.
 */
export function resolveAuthBackend(
  raw: string | undefined,
  config: Pick<FirebaseWebConfig, "apiKey" | "authDomain" | "projectId" | "appId">,
): Pick<FirebaseEnvResolution, "backend" | "backendSource" | "backendNote"> {
  const value = clean(raw).toLowerCase();
  const configured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);

  if (value === "firebase") {
    return {
      backend: "firebase",
      backendSource: "env",
      backendNote: 'NEXT_PUBLIC_AUTH_BACKEND="firebase" → real Firebase Auth.',
    };
  }
  if (value === "demo") {
    return {
      backend: "demo",
      backendSource: "env",
      backendNote: 'NEXT_PUBLIC_AUTH_BACKEND="demo" → on-device demo gateway.',
    };
  }
  if (value === "auto") {
    return configured
      ? {
          backend: "firebase",
          backendSource: "auto",
          backendNote: 'NEXT_PUBLIC_AUTH_BACKEND="auto" with a complete config → Firebase Auth.',
        }
      : {
          backend: "demo",
          backendSource: "auto",
          backendNote:
            'NEXT_PUBLIC_AUTH_BACKEND="auto" but the Firebase config is incomplete → demo gateway.',
        };
  }
  if (value) {
    return {
      backend: "demo",
      backendSource: "unknown",
      backendNote: `NEXT_PUBLIC_AUTH_BACKEND="${clean(raw)}" is not a known value (expected "firebase", "demo" or "auto") → demo gateway.`,
    };
  }
  return {
    backend: "demo",
    backendSource: "default",
    backendNote: configured
      ? 'NEXT_PUBLIC_AUTH_BACKEND is not set → demo gateway, although NEXT_PUBLIC_FIREBASE_* is configured. Set it to "firebase" to use Firebase Auth.'
      : 'NEXT_PUBLIC_AUTH_BACKEND is not set → demo gateway.',
  };
}

/** Pure resolution: raw env (+ backend string) in, config + diagnostics out. */
export function resolveFirebaseEnv(
  env: FirebaseEnv,
  backendRaw: string | undefined = undefined,
): FirebaseEnvResolution {
  const config = { ...FALLBACK_FIREBASE_CONFIG };
  const entries: FirebaseEnvEntry[] = FIREBASE_ENV_KEYS.map((key) => {
    const meta = ENV_META[key];
    const provided = clean(env[key]);
    const fallback = clean(FALLBACK_FIREBASE_CONFIG[meta.field]);
    const source: FirebaseEnvSource = provided ? "env" : fallback ? "fallback" : "missing";
    const value = provided || fallback;
    config[meta.field] = value;
    return { key, label: meta.label, field: meta.field, required: meta.required, value, source };
  });

  const missingAll = entries.filter((entry) => entry.source !== "env").map((entry) => entry.key);
  const missingRequired = entries
    .filter((entry) => entry.required && entry.source !== "env")
    .map((entry) => entry.key);
  const backend = resolveAuthBackend(backendRaw, config);

  return {
    entries,
    config,
    missingAll,
    missingRequired,
    allFromEnv: missingAll.length === 0,
    customProject: config.projectId !== FALLBACK_FIREBASE_CONFIG.projectId,
    ready: Boolean(config.apiKey && config.authDomain && config.projectId && config.appId),
    ...backend,
  };
}

/* ------------------------------------------------------------------ */
/*  Diagnostics                                                        */
/* ------------------------------------------------------------------ */

export type DiagnosticTone = "ok" | "info" | "warn" | "error";

export interface FirebaseDiagnosticLine {
  label: string;
  value: string;
  tone: DiagnosticTone;
}

export interface FirebaseRuntimeInfo {
  /** `window.location.origin`, when in a browser. */
  origin?: string;
  /** `window.location.hostname`, when in a browser. */
  hostname?: string;
  /** True when the app runs inside an iframe (Arena preview, embedded widget…). */
  inIframe?: boolean;
}

/** `AIza…` values are public in a web app, but never print them in full. */
export function redactFirebaseValue(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".local")
  );
}

/**
 * The single source for "why is Firebase Auth failing?" — env keys, backend,
 * project, origin and the two setup traps (authorized domains + iframes).
 */
export function firebaseDiagnostics(
  resolution: FirebaseEnvResolution,
  runtime: FirebaseRuntimeInfo = {},
): FirebaseDiagnosticLine[] {
  const lines: FirebaseDiagnosticLine[] = [
    {
      label: "backend",
      value: `${resolution.backend} (${resolution.backendSource})`,
      tone: resolution.backend === "firebase" ? "ok" : "warn",
    },
    { label: "projectId", value: resolution.config.projectId, tone: "info" },
    { label: "authDomain", value: resolution.config.authDomain, tone: "info" },
    { label: "apiKey", value: redactFirebaseValue(resolution.config.apiKey), tone: "info" },
  ];

  if (resolution.missingRequired.length > 0) {
    lines.push({
      label: "env",
      value: `missing/blank: ${resolution.missingRequired.join(", ")} → using the built-in fallback project`,
      tone: "warn",
    });
  } else if (resolution.allFromEnv) {
    lines.push({ label: "env", value: "all NEXT_PUBLIC_FIREBASE_* variables resolved from the environment", tone: "ok" });
  } else {
    lines.push({
      label: "env",
      value: `fallback values used for: ${resolution.missingAll.join(", ")}`,
      tone: "info",
    });
  }

  if (runtime.origin) {
    const authorized =
      isLocalHost(runtime.hostname ?? "") ||
      runtime.hostname === resolution.config.authDomain ||
      (runtime.hostname ?? "").endsWith(".firebaseapp.com") ||
      (runtime.hostname ?? "").endsWith(".web.app");
    lines.push({
      label: "origin",
      value: runtime.origin,
      tone: authorized ? "ok" : "warn",
    });
    if (!authorized) {
      lines.push({
        label: "authorized domains",
        value: `add "${runtime.origin}" to Firebase Console → Authentication → Settings → Authorized domains, otherwise Google sign-in fails with auth/unauthorized-domain`,
        tone: "warn",
      });
    }
  }

  if (runtime.inIframe) {
    lines.push({
      label: "iframe",
      value:
        "embedded in an iframe: Google popups/redirects are frequently blocked — open the app in its own tab if sign-in fails",
      tone: "warn",
    });
  }

  return lines;
}

const TONE_ORDER: DiagnosticTone[] = ["error", "warn", "info", "ok"];

function worstTone(lines: FirebaseDiagnosticLine[]): DiagnosticTone {
  for (const tone of TONE_ORDER) {
    if (lines.some((line) => line.tone === tone)) return tone;
  }
  return "info";
}

/** Console output for the diagnostics table — never `console.error` (a
 *  configured app load must not trip "no console errors" checks). */
export function logFirebaseDiagnostics(
  resolution: FirebaseEnvResolution,
  runtime: FirebaseRuntimeInfo = {},
  scope = "startup",
): FirebaseDiagnosticLine[] {
  const lines = firebaseDiagnostics(resolution, runtime);
  const tone = worstTone(lines);
  const text = lines.map((line) => `  ${line.label}: ${line.value}`).join("\n");
  const message = `[firebase] ${scope} diagnostics\n${text}`;
  if (tone === "warn" || tone === "error") console.warn(message);
  else console.info(message);
  return lines;
}

/** Multi-line text used by the "copy details" button in the auth UI. */
export function formatDiagnostics(lines: FirebaseDiagnosticLine[]): string {
  return lines.map((line) => `${line.label}: ${line.value}`).join("\n");
}
