"use client";

import {
  RecaptchaVerifier,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  updateProfile,
  type ConfirmationResult,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "@/lib/firebase";
import {
  AuthError,
  toAuthErrorCode,
  type AuthGateway,
  type AuthRole,
  type OtpChallenge,
  type ProfilePatch,
  type SignUpInput,
  type SessionUser,
} from "./types";
import { isValidDzMobile, normalizeDzPhone, toE164 } from "./validation";
import { getWilaya } from "@/lib/wilayas";

type FirebaseChallenge = OtpChallenge & { result: ConfirmationResult };

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
        if (typeof window !== "undefined") {
          try {
            await setPersistence(auth, browserLocalPersistence);
          } catch {
            // Browser environment may restrict 3rd-party persistence
          }
        }
        const cred = await signInWithPopup(auth, googleProvider);
        const data = await loadProfile(cred.user.uid);
        await setDoc(
          doc(db, "users", cred.user.uid),
          {
            uid: cred.user.uid,
            displayName: cred.user.displayName ?? data.displayName ?? "",
            email: cred.user.email ?? "",
            photoURL: cred.user.photoURL ?? null,
            lastLoginAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { merge: true },
        );
        return {
          uid: cred.user.uid,
          method: "google",
          displayName: cred.user.displayName ?? data.displayName ?? "",
          email: cred.user.email ?? undefined,
          role: data.role ?? null,
          wilayaCode: data.wilayaCode ?? data.wilaya ?? null,
          isGuest: false,
        };
      } catch (error) {
        throw new AuthError(toAuthErrorCode(error));
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
        throw new AuthError(toAuthErrorCode(error));
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
        throw new AuthError(toAuthErrorCode(error));
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
        throw new AuthError(toAuthErrorCode(error));
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
        throw new AuthError(toAuthErrorCode(error));
      }
    },

    async requestPasswordReset(email: string): Promise<void> {
      try {
        await sendPasswordResetEmail(auth, email);
      } catch (error) {
        throw new AuthError(toAuthErrorCode(error));
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
