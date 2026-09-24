"use client";

import { useMotionValueEvent, useScroll } from "framer-motion";
import { Leaf, MapPin, Sprout } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import AppBar, { AppBarBrand } from "@/components/app/AppBar";
import TabBar from "@/components/app/TabBar";
import { SHELL_COLUMN } from "@/components/app/shell";
import { useAuth } from "@/context/AuthContext";
import { computeIrrigation, weatherFor } from "@/lib/agronomy";
import { APP_SHELL } from "@/lib/app/copy";
import { AUTH } from "@/lib/auth/copy";
import { DASHBOARD } from "@/lib/dashboard/copy";
import { guestDisplayName, useGuest } from "@/lib/auth/guest";
import { useProfile } from "@/lib/auth/profile";
import type { AuthRole } from "@/lib/auth/types";
import { CROPS, DEFAULT_WILAYA_CODE, REGIONS, getWilaya, type Lang } from "@/lib/wilayas";
import { useLang } from "@/lib/use-lang";
import AccountSheet from "./AccountSheet";
import FieldTasksCard from "./FieldTasksCard";
import HeroCard from "./HeroCard";
import IrrigationCard from "./IrrigationCard";
import QuickActions, { type QuickTarget } from "./QuickActions";
import SatelliteCard from "./SatelliteCard";
import SettingsSheet from "./SettingsSheet";
import ScanCard from "./ScanCard";
import WeatherCard, { fmt } from "./WeatherCard";
import { SectionHeader } from "./parts";

const MONTH_LOCALE: Record<Lang, string> = { ar: "ar-DZ", fr: "fr-DZ" };

/** How long a jump target keeps its focus ring after a quick action. */
const HIGHLIGHT_MS = 1400;

/**
 * The live member dashboard, rendered by `/dashboard`. Every number reacts to
 * the wilaya + crop + parcel inputs, so the page is fully operational without
 * a backend: it is seeded, deterministic and clearly labelled as an estimate.
 *
 * Presentation is a native app shell: a translucent top bar, one scroll region
 * holding a large title, a hero decision card, thumb-zone quick actions and
 * grouped card sections, then a bottom tab bar. All state, derivations and
 * handlers below are unchanged — only what wraps them is.
 *
 * Session-gated with a guest escape hatch: an authenticated user (Google,
 * phone or e-mail — Firebase session or gateway-backed on-device session)
 * OR a local guest flag ("المتابعة كزائر") is required; anyone else is
 * redirected straight to the auth wizard.
 */
export default function DashboardView() {
  const router = useRouter();
  const { lang, setLang } = useLang("ar");
  const t = DASHBOARD[lang];
  const shell = APP_SHELL[lang];
  const brand = AUTH[lang].header;
  const { profile, ready, patch, clear } = useProfile();
  const { user: authUser, profile: authProfile, signOut: authSignOut, updateProfile } = useAuth();
  const { isGuest } = useGuest();

  /** `null` = follow the stored profile; a value = the user overrode it here. */
  const [wilayaOverride, setWilayaOverride] = useState<string | null>(null);
  const [roleOverride, setRoleOverride] = useState<AuthRole | null>(null);
  const [openPersonalize, setOpenPersonalize] = useState(false);
  /** Parcel size in hectares: one input, consumed by every card. */
  const [areaHa, setAreaHa] = useState(2);

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

  /* ---------------- Shell behaviour (presentation only) ---------------- */

  /** The one scroll region: drives the top bar's elevation. */
  const scrollRef = useRef<HTMLElement | null>(null);
  const [elevated, setElevated] = useState(false);
  const { scrollY } = useScroll({ container: scrollRef });
  useMotionValueEvent(scrollY, "change", (value) => setElevated(value > 8));

  /** Quick-action jump targets + the ring that answers "where did I land?". */
  const tasksRef = useRef<HTMLDivElement | null>(null);
  const irrigationRef = useRef<HTMLDivElement | null>(null);
  const scanRef = useRef<HTMLDivElement | null>(null);
  const [highlight, setHighlight] = useState<QuickTarget | null>(null);
  const highlightTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
  }, []);

  const jumpTo = useCallback((target: QuickTarget) => {
    const node =
      target === "scan" ? scanRef.current : target === "irrigation" ? irrigationRef.current : tasksRef.current;
    node?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlight(target);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
  }, []);

  // The "حسابي" tab deep-links to the dashboard with `#account` from other
  // screens. Read through the URL (hydration-safe, no state mirrored from an
  // effect) so the sheet can be opened, closed and re-opened by navigation.
  const hashAccount = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("hashchange", onChange);
      return () => window.removeEventListener("hashchange", onChange);
    },
    () => window.location.hash === "#account",
    () => false,
  );
  const accountOpen = openPersonalize || hashAccount;
  const closeAccount = () => {
    // Clear the hash first so the re-render triggered by the state update
    // already sees a hash-less URL.
    if (window.location.hash === "#account") {
      window.history.replaceState(null, "", window.location.pathname);
    }
    setOpenPersonalize(false);
  };

  // Same hash-driven pattern for the "الإعدادات" tab (`#settings`).
  const [openSettings, setOpenSettings] = useState(false);
  const hashSettings = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("hashchange", onChange);
      return () => window.removeEventListener("hashchange", onChange);
    },
    () => window.location.hash === "#settings",
    () => false,
  );
  const settingsOpen = openSettings || hashSettings;
  const closeSettings = () => {
    if (window.location.hash === "#settings") {
      window.history.replaceState(null, "", window.location.pathname);
    }
    setOpenSettings(false);
  };

  const ring = (target: QuickTarget) =>
    highlight === target ? "rounded-[1.5rem] ring-2 ring-emerald-400/55 ring-offset-2 ring-offset-[#f4f8f5]" : "";

  const advice = {
    line1: t.advice.line1
      .replace("{mm}", fmt(irrigation.netMmDay, 1))
      .replace("{area}", fmt(areaHa, 1)),
    line2: t.advice.line2.replace("{from}", "05:30").replace("{to}", "08:30"),
    line3: t.advice.line3
      .replace("{crop}", CROPS[crop][lang])
      .replace("{risk}", lang === "ar" ? "الآفات الفطرية" : "les maladies fongiques"),
  };

  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className={`screen-h app-canvas relative flex flex-col overflow-hidden text-emerald-950 ${
        lang === "ar" ? "font-arabic" : "font-latin"
      }`}
    >
      <AppBar
        label={shell.barLabel}
        elevated={elevated}
        leading={
          <AppBarBrand
            icon={<Leaf size={17} strokeWidth={2.4} className="text-white" aria-hidden />}
            title={brand.brand}
            subtitle={guestActive ? t.header.badgeGuest : t.header.badgeMember}
            status={
              <span
                aria-hidden
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  guestActive ? "bg-amber-500" : "bg-emerald-500"
                } shadow-[0_0_0_3px_rgba(16,185,129,0.18)]`}
              />
            }
          />
        }
      />

      {/* One scroll region between the two bars. */}
      <main
        ref={scrollRef}
        className="scroll-area scroll-pad-top relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className={`${SHELL_COLUMN} lg:max-w-[720px] scroll-pad-bottom flex flex-col gap-5 px-4 pt-2`}>
          {/* Large title + context */}
          <header className="flex flex-col gap-3 pt-1">
            <div>
              <h1 className="text-[26px] font-black leading-tight tracking-tight text-emerald-950">{greeting}</h1>
              <p className="mt-1.5 text-[12.5px] font-semibold leading-5 text-emerald-900/60">
                {t.welcome.caption
                  .replace("{wilaya}", lang === "ar" ? wilaya.nameAr : wilaya.nameFr)
                  .replace("{month}", month)}
              </p>
            </div>

            <div className="app-surface flex items-center gap-2.5 p-2 ps-3.5">
              <MapPin size={18} strokeWidth={2.5} aria-hidden className="shrink-0 text-emerald-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-black text-emerald-950">
                  {lang === "ar" ? wilaya.nameAr : wilaya.nameFr}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] font-semibold text-emerald-900/60">
                  <span className="truncate">{lang === "ar" ? REGIONS[wilaya.region].ar : REGIONS[wilaya.region].fr}</span>
                  {role && (
                    <>
                      <span aria-hidden className="text-emerald-900/25">·</span>
                      <Sprout size={11} strokeWidth={3} aria-hidden className="shrink-0 text-emerald-500" />
                      <span className="truncate">{t.personalize.roleOptions[role]}</span>
                    </>
                  )}
                </p>
              </div>
            </div>
          </header>

          {/* Today's decision + thumb-zone shortcuts */}
          <HeroCard t={t} irrigation={irrigation} cropLabel={CROPS[crop][lang]} advice={advice} />

          <QuickActions t={t} onJump={jumpTo} />

          <div ref={tasksRef} className={`scroll-mt-24 transition-[box-shadow,border-radius] ${ring("tasks")}`}>
            <FieldTasksCard t={t} lang={lang} wilayaCode={wilayaCode} crop={crop} areaHa={areaHa} />
          </div>

          {/* Weather + water calculator */}
          <section id="section-weather" aria-label={t.sections.weather} className="flex scroll-mt-[4.5rem] flex-col">
            <SectionHeader title={t.sections.weather} />
            <div className="grid gap-3 lg:grid-cols-2">
              <WeatherCard t={t} lang={lang} weather={weather} />
              <div
                ref={irrigationRef}
                className={`scroll-mt-24 transition-[box-shadow,border-radius] ${ring("irrigation")}`}
              >
                <IrrigationCard
                  t={t}
                  lang={lang}
                  wilayaCode={wilayaCode}
                  areaHa={areaHa}
                  onAreaChange={setAreaHa}
                />
              </div>
            </div>
          </section>

          {/* Field health: satellite index + leaf diagnosis */}
          <section id="section-field" aria-label={t.sections.field} className="flex scroll-mt-[4.5rem] flex-col">
            <SectionHeader title={t.sections.field} />
            <div className="grid gap-3 lg:grid-cols-2">
              <SatelliteCard t={t} lang={lang} wilayaCode={wilayaCode} crop={crop} />
              <div ref={scanRef} className={`scroll-mt-24 transition-[box-shadow,border-radius] ${ring("scan")}`}>
                <ScanCard t={t} wilayaCode={wilayaCode} />
              </div>
            </div>
          </section>

          <p className="mx-auto max-w-[70ch] px-2 pb-2 text-center text-[11px] font-semibold leading-5 text-emerald-900/55">
            {t.footer.builtWith} · {t.footer.disclaimer}
          </p>
        </div>
      </main>

      {/* The account sheet owns the screen while it is open — no competing tab bar. */}
      {!accountOpen && !settingsOpen && (
        <TabBar
          active="home"
          lang={lang}
          onAccount={() => setOpenPersonalize(true)}
          accountOpen={accountOpen}
          onSettings={() => setOpenSettings(true)}
          settingsOpen={settingsOpen}
        />
      )}

      <AccountSheet
        open={accountOpen}
        onClose={closeAccount}
        t={t}
        lang={lang}
        displayName={displayName || (lang === "ar" ? "فلاح" : "Agriculteur")}
        statusLabel={guestActive ? t.header.badgeGuest : t.header.badgeMember}
        role={role}
        wilayaCode={wilayaCode}
        onWilayaChange={updateWilaya}
        onRoleChange={updateRole}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={closeSettings}
        t={t}
        lang={lang}
        onLangChange={setLang}
        wilayaCode={wilayaCode}
        onWilayaChange={updateWilaya}
        onSignOut={() => void signOut()}
      />
    </div>
  );
}
