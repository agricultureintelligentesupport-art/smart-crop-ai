/**
 * Auth gateway factory.
 *
 * The UI never talks to an SDK directly: it calls the `AuthGateway` interface.
 * Today that interface is fulfilled by `createDemoGateway()` below, which runs
 * the whole flow on-device so every button is genuinely interactive before the
 * backend exists. Swap in Firebase without touching a single component:
 *
 *   1. npm i firebase
 *   2. copy `docs/firebase-adapter.md` → `src/lib/auth/firebase-adapter.ts`
 *   3. flip the two commented lines in `createAuthGateway()` below
 *
 * Every method on the demo gateway carries the exact Firebase call it stands
 * in for, so the mapping stays obvious.
 */

import { getWilaya } from "@/lib/wilayas";
import {
  readAuthBackendRaw,
  readFirebaseEnv,
  resolveFirebaseEnv,
} from "@/lib/firebase-env";
import { createFirebaseAuthGateway } from "./firebase-adapter";
import {
  AuthError,
  type AuthGateway,
  type OtpChallenge,
  type ProfilePatch,
  type SessionUser,
  type SignUpInput,
} from "./types";
import {
  OTP_LENGTH,
  OTP_RESEND_MS,
  OTP_TTL_MS,
  isValidDzMobile,
  isValidEmail,
  normalizeDzPhone,
  passwordStrength,
  toE164,
} from "./validation";

/** Code accepted by the on-device gateway. */
export const DEMO_OTP = "123456";

const USERS_KEY = "smart-crop.auth.users.v1";
const LATENCY_MS = 620;

interface DemoUser {
  uid: string;
  displayName: string;
  email?: string;
  phone?: string;
  /** Demo-only digest. Firebase Auth owns real credentials; never ship this. */
  passwordHash?: string;
  role: SessionUser["role"];
  wilayaCode: string | null;
}

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function fail(code: AuthError["code"]): never {
  throw new AuthError(code);
}

/** FNV-1a. Explicitly *not* security: it only keeps plain text out of devtools. */
function digest(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function passwordHash(uid: string, password: string): string {
  return `${digest(`${uid}:${password}`)}${digest(`${password}:${uid}`)}`;
}

function readUsers(): Record<string, DemoUser> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(USERS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, DemoUser>) : {};
  } catch {
    return {};
  }
}

function writeUsers(users: Record<string, DemoUser>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USERS_KEY, JSON.stringify(users));
  } catch {
    /* storage full / disabled: the session stays in memory only */
  }
}

function makeUid(seed: string): string {
  return `local_${digest(`${seed}:${Date.now()}`)}`;
}

function toSession(user: DemoUser, method: SessionUser["method"]): SessionUser {
  return {
    uid: user.uid,
    method,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    wilayaCode: user.wilayaCode,
    isGuest: false,
  };
}

export function createDemoGateway(): AuthGateway {
  return {
    id: "demo",
    isDemo: true,
    demoOtp: DEMO_OTP,

    /**
     * On-device stand-in for Google sign-in (kept for the AuthGateway
     * interface). NOTE: `useAuthFlow.handleGoogleAuth` never calls it — the
     * Google button ALWAYS performs real Firebase Auth (popup → redirect
     * fallback → getRedirectResult, see src/lib/auth/googleFlow.ts) so the
     * wizard can only advance with a real Firebase user. See
     * `docs/firebase-adapter.md` §7.
     */
    async signInWithGoogle() {
      const users = readUsers();
      const key = "google.demo@smart-crop.local";
      const existing = users[key];
      const user: DemoUser =
        existing ??
        {
          uid: makeUid(key),
          displayName: "Google demo",
          email: "google.demo@smart-crop.local",
          role: null,
          wilayaCode: null,
        };
      users[key] = user;
      writeUsers(users);
      return delay(toSession(user, "google"));
    },

    /**
     * Firebase: `new RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" })`
     * then `signInWithPhoneNumber(auth, phoneE164, verifier)` → keep the
     * returned `ConfirmationResult` as the challenge handle.
     */
    async sendOtp(phoneE164: string) {
      const digits = normalizeDzPhone(phoneE164);
      if (!isValidDzMobile(digits)) fail("invalid-input");
      const now = Date.now();
      const challenge: OtpChallenge = {
        requestId: `otp_${digest(`${phoneE164}:${now}`)}`,
        phone: toE164(digits),
        expiresAt: now + OTP_TTL_MS,
        resendAt: now + OTP_RESEND_MS,
      };
      // A real gateway would persist the pending challenge on the server.
      return delay(challenge, 780);
    },

    /**
     * Firebase: `confirmationResult.confirm(code)` — the SDK validates expiry
     * and attempt limits, which is why those branches are emulated here.
     */
    async verifyOtp(challenge: OtpChallenge, code: string) {
      if (Date.now() > challenge.expiresAt) fail("code-expired");
      if (code.replace(/\D/g, "").length !== OTP_LENGTH) fail("invalid-input");
      await delay(null, 700);
      if (code !== DEMO_OTP) fail("invalid-code");

      const users = readUsers();
      const key = challenge.phone.toLowerCase();
      const user: DemoUser =
        users[key] ??
        {
          uid: makeUid(key),
          displayName: `فلاح ${normalizeDzPhone(challenge.phone).slice(-4)}`,
          phone: challenge.phone,
          role: null,
          wilayaCode: null,
        };
      users[key] = user;
      writeUsers(users);
      return toSession(user, "phone");
    },

    /** Firebase: `signInWithEmailAndPassword(auth, email, password)`. */
    async signInWithEmail(email: string, password: string) {
      const key = email.trim().toLowerCase();
      if (!isValidEmail(key)) fail("invalid-input");
      const users = readUsers();
      const user = users[key];
      await delay(null, 680);
      if (!user) fail("user-not-found");
      if (passwordHash(user.uid, password) !== user.passwordHash) fail("wrong-password");
      return toSession(user, "email");
    },

    /** Firebase: `createUserWithEmailAndPassword(...)` + `updateProfile(...)`. */
    async registerWithEmail({ displayName, email, password }: SignUpInput) {
      const key = email.trim().toLowerCase();
      if (!isValidEmail(key)) fail("invalid-input");
      if (!displayName.trim()) fail("invalid-input");
      if (!passwordStrength(password).acceptable) fail("invalid-input");

      const users = readUsers();
      if (users[key]) fail("email-in-use");

      const uid = makeUid(key);
      const user: DemoUser = {
        uid,
        displayName: displayName.trim(),
        email: key,
        passwordHash: passwordHash(uid, password),
        role: null,
        wilayaCode: null,
      };
      users[key] = user;
      writeUsers(users);
      return delay(toSession(user, "email"));
    },

    /** Firebase: `sendPasswordResetEmail(auth, email)`. */
    async requestPasswordReset(email: string) {
      if (!isValidEmail(email)) fail("invalid-input");
      return delay(undefined, 640);
    },

    /**
     * Firebase: `setDoc(doc(db, "users", uid), patch, { merge: true })`.
     * Here it merges into the on-device user record so role + wilaya survive
     * the redirect into the dashboard.
     */
    async saveProfile(uid: string, patch: ProfilePatch) {
      const users = readUsers();
      const entry = Object.values(users).find((u) => u.uid === uid);
      if (!entry) fail("user-not-found");
      if (patch.displayName !== undefined) entry.displayName = patch.displayName;
      if (patch.role !== undefined) entry.role = patch.role;
      if (patch.wilayaCode !== undefined && getWilaya(patch.wilayaCode)) {
        entry.wilayaCode = patch.wilayaCode;
      }
      writeUsers(users);
      return delay(toSession(entry, "email"), 420);
    },

    /** Firebase: `signOut(auth)`. */
    async signOut() {
      return delay(undefined, 220);
    },
  };
}

let gateway: AuthGateway | null = null;

/**
 * Resolves `NEXT_PUBLIC_AUTH_BACKEND` (trimmed, case-insensitive, `auto`
 * supported) against the `NEXT_PUBLIC_FIREBASE_*` environment, and explains the
 * outcome. An unrecognised value no longer silently disables the switch: it
 * falls back to the demo gateway with a warning naming the offending value, and
 * "auto" picks Firebase only when the config is complete.
 */
export function resolveGatewayBackend() {
  return resolveFirebaseEnv(readFirebaseEnv(), readAuthBackendRaw());
}

/** Single app-wide gateway instance (module-level so hot reloads do not churn it). */
export function createAuthGateway(): AuthGateway {
  if (gateway) return gateway;
  const env = resolveGatewayBackend();
  gateway = env.backend === "firebase" ? createFirebaseAuthGateway() : createDemoGateway();
  const line = `[auth] gateway: ${env.backend} — ${env.backendNote}`;
  if (env.backendSource === "unknown" || env.backendSource === "default") console.warn(line);
  else console.info(line);
  return gateway;
}

export { AuthError } from "./types";
