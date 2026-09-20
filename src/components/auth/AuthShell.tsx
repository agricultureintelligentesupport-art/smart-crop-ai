"use client";

import type { ReactNode } from "react";
import AmbientBackdrop from "@/components/AmbientBackdrop";
import type { AuthCopy } from "@/lib/auth/copy";
import type { Lang } from "@/lib/wilayas";
import AuthHeader from "./AuthHeader";
import StepLadder, { type StepId } from "./StepLadder";

interface AuthShellProps {
  t: AuthCopy;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  navHref: string;
  navLabel: string;
  navIcon?: ReactNode;
  plan: StepId[];
  current: StepId;
  allDone?: boolean;
  onStepSelect?: (step: StepId) => void;
  /** Retained between steps so the card chrome never flickers. */
  children: ReactNode;
}

/**
 * Chrome for the whole auth flow: gradient canvas, ambient backdrop, header,
 * progress ladder and the scrolling glass card.
 *
 * Layout contract: `body` is overflow-hidden app-wide, so the shell owns the
 * single scroll container (main) and the header stays pinned on 360px phones
 * with the on-screen keyboard open.
 */
export default function AuthShell({
  t,
  lang,
  onLangChange,
  navHref,
  navLabel,
  navIcon,
  plan,
  current,
  allDone,
  onStepSelect,
  children,
}: AuthShellProps) {
  const rtl = lang === "ar";
  return (
    <div
      dir={rtl ? "rtl" : "ltr"}
      className={`screen-h relative mx-auto flex w-full max-w-[520px] flex-col overflow-hidden text-emerald-950 sm:border-x sm:border-emerald-900/10 ${
        rtl ? "font-arabic" : "font-latin"
      }`}
      style={{ background: "linear-gradient(180deg, #F4FBF7 0%, #E6F7EF 58%, #DCF5E6 100%)" }}
    >
      <AmbientBackdrop variant="auth" />

      <AuthHeader
        t={t}
        lang={lang}
        onLangChange={onLangChange}
        navHref={navHref}
        navLabel={navLabel}
        navIcon={navIcon}
      />

      <main className="scroll-area relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full flex-1 flex-col px-4 pb-3 pt-1 sm:px-5">
          {/* my-auto centres short steps but never clips tall ones: auto
              margins collapse to 0 once the content overflows, so every part
              of the form stays reachable by scrolling. */}
          <div className="my-auto flex min-w-0 flex-col">
            <StepLadder
              plan={plan}
              current={current}
              labels={{ method: t.steps.method, role: t.steps.role, location: t.steps.location }}
              ariaLabel={t.steps.aria}
              stepWord={t.steps.stepWord}
              ofWord={t.steps.ofWord}
              onSelect={onStepSelect}
              allDone={allDone}
            />

            <div className="glass-card rounded-3xl p-4 sm:p-5">{children}</div>

            <p className="pb-safe mt-3 text-center text-[10.5px] font-bold text-emerald-900/55">
              {t.header.brand} · {t.header.brandTag}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
