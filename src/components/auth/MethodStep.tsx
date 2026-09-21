"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Info,
  Mail,
  MessageSquareLock,
  Phone,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { interpolate } from "@/lib/auth/copy";
import { enterGuestMode } from "@/lib/auth/guest";
import { DZ_COUNTRY_CODE, formatDzPhone, normalizeDzPhone } from "@/lib/auth/validation";
import type { EmailIntent } from "@/lib/auth/types";
import AuthErrorPanel from "./AuthErrorPanel";
import GoogleMark from "./GoogleMark";
import OtpInput from "./OtpInput";
import type { AuthChannel, FlowController } from "./useAuthFlow";
import {
  Badge,
  Divider,
  EASE_OUT,
  FieldError,
  FOCUS_RING,
  GPU,
  LiveRegion,
  Notice,
  PasswordField,
  PrimaryButton,
  RuleCheck,
  SPRING,
  StrengthMeter,
  TextField,
} from "./ui";

/* ------------------------------------------------------------------ */
/*  Step 1 — auth methods + credentials                                */
/* ------------------------------------------------------------------ */

export default function MethodStep({ flow }: { flow: FlowController }) {
  const { t, lang } = flow;
  const rtl = lang === "ar";
  const title = flow.mode === "register" ? t.method.titleRegister : t.method.titleSignin;
  const subtitle = flow.mode === "register" ? t.method.subtitleRegister : t.method.subtitleSignin;

  return (
    <section aria-labelledby="auth-title" className="flex flex-col gap-4">
      <ModeToggle flow={flow} />

      <header className="text-center">
        <h1 id="auth-title" className="text-[22px] font-black leading-tight text-emerald-950">
          {title}
        </h1>
        <p className="mx-auto mt-1 max-w-[38ch] text-[12.5px] font-semibold leading-6 text-emerald-900/75">
          {subtitle}
        </p>
      </header>

      <GoogleButton flow={flow} />

      <Divider label={t.method.divider} />

      <ChannelTabs flow={flow} />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={flow.channel}
          initial={{ opacity: 0, x: rtl ? -16 : 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: rtl ? 16 : -16 }}
          transition={{ duration: 0.24, ease: EASE_OUT }}
          className={GPU}
        >
          {flow.channel === "phone" ? <PhonePanel flow={flow} /> : <EmailPanel flow={flow} />}
        </motion.div>
      </AnimatePresence>

      {/* While an SMS challenge is open the in-panel hint already explains the
          demo code, so the generic notice would just repeat itself. */}
      {flow.gateway.isDemo && !flow.challenge && (
        <Notice tone="demo" title={t.demo.noteTitle} icon={<Info size={15} strokeWidth={2.4} aria-hidden />}>
          {t.demo.noteBody}
        </Notice>
      )}

      {/* Guest bypass: a subtle link that claims the local guest flag and
          jumps straight to the dashboard — no Firebase call, no wizard steps.
          Purely additive; every sign-in handler above stays untouched. */}
      <GuestContinue flow={flow} />

      <LiveRegion message={flow.notice} />

      <div id="recaptcha-container" />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Continue as Guest (local bypass)                                   */
/* ------------------------------------------------------------------ */

function GuestContinue({ flow }: { flow: FlowController }) {
  const router = useRouter();
  const { t } = flow;

  const handleGuest = () => {
    enterGuestMode();
    router.push("/dashboard");
  };

  return (
    <div className="flex flex-col items-center gap-0.5 pt-0.5">
      <button
        type="button"
        onClick={handleGuest}
        className={`rounded-xl px-3 py-2 text-[12.5px] font-extrabold text-emerald-800/65 transition-colors hover:text-emerald-700 ${FOCUS_RING}`}
      >
        {t.method.guest}
      </button>
      <p className="text-center text-[10px] font-semibold text-emerald-900/45">{t.method.guestNote}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sign in / Create account toggle                                    */
/* ------------------------------------------------------------------ */

function ModeToggle({ flow }: { flow: FlowController }) {
  const { t } = flow;
  // The aria-labels differ from the visible text on purpose: the submit
  // buttons inside the e-mail panel would otherwise share the exact same
  // accessible name, which is ambiguous for screen-reader users and tests.
  const options: { id: EmailIntent; label: string; ariaLabel: string; icon: typeof ShieldCheck }[] = [
    { id: "signin", label: t.method.tabSignin, ariaLabel: t.method.switchToSignin, icon: ShieldCheck },
    { id: "register", label: t.method.tabRegister, ariaLabel: t.method.switchToRegister, icon: UserPlus },
  ];

  return (
    <div
      role="group"
      aria-label={t.method.switchAria}
      className="mx-auto flex w-full max-w-[330px] items-center rounded-2xl border border-[#E2F1E8] bg-white/70 p-1"
    >
      {options.map((option) => {
        const active = flow.mode === option.id;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => flow.setMode(option.id)}
            aria-label={option.ariaLabel}
            aria-pressed={active}
            className={`relative flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-1 text-[11.5px] font-black whitespace-nowrap transition-colors min-[380px]:text-[12.5px] ${FOCUS_RING} ${
              active ? "text-white" : "text-emerald-900/70 hover:text-emerald-800"
            }`}
          >
            {active && (
              <motion.span
                layoutId="auth-mode-thumb"
                className={`absolute inset-0 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 ${GPU}`}
                transition={SPRING}
              />
            )}
            <Icon size={14} strokeWidth={2.6} className="relative z-10 shrink-0" aria-hidden />
            <span className="relative z-10 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Google                                                             */
/* ------------------------------------------------------------------ */

function GoogleButton({ flow }: { flow: FlowController }) {
  const { t } = flow;
  const loading = flow.busy === "google";
  return (
    <div className="flex flex-col gap-1.5">
      <motion.button
        type="button"
        onClick={flow.handleGoogleAuth}
        disabled={loading}
        aria-busy={loading || undefined}
        whileHover={loading ? undefined : { y: -2 }}
        whileTap={loading ? undefined : { scale: 0.985 }}
        transition={SPRING}
        className={`${GPU} ${FOCUS_RING} flex h-12 w-full items-center justify-center gap-2.5 rounded-2xl border border-[#E2F1E8] bg-white/95 text-[14.5px] font-extrabold text-emerald-950 shadow-[0_6px_18px_-12px_rgba(6,78,59,0.45)] transition-colors hover:border-emerald-300 hover:bg-white disabled:cursor-not-allowed disabled:opacity-70`}
      >
        {loading ? (
          <span className="inline-flex items-center gap-2 text-emerald-800">
            <motion.span
              aria-hidden
              className="h-4 w-4 rounded-full border-2 border-emerald-500 border-t-transparent"
              animate={{ rotate: 360 }}
              transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
            />
            {t.method.googleBusy}
          </span>
        ) : (
          <>
            <GoogleMark />
            {t.method.google}
          </>
        )}
      </motion.button>
      {/* Errors are never console-only: the localized sentence is followed by
          the raw `error.code` / `error.message`, the actionable hint and the
          Firebase diagnostics (env, project, origin, persistence). */}
      {flow.googleErrorDetail ? (
        <AuthErrorPanel
          report={flow.googleErrorDetail}
          message={flow.googleError}
          diagnostics={flow.diagnostics}
          labels={{
            code: t.method.errorCode,
            message: t.method.errorMessage,
            hint: t.method.errorHint,
            diagnostics: t.method.errorDiagnostics,
            copy: t.method.errorCopy,
            copied: t.method.errorCopied,
          }}
        />
      ) : flow.googleError ? (
        <FieldError>{flow.googleError}</FieldError>
      ) : (
        <p className="text-center text-[10.5px] font-semibold text-emerald-900/55">{t.method.googleNote}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Channel tabs (phone ⇄ e-mail) with roving tabindex                 */
/* ------------------------------------------------------------------ */

function ChannelTabs({ flow }: { flow: FlowController }) {
  const { t } = flow;
  const order: AuthChannel[] = ["phone", "email"];
  const refs = useRef<Record<AuthChannel, HTMLButtonElement | null>>({ phone: null, email: null });

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: AuthChannel) => {
    const dir = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    event.preventDefault();
    const next = order[(order.indexOf(current) + dir + order.length) % order.length];
    flow.setChannel(next);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={t.method.channelsAria} className="grid grid-cols-2 gap-1.5">
      {order.map((id) => {
        const active = flow.channel === id;
        const Icon = id === "phone" ? Phone : Mail;
        const label = id === "phone" ? t.method.channelPhone : t.method.channelEmail;
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`channel-tab-${id}`}
            aria-selected={active}
            aria-controls={`channel-panel-${id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => flow.setChannel(id)}
            onKeyDown={(e) => onKeyDown(e, id)}
            className={`relative flex h-11 items-center justify-center gap-2 rounded-2xl border text-[13px] font-extrabold transition-colors ${FOCUS_RING} ${
              active
                ? "border-emerald-300 bg-white text-emerald-800 shadow-[0_6px_16px_-10px_rgba(6,78,59,0.5)]"
                : "border-transparent bg-white/55 text-emerald-900/60 hover:text-emerald-800"
            }`}
          >
            <Icon size={15} strokeWidth={2.4} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Phone + OTP panel                                                  */
/* ------------------------------------------------------------------ */

function PhonePanel({ flow }: { flow: FlowController }) {
  const { t } = flow;
  const [edited, setEdited] = useState<string | null>(null);
  const sending = flow.busy === "otp-send";
  const verifying = flow.busy === "otp-verify";
  const hasChallenge = Boolean(flow.challenge);
  // While a challenge is open the field is locked; otherwise it shows whatever
  // the user has typed on top of the verified number. Derived, never mirrored.
  const digits = edited ?? flow.phoneDigits;
  const setDigits = setEdited;

  const phoneError = flow.fieldErrors.phone ?? null;

  return (
    <div
      role="tabpanel"
      id="channel-panel-phone"
      aria-labelledby="channel-tab-phone"
      className="flex flex-col gap-3"
    >
      <div className="text-center">
        <h2 className="text-[15px] font-black text-emerald-950">{t.phone.title}</h2>
        <p className="mx-auto mt-0.5 max-w-[36ch] text-[11.5px] font-semibold leading-5 text-emerald-900/70">
          {t.phone.subtitle}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="auth-phone" className="text-[12.5px] font-extrabold text-emerald-900">
          {t.method.channelPhone}
        </label>
        <div dir="ltr" className="flex items-stretch gap-2">
          <span
            aria-label={t.phone.prefixAria}
            title={t.phone.prefixAria}
            dir="ltr"
            className="grid h-12 shrink-0 place-items-center rounded-2xl border border-[#D6ECE0] bg-white/85 px-3 text-[14px] font-black text-emerald-800"
          >
            {DZ_COUNTRY_CODE}
          </span>
          <input
            id="auth-phone"
            name="phone"
            type="tel"
            dir="ltr"
            inputMode="numeric"
            autoComplete="tel-national"
            enterKeyHint="send"
            placeholder={t.phone.placeholder}
            value={formatDzPhone(digits)}
            onChange={(e) => setDigits(normalizeDzPhone(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void flow.handleSendOTP(digits);
            }}
            disabled={hasChallenge}
            aria-invalid={phoneError ? true : undefined}
            aria-describedby={phoneError ? "auth-phone-error" : "auth-phone-hint"}
            className="field-input h-12 flex-1 px-4 text-center tracking-[0.08em]"
          />
        </div>
        {phoneError ? (
          <p id="auth-phone-error" role="alert" className="text-[11.5px] font-bold text-rose-700">
            {phoneError}
          </p>
        ) : (
          <p id="auth-phone-hint" className="text-[11.5px] font-medium text-emerald-800/70">
            {t.phone.helper}
          </p>
        )}
      </div>

      <AnimatePresence initial={false} mode="wait">
        {!hasChallenge ? (
          <motion.div
            key="send"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className={GPU}
          >
            <PrimaryButton
              onClick={() => void flow.handleSendOTP(digits)}
              loading={sending}
              loadingLabel={t.phone.sending}
              icon={<MessageSquareLock size={17} strokeWidth={2.6} aria-hidden />}
            >
              {t.phone.send}
            </PrimaryButton>
          </motion.div>
        ) : (
          <motion.div
            key="otp"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className={`${GPU} flex flex-col gap-3 rounded-2xl border border-emerald-200/70 bg-emerald-50/50 p-3`}
          >
            <p className="text-center text-[12px] font-bold text-emerald-900">
              {t.phone.sentTo}{" "}
              <span dir="ltr" className="font-black tracking-wide text-emerald-800">
                {flow.challenge ? formatDzPhone(flow.challenge.phone) : ""}
              </span>
            </p>

            <div className="flex flex-col items-center gap-1">
              <OtpInput
                value={flow.otpCode}
                onChange={flow.setOtpCode}
                label={t.phone.otpLabel}
                describedBy="otp-hint"
                disabled={verifying}
                invalid={Boolean(flow.fieldErrors.otp)}
                autoFocus
              />
              {flow.fieldErrors.otp ? (
                <p id="otp-hint" role="alert" className="mt-1 text-center text-[11.5px] font-bold text-rose-700">
                  {flow.fieldErrors.otp}
                </p>
              ) : (
                <p id="otp-hint" className="mt-1 text-center text-[11px] font-medium text-emerald-800/75">
                  {flow.otpExpired
                    ? t.errors.codeExpired
                    : interpolate(t.phone.expiresIn, { min: flow.minLeft })}
                  {!flow.otpExpired && flow.otpAttemptsLeft < 4
                    ? ` · ${interpolate(t.phone.attempts, { n: flow.otpAttemptsLeft })}`
                    : ""}
                </p>
              )}
            </div>

            {flow.gateway.isDemo && flow.gateway.demoOtp && (
              <p className="rounded-xl border border-amber-300/60 bg-amber-50/80 px-3 py-2 text-center text-[11px] font-bold text-amber-900">
                {interpolate(t.demo.otpBody, { code: flow.gateway.demoOtp })}
              </p>
            )}

            <PrimaryButton
              onClick={() => void flow.handleVerifyOTP(flow.otpCode)}
              loading={verifying}
              loadingLabel={t.phone.verifying}
              disabled={flow.otpBlocked}
              icon={<ShieldCheck size={17} strokeWidth={2.6} aria-hidden />}
            >
              {t.phone.verify}
            </PrimaryButton>

            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => void flow.handleResendOtp()}
                disabled={flow.resendIn > 0 || sending}
                className={`rounded-xl px-2 py-1.5 text-[11.5px] font-extrabold text-emerald-700 transition-colors hover:text-emerald-600 disabled:cursor-not-allowed disabled:text-emerald-900/40 ${FOCUS_RING}`}
              >
                {flow.resendIn > 0 ? interpolate(t.phone.resendIn, { sec: flow.resendIn }) : t.phone.resend}
              </button>
              <span aria-hidden className="h-3 w-px bg-emerald-900/15" />
              <button
                type="button"
                onClick={() => {
                  flow.handleChangeNumber();
                  setDigits("");
                }}
                autoFocus
                className={`rounded-xl px-2 py-1.5 text-[11.5px] font-extrabold text-emerald-800/75 transition-colors hover:text-emerald-700 ${FOCUS_RING}`}
              >
                {t.phone.changeNumber}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {flow.channel === "phone" && flow.mode === "register" && (
        <p className="flex items-center justify-center gap-1.5 text-[10.5px] font-bold text-emerald-800/70">
          <Sparkles size={12} strokeWidth={2.6} aria-hidden />
          {t.role.hint}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  E-mail panel                                                       */
/* ------------------------------------------------------------------ */

function EmailPanel({ flow }: { flow: FlowController }) {
  const { t } = flow;
  const isRegister = flow.mode === "register";
  const busy = flow.busy === "email" || flow.busy === "forgot";

  return (
    <div
      role="tabpanel"
      id="channel-panel-email"
      aria-labelledby="channel-tab-email"
      className="flex flex-col gap-3"
    >
      <AnimatePresence initial={false}>
        {isRegister && (
          <motion.div
            key="name"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className={`${GPU} overflow-hidden`}
          >
            <TextField
              label={t.email.name}
              placeholder={t.email.namePlaceholder}
              autoComplete="name"
              value={flow.email.name}
              onChange={(e) => flow.setEmailField("name", e.target.value)}
              error={flow.fieldErrors.name}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <TextField
        label={t.email.email}
        type="email"
        dir="ltr"
        inputMode="email"
        autoComplete="email"
        placeholder={t.email.emailPlaceholder}
        value={flow.email.email}
        onChange={(e) => flow.setEmailField("email", e.target.value)}
        error={flow.fieldErrors.email}
      />

      <PasswordField
        label={t.email.password}
        dir="ltr"
        autoComplete={isRegister ? "new-password" : "current-password"}
        placeholder={t.email.passwordPlaceholder}
        value={flow.email.password}
        onChange={(e) => flow.setEmailField("password", e.target.value)}
        error={flow.fieldErrors.password}
        showLabel={t.email.show}
        hideLabel={t.email.hide}
        hint={
          !isRegister && (
            <button
              type="button"
              onClick={() => void flow.handleForgotPassword()}
              className={`rounded-lg text-[11px] font-extrabold text-emerald-700 transition-colors hover:text-emerald-600 ${FOCUS_RING}`}
            >
              {flow.busy === "forgot" ? t.email.busy : t.email.forgot}
            </button>
          )
        }
      />

      {isRegister && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={`${GPU} flex flex-col gap-2 rounded-2xl border border-emerald-200/60 bg-emerald-50/40 p-2.5`}
        >
          <StrengthMeter
            score={flow.emailStrength.score}
            labels={t.email.strengthLabels}
            ariaLabel={t.email.strengthAria}
          />
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <RuleCheck ok={flow.emailStrength.rules.length}>{t.email.ruleLength}</RuleCheck>
            <RuleCheck ok={flow.emailStrength.rules.letter}>{t.email.ruleLetter}</RuleCheck>
            <RuleCheck ok={flow.emailStrength.rules.number}>{t.email.ruleNumber}</RuleCheck>
          </div>
        </motion.div>
      )}

      <AnimatePresence initial={false}>
        {isRegister && (
          <motion.div
            key="confirm"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className={`${GPU} overflow-hidden`}
          >
            <PasswordField
              label={t.email.confirm}
              dir="ltr"
              autoComplete="new-password"
              placeholder={t.email.confirmPlaceholder}
              value={flow.email.confirm}
              onChange={(e) => flow.setEmailField("confirm", e.target.value)}
              error={flow.fieldErrors.confirm}
              showLabel={t.email.show}
              hideLabel={t.email.hide}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <PrimaryButton
        onClick={() => void flow.handleEmailAuth()}
        loading={busy}
        loadingLabel={t.email.busy}
        icon={
          flow.lang === "ar" ? (
            <ArrowLeft size={17} strokeWidth={2.8} aria-hidden />
          ) : (
            <ArrowRight size={17} strokeWidth={2.8} aria-hidden />
          )
        }
      >
        {isRegister ? t.email.submitRegister : t.email.submitSignin}
      </PrimaryButton>

      {isRegister && (
        <p className="text-center text-[10.5px] font-medium leading-5 text-emerald-900/60">
          {t.email.terms}
        </p>
      )}

      {flow.errorMessage && Object.keys(flow.fieldErrors).length === 0 && (
        <div className="flex justify-center">
          <Badge tone="amber" className="max-w-full">
            {flow.errorMessage}
          </Badge>
        </div>
      )}
    </div>
  );
}
