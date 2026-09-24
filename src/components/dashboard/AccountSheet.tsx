"use client";

import { ChevronLeft, Compass, Info, Languages, Leaf, LogOut, Sprout, UserRound } from "lucide-react";
import Link from "next/link";
import Sheet from "@/components/app/Sheet";
import LanguageSwitch from "@/components/auth/LanguageSwitch";
import { FOCUS_RING } from "@/components/auth/ui";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { AuthRole } from "@/lib/auth/types";
import { getWilaya, type Lang } from "@/lib/wilayas";
import WilayaSelect from "./WilayaSelect";
import { Chip, Segmented } from "./parts";

/**
 * Account & personalisation sheet, opened from the "حسابي" tab. Holds the
 * identity recap, the wilaya / role controls, the language switch and the
 * sign-out action (all relocated here from the top bar — the same handlers as
 * before, no logic lives here) and the way back to the intro screen.
 */
export default function AccountSheet({
  open,
  onClose,
  t,
  lang,
  displayName,
  statusLabel,
  role,
  wilayaCode,
  onWilayaChange,
  onRoleChange,
  onLangChange,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  t: DashboardCopy;
  lang: Lang;
  displayName: string;
  /** "حساب مُفعّل" / "حساب زائر". */
  statusLabel: string;
  role: AuthRole | null;
  wilayaCode: string;
  onWilayaChange: (code: string) => void;
  onRoleChange: (role: AuthRole) => void;
  /** Same setter the header switch used — relocation only. */
  onLangChange: (lang: Lang) => void;
  /** Same handler the header sign-out button used — relocation only. */
  onSignOut: () => void;
}) {
  const wilaya = getWilaya(wilayaCode);

  return (
    <Sheet open={open} onClose={onClose} title={t.account.title} subtitle={t.account.subtitle} lang={lang}>
      <div className="flex flex-col gap-4">
        {/* Identity */}
        <div className="app-tile flex items-center gap-3 p-3">
          <span
            aria-hidden
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 text-white shadow-[0_8px_20px_-10px_rgba(16,185,129,0.95)]"
          >
            <UserRound size={19} strokeWidth={2.5} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-black text-emerald-950">{displayName}</p>
            <p className="mt-0.5 truncate text-[11.5px] font-semibold text-emerald-900/60">
              {lang === "ar" ? wilaya.nameAr : wilaya.nameFr}
            </p>
          </div>
          <Chip tone="emerald">{statusLabel}</Chip>
        </div>

        {/* Personalisation — same handlers as the inline panel it replaces */}
        <section aria-label={t.account.personalization} className="flex flex-col gap-3">
          <h3 className="px-1 text-[12px] font-black tracking-wide text-emerald-800/65">
            {t.account.personalization}
          </h3>
          <WilayaSelect t={t} lang={lang} value={wilayaCode} onChange={onWilayaChange} />
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 px-1 text-[12px] font-extrabold text-emerald-900">
              <Sprout size={13} strokeWidth={2.6} aria-hidden className="text-emerald-600" />
              {t.personalize.role}
            </span>
            <Segmented<AuthRole>
              layoutId="account-role"
              ariaLabel={t.personalize.role}
              value={role ?? "farmer"}
              onChange={onRoleChange}
              options={[
                { id: "farmer", label: t.personalize.roleOptions.farmer },
                { id: "agronomist", label: t.personalize.roleOptions.agronomist },
                { id: "investor", label: t.personalize.roleOptions.investor },
              ]}
            />
          </div>
          <p className="px-1 text-[11.5px] font-semibold leading-5 text-emerald-900/55">
            {t.personalize.savedNote}
          </p>
        </section>

        {/* Language — relocated from the top bar; same switch, same handler */}
        <div className="app-tile flex items-center gap-3 p-3 ps-3.5">
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[0.85rem] bg-white text-emerald-700 ring-1 ring-[rgba(6,78,59,0.08)]"
          >
            <Languages size={18} strokeWidth={2.4} />
          </span>
          <span className="min-w-0 flex-1 text-[13.5px] font-black text-emerald-950">{t.account.language}</span>
          <LanguageSwitch
            lang={lang}
            onChange={onLangChange}
            ariaLabel={lang === "ar" ? "اختيار اللغة" : "Choix de la langue"}
            labels={{ ar: t.header.langAr, fr: t.header.langFr }}
            layoutId="dashboard-lang-thumb"
          />
        </div>

        {/* Intro screen — the entry point that used to sit in the header */}
        <Link
          href="/"
          className={`app-tile flex items-center gap-3 p-3 transition-colors hover:border-emerald-300 ${FOCUS_RING}`}
        >
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[0.85rem] bg-white text-emerald-700 ring-1 ring-[rgba(6,78,59,0.08)]"
          >
            <Compass size={18} strokeWidth={2.4} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-black text-emerald-950">{t.account.intro}</span>
            <span className="mt-0.5 block text-[11.5px] font-semibold leading-4 text-emerald-900/60">
              {t.account.introHint}
            </span>
          </span>
          <ChevronLeft size={18} strokeWidth={2.6} aria-hidden className="shrink-0 text-emerald-700/60 rtl:rotate-0 ltr:rotate-180" />
        </Link>

        {/* Sign out — relocated from the top bar; same handler, new home */}
        <button
          type="button"
          onClick={onSignOut}
          className={`app-tile flex w-full items-center gap-3 p-3 ps-3.5 text-start transition-colors hover:border-emerald-300 ${FOCUS_RING}`}
        >
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[0.85rem] bg-white text-emerald-700 ring-1 ring-[rgba(6,78,59,0.08)]"
          >
            <LogOut size={18} strokeWidth={2.4} />
          </span>
          <span className="min-w-0 flex-1 text-[13.5px] font-black text-emerald-950">{t.header.signOut}</span>
        </button>

        {/* About */}
        <div className="flex flex-col gap-2 rounded-[1.1rem] bg-[#f4f8f5] p-3.5">
          <p className="flex items-center gap-1.5 text-[11.5px] font-black text-emerald-800/70">
            <Info size={12} strokeWidth={2.8} aria-hidden />
            {t.account.about}
          </p>
          <p className="text-[11.5px] font-semibold leading-5 text-emerald-900/60">{t.footer.disclaimer}</p>
          <p className="flex items-center gap-1.5 text-[10.5px] font-bold text-emerald-800/60">
            <Leaf size={12} strokeWidth={2.8} aria-hidden className="text-emerald-500" />
            {t.footer.builtWith}
          </p>
        </div>
      </div>
    </Sheet>
  );
}
