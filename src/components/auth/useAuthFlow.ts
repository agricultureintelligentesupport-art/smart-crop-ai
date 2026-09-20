"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import {
  auth,
  db,
  ensureAuthPersistence,
  firebaseDiagnosticLines,
  googleProvider,
  isAuthReady,
  logFirebaseDiagnosticsOnce,
} from "@/lib/firebase";
import type { FirebaseDiagnosticLine } from "@/lib/firebase-env";
import { describeAuthError, type AuthErrorReport } from "@/lib/auth/errorReport";
import { AUTH, interpolate, type AuthCopy } from "@/lib/auth/copy";
import { logAuthError, logAuthInfo } from "@/lib/auth/logging";
import { runGoogleSignIn } from "@/lib/auth/googleFlow";
import { methodForFirebaseUser, resolveGoogleReturn } from "@/lib/auth/returnGate";
import { createAuthGateway } from "@/lib/auth/gateway";
import { syncUserDoc, type UserDocPatch } from "@/lib/auth/userDoc";
import {
  clearProfile,
  profileFromUser,
  readProfile,
  readPrefs,
  useProfile,
  writePrefs,
  writeProfile,
} from "@/lib/auth/profile";
import {
  clearAllLocalCache,
  isSwitchingAccounts,
  resolveSessionBinding,
} from "@/lib/auth/session";
import {
  AuthError,
  toAuthErrorCode,
  type AuthErrorCode,
  type AuthRole,
  type EmailIntent,
  type OtpChallenge,
  type SessionUser,
} from "@/lib/auth/types";
import {
  OTP_LENGTH,
  isCompleteOtp,
  isValidDzMobile,
  isValidEmail,
  normalizeDzPhone,
  passwordStrength,
  toE164,
} from "@/lib/auth/validation";
import { DEFAULT_WILAYA_CODE, getWilaya } from "@/lib/wilayas";
import { useLang } from "@/lib/use-lang";
import type { StepId } from "./StepLadder";

export type AuthChannel = "phone" | "email";

export type BusyState = null | "google" | "otp-send" | "otp-verify" | "email" | "forgot";

export interface EmailFormState {
  name: string;
  email: string;
  password: string;
  confirm: string;
}

export type EmailField = keyof EmailFormState;

export type FieldErrors = Partial<Record<EmailField | "phone" | "otp", string>>;

const EMPTY_EMAIL: EmailFormState = { name: "", email: "", password: "", confirm: "" };
const MAX_OTP_ATTEMPTS = 4;

/**
 * Owns the entire multi-step auth workflow: form state, validation, the
 * gateway calls (Google / SMS OTP / e-mail) and step navigation.
 *
 * The four handlers the Firebase SDK will eventually back are named exactly as
 * they are used in the UI: `handleGoogleAuth`, `handleSendOTP`,
 * `handleVerifyOTP`, `handleEmailAuth`.
 */
export function useAuthFlow({ initialMode = "signin" }: { initialMode?: EmailIntent } = {}) {
  const router = useRouter();
  const gateway = useMemo(() => createAuthGateway(), []);
  const { lang, setLang } = useLang("ar");
  const t: AuthCopy = AUTH[lang];
  const stored = useProfile();

  const [mode, setModeState] = useState<EmailIntent>(initialMode);
  const [channel, setChannelState] = useState<AuthChannel>("phone");
  const [step, setStep] = useState<StepId>("method");
  const [needsSetup, setNeedsSetup] = useState(initialMode === "register");

  const [email, setEmailState] = useState<EmailFormState>(EMPTY_EMAIL);
  const [phoneDigits, setPhoneDigits] = useState("");
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [otpAttempts, setOtpAttempts] = useState(0);

  // Seeded from the device preferences so a returning farmer lands on their
  // own wilaya instead of the national default.
  const [prefs] = useState(() => readPrefs());
  const [role, setRole] = useState<AuthRole | null>(prefs.role);
  const [wilayaCode, setWilayaCode] = useState<string | null>(prefs.wilayaCode);

  const [user, setUser] = useState<SessionUser | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);
  /** Google-specific failure copy, rendered right under the Google button. */
  const [googleError, setGoogleError] = useState<string | null>(null);
  /**
   * Raw `error.code` + `error.message` (plus the actionable hint) behind
   * `googleError` — always displayed, never swallowed (see AuthErrorPanel).
   */
  const [googleErrorDetail, setGoogleErrorDetail] = useState<AuthErrorReport | null>(null);
  /**
   * Env / origin / persistence facts shown next to a failed sign-in. Filled by
   * `failGoogle` (an event handler, not an effect) so it always reflects the
   * state at the moment of the failure.
   */
  const [diagnostics, setDiagnostics] = useState<FirebaseDiagnosticLine[]>([]);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* ---------------- Firebase diagnostics ----------------
   * Logs which backend/project/origin are in play, once per page load. The
   * same table is rebuilt on demand when a sign-in fails, so it always shows
   * the state at the moment of the failure (see `failGoogle`). Uses
   * console.info/console.warn only, so a healthy load keeps a clean console.
   */
  useEffect(() => {
    logFirebaseDiagnosticsOnce("auth-mount");
  }, []);

  /* ---------------- OTP clock (resend + expiry countdown) ---------------- */

  useEffect(() => {
    if (!challenge || step !== "method") return;
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [challenge, step]);

  const resendIn = challenge ? Math.max(0, Math.ceil((challenge.resendAt - clock) / 1000)) : 0;
  const otpExpired = Boolean(challenge && clock > challenge.expiresAt);
  const otpBlocked = otpAttempts >= MAX_OTP_ATTEMPTS;

  /* ---------------- helpers ---------------- */

  const copyFor = useCallback((code: AuthErrorCode): string => t.errors[codeKey(code)], [t]);

  const failWith = useCallback(
    (code: AuthErrorCode, field?: keyof FieldErrors) => {
      setErrorCode(code);
      if (field) setFieldErrors((prev) => ({ ...prev, [field]: copyFor(code) }));
    },
    [copyFor],
  );

  const clearErrors = useCallback(() => {
    setErrorCode(null);
    setFieldErrors({});
  }, []);

  /**
   * Single Google-failure entry point: localized copy for the user + the raw
   * provider facts (`code`, `message`, hint, scope) for the panel, plus a
   * refreshed diagnostics snapshot. Every popup / redirect / getRedirectResult
   * failure path goes through here, so nothing is only logged to the console.
   */
  const failGoogle = useCallback(
    (report: AuthErrorReport) => {
      if (!mounted.current) return;
      setGoogleError(copyFor(report.appCode));
      setGoogleErrorDetail(report);
      setDiagnostics(firebaseDiagnosticLines(report.scope ?? "google"));
    },
    [copyFor],
  );

  const clearGoogleError = useCallback(() => {
    setGoogleError(null);
    setGoogleErrorDetail(null);
  }, []);

  const setEmailField = useCallback((field: EmailField, value: string) => {
    setEmailState((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setErrorCode(null);
  }, []);

  const setMode = useCallback(
    (next: EmailIntent) => {
      setModeState(next);
      setNeedsSetup(next === "register");
      clearErrors();
      clearGoogleError();
      setNotice(null);
    },
    [clearErrors, clearGoogleError],
  );

  const setChannel = useCallback(
    (next: AuthChannel) => {
      setChannelState(next);
      clearErrors();
      clearGoogleError();
      setNotice(null);
    },
    [clearErrors, clearGoogleError],
  );

  /* ---------------- plan + navigation ---------------- */

  // Signing in on a device that never completed onboarding still needs the
  // role + wilaya steps, so those become part of the plan.
  const knownRole = stored.profile?.role ?? prefs.role;
  const knownWilaya = stored.profile?.wilayaCode ?? prefs.wilayaCode;
  const runsSetup = needsSetup || !(knownRole && knownWilaya);
  const plan = useMemo<StepId[]>(
    () => (runsSetup ? ["method", "role", "location"] : ["method"]),
    [runsSetup],
  );

  const goToStep = useCallback(
    (next: StepId) => {
      clearErrors();
      clearGoogleError();
      setNotice(null);
      setStep(next);
    },
    [clearErrors, clearGoogleError],
  );

  /**
   * The Firebase uid the wizard's user state is currently bound to (set by
   * `afterAuth` only when the SDK actually holds that session — popup /
   * redirect / e-mail — never for gateway-only demo/device sessions). The
   * signed-out reset effect below watches it: the moment the bound session
   * disappears, every user-bound bit of wizard state drops to the Step 1
   * defaults instead of lingering for the next account.
   */
  const firebaseBoundUid = useRef<string | null>(null);

  /** Every completed authentication lands here. */
  const afterAuth = useCallback(
    (session: SessionUser) => {
      const previous = readProfile();
      const device = readPrefs();
      // Strict UID-bound merge: cached role/wilaya apply ONLY when they
      // belong to this same uid — on an account switch the Firestore-backed
      // session is the sole source of truth (see session.ts).
      const binding = resolveSessionBinding(session, previous, device);
      const resolvedRole = binding.role;
      const resolvedWilaya = binding.wilayaCode;

      writeProfile(
        profileFromUser({ ...session, role: resolvedRole, wilayaCode: resolvedWilaya }, { lang }),
      );
      writePrefs({ role: resolvedRole, wilayaCode: resolvedWilaya, lang });
      // Complete overwrite of the wizard's in-memory user state: nothing of
      // a previously signed-in account survives next to the new session.
      setUser({ ...session, role: resolvedRole, wilayaCode: resolvedWilaya });
      setRole(resolvedRole);
      setWilayaCode(resolvedWilaya);

      // Bind the wizard to the Firebase session when the SDK actually holds
      // this uid. Gateway-only sessions (demo, device OTP) never bind, so
      // the signed-out reset below ignores them.
      if (isAuthReady(auth) && auth.currentUser?.uid === session.uid) {
        firebaseBoundUid.current = session.uid;
      }

      if (resolvedRole && resolvedWilaya) {
        router.push("/dashboard");
        return;
      }
      setNeedsSetup(true);
      setStep("role");
    },
    [lang, router],
  );

  /* ---------------- validation ---------------- */

  const validateEmailForm = useCallback((): boolean => {
    const errors: FieldErrors = {};
    const isRegister = mode === "register";

    if (isRegister && !email.name.trim()) errors.name = t.errors.required;
    if (!email.email.trim()) errors.email = t.errors.required;
    else if (!isValidEmail(email.email)) errors.email = t.errors.email;

    if (!email.password) errors.password = t.errors.required;
    else if (isRegister && !passwordStrength(email.password).acceptable) {
      errors.password = t.errors.passwordWeak;
    }
    if (isRegister) {
      if (!email.confirm) errors.confirm = t.errors.required;
      else if (email.confirm !== email.password) errors.confirm = t.errors.passwordMismatch;
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [email, mode, t]);

  /* ---------------- Step 1 · Google ---------------- */

  /** The uid currently owned by one of the sign-in paths (popup / redirect /
   *  restored session). Claimed synchronously so the three can never both
   *  complete the same sign-in; released again on sign-out. */
  const pendingGoogleUid = useRef<string | null>(null);
  /** True while the e-mail/OTP handlers are mid sign-in — the restored-session
   *  adopter must not hijack those flows. */
  const manualSignIn = useRef(false);

  /**
   * Shared post-sign-in work for every real Firebase user (popup path, the
   * redirect return via `getRedirectResult`, and restored-session adoption):
   * sync `users/{uid}` in Firestore via the retrying `syncUserDoc()` FIRST,
   * then build the SessionUser from the Google/Firebase profile data
   * (`displayName`, `email`, `photoURL`). The profile write never blocks the
   * session — on final failure it logs and warns instead.
   */
  const buildSyncedSession = useCallback(
    async (fbUser: User): Promise<SessionUser> => {
      // Strict UID-bound sync: never write wizard/device state into the
      // Firestore doc of a DIFFERENT user, and never let an empty local
      // state clobber the doc of a returning user — the patch carries only
      // explicit in-session values for the same user, and the session
      // resolves strictly from users/{uid}.
      const switching = isSwitchingAccounts(readProfile(), fbUser.uid);
      const patch: UserDocPatch = { lastLoginAt: new Date().toISOString() };
      if (!switching) {
        if (role) patch.role = role;
        if (wilayaCode) patch.wilayaCode = wilayaCode;
      }
      const { ok, data, error } = await syncUserDoc(
        {
          uid: fbUser.uid,
          displayName: fbUser.displayName,
          email: fbUser.email,
          photoURL: fbUser.photoURL,
        },
        patch,
      );
      if (!ok) {
        logAuthError("google-profile-sync", error);
        if (mounted.current) setNotice(t.errors.profileSave);
      }

      const resolvedRole = (data.role ?? null) as AuthRole | null;
      const resolvedWilaya = (data.wilayaCode ?? data.wilaya ?? null) as string | null;

      return {
        uid: fbUser.uid,
        method: methodForFirebaseUser(fbUser),
        displayName: fbUser.displayName || data.displayName || "",
        email: fbUser.email ?? data.email ?? undefined,
        photoURL: fbUser.photoURL ?? (data.photoURL as string | null | undefined) ?? null,
        role: resolvedRole,
        wilayaCode: resolvedWilaya,
      };
    },
    [role, t, wilayaCode],
  );

  /** Fill what Google already knows into the e-mail form (never passwords). */
  const prefillProfileFields = useCallback((fbUser: User) => {
    const name = fbUser.displayName?.trim() ?? "";
    const mail = fbUser.email?.trim() ?? "";
    if (!name && !mail) return;
    setEmailState((prev) => ({
      ...prev,
      name: prev.name || name,
      email: prev.email || mail,
    }));
  }, []);

  /**
   * THE post-auth success handler, shared by every path that completes a
   * real Firebase sign-in:
   *   1. `signInWithPopup` resolving in-page (desktop),
   *   2. the return from `signInWithRedirect` consumed by `getRedirectResult`,
   *   3. a restored Firebase session (see the `onAuthStateChanged` effect).
   *
   * The order inside is deliberate:
   *   a) claim the uid so the other paths no-op,
   *   b) await the `users/{uid}` Firestore sync (spec: sync BEFORE advancing),
   *   c) pre-fill the Google profile (displayName / email / photoURL),
   *   d) `afterAuth` — which lands a user without role + wilaya on
   *      Step 2 of the wizard (“الصفة”, the role step) and a fully-known
   *      user straight on the dashboard.
   */
  const handlePostAuthSuccess = useCallback(
    async (fbUser: User, source: "popup" | "redirect" | "auth-state") => {
      if (pendingGoogleUid.current === fbUser.uid) return;
      pendingGoogleUid.current = fbUser.uid;
      logAuthInfo(source, `Firebase sign-in captured (uid ${fbUser.uid})`);
      try {
        const session = await buildSyncedSession(fbUser);
        if (!mounted.current) return;
        prefillProfileFields(fbUser);
        afterAuth(session);
      } catch (error) {
        logAuthError(`${source}-post-auth`, error);
        pendingGoogleUid.current = null;
        failGoogle(describeAuthError(error, `${source}-post-auth`));
      }
    },
    [afterAuth, buildSyncedSession, failGoogle, prefillProfileFields],
  );

  /* ---------------- Google redirect result ----------------
   * signInWithRedirect() (mobile first, or the popup-blocked fallback)
   * navigates the whole browser away; the credential only comes back with the
   * next load of this page. getRedirectResult() consumes the pending redirect
   * exactly once — on every normal load it simply resolves to null, so this
   * is safe on every mount. A lost/failed payload is NOT fatal: the
   * onAuthStateChanged catcher below adopts the session Firebase restored.
   */
  const redirectChecked = useRef(false);
  useEffect(() => {
    if (redirectChecked.current) return;
    if (typeof window === "undefined") return;
    if (!isAuthReady(auth)) return;
    redirectChecked.current = true;

    (async () => {
      let redirectUser: User | null = null;
      try {
        // getRedirectResult() is wrapped like signInWithPopup/Redirect: any
        // failure is logged with its code + message AND rendered in the panel.
        const result = await getRedirectResult(auth);
        redirectUser = result?.user ?? null;
        if (redirectUser) {
          logAuthInfo("getRedirectResult", `redirect payload received (uid ${redirectUser.uid})`);
        }
      } catch (error) {
        logAuthError("getRedirectResult", error);
        failGoogle(describeAuthError(error, "getRedirectResult"));
      }

      // Strict gate: complete only with a Firebase user that carries a uid.
      const decision = resolveGoogleReturn({
        redirectUser,
        authedUser: auth.currentUser ?? null,
        handledUid: pendingGoogleUid.current,
        manualSignInActive: manualSignIn.current,
        onMethodStep: true,
      });
      if (decision.kind === "complete") {
        logAuthInfo("google", `redirect sign-in complete (uid ${decision.user.uid})`);
        void handlePostAuthSuccess(decision.user, "redirect");
      }
      // Nothing else to do here: a failure is already on screen (failGoogle)
      // and the restored-session catcher below can still complete the sign-in
      // when Firebase holds a user despite the lost/consumed payload.
    })();
  }, [failGoogle, handlePostAuthSuccess]);

  /* ---------------- Restored Firebase session ----------------
   * Safety net for the case the redirect payload never arrives while the
   * sign-in itself succeeded (page reloaded mid-return, partitioned
   * sessionStorage in embedded previews, the result consumed by an earlier
   * mount, …). If Firebase Auth holds a user, treat it as the completed
   * sign-in: sync users/{uid}, pre-fill the Google profile, and advance the
   * wizard to Step 2 (“الصفة”) instead of leaving it reset on Step 1.
   */
  useEffect(() => {
    if (!isAuthReady(auth)) return;
    if (user || step !== "method") return;

    const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
      if (!fbUser?.uid) {
        // Signed out (or never signed in): release the claim so the same
        // account can sign in again within this mount.
        pendingGoogleUid.current = null;
        return;
      }
      const decision = resolveGoogleReturn({
        redirectUser: null,
        authedUser: fbUser,
        handledUid: pendingGoogleUid.current,
        manualSignInActive: manualSignIn.current,
        onMethodStep: true,
      });
      if (decision.kind === "complete") {
        logAuthInfo("auth-state", "no redirect payload — adopting the restored Firebase session");
        void handlePostAuthSuccess(decision.user, "auth-state");
      }
    });
    return unsubscribe;
  }, [handlePostAuthSuccess, step, user]);

  /* ---------------- Signed-out reset (strict session isolation) ----------------
   * The wizard binds to exactly one Firebase uid per mount (see afterAuth).
   * Whenever that session disappears — sign-out here, in another tab, or an
   * expired/revoked token — every user-bound bit of wizard state drops back
   * to the Step 1 defaults instead of lingering for the next account.
   * Gateway-only sessions (demo / device OTP) never bound, so they are
   * untouched; the on-device profile of the bound account is dropped so the
   * next account starts from a clean slate.
   */
  useEffect(() => {
    if (!isAuthReady(auth)) return;
    const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser?.uid) return;
      if (!firebaseBoundUid.current) return;
      firebaseBoundUid.current = null;
      pendingGoogleUid.current = null;
      setUser(null);
      setRole(null);
      setWilayaCode(null);
      setChallenge(null);
      setOtpCode("");
      setOtpAttempts(0);
      setPhoneDigits("");
      setEmailState(EMPTY_EMAIL);
      setBusy(null);
      clearErrors();
      clearGoogleError();
      setNotice(null);
      setStep("method");
      clearProfile();
    });
    return unsubscribe;
  }, [clearErrors, clearGoogleError]);

  const handleGoogleAuth = useCallback(async () => {
    clearErrors();
    clearGoogleError();
    setNotice(null);
    setBusy("google");

    try {
      // Google sign-in ALWAYS goes through real Firebase Auth — there is no
      // on-device/mock session for it. runGoogleSignIn() only ever produces
      // `signed-in` from a valid Firebase user object (popup, or the redirect
      // consumed below), so the wizard can never advance without real auth.
      //
      // Both SDK calls are wrapped: `ensurePersistence()` runs FIRST (so the
      // session survives the round-trip), and every rejection is turned into
      // an on-screen report carrying the raw `error.code` + `error.message`.
      const outcome = await runGoogleSignIn({
        ensurePersistence: () => ensureAuthPersistence("signInWithPopup"),
        signInWithPopup: () => signInWithPopup(auth, googleProvider),
        signInWithRedirect: () => signInWithRedirect(auth, googleProvider),
        onRedirectStart: () => {
          if (mounted.current) setNotice(t.method.googleRedirecting);
        },
      });

      if (outcome.kind === "signed-in") {
        logAuthInfo("google", `popup sign-in complete (uid ${outcome.user.uid})`);
        // Firestore sync + profile pre-fill + step advance all happen inside
        // the shared success handler (it claims the uid so the redirect /
        // auth-state catchers can't double-run).
        await handlePostAuthSuccess(outcome.user, "popup");
        return;
      }

      if (outcome.kind === "redirect-started") {
        // The browser is navigating to Google's account chooser. The wizard
        // stays put until the real session comes back via getRedirectResult().
        logAuthInfo("google", "redirect started — waiting for getRedirectResult on return");
        return;
      }

      // Every other outcome — a cancelled chooser, unauthorized domain, a
      // blocked popup whose redirect fallback also failed — keeps the user on
      // step 1 with the localised copy AND the raw provider report underneath.
      failGoogle(outcome.report);
    } catch (error: unknown) {
      logAuthError("handleGoogleAuth", error);
      failGoogle(describeAuthError(error, "handleGoogleAuth"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [clearErrors, clearGoogleError, failGoogle, handlePostAuthSuccess, t]);

  /* ---------------- Step 1 · Phone + OTP ---------------- */

  const handleSendOTP = useCallback(
    async (rawDigits: string) => {
      clearErrors();
      setNotice(null);
      const digits = normalizeDzPhone(rawDigits);
      if (!isValidDzMobile(digits)) {
        // Field-specific copy beats the generic "required" mapping here.
        setErrorCode("invalid-input");
        setFieldErrors({ phone: t.errors.phone });
        return;
      }
      setBusy("otp-send");
      try {
        const next = await gateway.sendOtp(toE164(digits));
        if (!mounted.current) return;
        setChallenge(next);
        setOtpCode("");
        setOtpAttempts(0);
        setClock(Date.now());
        setPhoneDigits(digits);
      } catch (error) {
        if (mounted.current) setErrorCode(toAuthErrorCode(error));
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [clearErrors, gateway, t.errors.phone],
  );

  const handleVerifyOTP = useCallback(
    async (code: string) => {
      clearErrors();
      setNotice(null);
      if (!challenge) {
        failWith("invalid-input", "otp");
        return;
      }
      if (!isCompleteOtp(code)) {
        setFieldErrors((prev) => ({ ...prev, otp: t.errors.otpIncomplete }));
        return;
      }
      if (otpExpired) {
        failWith("code-expired", "otp");
        return;
      }
      if (otpBlocked) {
        failWith("too-many-requests", "otp");
        return;
      }

      setBusy("otp-verify");
      manualSignIn.current = true;
      try {
        const session = await gateway.verifyOtp(challenge, code);
        if (!mounted.current) return;
        pendingGoogleUid.current = session.uid;
        afterAuth(session);
      } catch (error) {
        if (!mounted.current) return;
        const code2 = toAuthErrorCode(error);
        setOtpAttempts((n) => n + 1);
        setErrorCode(code2);
        setFieldErrors((prev) => ({ ...prev, otp: copyFor(code2) }));
      } finally {
        manualSignIn.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [afterAuth, challenge, clearErrors, copyFor, failWith, gateway, otpBlocked, otpExpired, t],
  );

  const handleResendOtp = useCallback(async () => {
    if (!challenge || resendIn > 0) return;
    await handleSendOTP(challenge.phone);
    if (mounted.current) setNotice(t.phone.resent);
  }, [challenge, handleSendOTP, resendIn, t]);

  const handleChangeNumber = useCallback(() => {
    setChallenge(null);
    setOtpCode("");
    setOtpAttempts(0);
    clearErrors();
    setNotice(null);
  }, [clearErrors]);

  /* ---------------- Step 1 · E-mail ---------------- */

  const handleEmailAuth = useCallback(async () => {
    setNotice(null);
    if (!validateEmailForm()) return;
    setErrorCode(null);
    setBusy("email");
    // The e-mail form owns this sign-in: the auth-state adopter must watch,
    // not interfere, until the credential is resolved.
    manualSignIn.current = true;
    try {
      let session: SessionUser;
      // A pre-existing Firebase session (or a cached profile for another
      // uid) means this sign-in switches accounts: local role/wilaya state
      // must not be seeded into the new user's document.
      const priorUid = auth.currentUser?.uid ?? null;
      if (mode === "register") {
        try {
          const cred = await createUserWithEmailAndPassword(auth, email.email.trim(), email.password);
          const fbUser = cred.user;
          const displayName = email.name.trim();
          if (displayName) {
            await updateProfile(fbUser, { displayName });
          }

          const switched = priorUid !== null || isSwitchingAccounts(readProfile(), fbUser.uid);
          const targetRole = switched ? null : (role ?? null);
          const targetWilaya = switched ? null : (wilayaCode ?? null);
          const wilayaData = targetWilaya ? getWilaya(targetWilaya) : null;
          const preferredCrop = wilayaData?.crops?.[0] ?? null;

          await setDoc(
            doc(db, "users", fbUser.uid),
            {
              uid: fbUser.uid,
              displayName,
              email: fbUser.email,
              role: targetRole,
              wilaya: targetWilaya,
              wilayaCode: targetWilaya,
              preferredCrop,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            { merge: true },
          );

          session = {
            uid: fbUser.uid,
            method: "email",
            displayName: displayName || fbUser.displayName || "",
            email: fbUser.email ?? email.email.trim(),
            role: targetRole,
            wilayaCode: targetWilaya,
          };
        } catch (fbErr: unknown) {
          const errCode = (fbErr as { code?: string })?.code;
          if (
            gateway.isDemo ||
            errCode === "auth/network-request-failed" ||
            errCode === "auth/operation-not-supported-in-this-environment"
          ) {
            session = await gateway.registerWithEmail({
              displayName: email.name.trim(),
              email: email.email.trim(),
              password: email.password,
            });
          } else {
            throw fbErr;
          }
        }
      } else {
        try {
          const cred = await signInWithEmailAndPassword(auth, email.email.trim(), email.password);
          const fbUser = cred.user;
          const snap = await getDoc(doc(db, "users", fbUser.uid));
          const data = snap.exists() ? snap.data() : {};

          const switched =
            (priorUid !== null && priorUid !== fbUser.uid) ||
            isSwitchingAccounts(readProfile(), fbUser.uid);
          const resolvedRole = (
            switched ? (data.role ?? null) : (data.role ?? role)
          ) as AuthRole | null;
          const resolvedWilaya = (
            switched ? (data.wilayaCode ?? data.wilaya ?? null) : (data.wilayaCode ?? data.wilaya ?? wilayaCode)
          ) as string | null;

          session = {
            uid: fbUser.uid,
            method: "email",
            displayName: fbUser.displayName || data.displayName || email.email.trim().split("@")[0],
            email: fbUser.email ?? email.email.trim(),
            role: resolvedRole,
            wilayaCode: resolvedWilaya,
          };
        } catch (fbErr: unknown) {
          const errCode = (fbErr as { code?: string })?.code;
          if (
            gateway.isDemo ||
            errCode === "auth/network-request-failed" ||
            errCode === "auth/operation-not-supported-in-this-environment"
          ) {
            session = await gateway.signInWithEmail(email.email.trim(), email.password);
          } else {
            throw fbErr;
          }
        }
      }

      if (!mounted.current) return;
      // Claim the uid before afterAuth advances the wizard, so the restored
      // session this sign-in just produced is not "adopted" a second time.
      pendingGoogleUid.current = session.uid;
      afterAuth(session);
    } catch (error) {
      if (!mounted.current) return;
      const code = toAuthErrorCode(error);
      setErrorCode(code);
      if (code === "invalid-input") setFieldErrors({ password: t.errors.passwordWeak });
      else if (code === "email-in-use" || code === "user-not-found") {
        setFieldErrors({ email: copyFor(code) });
      } else if (code === "wrong-password") setFieldErrors({ password: copyFor(code) });
    } finally {
      manualSignIn.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [afterAuth, copyFor, email, gateway, mode, role, t, validateEmailForm, wilayaCode]);

  const handleForgotPassword = useCallback(async () => {
    clearErrors();
    if (!isValidEmail(email.email)) {
      setFieldErrors({ email: t.errors.email });
      return;
    }
    setBusy("forgot");
    try {
      await gateway.requestPasswordReset(email.email.trim());
      if (mounted.current) setNotice(interpolate(t.email.forgotSent, { email: email.email.trim() }));
    } catch (error) {
      if (mounted.current) setErrorCode(toAuthErrorCode(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [clearErrors, email.email, gateway, t]);

  /* ---------------- Step 2 · Role ---------------- */

  const handleRoleSelect = useCallback(
    (next: AuthRole) => {
      setRole(next);
      clearErrors();
    },
    [clearErrors],
  );

  const handleRoleConfirm = useCallback(() => {
    if (!role) return;
    setStep("location");
  }, [role]);

  /* ---------------- Step 3 · Wilaya ---------------- */

  const handleWilayaSelect = useCallback(
    (code: string) => {
      setWilayaCode(code);
      clearErrors();
    },
    [clearErrors],
  );

  const handleWilayaConfirm = useCallback(async () => {
    const code = wilayaCode ?? DEFAULT_WILAYA_CODE;
    setBusy("email");
    try {
      const wilayaData = getWilaya(code);
      const preferredCrop = wilayaData?.crops?.[0] ?? null;

      const currentFbUser = auth.currentUser;
      if (currentFbUser) {
        try {
          await setDoc(
            doc(db, "users", currentFbUser.uid),
            {
              role: role ?? null,
              wilaya: code,
              wilayaCode: code,
              preferredCrop,
              updatedAt: new Date().toISOString(),
            },
            { merge: true },
          );
        } catch {
          // Ignore network errors in offline/demo environments
        }
      }

      let session = user;
      if (user) {
        session = await gateway.saveProfile(user.uid, {
          role: role ?? undefined,
          wilayaCode: code,
        });
      }
      if (mounted.current) {
        setWilayaCode(code);
        setUser(session ? { ...session, role: role ?? session.role, wilayaCode: code } : session);
        writeProfile(
          profileFromUser(
            session ?? {
              uid: currentFbUser?.uid ?? "local",
              method: "email",
              displayName: currentFbUser?.displayName ?? "",
              role,
              wilayaCode: code,
            },
            { role, wilayaCode: code, lang },
          ),
        );
        writePrefs({ role, wilayaCode: code, lang });
        setStep("done");
      }
    } catch (error) {
      if (mounted.current) setErrorCode(toAuthErrorCode(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [gateway, lang, role, user, wilayaCode]);

  /* ---------------- Dashboard ---------------- */

  const handleGoToDashboard = useCallback(() => {
    router.push("/dashboard");
  }, [router]);

  /**
   * Signing out drops the session AND every trace of the identity: the SDK
   * sign-out is accompanied by a full local-cache wipe (localStorage +
   * sessionStorage), a reset of the wizard to Step 1, and a reset of all
   * user-bound React state — so the next account can never inherit this
   * profile (stale-cache bleed fix).
   */
  const handleSignOut = useCallback(async () => {
    clearErrors();
    clearGoogleError();
    setNotice(null);
    try {
      await fbSignOut(auth);
    } catch {
      // offline / demo fallback — the local cleanup below still runs
    }
    try {
      await gateway.signOut();
    } catch {
      // firebase adapter may reject when offline; the demo gateway never does
    }
    // Release the redirect/adoption claim so signing back in — even on the
    // same page instance — is captured again instead of being deduped away.
    pendingGoogleUid.current = null;
    firebaseBoundUid.current = null;
    // Complete local cache wipe: no field of this identity may survive for
    // the next account.
    clearAllLocalCache();
    stored.clear();
    // Reset the wizard to the Step 1 defaults.
    setUser(null);
    setRole(null);
    setWilayaCode(null);
    setChallenge(null);
    setOtpCode("");
    setOtpAttempts(0);
    setPhoneDigits("");
    setEmailState(EMPTY_EMAIL);
    setBusy(null);
    setNeedsSetup(initialMode === "register");
    setStep("method");
    router.push("/auth");
  }, [clearErrors, clearGoogleError, gateway, initialMode, router, stored]);

  /* ---------------- Derived ---------------- */

  const emailStrength = useMemo(() => passwordStrength(email.password), [email.password]);
  const minLeft = challenge ? Math.max(0, Math.ceil((challenge.expiresAt - clock) / 60000)) : 0;
  const otpAttemptsLeft = Math.max(0, MAX_OTP_ATTEMPTS - otpAttempts);

  const setOtpCodeSafe = useCallback((value: string) => {
    setOtpCode(value);
    setFieldErrors((prev) => {
      if (!prev.otp) return prev;
      const next = { ...prev };
      delete next.otp;
      return next;
    });
    setErrorCode(null);
  }, []);

  const errorMessage = errorCode && !fieldErrors.phone && !fieldErrors.otp ? copyFor(errorCode) : null;

  return {
    // copy + chrome
    t,
    lang,
    setLang,
    gateway,
    // state
    mode,
    setMode,
    channel,
    setChannel,
    step,
    setStep,
    plan,
    goToStep,
    needsSetup,
    runsSetup,
    email,
    setEmailField,
    phoneDigits: normalizeDzPhone(phoneDigits),
    challenge,
    otpCode,
    setOtpCode: setOtpCodeSafe,
    otpLength: OTP_LENGTH,
    resendIn,
    otpExpired,
    otpAttemptsLeft,
    otpBlocked,
    minLeft,
    role,
    wilayaCode,
    user,
    // ui state
    busy,
    errorCode,
    errorMessage,
    googleError,
    googleErrorDetail,
    diagnostics,
    fieldErrors,
    notice,
    emailStrength,
    storedProfile: stored.profile,
    // handlers
    handleGoogleAuth,
    handleSendOTP,
    handleVerifyOTP,
    handleResendOtp,
    handleChangeNumber,
    handleEmailAuth,
    handleForgotPassword,
    handleRoleSelect,
    handleRoleConfirm,
    handleWilayaSelect,
    handleWilayaConfirm,
    handleGoToDashboard,
    handleSignOut,
    clearErrors,
  };
}

export type FlowController = ReturnType<typeof useAuthFlow>;

/** AuthErrorCode → key on the copy `errors` block (kebab-case → camelCase). */
function codeKey(code: AuthErrorCode): keyof AuthCopy["errors"] {
  switch (code) {
    case "invalid-input":
      return "required";
    case "email-in-use":
      return "emailInUse";
    case "user-not-found":
      return "userNotFound";
    case "wrong-password":
      return "wrongPassword";
    case "invalid-code":
      return "invalidCode";
    case "code-expired":
      return "codeExpired";
    case "too-many-requests":
      return "tooMany";
    case "popup-closed":
      return "popupClosed";
    case "popup-blocked":
      return "popupBlocked";
    case "unauthorized-domain":
      return "unauthorizedDomain";
    case "operation-not-supported":
      return "operationNotSupported";
    case "network":
      return "network";
    default:
      return "unknown";
  }
}

export { AuthError };
