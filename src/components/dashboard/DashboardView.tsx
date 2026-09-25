"use client";

import { useMotionValueEvent, useScroll } from "framer-motion";
import { Leaf } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import AppBar, { AppBarBrand } from "@/components/app/AppBar";
import TabBar from "@/components/app/TabBar";
import { SHELL_COLUMN } from "@/components/app/shell";
import { useAuth } from "@/context/AuthContext";
import { computeIrrigation, type IrrigationSystem } from "@/lib/agronomy";
import { APP_SHELL } from "@/lib/app/copy";
import { AUTH } from "@/lib/auth/copy";
import { DASHBOARD } from "@/lib/dashboard/copy";
import { guestDisplayName, useGuest } from "@/lib/auth/guest";
import { useProfile } from "@/lib/auth/profile";
import type { AuthRole } from "@/lib/auth/types";
import { useDailyTasks } from "@/lib/dailyTasks/useDailyTasks";
import { CROPS, DEFAULT_WILAYA_CODE, SOILS, getWilaya, type Lang } from "@/lib/wilayas";
import { useLang } from "@/lib/use-lang";
import { useLiveWeather } from "@/lib/weather/useLiveWeather";
import AccountSheet from "./AccountSheet";
import CalculatorDetailModal from "./CalculatorDetailModal";
import FieldHeatmapCard from "./FieldHeatmapCard";
import HeroCard from "./HeroCard";
import IrrigationWindowSheet from "./IrrigationWindowSheet";
import type { ParcelInput } from "./IrrigationCard";
import PerHectareFlowSheet from "./PerHectareFlowSheet";
import QuickAccessGrid from "./QuickAccessGrid";
import SatelliteCard from "./SatelliteCard";
import SettingsSheet from "./SettingsSheet";
import ScanCard from "./ScanCard";
import WeatherDetailModal from "./WeatherDetailModal";
import { SectionHeader } from "./parts";

const MONTH_LOCALE: Record<Lang, string> = { ar: "ar-DZ", fr: "fr-DZ" };

/**
 * The live member dashboard, rendered by `/dashboard`. Every number reacts to
 * the wilaya + crop + parcel inputs, so the page is fully operational without
 * a backend: it is seeded, deterministic and clearly labelled as an estimate.
 *
 * Presentation is a native app shell: a translucent top bar, one scroll region
 * holding a large title, a hero decision card and grouped card sections, then a
 * bottom tab bar. All state, derivations and handlers below are unchanged —
 * only what wraps them is.
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
  /** Irrigation-window detail sheet, opened from the hero's "نافذة السقي" tile. */
  const [openWindowDetail, setOpenWindowDetail] = useState(false);
  /** Per-hectare calculation flow, opened from the hero's unit pill. */
  const [openPerHectareFlow, setOpenPerHectareFlow] = useState(false);
  /** Parcel size in hectares: one input, consumed by every card. */
  const [areaHa, setAreaHa] = useState(2);
  /**
   * Parcel inputs (crop + soil + system) used to live inside `IrrigationCard`.
   * They are lifted here so the hero decision card, the quick-access calculator
   * widget and the calculator sheet all read the same parcel — an edit in the
   * sheet updates the widget and the decision card in the same render.
   *
   * The record carries the wilaya it was chosen for: switching wilaya therefore
   * falls back to that wilaya's own defaults (the old card's sync behaviour)
   * without a state-copying effect.
   */
  const [parcelChoice, setParcelChoice] = useState<({ wilayaCode: string } & ParcelInput) | null>(null);
  /** Weather detail sheet, opened from the "الطقس والتوقعات" quick widget. */
  const [openWeatherDetail, setOpenWeatherDetail] = useState(false);
  /** Calculator sheet, opened from the "حاسبة السقي" quick widget. */
  const [openCalculatorDetail, setOpenCalculatorDetail] = useState(false);

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
  // Live Open-Meteo weather for the wilaya (hourly cache, graceful fallback to
  // the static reference values). One shared snapshot feeds every card, the
  // irrigation calculation and the window detail sheet — same formulas as
  // before, only the climate inputs can now be live.
  const liveWeather = useLiveWeather(wilayaCode);
  const weather = liveWeather.snapshot;
  // Parcel inputs: the user's own choice while it belongs to the current
  // wilaya, otherwise that wilaya's defaults (the calculator's old reset rule).
  const parcel =
    parcelChoice && parcelChoice.wilayaCode === wilayaCode
      ? parcelChoice
      : { crop: wilaya.crops[0], soil: wilaya.soil, system: "drip" as IrrigationSystem };
  const { crop, soil, system } = parcel;
  const updateParcel = (patch: Partial<ParcelInput>) =>
    setParcelChoice({ wilayaCode, crop, soil, system, ...patch });
  const irrigation = computeIrrigation({
    wilayaCode,
    crop,
    areaHa,
    soil,
    system,
    weather,
  });

  const soilLabel = SOILS[soil][lang];
  const month = new Intl.DateTimeFormat(MONTH_LOCALE[lang], { month: "long" }).format(new Date());
  // Guests render as "زائر" / "Invité"; a real identity always wins.
  const displayName = guestActive
    ? guestDisplayName(lang)
    : profile?.displayName ?? authProfile?.displayName ?? authUser?.displayName ?? "";
  const greeting = t.welcome.member.replace(
    "{name}",
    displayName || (lang === "ar" ? "فلاح" : "Agriculteur"),
  );

  // Daily AI tasks for the hero checklist: cached per day (LocalStorage),
  // generated by the AI engine (00:00 cron or on-demand), with the local
  // rule-based generator as the never-empty fallback. Checked state persists
  // across refreshes for the current day.
  const dailyTasks = useDailyTasks({
    wilayaCode,
    crop,
    soil: wilaya.soil,
    areaHa,
    system: "drip",
    lang,
    weather,
  });

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
          <header className="pt-1">
            <h1 className="text-[26px] font-black leading-tight tracking-tight text-emerald-950">{greeting}</h1>
            <p className="mt-1.5 text-[12.5px] font-semibold leading-5 text-emerald-900/60">
              {t.welcome.caption
                .replace("{wilaya}", lang === "ar" ? wilaya.nameAr : wilaya.nameFr)
                .replace("{month}", month)}
            </p>
          </header>

          {/* Today's decision + the daily AI task checklist, then the two
              quick-access widgets that open the weather and calculator sheets.
              The widgets are glued to the decision card (own flex group) so
              they sit exactly `mt-4` under it. */}
          <div className="flex flex-col">
            <HeroCard
              t={t}
              irrigation={irrigation}
              cropLabel={CROPS[crop][lang]}
              wilayaLabel={lang === "ar" ? wilaya.nameAr : wilaya.nameFr}
              tasks={dailyTasks.tasks}
              taskDone={dailyTasks.done}
              onToggleTask={dailyTasks.toggle}
              tasksDoneCount={dailyTasks.doneCount}
              tasksTotal={dailyTasks.total}
              tasksAllDone={dailyTasks.allDone}
              onOpenWindowDetail={() => setOpenWindowDetail(true)}
              onOpenPerHectareFlow={() => setOpenPerHectareFlow(true)}
              flowOpen={openPerHectareFlow}
            />

            <section
              id="section-weather"
              aria-label={t.sections.weather}
              className="mt-4 scroll-mt-[4.5rem]"
            >
              <QuickAccessGrid
                t={t}
                weather={weather}
                irrigation={irrigation}
                cropLabel={CROPS[crop][lang]}
                areaHa={areaHa}
                weatherOpen={openWeatherDetail}
                calculatorOpen={openCalculatorDetail}
                onOpenWeather={() => setOpenWeatherDetail(true)}
                onOpenCalculator={() => setOpenCalculatorDetail(true)}
              />
            </section>
          </div>

          {/* Field health: satellite index + leaf diagnosis */}
          <section id="section-field" aria-label={t.sections.field} className="flex scroll-mt-[4.5rem] flex-col">
            <SectionHeader title={t.sections.field} />
            <div className="grid gap-3 lg:grid-cols-2">
              {/* The map reads the same irrigation result as the hero card, so the
                  moisture layer always averages back to the daily L/ha figure. */}
              <FieldHeatmapCard
                t={t}
                lang={lang}
                wilayaCode={wilayaCode}
                crop={crop}
                areaHa={areaHa}
                irrigation={irrigation}
                weather={weather}
              />
              <SatelliteCard t={t} lang={lang} wilayaCode={wilayaCode} crop={crop} />
              <ScanCard t={t} wilayaCode={wilayaCode} />
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

      {/* Weather details: the complete forecast view, opened by its widget. */}
      <WeatherDetailModal
        open={openWeatherDetail}
        onClose={() => setOpenWeatherDetail(false)}
        t={t}
        lang={lang}
        wilayaCode={wilayaCode}
        weather={weather}
        source={liveWeather.source}
        fetchedAt={liveWeather.fetchedAt}
      />

      {/* Calculator: the complete calculator view, opened by its widget. Its
          edits reach the hero card and the widget through the shared parcel. */}
      <CalculatorDetailModal
        open={openCalculatorDetail}
        onClose={() => setOpenCalculatorDetail(false)}
        t={t}
        lang={lang}
        wilayaCode={wilayaCode}
        parcel={parcel}
        onParcelChange={updateParcel}
        areaHa={areaHa}
        onAreaChange={setAreaHa}
        weather={weather}
      />

      {/* Irrigation-window detail: why this window + volume (real inputs only).
          Same inputs as the hero's own numbers: the selected crop, soil, system
          and parcel size. */}
      <IrrigationWindowSheet
        open={openWindowDetail}
        onClose={() => setOpenWindowDetail(false)}
        t={t}
        lang={lang}
        wilayaCode={wilayaCode}
        crop={crop}
        soil={soil}
        system={system}
        areaHa={areaHa}
        weather={weather}
        irrigation={irrigation}
        source={liveWeather.source}
      />

      {/* Per-hectare flow: the same chain and the same numbers as the hero. */}
      <PerHectareFlowSheet
        open={openPerHectareFlow}
        onClose={() => setOpenPerHectareFlow(false)}
        t={t}
        lang={lang}
        wilayaName={lang === "ar" ? wilaya.nameAr : wilaya.nameFr}
        cropName={CROPS[crop][lang]}
        soilName={soilLabel}
        systemName={t.irrigation.systems[system]}
        areaHa={areaHa}
        irrigation={irrigation}
        weather={weather}
      />

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
