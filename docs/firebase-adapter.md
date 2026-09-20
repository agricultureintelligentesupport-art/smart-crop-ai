# Wiring Firebase Auth

The auth flow never talks to an SDK directly. Every screen calls the
`AuthGateway` interface in `src/lib/auth/types.ts`, which today is fulfilled by
`createDemoGateway()`. Swapping in Firebase means adding one file and flipping
one line — no component changes, no prop drilling, no new state.

## 1. Where the seam is

```
components/auth/**
        │  (handleGoogleAuth / handleSendOTP / handleVerifyOTP / handleEmailAuth)
        ▼
src/lib/auth/useAuthFlow.ts      ← validation, step navigation, error mapping
        ▼
AuthGateway  (src/lib/auth/types.ts)
        ├── createDemoGateway()      ← ships today, runs on-device
        └── createFirebaseAuthGateway()   ← this document
```

`useAuthFlow` only knows the interface: it awaits a `SessionUser`, an
`OtpChallenge` or an `AuthErrorCode`. Anything the SDK throws is funnelled
through `toAuthErrorCode()` so the copy table keeps working.

## 2. Install and configure

```bash
npm i firebase
```

`.env.local` (already git-ignored):

```bash
NEXT_PUBLIC_AUTH_BACKEND=firebase
NEXT_PUBLIC_FIREBASE_API_KEY=…
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=smart-crop-ai.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=smart-crop-ai
NEXT_PUBLIC_FIREBASE_APP_ID=…
```

Enable in the Firebase console: **Google**, **Phone** (add your SHA-1 for
Android; for web add the hostnames under *Authorized domains*, including the
Arena preview host `*.e2b.app`), and **Email/Password**.

## 3. `src/lib/auth/firebase-adapter.ts`

```ts
"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  RecaptchaVerifier,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  updateProfile,
  type ConfirmationResult,
} from "firebase/auth";
import { doc, getDoc, getFirestore, setDoc } from "firebase/firestore";
import { AuthError, type AuthGateway, type OtpChallenge, type ProfilePatch } from "./types";
import { isValidDzMobile, normalizeDzPhone, toE164 } from "./validation";

const app = getApps().length ? getApp() : initializeApp({ /* NEXT_PUBLIC_FIREBASE_* */ });
const auth = getAuth(app);
const db = getFirestore(app);

/**
 * One shared Google provider for popup AND redirect. `prompt:
 * select_account` forces the Google account chooser on every sign-in, so the
 * account selection screen is always shown instead of silently re-using the
 * previously signed-in account.
 */
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

/** The demo challenge carries the ConfirmationResult that Firebase returns. */
type FirebaseChallenge = OtpChallenge & { result: ConfirmationResult };

/** Firebase error codes → the codes the UI already localises. */
const CODE_MAP: Record<string, ConstructorParameters<typeof AuthError>[0]> = {
  "auth/invalid-email": "invalid-input",
  "auth/email-already-in-use": "email-in-use",
  "auth/user-not-found": "user-not-found",
  "auth/wrong-password": "wrong-password",
  "auth/invalid-credential": "wrong-password",
  "auth/invalid-verification-code": "invalid-code",
  "auth/code-expired": "code-expired",
  "auth/too-many-requests": "too-many-requests",
  "auth/popup-closed-by-user": "popup-closed",
  "auth/network-request-failed": "network",
};

const rethrow = (error: unknown): never => {
  const code = (error as { code?: string })?.code ?? "";
  throw new AuthError(CODE_MAP[code] ?? "unknown", code);
};

async function loadProfile(uid: string) {
  const snap = await getDoc(doc(db, "users", uid));
  return (snap.exists() ? snap.data() : {}) as { role?: never; wilayaCode?: string };
}

export function createFirebaseAuthGateway(): AuthGateway {
  return {
    id: "firebase",
    isDemo: false,

    /** handleGoogleAuth → signInWithPopup; the popup needs a user gesture. */
    async signInWithGoogle() {
      try {
        await setPersistence(auth, browserLocalPersistence);
        const cred = await signInWithPopup(auth, googleProvider);
        const data = await loadProfile(cred.user.uid);
        return {
          uid: cred.user.uid,
          method: "google",
          displayName: cred.user.displayName ?? "",
          email: cred.user.email ?? undefined,
          role: data.role ?? null,
          wilayaCode: data.wilayaCode ?? null,
          isGuest: false,
        };
      } catch (error) {
        return rethrow(error);
      }
    },

    /** handleSendOTP → invisible reCAPTCHA + signInWithPhoneNumber. */
    async sendOtp(phoneE164: string) {
      const digits = normalizeDzPhone(phoneE164);
      if (!isValidDzMobile(digits)) throw new AuthError("invalid-input");
      const phone = toE164(digits);
      try {
        // Render one invisible verifier into <div id="recaptcha-container" /> on /auth.
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
        return rethrow(error);
      }
    },

    /** handleVerifyOTP → confirmationResult.confirm(code). */
    async verifyOtp(challenge: OtpChallenge, code: string) {
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
          wilayaCode: data.wilayaCode ?? null,
          isGuest: false,
        };
      } catch (error) {
        return rethrow(error);
      }
    },

    /** handleEmailAuth (sign-in branch). */
    async signInWithEmail(email: string, password: string) {
      try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        const data = await loadProfile(cred.user.uid);
        return {
          uid: cred.user.uid,
          method: "email",
          displayName: cred.user.displayName ?? email.split("@")[0],
          email: cred.user.email ?? email,
          role: data.role ?? null,
          wilayaCode: data.wilayaCode ?? null,
          isGuest: false,
        };
      } catch (error) {
        return rethrow(error);
      }
    },

    /** handleEmailAuth (register branch). */
    async registerWithEmail({ displayName, email, password }) {
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(cred.user, { displayName });
        await setDoc(doc(db, "users", cred.user.uid), { displayName, email }, { merge: true });
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
        return rethrow(error);
      }
    },

    async requestPasswordReset(email: string) {
      try {
        await sendPasswordResetEmail(auth, email);
      } catch (error) {
        rethrow(error);
      }
    },

    /** Step 2 + 3 land here: role and wilaya are merged into users/{uid}. */
    async saveProfile(uid: string, patch: ProfilePatch) {
      const user = auth.currentUser;
      if (!user || user.uid !== uid) throw new AuthError("user-not-found");
      await setDoc(doc(db, "users", uid), patch, { merge: true });
      const data = await loadProfile(uid);
      return {
        uid: user.uid,
        method: "email",
        displayName: patch.displayName ?? user.displayName ?? "",
        email: user.email ?? undefined,
        role: patch.role ?? data.role ?? null,
        wilayaCode: patch.wilayaCode ?? data.wilayaCode ?? null,
        isGuest: false,
      };
    },

    async signOut() {
      await signOut(auth);
    },
  };
}
```

## 4. Flip the switch

`src/lib/auth/gateway.ts` already contains the exact two lines to uncomment:

```ts
import { createFirebaseAuthGateway } from "./firebase-adapter";

gateway =
  process.env.NEXT_PUBLIC_AUTH_BACKEND === "firebase"
    ? createFirebaseAuthGateway()
    : createDemoGateway();
```

## 5. Companion changes

| Concern | File | Note |
| --- | --- | --- |
| reCAPTCHA mount point | `src/components/auth/MethodStep.tsx` | add `<div id="recaptcha-container" />` once `isDemo` is false |
| Demo OTP hint | `MethodStep.tsx` | renders only while `gateway.isDemo` — disappears automatically |
| Session bootstrap | `src/lib/auth/profile.ts` | replace `useProfile()`'s localStorage read with `onAuthStateChanged` |
| Wilaya/role persistence | `src/lib/auth/useAuthFlow.ts` | `saveProfile()` already writes through the gateway |
| Firestore rules | Firebase console | `match /users/{uid} { allow read, write: if request.auth.uid == uid; }` |

## 6. Guest mode

`/guest` never touches the gateway: it writes a local record with
`uid: null, isGuest: true` (`guestProfile()`). To migrate a guest to a real
account later, call `linkWithCredential()` during `handleGoogleAuth` /
`handleVerifyOTP` — the `SessionUser` shape is identical, so the dashboard
needs no changes.

## 7. Google: strict auth, account chooser, popup blocked and mobile

**Strict rule:** the Google button ALWAYS performs real Firebase Auth — there
is no on-device/mock session for it (the demo gateway's `signInWithGoogle`
is kept for interface completeness but is never called by the flow). The
onboarding wizard advances ONLY when a valid Firebase `user` object comes
back, and the decision logic is a pure, unit-tested function:
`runGoogleSignIn()` in `src/lib/auth/googleFlow.ts`
(`test/unit/google-flow.unit.test.ts`).

`handleGoogleAuth` (in `useAuthFlow.ts`) wraps that runner around the shared
`googleProvider` from §2/§3:

1. **Account chooser** — the provider always carries
   `setCustomParameters({ prompt: "select_account" })`, so clicking
   "Continue with Google" opens the Google *account selection* screen.
2. **Popup first (desktop)** — `signInWithPopup(auth, googleProvider)`.
3. **Redirect fallback** — on `auth/popup-blocked`,
   `auth/operation-not-supported-in-this-environment` (or *first* on mobile
   browsers, detected via `isMobileBrowser()` in `src/lib/auth/platform.ts`)
   the flow calls `signInWithRedirect(auth, googleProvider)` instead. The
   result comes back with the next page load, where a mount effect calls
   `getRedirectResult(auth)` (resolves to `null` on normal loads) and runs
   the same post-sign-in work.
4. **User cancellation** — `auth/popup-closed-by-user`,
   `auth/cancelled-popup-request`, `auth/cancelled-redirect` and
   `auth/redirect-cancelled-by-user` never trigger a redirect; the user sees
   the localised "popup closed" copy under the button and can retry.
5. **Setup problems** — `auth/unauthorized-domain` (the current origin is not
   in *Firebase Console → Authentication → Settings → Authorized domains*)
   is reported with that exact instruction instead of retrying into the same
   failure.
6. **Profile document** — after *both* the popup and the redirect result,
   `syncUserDoc()` (in `src/lib/auth/userDoc.ts`) creates/merges
   `users/{uid}` with retries and backoff; a final failure is logged
   (`logAuthError`) and surfaced as a notice without killing the session.
7. **Logging** — every failure path goes through
   `logAuthError(scope, error)` (`src/lib/auth/logging.ts`), which prints the
   Firebase code, the page origin and an actionable hint (see the
   `HINTS` table), so the console alone explains what happened.
