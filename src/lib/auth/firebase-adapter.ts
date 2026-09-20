"use client";

import {
  RecaptchaVerifier,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  updateProfile,
  type ConfirmationResult,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db, ensureAuthPersistence, googleProvider } from "@/lib/firebase";
import { describeAuthError } from "./errorReport";
import {
  AuthError,
  type AuthGateway,
  type AuthRole,
  type OtpChallenge,
  type ProfilePatch,
  type SignUpInput,
  type SessionUser,
} from "./types";
import { isValidDzMobile, normalizeDzPhone, toE164 } from "./validation";
import { logAuthError, logAuthInfo } from "./logging";
import { syncUserDoc } from "./userDoc";
import { getWilaya } from "@/lib/wilayas";

type FirebaseChallenge = OtpChallenge & { result: ConfirmationResult };

/**
 * Converts an SDK rejection into an `AuthError` that keeps BOTH the localisable
 * app code and the raw provider facts (`error.code`, `error.message`), so the
 * UI panel can show exactly what Firebase said.
 */
function toAdapterError(error: unknown, scope: string): AuthError {
  const report = describeAuthError(error, scope);
  return new AuthError(report.appCode, report.message, report.code);
}

async function loadProfile(uid: string) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return (snap.exists() ? snap.data() : {}) as {
      role?: AuthRole;
      wilayaCode?: string;
      wilaya?: string;
      preferredCrop?: string;
      displayName?: string;
    };
  } catch {
    return {};
  }
}

export function createFirebaseAuthGateway(): AuthGateway {
  return {
    id: "firebase",
    isDemo: false,

    async signInWithGoogle(): Promise<SessionUser> {
      try {
        // Persistence FIRST: the popup/redirect session must be written to
        // localStorage, not just kept in memory for this page load.
        await ensureAuthPersistence("signInWithGoogle");
        const cred = await signInWithPopup(auth, googleProvider);
        logAuthInfo("signInWithPopup", `complete (uid ${cred.user.uid})`);
        // Reliable users/{uid} sync (merge + retry + logging) — the same
        // helper the popup and redirect paths in useAuthFlow use, so the
        // profile document is maintained identically on every entry point.
        const { ok, data, error } = await syncUserDoc(
          {
            uid: cred.user.uid,
            displayName: cred.user.displayName,
            email: cred.user.email,
            photoURL: cred.user.photoURL,
          },
          { lastLoginAt: new Date().toISOString() },
        );
        if (!ok) logAuthError("google-profile-sync", error);
        return {
          uid: cred.user.uid,
          method: "google",
          displayName: cred.user.displayName ?? data.displayName ?? "",
          email: cred.user.email ?? data.email ?? undefined,
          role: data.role ?? null,
          wilayaCode: data.wilayaCode ?? data.wilaya ?? null,
          isGuest: false,
        };
      } catch (error) {
        logAuthError("signInWithGoogle (gateway)", error);
        throw toAdapterError(error, "signInWithGoogle");
      }
    },

    async sendOtp(phoneE164: string): Promise<OtpChallenge> {
      const digits = normalizeDzPhone(phoneE164);
      if (!isValidDzMobile(digits)) throw new AuthError("invalid-input");
      const phone = toE164(digits);
      try {
        let container = document.getElementById("recaptcha-container");
        if (!container) {
          container = document.createElement("div");
          container.id = "recaptcha-container";
          document.body.appendChild(container);
        }
        const verifier = new RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" });
        const result = await signInWithPhoneNumber(auth, phone, verifier);
        const now = Date.now();
        return {
          requestId: result.verificationId,
          phone,
          expiresAt: now + 5 * 60 * 1000,
          resendAt: now + 30 * 1000,
          result,
        } satisfies FirebaseChallenge;
      } catch (error) {
        throw toAdapterError(error, "firebase/sendOtp");
      }
    },

    async verifyOtp(challenge: OtpChallenge, code: string): Promise<SessionUser> {
      const { result } = challenge as FirebaseChallenge;
      try {
        const cred = await result.confirm(code);
        const data = await loadProfile(cred.user.uid);
        return {
          uid: cred.user.uid,
          method: "phone",
          displayName: cred.user.displayName ?? `+${normalizeDzPhone(challenge.phone)}`,
          phone: cred.user.phoneNumber ?? challenge.phone,
          role: data.role ?? null,
          wilayaCode: data.wilayaCode ?? data.wilaya ?? null,
          isGuest: false,
        };
      } catch (error) {
        throw toAdapterError(error, "firebase/verifyOtp");
      }
    },

    async signInWithEmail(email: string, password: string): Promise<SessionUser> {
      try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        const data = await loadProfile(cred.user.uid);
        return {
          uid: cred.user.uid,
          method: "email",
          displayName: cred.user.displayName ?? data.displayName ?? email.split("@")[0],
          email: cred.user.email ?? email,
          role: data.role ?? null,
          wilayaCode: data.wilayaCode ?? data.wilaya ?? null,
          isGuest: false,
        };
      } catch (error) {
        throw toAdapterError(error, "firebase/signInWithEmail");
      }
    },

    async registerWithEmail({ displayName, email, password }: SignUpInput): Promise<SessionUser> {
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(cred.user, { displayName });
        await setDoc(
          doc(db, "users", cred.user.uid),
          {
            uid: cred.user.uid,
            displayName,
            email,
            role: null,
            wilaya: null,
            wilayaCode: null,
            preferredCrop: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { merge: true },
        );
        return {
          uid: cred.user.uid,
          method: "email",
          displayName,
          email,
          role: null,
          wilayaCode: null,
          isGuest: false,
        };
      } catch (error) {
        throw toAdapterError(error, "firebase/registerWithEmail");
      }
    },

    async requestPasswordReset(email: string): Promise<void> {
      try {
        await sendPasswordResetEmail(auth, email);
      } catch (error) {
        throw toAdapterError(error, "firebase/requestPasswordReset");
      }
    },

    async saveProfile(uid: string, patch: ProfilePatch): Promise<SessionUser> {
      const user = auth.currentUser;
      if (!user || user.uid !== uid) throw new AuthError("user-not-found");
      const wilayaData = patch.wilayaCode ? getWilaya(patch.wilayaCode) : null;
      const preferredCrop = wilayaData?.crops?.[0] ?? null;

      await setDoc(
        doc(db, "users", uid),
        {
          ...patch,
          wilaya: patch.wilayaCode,
          preferredCrop,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
      const data = await loadProfile(uid);
      return {
        uid: user.uid,
        method: "email",
        displayName: patch.displayName ?? user.displayName ?? "",
        email: user.email ?? undefined,
        role: patch.role ?? data.role ?? null,
        wilayaCode: patch.wilayaCode ?? data.wilayaCode ?? data.wilaya ?? null,
        isGuest: false,
      };
    },

    async signOut(): Promise<void> {
      if (auth && (auth as { app?: unknown }).app) {
        await signOut(auth);
      }
    },
  };
}
