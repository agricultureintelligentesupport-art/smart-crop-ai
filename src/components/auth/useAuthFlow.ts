"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AUTH, interpolate, type AuthCopy } from "@/lib/auth/copy";
import { createAuthGateway } from "@/lib/auth/gateway";
import {
  guestProfile,
  profileFromUser,
  readProfile,
  readPrefs,
  useProfile,
  writePrefs,
  writeProfile,
} from "@/lib/auth/profile";
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
import { DEFAULT_WILAYA_CODE } from "@/lib/wilayas";
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
      setNotice(null);
    },
    [clearErrors],
  );

  const setChannel = useCallback(
    (next: AuthChannel) => {
      setChannelState(next);
      clearErrors();
      setNotice(null);
    },
    [clearErrors],
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
      setNotice(null);
      setStep(next);
    },
    [clearErrors],
  );

  /** Every completed authentication lands here. */
  const afterAuth = useCallback(
    (session: SessionUser) => {
      const previous = readProfile();
      const device = readPrefs();
      const resolvedRole = session.role ?? previous?.role ?? device.role ?? null;
      const resolvedWilaya = session.wilayaCode ?? previous?.wilayaCode ?? device.wilayaCode ?? null;

      writeProfile(
        profileFromUser({ ...session, role: resolvedRole, wilayaCode: resolvedWilaya }, { lang }),
      );
      writePrefs({ role: resolvedRole, wilayaCode: resolvedWilaya, lang });
      setUser({ ...session, role: resolvedRole, wilayaCode: resolvedWilaya });
      setRole(resolvedRole);
      setWilayaCode(resolvedWilaya);

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

  const handleGoogleAuth = useCallback(async () => {
    clearErrors();
    setNotice(null);
    setBusy("google");
    try {
      const session = await gateway.signInWithGoogle();
      if (!mounted.current) return;
      afterAuth(session);
    } catch (error) {
      if (mounted.current) setErrorCode(toAuthErrorCode(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [afterAuth, clearErrors, gateway]);

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
      try {
        const session = await gateway.verifyOtp(challenge, code);
        if (!mounted.current) return;
        afterAuth(session);
      } catch (error) {
        if (!mounted.current) return;
        const code2 = toAuthErrorCode(error);
        setOtpAttempts((n) => n + 1);
        setErrorCode(code2);
        setFieldErrors((prev) => ({ ...prev, otp: copyFor(code2) }));
      } finally {
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
    try {
      const session =
        mode === "register"
          ? await gateway.registerWithEmail({
              displayName: email.name.trim(),
              email: email.email.trim(),
              password: email.password,
            })
          : await gateway.signInWithEmail(email.email.trim(), email.password);
      if (!mounted.current) return;
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
      if (mounted.current) setBusy(null);
    }
  }, [afterAuth, copyFor, email, gateway, mode, t, validateEmailForm]);

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
      let session = user;
      if (user && !user.isGuest) {
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
              uid: "local",
              method: "email",
              displayName: "",
              role,
              wilayaCode: code,
              isGuest: false,
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

  /* ---------------- Guest + dashboard ---------------- */

  const handleGuestContinue = useCallback(
    (code?: string) => {
      const target = code ?? wilayaCode ?? DEFAULT_WILAYA_CODE;
      writePrefs({ role: role ?? prefs.role, wilayaCode: target, lang });
      writeProfile(
        guestProfile({
          wilayaCode: target,
          role: role ?? undefined,
          lang,
          displayName: lang === "ar" ? "زائر" : "Invité",
        }),
      );
      router.push("/guest");
    },
    [lang, prefs.role, role, router, wilayaCode],
  );

  const handleGoToDashboard = useCallback(() => {
    router.push("/dashboard");
  }, [router]);

  /** Signing out drops the session but keeps the device preferences. */
  const handleSignOut = useCallback(async () => {
    clearErrors();
    await gateway.signOut();
    stored.clear();
    router.push("/auth");
  }, [clearErrors, gateway, router, stored]);

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
    handleGuestContinue,
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
    case "network":
      return "network";
    default:
      return "unknown";
  }
}

export { AuthError };
