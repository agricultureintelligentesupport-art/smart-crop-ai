"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Bot, Droplets, Leaf, LogOut, MapPin, Sprout, Sun } from "lucide-react";
import Link from "next/link";
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
import { DEFAULT_WILAYA_CODE, REGIONS, getWilaya, type Lang } from "@/lib/wilayas";
import { useLang } from "@/lib/use-lang";
import FieldTasksCard from "./FieldTasksCard";
import IrrigationCard from "./IrrigationCard";
import SatelliteCard from "./SatelliteCard";
import ScanCard from "./ScanCard";
import WeatherCard, { fmt } from "./WeatherCard";
import WilayaSelect from "./WilayaSelect";
import BottomNav, { type DashboardTab } from "./BottomNav";
import QuickReadHero from "./QuickReadHero";
import { Chip, Segmented } from "./parts";

const MONTH_LOCALE: Record<Lang, string> = { ar: "ar-DZ", fr: "fr-DZ" };

/** Horizontal padding of the app column, shared by header, screens and dock. */
const APP_COLUMN = "mx-auto w-full max-w-[560px]";
/** Clearance above the floating bottom dock (+ safe area). */
const NAV_CLEARANCE = "pb-[calc(7.25rem+env(safe-area-inset-bottom))]";

/** Screen-level transition: fade + slide-up (with bento stagger on children). */
const SCREEN = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: EASE_OUT, staggerChildren: 0.055 },
  },
  exit: { opacity: 0, y: -12, transition: { duration: 0.18, ease: EASE_OUT } },
} as const;

/** Bento card entrance item. */
const ITEM = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.12 } },
} as const;

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
 * UI shell (bento architecture): four bottom-dock screens —
 *   الرئيسية   hero ring gauge + quick actions + tasks + NDVI + weather
 *   السقي      dedicated water-needs calculator
 *   المستشار   plant-health scan + AI chat entry
 *   الحساب     profile, wilaya/role, language, sign-out
 * All data hooks, computations and handlers are unchanged by this shell.
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
  /** Active bottom-dock screen (UI shell state only). */
  const [tab, setTab] = useState<DashboardTab>("home");
  /** Parcel size in hectares: one input, consumed by every card. */
  const [areaHa, setAreaHa] = useState(2);

  const scrollRef = useRef<HTMLElement | null>(null);
  const weatherRef = useRef<HTMLDivElement | null>(null);

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

  /** Weather summary pill → jump home and glide to the weather bento card. */
  const scrollToWeather = () => {
    if (tab === "home") {
      weatherRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setTab("home");
    window.setTimeout(() => {
      weatherRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 430);
  };

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

  const footer = (
    <p className="mx-auto max-w-[70ch] pb-1 text-center text-[10.5px] font-semibold leading-5 text-emerald-900/60">
      {t.footer.builtWith} · {t.footer.disclaimer}
    </p>
  );

  const quickActions = (
    <motion.div
      variants={ITEM}
      role="group"
      aria-label={t.quickActions.aria}
      className="flex items-center gap-2"
    >
      <motion.button
        type="button"
        onClick={() => setTab("assistant")}
        whileTap={{ scale: 0.94 }}
        className={`glass inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-[11.5px] font-black text-emerald-800 shadow-[0_10px_24px_-14px_rgba(6,78,59,0.5)] transition-colors hover:bg-white/95 ${FOCUS_RING}`}
      >
        <Bot size={15} strokeWidth={2.6} aria-hidden />
        <span className="truncate">{t.quickActions.scan}</span>
      </motion.button>
      <motion.button
        type="button"
        onClick={() => setTab("irrigation")}
        whileTap={{ scale: 0.94 }}
        className={`glass inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-[11.5px] font-black text-emerald-800 shadow-[0_10px_24px_-14px_rgba(6,78,59,0.5)] transition-colors hover:bg-white/95 ${FOCUS_RING}`}
      >
        <Droplets size={15} strokeWidth={2.6} aria-hidden />
        <span className="truncate">{t.quickActions.irrigation}</span>
      </motion.button>
      <motion.button
        type="button"
        onClick={scrollToWeather}
        whileTap={{ scale: 0.94 }}
        className={`glass inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-[11.5px] font-black text-emerald-800 shadow-[0_10px_24px_-14px_rgba(6,78,59,0.5)] transition-colors hover:bg-white/95 ${FOCUS_RING}`}
      >
        <Sun size={15} strokeWidth={2.6} aria-hidden />
        <span className="truncate">{t.quickActions.weather}</span>
      </motion.button>
    </motion.div>
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

      {/* Compact native header: avatar + greeting + weather pill / location badge. */}
      <header className="pt-safe relative z-30 shrink-0 border-b border-emerald-500/10 bg-white/60 shadow-[0_16px_36px_-30px_rgba(6,78,59,0.6)] backdrop-blur-xl">
        <div className={`${APP_COLUMN} flex flex-col gap-2 px-4 pb-2.5 pt-2`}>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setTab("profile")}
              aria-label={t.nav.profile}
              className={`shrink-0 rounded-2xl transition-transform duration-150 active:scale-95 ${FOCUS_RING}`}
            >
              {renderAvatar("md")}
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[17px] font-black leading-6 text-emerald-950">{greeting}</h1>
              <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-[2px] text-[9.5px] font-black text-emerald-700 ring-1 ring-emerald-500/15">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
                {guestActive ? t.header.badgeGuest : t.header.badgeMember}
              </span>
            </div>
            <button
              type="button"
              onClick={scrollToWeather}
              aria-label={t.quickActions.weather}
              className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-white/80 px-2.5 text-[12px] font-black text-emerald-900 ring-1 ring-emerald-500/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] transition-all duration-150 hover:bg-white active:scale-95 ${FOCUS_RING}`}
            >
              <Sun size={14} strokeWidth={2.6} aria-hidden className="text-amber-500" />
              <span dir="ltr" className="tabular-nums">{fmt(weather.tempC, 1)}°</span>
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-9 min-w-0 items-center gap-1.5 rounded-full bg-white/80 px-3 text-[11.5px] font-black text-emerald-900 ring-1 ring-emerald-500/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <MapPin size={13} strokeWidth={2.8} aria-hidden className="shrink-0 text-emerald-600" />
              <span className="truncate">{lang === "ar" ? wilaya.nameAr : wilaya.nameFr}</span>
            </span>
          </div>
        </div>
      </header>

      {/* Scroll body — one bento screen at a time, driven by the bottom dock */}
      <main
        ref={scrollRef}
        className="scroll-area relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={tab}
            variants={SCREEN}
            initial="hidden"
            animate="show"
            exit="exit"
            className={`${GPU} ${APP_COLUMN} flex flex-col gap-3 px-4 pt-3 ${NAV_CLEARANCE}`}
          >
            {tab === "home" && (
              <>
                {/* Bento hero: ring gauge + advisory */}
                <motion.div variants={ITEM}>
                  <QuickReadHero
                    t={t}
                    lang={lang}
                    netMmDay={irrigation.netMmDay}
                    areaHa={areaHa}
                    crop={crop}
                  />
                </motion.div>

                {/* Quick actions floating row */}
                {quickActions}

                {/* Today's tasks (top 3) with animated checkboxes */}
                <motion.div variants={ITEM}>
                  <FieldTasksCard
                    t={t}
                    lang={lang}
                    wilayaCode={wilayaCode}
                    crop={crop}
                    areaHa={areaHa}
                    limit={3}
                  />
                </motion.div>

                {/* NDVI mini bento: sparkline + glowing pulse badge */}
                <motion.div variants={ITEM}>
                  <SatelliteCard t={t} lang={lang} wilayaCode={wilayaCode} crop={crop} />
                </motion.div>

                {/* Full weather bento (2×2 metrics + forecast carousels) */}
                <motion.div variants={ITEM} ref={weatherRef} className="scroll-mt-2">
                  <WeatherCard t={t} lang={lang} weather={weather} />
                </motion.div>

                {footer}
              </>
            )}

            {tab === "irrigation" && (
              <>
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
                {footer}
              </>
            )}

            {tab === "assistant" && (
              <>
                {/* AI chat entry card */}
                <motion.section
                  aria-label={t.assistantView.title}
                  className="glass-widget relative overflow-hidden rounded-3xl p-4"
                >
                  <div aria-hidden className="pointer-events-none absolute inset-0">
                    <div className="absolute -top-12 -end-8 h-36 w-36 rounded-full bg-teal-300/25 blur-3xl" />
                    <div className="absolute -bottom-14 -start-8 h-36 w-36 rounded-full bg-emerald-300/25 blur-3xl" />
                  </div>
                  <div className="relative flex items-start gap-3">
                    <span
                      aria-hidden
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-[0_10px_24px_-10px_rgba(13,148,136,0.8)]"
                    >
                      <Bot size={20} strokeWidth={2.4} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-[14px] font-black leading-5 text-emerald-950">
                        {t.assistantView.title}
                      </h2>
                      <p className="mt-0.5 text-[11px] font-semibold leading-4 text-emerald-900/65">
                        {t.assistantView.subtitle}
                      </p>
                    </div>
                  </div>
                  <div className="relative mt-3 rounded-2xl bg-white/80 p-3 ring-1 ring-emerald-500/10">
                    <p className="text-[12px] font-black text-emerald-950">{t.assistantView.chatTitle}</p>
                    <p className="mt-0.5 text-[10.5px] font-semibold leading-4 text-emerald-900/65">
                      {t.assistantView.chatSubtitle}
                    </p>
                    <Link
                      href="/assistant"
                      className={`glow-emerald mt-2.5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-emerald-500 via-emerald-500 to-green-600 text-[12.5px] font-black text-white transition-transform duration-150 active:scale-95 ${FOCUS_RING}`}
                    >
                      {t.assistantView.chatCta}
                    </Link>
                  </div>
                </motion.section>

                {/* Plant health scan (camera / upload + radar scanner) */}
                <ScanCard t={t} wilayaCode={wilayaCode} />

                {footer}
              </>
            )}

            {tab === "profile" && (
              <>
                {/* Identity */}
                <section aria-label={t.nav.profile} className="glass-widget rounded-3xl p-4">
                  <div className="flex items-center gap-3">
                    {renderAvatar("lg")}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-black text-emerald-950">
                        {displayName || (lang === "ar" ? "فلاح" : "Agriculteur")}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[10.5px] font-semibold leading-4 text-emerald-900/65">
                        {caption}
                      </p>
                      <p className="mt-0.5 text-[9.5px] font-bold text-emerald-700/70">{brand.brand}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Chip tone="slate">
                          {lang === "ar" ? REGIONS[wilaya.region].ar : REGIONS[wilaya.region].fr}
                        </Chip>
                        {role && (
                          <Chip tone="emerald" icon={<Sprout size={11} strokeWidth={3} aria-hidden />}>
                            {t.personalize.roleOptions[role]}
                          </Chip>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                {/* Personalisation: wilaya bottom-sheet + role */}
                <section
                  aria-label={t.personalize.title}
                  className="glass-widget flex flex-col gap-3 rounded-3xl p-4"
                >
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

                {/* Language */}
                <section aria-label={t.personalize.language} className="glass-widget flex items-center justify-between gap-3 rounded-3xl p-4">
                  <p className="text-[13px] font-black text-emerald-950">{t.personalize.language}</p>
                  <LanguageSwitch
                    lang={lang}
                    onChange={setLang}
                    ariaLabel={lang === "ar" ? "اختيار اللغة" : "Choix de la langue"}
                    labels={{ ar: t.header.langAr, fr: t.header.langFr }}
                    layoutId="dashboard-lang-thumb"
                  />
                </section>

                {/* Session */}
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className={`glass-widget inline-flex h-12 items-center justify-center gap-2 rounded-3xl text-[13px] font-black text-rose-700 transition-all duration-150 hover:bg-rose-50/70 active:scale-[0.99] ${FOCUS_RING}`}
                >
                  <LogOut size={16} strokeWidth={2.6} aria-hidden />
                  {t.header.signOut}
                </button>

                {footer}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Fixed floating glass dock */}
      <BottomNav t={t} tab={tab} onTabChange={setTab} />
    </div>
  );
}
