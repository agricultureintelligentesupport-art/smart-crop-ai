"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  Leaf,
  LogOut,
  MapPin,
  Settings2,
  Sprout,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AmbientBackdrop from "@/components/AmbientBackdrop";
import LanguageSwitch from "@/components/auth/LanguageSwitch";
import { EASE_OUT, FOCUS_RING, GPU } from "@/components/auth/ui";
import { useAuth } from "@/context/AuthContext";
import { computeIrrigation, weatherFor } from "@/lib/agronomy";
import { AUTH } from "@/lib/auth/copy";
import { DASHBOARD } from "@/lib/dashboard/copy";
import { guestDisplayName, useGuest } from "@/lib/auth/guest";
import { useProfile } from "@/lib/auth/profile";
import type { AuthRole } from "@/lib/auth/types";
import { DEFAULT_WILAYA_CODE, REGIONS, getWilaya, type Lang } from "@/lib/wilayas";import { useLang } from "@/lib/use-lang";
import FieldTasksCard from "./FieldTasksCard";
import IrrigationCard from "./IrrigationCard";
import SatelliteCard from "./SatelliteCard";
import ScanCard from "./ScanCard";
import WeatherCard from "./WeatherCard";
import WilayaSelect from "./WilayaSelect";
import BottomNav, { type DashboardTab } from "./BottomNav";
import QuickReadHero from "./QuickReadHero";
import { Chip, Segmented } from "./parts";

const MONTH_LOCALE: Record<Lang, string> = { ar: "ar-DZ", fr: "fr-DZ" };

/** Horizontal padding of the app column, shared by header, screens and nav. */
const APP_COLUMN = "mx-auto w-full max-w-[560px]";
/** Clearance above the floating bottom navigation (+ safe area). */
const NAV_CLEARANCE = "pb-[calc(6.75rem+env(safe-area-inset-bottom))]";

/**
 * The live member dashboard, rendered by `/dashboard`. Every number reacts to
 * the wilaya + crop + parcel inputs, so the page is fully operational without
 * a backend: it is seeded, deterministic and clearly labelled as an estimate.
 *
 * Session-gated with a guest escape hatch: an authenticated user (Google,
 * phone or e-mail — Firebase session or gateway-backed on-device session)
 * OR a local guest flag ("المتابعة كزائر") is required; anyone else is
 * redirected straight to the auth wizard.
 *
 * UI shell: a mobile-first app screen — clean greeting header, a fixed glass
 * bottom navigation (الرئيسية / المستشار / السقي / الحساب) switching between
 * three in-app screens, with the assistant living on its own route. All data
 * hooks, computations and handlers are unchanged by this shell.
 */
export default function DashboardView() {
  const router = useRouter();
  const { lang, setLang } = useLang("ar");
  const t = DASHBOARD[lang];
  const brand = AUTH[lang].header;
  const { profile, ready, patch, clear } = useProfile();
  const { user: authUser, profile: authProfile, signOut: authSignOut, updateProfile } = useAuth();
  const { isGuest } = useGuest();

  /** `null` = follow the stored profile; a value = the user overrode it here. */
  const [wilayaOverride, setWilayaOverride] = useState<string | null>(null);
  const [roleOverride, setRoleOverride] = useState<AuthRole | null>(null);
  /** Active bottom-navigation screen (UI shell state only). */
  const [tab, setTab] = useState<DashboardTab>("home");
  /** Parcel size in hectares: one input, consumed by every card. */
  const [areaHa, setAreaHa] = useState(2);

  const scrollRef = useRef<HTMLElement | null>(null);

  // Derived from the stored profile (server renders the default, so hydration
  // is stable and no effect has to copy state around).
  const wilayaCode =
    wilayaOverride ?? profile?.wilayaCode ?? authProfile?.wilayaCode ?? authProfile?.wilaya ?? DEFAULT_WILAYA_CODE;
  const role = roleOverride ?? profile?.role ?? (authProfile?.role as AuthRole | null) ?? null;

  // Session gate: a signed-in Firebase user, a stored authenticated session
  // (Google / phone / e-mail through the gateway) OR the local guest flag is
  // accepted. Legacy guest records are still rejected by `readProfile()`'s
  // guard — guest mode now lives in its own storage key (see auth/guest.ts).
  // A real member session always wins over a stale guest flag.
  const member = Boolean(authUser) || (profile?.uid ?? null) !== null;
  const guestActive = isGuest && !member;
  const authenticated = member || isGuest;
  useEffect(() => {
    if (!ready) return;
    if (!authenticated) router.replace("/auth");
  }, [authenticated, ready, router]);

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
  // Guests render as "زائر" / "Invité"; a real identity always wins.
  const displayName = guestActive
    ? guestDisplayName(lang)
    : profile?.displayName ?? authProfile?.displayName ?? authUser?.displayName ?? "";
  const greeting = t.welcome.member.replace(
    "{name}",
    displayName || (lang === "ar" ? "فلاح" : "Agriculteur"),
  );
  const caption = t.welcome.caption
    .replace("{wilaya}", lang === "ar" ? wilaya.nameAr : wilaya.nameFr)
    .replace("{month}", month);

  const updateWilaya = (code: string) => {
    setWilayaOverride(code);
    patch({ wilayaCode: code });
    if (authUser) {
      void updateProfile({ wilaya: code, wilayaCode: code });
    }
  };

  const updateRole = (next: AuthRole) => {
    setRoleOverride(next);
    patch({ role: next });
    if (authUser) {
      void updateProfile({ role: next });
    }
  };

  const signOut = async () => {
    try {
      await authSignOut();
    } catch {
      // ignore
    }
    clear();
    router.push("/auth");
  };

  // New screens start at the top (the scroll container persists across tabs).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  /** Brand avatar: a deterministic leaf glyph (never hydration-dependent). */
  const renderAvatar = (size: "md" | "lg") => (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 text-white shadow-[0_8px_20px_-8px_rgba(16,185,129,0.8)] ring-1 ring-emerald-500/40 ${
        size === "lg" ? "h-14 w-14" : "h-11 w-11"
      }`}
    >
      <Leaf size={size === "lg" ? 24 : 19} strokeWidth={2.4} />
    </span>
  );

  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className={`screen-h relative flex flex-col overflow-hidden text-emerald-950 ${
        lang === "ar" ? "font-arabic" : "font-latin"
      }`}
      style={{ background: "linear-gradient(180deg, #F4FBF7 0%, #E6F7EF 58%, #DCF5E6 100%)" }}
    >
      <AmbientBackdrop variant="dashboard" />

      {/* Clean app header: greeting + status, location pill, language. */}
      <header className="pt-safe relative z-30 shrink-0 px-4 pb-1 pt-3">
        <div className={`${APP_COLUMN} flex items-center gap-2.5`}>
          {renderAvatar("md")}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-black leading-6 text-emerald-950">{greeting}</h1>
            <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-white/70 px-2 py-[2px] text-[9.5px] font-black text-emerald-700 ring-1 ring-[#E2F1E8]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {guestActive ? t.header.badgeGuest : t.header.badgeMember}
            </span>
          </div>
          <LanguageSwitch
            lang={lang}
            onChange={setLang}
            ariaLabel={lang === "ar" ? "اختيار اللغة" : "Choix de la langue"}
            labels={{ ar: t.header.langAr, fr: t.header.langFr }}
            layoutId="dashboard-lang-thumb"
          />
        </div>

        {/* Context strip: where the farm is + entry to personalisation */}
        <div className={`${APP_COLUMN} mt-2.5 flex items-center gap-1.5`}>
          <span className="glass inline-flex h-9 min-w-0 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-black text-emerald-900">
            <MapPin size={13} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-600" />
            <span className="truncate">{lang === "ar" ? wilaya.nameAr : wilaya.nameFr}</span>
          </span>
          <Chip tone="slate">{lang === "ar" ? REGIONS[wilaya.region].ar : REGIONS[wilaya.region].fr}</Chip>
          {role && (
            <Chip tone="emerald" icon={<Sprout size={11} strokeWidth={3} aria-hidden />}>
              {t.personalize.roleOptions[role]}
            </Chip>
          )}
          <span className="min-w-2 flex-1" />
          {tab !== "profile" && (
            <button
              type="button"
              onClick={() => setTab("profile")}
              className={`glass inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[11px] font-black text-emerald-800 transition-colors hover:bg-white/95 active:bg-emerald-50 ${FOCUS_RING}`}
            >
              <Settings2 size={13} strokeWidth={2.8} aria-hidden />
              {t.personalize.edit}
            </button>
          )}
        </div>
      </header>

      {/* Scroll body — one screen at a time, driven by the bottom bar */}
      <main
        ref={scrollRef}
        className="scroll-area relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className={`${GPU} ${APP_COLUMN} px-4 pt-2 ${NAV_CLEARANCE}`}
          >
            {tab === "home" && (
              <div className="flex flex-col gap-3">
                {/* Daily status hero */}
                <QuickReadHero
                  t={t}
                  lang={lang}
                  netMmDay={irrigation.netMmDay}
                  areaHa={areaHa}
                  crop={crop}
                />

                {/* Data widgets */}
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

                {/* Account shortcut (full account screen lives in the bottom bar) */}
                <section
                  aria-label={t.nav.profile}
                  className="glass-card flex items-center gap-3 rounded-3xl p-3.5"
                >
                  {renderAvatar("md")}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-black text-emerald-950">
                      {displayName || (lang === "ar" ? "فلاح" : "Agriculteur")}
                    </p>
                    <p className="mt-0.5 truncate text-[10.5px] font-semibold text-emerald-900/65">
                      {role
                        ? t.personalize.roleOptions[role]
                        : lang === "ar"
                          ? wilaya.nameAr
                          : wilaya.nameFr}
                      <span aria-hidden className="mx-1.5 text-emerald-900/25">·</span>
                      {brand.brand}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void signOut()}
                    className={`inline-flex h-11 shrink-0 items-center gap-1.5 rounded-2xl bg-rose-50/90 px-3 text-[11px] font-black text-rose-700 ring-1 ring-rose-200/80 transition-colors hover:bg-rose-100/90 active:bg-rose-100 ${FOCUS_RING}`}
                  >
                    <LogOut size={14} strokeWidth={2.6} aria-hidden />
                    {t.header.signOut}
                  </button>
                </section>

                <p className="mx-auto max-w-[70ch] pb-1 text-center text-[10.5px] font-semibold leading-5 text-emerald-900/60">
                  {t.footer.builtWith} · {t.footer.disclaimer}
                </p>
              </div>
            )}

            {tab === "irrigation" && (
              <div className="flex flex-col gap-3">
                <QuickReadHero
                  t={t}
                  lang={lang}
                  netMmDay={irrigation.netMmDay}
                  areaHa={areaHa}
                  crop={crop}
                />
                <IrrigationCard
                  t={t}
                  lang={lang}
                  wilayaCode={wilayaCode}
                  areaHa={areaHa}
                  onAreaChange={setAreaHa}
                />
                <p className="mx-auto max-w-[70ch] pb-1 text-center text-[10.5px] font-semibold leading-5 text-emerald-900/60">
                  {t.footer.builtWith} · {t.footer.disclaimer}
                </p>
              </div>
            )}

            {tab === "profile" && (
              <div className="flex flex-col gap-3">
                {/* Identity */}
                <section aria-label={t.nav.profile} className="glass-card rounded-3xl p-4">
                  <div className="flex items-center gap-3">
                    {renderAvatar("lg")}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-black text-emerald-950">
                        {displayName || (lang === "ar" ? "فلاح" : "Agriculteur")}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[10.5px] font-semibold leading-4 text-emerald-900/65">
                        {caption}
                      </p>
                    </div>
                  </div>
                </section>

                {/* Personalisation */}
                <section aria-label={t.personalize.title} className="glass-card flex flex-col gap-3 rounded-3xl p-4">
                  <div>
                    <p className="text-[13px] font-black text-emerald-950">{t.personalize.title}</p>
                    <p className="mt-0.5 text-[11px] font-semibold text-emerald-900/70">
                      {t.personalize.subtitle}
                    </p>
                  </div>

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

                  <p className="text-[10.5px] font-semibold text-emerald-900/60">{t.personalize.savedNote}</p>
                </section>

                {/* Session */}
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className={`glass-card inline-flex h-12 items-center justify-center gap-2 rounded-3xl text-[13px] font-black text-rose-700 transition-colors hover:bg-rose-50/80 active:bg-rose-100/80 ${FOCUS_RING}`}
                >
                  <LogOut size={16} strokeWidth={2.6} aria-hidden />
                  {t.header.signOut}
                </button>

                <p className="mx-auto max-w-[70ch] pb-1 text-center text-[10.5px] font-semibold leading-5 text-emerald-900/60">
                  {t.footer.builtWith} · {t.footer.disclaimer}
                </p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Fixed app bottom navigation */}
      <BottomNav t={t} tab={tab} onTabChange={setTab} />
    </div>
  );
}
