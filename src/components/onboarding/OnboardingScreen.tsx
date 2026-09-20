"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, MoveHorizontal, UserPlus, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ComponentType } from "react";
import { COPY, SLIDES, type Copy, type Lang, type SlideId } from "@/lib/content";
import HeaderBar from "./HeaderBar";
import IrrigationArt from "./graphics/IrrigationArt";
import LeafScannerArt from "./graphics/LeafScannerArt";
import SatelliteArt from "./graphics/SatelliteArt";

const ART: Record<SlideId, ComponentType> = {
  scan: LeafScannerArt,
  irrigation: IrrigationArt,
  satellite: SatelliteArt,
};

const SWIPE_THRESHOLD = 64;
const FLICK_VELOCITY = 420;
const SPRING = { type: "spring", stiffness: 320, damping: 34, mass: 0.9 } as const;

/** Structural subset of framer-motion's PanInfo, so we don't couple to its type exports. */
type DragInfo = { offset: { x: number; y: number }; velocity: { x: number; y: number } };

export default function OnboardingScreen() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>("ar");
  const [[slide, dir], setSlide] = useState<[number, number]>([0, 0]);

  const t = COPY[lang];
  const rtl = t.dir === "rtl";
  /** Direction factor: in RTL everything physical (enter/exit offsets, swipe vectors) mirrors. */
  const fdir = rtl ? -1 : 1;
  const last = SLIDES.length - 1;
  const isLast = slide === last;

  // Keep <html lang/dir> in sync with the active language.
  useEffect(() => {
    const el = document.documentElement;
    el.lang = lang;
    el.dir = t.dir;
  }, [lang, t.dir]);

  const goTo = useCallback(
    (index: number) => {
      setSlide(([current]) => {
        const target = Math.min(Math.max(index, 0), last);
        if (target === current) return [current, 0];
        return [target, target > current ? 1 : -1];
      });
    },
    [last],
  );

  // Keyboard navigation (mirrors RTL semantics).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") goTo(rtl ? slide - 1 : slide + 1);
      else if (e.key === "ArrowLeft") goTo(rtl ? slide + 1 : slide - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, rtl, slide]);

  const handleDragEnd = useCallback(
    (_: unknown, info: DragInfo) => {
      const { offset, velocity } = info;
      if (offset.x * fdir < -SWIPE_THRESHOLD || velocity.x * fdir < -FLICK_VELOCITY) goTo(slide + 1);
      else if (offset.x * fdir > SWIPE_THRESHOLD || velocity.x * fdir > FLICK_VELOCITY) goTo(slide - 1);
    },
    [fdir, goTo, slide],
  );

  return (
    <div
      dir={t.dir}
      className={`screen-h relative mx-auto flex w-full max-w-[480px] flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 sm:border-x sm:border-black/5 dark:sm:border-white/5 ${
        rtl ? "font-arabic" : "font-latin"
      }`}
    >
      <Backdrop />

      <HeaderBar t={t} lang={lang} onLangChange={setLang} showSkip={!isLast} onSkip={() => goTo(last)} />

      {/* Carousel — one full-viewport slide area, swipeable */}
      <main className="relative z-10 min-h-0 flex-1">
        <AnimatePresence initial={false}>
          <motion.section
            key={slide}
            aria-label={`${t.stepWord} ${slide + 1} / ${SLIDES.length}`}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.55}
            dragTransition={{ bounceStiffness: 560, bounceDamping: 36 }}
            onDragEnd={handleDragEnd}
            initial={{ x: `${dir * fdir * 110}%`, opacity: 0, scale: 0.94 }}
            animate={{ x: 0, opacity: 1, scale: 1 }}
            exit={{ x: `${-dir * fdir * 110}%`, opacity: 0, scale: 0.94 }}
            transition={SPRING}
            style={{ touchAction: "pan-y" }}
            className="absolute inset-0 cursor-grab select-none active:cursor-grabbing"
          >
            <SlideView t={t} index={slide} rtl={rtl} />
          </motion.section>
        </AnimatePresence>
      </main>

      <Controls
        t={t}
        slide={slide}
        isLast={isLast}
        fdir={fdir}
        onDot={goTo}
        onNext={() => goTo(slide + 1)}
        onCreate={() => router.push("/register")}
        onGuest={() => router.push("/guest")}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Slide content: art + kicker + title + description                  */
/* ------------------------------------------------------------------ */

function SlideView({ t, index, rtl }: { t: Copy; index: number; rtl: boolean }) {
  const s = t.slides[index];
  const Art = ART[SLIDES[index]];

  return (
    <div className="flex h-full select-none flex-col items-center justify-center gap-2 px-6 pb-2 pt-1 text-center">
      {/* Interactive illustration */}
      <div className="relative min-h-0 w-full max-w-[340px] flex-1">
        <Art />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 22 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="flex w-full flex-col items-center gap-2.5"
      >
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-600/15 bg-white/65 px-3 py-[5px] text-[10px] font-bold text-emerald-700 shadow-sm backdrop-blur-md dark:border-emerald-300/15 dark:bg-white/5 dark:text-emerald-300">
          <span className="font-extrabold tabular-nums">{String(index + 1).padStart(2, "0")}</span>
          <span className="h-2.5 w-px bg-emerald-600/30" />
          <span>{s.kicker}</span>
        </span>

        <h2
          className={`mx-auto max-w-[320px] text-[clamp(19px,4.6vh,24px)] font-black text-slate-900 dark:text-white ${
            rtl ? "leading-[1.55]" : "leading-snug"
          }`}
        >
          {s.title}
        </h2>

        <p
          className={`mx-auto max-w-[44ch] text-[clamp(12px,3vh,13.5px)] text-slate-600 dark:text-slate-300/85 ${
            rtl ? "leading-[2]" : "leading-6"
          }`}
        >
          {s.description}
        </p>

        {index < t.slides.length - 1 && (
          <motion.span
            animate={{ x: rtl ? [0, 4, 0, -4, 0] : [0, -4, 0, 4, 0] }}
            transition={{ duration: 1.8, ease: "easeInOut", repeat: Infinity }}
            className="mt-0.5 inline-flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 dark:text-slate-500"
          >
            <MoveHorizontal size={13} className="text-emerald-500" />
            {t.swipeHint}
          </motion.span>
        )}
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sticky bottom area: glowing page dots + dynamic CTA                */
/* ------------------------------------------------------------------ */

function Controls({
  t,
  slide,
  isLast,
  fdir,
  onDot,
  onNext,
  onCreate,
  onGuest,
}: {
  t: Copy;
  slide: number;
  isLast: boolean;
  fdir: number;
  onDot: (i: number) => void;
  onNext: () => void;
  onCreate: () => void;
  onGuest: () => void;
}) {
  return (
    <footer className="pb-safe relative z-20 shrink-0 px-6">
      <PageDots count={t.slides.length} active={slide} stepWord={t.stepWord} onSelect={onDot} />

      {/* Fixed-height swap zone → the layout never jumps between states */}
      <div className="grid h-[104px] place-items-stretch">
        <AnimatePresence mode="wait" initial={false}>
          {isLast ? (
            <motion.div
              key="final"
              initial={{ opacity: 0, y: 18, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -14, scale: 0.97 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col justify-center gap-2"
            >
              <motion.button
                type="button"
                onClick={onCreate}
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                className="grid h-12 w-full place-items-center rounded-2xl bg-emerald-500 text-[15px] font-black text-white shadow-[0_14px_30px_-10px_rgba(16,185,129,0.7)] transition-colors hover:bg-emerald-400"
              >
                <span className="inline-flex items-center gap-2">
                  <UserPlus size={18} strokeWidth={2.6} />
                  {t.createAccount}
                </span>
              </motion.button>
              <motion.button
                type="button"
                onClick={onGuest}
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                className="glass grid h-12 w-full place-items-center rounded-2xl text-[15px] font-extrabold text-emerald-800 transition-colors hover:bg-white/80 dark:text-emerald-200 dark:hover:bg-white/10"
              >
                <span className="inline-flex items-center gap-2">
                  <UserRound size={18} strokeWidth={2.2} />
                  {t.continueGuest}
                </span>
              </motion.button>
            </motion.div>
          ) : (
            <motion.div
              key="next"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="grid place-items-center"
            >
              <motion.button
                type="button"
                onClick={onNext}
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                className="glow-emerald grid h-12 w-full place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 text-[15px] font-black text-white transition-colors hover:from-emerald-400"
              >
                <span className="inline-flex items-center gap-2">
                  {t.next}
                  {fdir === 1 ? <ArrowRight size={18} strokeWidth={2.8} /> : <ArrowLeft size={18} strokeWidth={2.8} />}
                </span>
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </footer>
  );
}

function PageDots({
  count,
  active,
  stepWord,
  onSelect,
}: {
  count: number;
  active: number;
  stepWord: string;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="flex items-center justify-center">
      {Array.from({ length: count }, (_, i) => {
        const isActive = i === active;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSelect(i)}
            aria-label={`${stepWord} ${i + 1} / ${count}`}
            aria-current={isActive ? "step" : undefined}
            className="relative grid h-12 w-11 place-items-center"
          >
            {isActive && <span aria-hidden className="absolute h-3 w-3 animate-ping rounded-full bg-emerald-400/45" />}
            <motion.span
              aria-hidden
              className={`block h-2.5 rounded-full ${
                isActive
                  ? "bg-gradient-to-r from-emerald-400 to-emerald-600 shadow-[0_0_12px_rgba(16,185,129,0.9)]"
                  : "bg-slate-300/90 dark:bg-slate-700"
              }`}
              animate={{ width: isActive ? 26 : 10 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
            />
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Ambient "Sunrise & High-Tech Agriculture" backdrop                */
/* ------------------------------------------------------------------ */

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
      <div className="absolute inset-0 bg-gradient-to-b from-emerald-100/70 via-transparent to-amber-100/60 dark:from-emerald-500/[0.06] dark:via-transparent dark:to-amber-500/[0.05]" />
      <div className="absolute -start-24 -top-28 h-72 w-72 rounded-full bg-emerald-400/25 blur-3xl dark:bg-emerald-500/15" />
      <div className="absolute -end-24 top-1/3 h-64 w-64 rounded-full bg-amber-300/30 blur-3xl dark:bg-amber-400/10" />
      <div className="absolute -bottom-24 start-1/4 h-72 w-72 rounded-full bg-emerald-300/20 blur-3xl dark:bg-emerald-600/10" />
      <div
        className="absolute inset-0 opacity-60 dark:opacity-20"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(15,118,82,0.14) 1px, transparent 0)",
          backgroundSize: "26px 26px",
        }}
      />
    </div>
  );
}
