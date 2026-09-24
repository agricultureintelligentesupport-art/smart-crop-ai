"use client";

import { Languages, LogOut } from "lucide-react";
import Sheet from "@/components/app/Sheet";
import LanguageSwitch from "@/components/auth/LanguageSwitch";
import { FOCUS_RING } from "@/components/auth/ui";
import { APP_SHELL } from "@/lib/app/copy";
import type { DashboardCopy } from "@/lib/dashboard/copy";
import type { Lang } from "@/lib/wilayas";
import WilayaSelect from "./WilayaSelect";

/**
 * Settings sheet, opened from the "الإعدادات" tab. Presentation only: it hosts
 * the language switch and sign-out button that used to sit in the top bar and
 * the wilaya picker, all wired to the exact same handlers as before.
 */
export default function SettingsSheet({
  open,
  onClose,
  t,
  lang,
  onLangChange,
  wilayaCode,
  onWilayaChange,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  t: DashboardCopy;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
  wilayaCode: string;
  onWilayaChange: (code: string) => void;
  onSignOut: () => void;
}) {
  const s = APP_SHELL[lang].settings;
  const heading = "px-1 text-[12px] font-black tracking-wide text-emerald-800/65";

  return (
    <Sheet open={open} onClose={onClose} title={s.title} subtitle={s.subtitle} lang={lang}>
      <div className="flex flex-col gap-4">
        {/* Language */}
        <section aria-label={s.language} className="flex flex-col gap-2">
          <h3 className={heading}>{s.language}</h3>
          <div className="app-tile flex items-center gap-3 p-3">
            <span
              aria-hidden
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[0.85rem] bg-white text-emerald-700 ring-1 ring-[rgba(6,78,59,0.08)]"
            >
              <Languages size={18} strokeWidth={2.4} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-black text-emerald-950">
              {lang === "ar" ? t.header.langAr : t.header.langFr}
            </span>
            <LanguageSwitch
              lang={lang}
              onChange={onLangChange}
              ariaLabel={lang === "ar" ? "اختيار اللغة" : "Choix de la langue"}
              labels={{ ar: t.header.langAr, fr: t.header.langFr }}
              layoutId="settings-lang-thumb"
            />
          </div>
        </section>

        {/* Wilaya */}
        <section aria-label={s.region} className="flex flex-col gap-2">
          <h3 className={heading}>{s.region}</h3>
          <WilayaSelect t={t} lang={lang} value={wilayaCode} onChange={onWilayaChange} />
          <p className="px-1 text-[11.5px] font-semibold leading-5 text-emerald-900/55">{t.personalize.savedNote}</p>
        </section>

        {/* Session */}
        <section aria-label={s.session} className="flex flex-col gap-2">
          <h3 className={heading}>{s.session}</h3>
          <button
            type="button"
            onClick={onSignOut}
            className={`app-tile flex items-center gap-3 p-3 text-start transition-colors hover:border-rose-300 ${FOCUS_RING}`}
          >
            <span
              aria-hidden
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[0.85rem] bg-white text-rose-600 ring-1 ring-[rgba(6,78,59,0.08)]"
            >
              <LogOut size={18} strokeWidth={2.4} />
            </span>
            <span className="min-w-0 flex-1 text-[13.5px] font-black text-rose-700">{t.header.signOut}</span>
          </button>
        </section>
      </div>
    </Sheet>
  );
}
