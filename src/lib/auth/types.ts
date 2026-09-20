/**
 * Auth domain types shared by the UI, the demo gateway and the future
 * Firebase adapter (see `docs/firebase-adapter.md`).
 */

export type AuthMethod = "google" | "phone" | "email";

/** Which side of the email tab the user is on. */
export type EmailIntent = "signin" | "register";

export type AuthRole = "farmer" | "agronomist" | "investor";

export const AUTH_ROLES: readonly AuthRole[] = ["farmer", "agronomist", "investor"] as const;

export interface SessionUser {
  uid: string;
  method: AuthMethod;
  displayName: string;
  email?: string;
  phone?: string;
  /** Filled in during step 2 (null until then). */
  role: AuthRole | null;
  /** Wilaya code filled in during step 3 (null until then). */
  wilayaCode: string | null;
  isGuest: boolean;
}

/** Phone challenge returned by `sendOtp` and consumed by `verifyOtp`. */
export interface OtpChallenge {
  requestId: string;
  /** E.164 number the SMS was sent to, e.g. +213661223344. */
  phone: string;
  /** Epoch ms when the code stops being valid. */
  expiresAt: number;
  /** Epoch ms when a resend becomes possible. */
  resendAt: number;
  /** Confirmation handle when backed by Firebase. */
  result?: unknown;
}

export const AUTH_ERROR_CODES = [
  "invalid-input",
  "email-in-use",
  "user-not-found",
  "wrong-password",
  "invalid-code",
  "code-expired",
  "too-many-requests",
  "popup-closed",
  "network",
  "unknown",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** Thin wrapper so the UI can map failures onto localised copy. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AuthError";
    this.code = code;
  }
}

export function toAuthErrorCode(error: unknown): AuthErrorCode {
  if (error instanceof AuthError) return error.code;
  const fbCode = (error as { code?: string })?.code;
  if (typeof fbCode === "string") {
    switch (fbCode) {
      case "auth/invalid-email":
      case "auth/invalid-password":
        return "invalid-input";
      case "auth/email-already-in-use":
        return "email-in-use";
      case "auth/user-not-found":
        return "user-not-found";
      case "auth/wrong-password":
      case "auth/invalid-credential":
        return "wrong-password";
      case "auth/invalid-verification-code":
        return "invalid-code";
      case "auth/code-expired":
        return "code-expired";
      case "auth/too-many-requests":
        return "too-many-requests";
      case "auth/popup-closed-by-user":
        return "popup-closed";
      case "auth/network-request-failed":
        return "network";
      default:
        break;
    }
  }
  return "unknown";
}

export interface SignUpInput {
  displayName: string;
  email: string;
  password: string;
}

export interface ProfilePatch {
  role?: AuthRole;
  wilayaCode?: string;
  displayName?: string;
}

/**
 * The single seam between UI and identity provider.
 *
 * `DemoAuthGateway` implements it entirely on-device (see `gateway.ts`).
 * `docs/firebase-adapter.md` contains a drop-in Firebase implementation of the
 * exact same interface, so no component changes when the SDK is wired.
 */
export interface AuthGateway {
  readonly id: "demo" | "firebase";
  /** True when no real SMS / OAuth / server is involved. */
  readonly isDemo: boolean;
  /** Demo code surfaced in the UI when `isDemo` (never set by Firebase). */
  readonly demoOtp?: string;

  signInWithGoogle(): Promise<SessionUser>;
  sendOtp(phoneE164: string): Promise<OtpChallenge>;
  verifyOtp(challenge: OtpChallenge, code: string): Promise<SessionUser>;
  signInWithEmail(email: string, password: string): Promise<SessionUser>;
  registerWithEmail(input: SignUpInput): Promise<SessionUser>;
  requestPasswordReset(email: string): Promise<void>;
  saveProfile(uid: string, patch: ProfilePatch): Promise<SessionUser>;
  signOut(): Promise<void>;
}
