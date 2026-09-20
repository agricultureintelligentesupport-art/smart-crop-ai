"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Clock,
  Home,
  Leaf,
  LogOut,
  MapPin,
  Settings2,
  ShieldCheck,
  Sprout,
  Sun,
  UserRound,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AmbientBackdrop from "@/components/AmbientBackdrop";
import LanguageSwitch from "@/components/auth/LanguageSwitch";
import { EASE_OUT, FOCUS_RING, GPU } from "@/components/auth/ui";
import { computeIrrigation, weatherFor } from "@/lib/agronomy";
import { AUTH } from "@/lib/auth/copy";
import { DASHBOARD } from "@/lib/dashboard/copy";
import { useProfile } from "@/lib/auth/profile";
import type { AuthRole } from "@/lib/auth/types";
import { CROPS, DEFAULT_WILAYA_CODE, REGIONS, getWilaya, type Lang } from "@/lib/wilayas";
import { useLang } from "@/lib/use-lang";
import FieldTasksCard from "./FieldTasksCard";
import IrrigationCard from "./IrrigationCard";
import SatelliteCard from "./SatelliteCard";
import ScanCard from "./ScanCard";
import UpgradeCard from "./UpgradeCard";
import WeatherCard, { fmt } from "./WeatherCard";
import WilayaSelect from "./WilayaSelect";
import { Chip, Segmented } from "./parts";

const MONTH_LOCALE: Record<Lang, string> = { ar: "ar-DZ", fr: "fr-DZ" };

/**
 * The live dashboard. `/guest` renders it in guest mode (local data only),
 * `/dashboard` in member mode (session required). Every number reacts to the
 * wilaya + crop + parcel inputs, so the page is fully operational without a
 * backend: it is seeded, deterministic and clearly labelled as an estimate.
 */
export default function DashboardView({ mode }: { mode: "guest" | "member" }) {
  const router = useRouter();
  const { lang, setLang } = useLang("ar");
  const t = DASHBOARD[lang];
  const brand = AUTH[lang].header;
  const { profile, ready, patch, save, clear } = useProfile();

  /** `null` = follow the stored profile; a value = the user overrode it here. */
  const [wilayaOverride, setWilayaOverride] = useState<string | null>(null);
  const [roleOverride, setRoleOverride] = useState<AuthRole | null>(null);
  const [openPersonalize, setOpenPersonalize] = useState(false);
  /** Parcel size in hectares: one input, consumed by every card. */
  const [areaHa, setAreaHa] = useState(2);

  // Derived from the stored profile (server renders the default, so hydration
  // is stable and no effect has to copy state around).
  const wilayaCode = wilayaOverride ?? profile?.wilayaCode ?? DEFAULT_WILAYA_CODE;
  const role = roleOverride ?? profile?.role ?? null;

  // /dashboard is member-only: no session → back to the auth flow.
  useEffect(() => {
    if (mode !== "member" || !ready) return;
    if (!profile) router.replace("/auth");
  }, [mode, profile, ready, router]);

  // A guest arriving without a record still gets one, so choices stick.
  useEffect(() => {
    if (mode !== "guest" || !ready || profile) return;
    save({
      uid: null,
      method: "guest",
      displayName: lang === "ar" ? "زائر" : "Invité",
      role: null,
      wilayaCode: DEFAULT_WILAYA_CODE,
      isGuest: true,
      lang,
      updatedAt: Date.now(),
    });
  }, [lang, mode, profile, ready, save]);

  const wilaya = getWilaya(wilayaCode);
  const weather = weatherFor(wilayaCode);
  const crop = wilaya.crops[0];
  const irrigation = computeIrrigation({
    wilayaCode,
    crop,
    areaHa,
    soil: wilaya.soil,
    system: "drip",
  });

  const month = new Intl.DateTimeFormat(MONTH_LOCALE[lang], { month: "long" }).format(new Date());
  const displayName = profile?.displayName ?? (mode === "guest" ? t.welcome.guest : "");
  const greeting =
    mode === "guest"
      ? t.welcome.guest
      : t.welcome.member.replace("{name}", displayName || (lang === "ar" ? "فلاح" : "Agriculteur"));

  const updateWilaya = (code: string) => {
    setWilayaOverride(code);
    patch({ wilayaCode: code });
  };

  const updateRole = (next: AuthRole) => {
    setRoleOverride(next);
    patch({ role: next });
  };

  const signOut = async () => {
    clear();
    router.push("/auth");
  };

  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className={`screen-h relative flex flex-col overflow-hidden text-emerald-950 ${
        lang === "ar" ? "font-arabic" : "font-latin"
      }`}
      style={{ background: "linear-gradient(180deg, #F4FBF7 0%, #E6F7EF 58%, #DCF5E6 100%)" }}
    >
      <AmbientBackdrop variant="dashboard" />

      {/* Header */}
      <header className="pt-safe relative z-30 mx-auto flex w-full max-w-[900px] shrink-0 items-center justify-between gap-2 px-3.5 pb-1.5 sm:px-5">
        <div className="glass flex h-12 min-w-0 items-center gap-2 rounded-2xl px-2 shadow-sm">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 shadow-[0_0_18px_rgba(16,185,129,0.55)]">
            <Leaf size={15} strokeWidth={2.4} className="text-white" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[11.5px] font-black whitespace-nowrap text-emerald-950">
              {brand.brand}
            </span>
            <span className="hidden truncate text-[8px] font-bold whitespace-nowrap text-emerald-700/80 min-[380px]:block">
              {mode === "guest" ? t.header.badgeGuest : t.header.badgeMember}
            </span>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <LanguageSwitch
            lang={lang}
            onChange={setLang}
            ariaLabel={lang === "ar" ? "اختيار اللغة" : "Choix de la langue"}
            labels={{ ar: t.header.langAr, fr: t.header.langFr }}
            layoutId="dashboard-lang-thumb"
          />
          {mode === "guest" ? (
            <Link
              href="/register"
              className={`glass inline-flex h-12 items-center gap-1.5 rounded-2xl px-3 text-[11.5px] font-extrabold whitespace-nowrap text-emerald-900 transition-colors hover:bg-white/95 ${FOCUS_RING}`}
            >
              <UserRound size={15} strokeWidth={2.4} aria-hidden />
              {t.header.navCreate}
            </Link>
          ) : (
            <>
              <Link
                href="/"
                aria-label={t.header.navHome}
                className={`glass grid h-12 w-12 place-items-center rounded-2xl text-emerald-900 transition-colors hover:bg-white/95 ${FOCUS_RING}`}
              >
                <Home size={16} strokeWidth={2.4} aria-hidden />
              </Link>
              <button
                type="button"
                onClick={() => void signOut()}
                aria-label={t.header.signOut}
                className={`glass grid h-12 w-12 place-items-center rounded-2xl text-emerald-900 transition-colors hover:bg-white/95 ${FOCUS_RING}`}
              >
                <LogOut size={16} strokeWidth={2.4} aria-hidden />
              </button>
            </>
          )}
        </div>
      </header>

      {/* Scroll body */}
      <main className="scroll-area relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-3 px-3.5 pb-6 pt-1 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-[20px] font-black leading-tight text-emerald-950">{greeting}</h1>
              <p className="mt-0.5 text-[11.5px] font-semibold text-emerald-900/70">
                {t.welcome.caption
                  .replace("{wilaya}", lang === "ar" ? wilaya.nameAr : wilaya.nameFr)
                  .replace("{month}", month)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone="slate" icon={<MapPin size={11} strokeWidth={3} aria-hidden />}>
                {lang === "ar" ? REGIONS[wilaya.region].ar : REGIONS[wilaya.region].fr}
              </Chip>
              {role && (
                <Chip tone="emerald" icon={<Sprout size={11} strokeWidth={3} aria-hidden />}>
                  {t.personalize.roleOptions[role]}
                </Chip>
              )}
              <button
                type="button"
                onClick={() => setOpenPersonalize((v) => !v)}
                aria-expanded={openPersonalize}
                className={`glass inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[10.5px] font-black text-emerald-800 transition-colors hover:bg-white/95 ${FOCUS_RING}`}
              >
                <Settings2 size={12} strokeWidth={3} aria-hidden />
                {openPersonalize ? t.personalize.close : t.personalize.edit}
              </button>
            </div>
          </div>

          {/* Personalisation */}
          <AnimatePresence initial={false}>
            {openPersonalize && (
              <motion.section
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.24, ease: EASE_OUT }}
                className={`${GPU} overflow-hidden`}
                aria-label={t.personalize.title}
              >
                <div className="glass-card flex flex-col gap-3 rounded-3xl p-3.5">
                  <div>
                    <p className="text-[13px] font-black text-emerald-950">{t.personalize.title}</p>
                    <p className="mt-0.5 text-[11px] font-semibold text-emerald-900/70">{t.personalize.subtitle}</p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <WilayaSelect t={t} lang={lang} value={wilayaCode} onChange={updateWilaya} />
                    <div className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-bold text-emerald-800/70">{t.personalize.role}</span>
                      <Segmented<AuthRole>
                        layoutId="dash-role"
                        ariaLabel={t.personalize.role}
                        value={role ?? "farmer"}
                        onChange={updateRole}
                        options={[
                          { id: "farmer", label: t.personalize.roleOptions.farmer },
                          { id: "agronomist", label: t.personalize.roleOptions.agronomist },
                          { id: "investor", label: t.personalize.roleOptions.investor },
                        ]}
                      />
                    </div>
                  </div>

                  <p className="text-[10.5px] font-semibold text-emerald-900/60">{t.personalize.savedNote}</p>
                </div>
              </motion.section>
            )}
          </AnimatePresence>

          {/* Quick read strip */}
          <section
            aria-label={t.advice.title}
            className="glass-card flex flex-col gap-1.5 rounded-3xl p-3.5"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden className="grid h-8 w-8 place-items-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-100">
                <Sun size={15} strokeWidth={2.5} />
              </span>
              <div>
                <p className="text-[13px] font-black text-emerald-950">{t.advice.title}</p>
                <p className="text-[10.5px] font-semibold text-emerald-900/65">{t.advice.subtitle}</p>
              </div>
            </div>
            <ul className="mt-1 flex flex-col gap-1 text-[11.5px] font-bold text-emerald-900/85">
              <li className="flex items-start gap-1.5">
                <Waves size={13} strokeWidth={2.6} aria-hidden className="mt-[2px] shrink-0 text-emerald-500" />
                {t.advice.line1
                  .replace("{mm}", fmt(irrigation.netMmDay, 1))
                  .replace("{area}", fmt(areaHa, 1))}
              </li>
              <li className="flex items-start gap-1.5">
                <Clock size={13} strokeWidth={2.6} aria-hidden className="mt-[2px] shrink-0 text-emerald-500" />
                {t.advice.line2.replace("{from}", "05:30").replace("{to}", "08:30")}
              </li>
              <li className="flex items-start gap-1.5">
                <ShieldCheck size={13} strokeWidth={2.6} aria-hidden className="mt-[2px] shrink-0 text-emerald-500" />
                {t.advice.line3
                  .replace("{crop}", CROPS[crop][lang])
                  .replace("{risk}", lang === "ar" ? "الآفات الفطرية" : "les maladies fongiques")}
              </li>
            </ul>
          </section>

          {/* Cards */}
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <WeatherCard t={t} lang={lang} weather={weather} />
            <IrrigationCard
              t={t}
              lang={lang}
              wilayaCode={wilayaCode}
              areaHa={areaHa}
              onAreaChange={setAreaHa}
            />
            <SatelliteCard t={t} lang={lang} wilayaCode={wilayaCode} crop={crop} />
            <FieldTasksCard t={t} lang={lang} wilayaCode={wilayaCode} crop={crop} areaHa={areaHa} />
            <ScanCard t={t} wilayaCode={wilayaCode} />
            {mode === "guest" && (
              <div className="min-w-0 sm:col-span-2">
                <UpgradeCard t={t} lang={lang} />
              </div>
            )}
          </div>

          <p className="mx-auto max-w-[70ch] text-center text-[10.5px] font-semibold leading-5 text-emerald-900/60">
            {t.footer.builtWith} · {t.footer.disclaimer}
          </p>
        </div>
      </main>
    </div>
  );
}
