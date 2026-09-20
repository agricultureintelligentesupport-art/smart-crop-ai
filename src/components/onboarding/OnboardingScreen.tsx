"use client";

import { AnimatePresence, motion, useWillChange } from "framer-motion";
import { ArrowLeft, ArrowRight, MoveHorizontal, UserPlus, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useState, type ComponentType } from "react";
import { COPY, SLIDES, type Copy, type Lang, type SlideId } from "@/lib/content";
import HeaderBar from "./HeaderBar";
import IrrigationArt from "./graphics/IrrigationArt";
import LeafScannerArt from "./graphics/LeafScannerArt";
import SatelliteArt from "./graphics/SatelliteArt";

/** Memoized below — static artwork never re-renders while its slide is live. */
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
      setSlide((prev) => {
        const [current, dir] = prev;
        const target = Math.min(Math.max(index, 0), last);
        // Perf: hand React back the exact same state reference on no-op
        // navigations (e.g. tapping the active dot) so it can bail out of the
        // re-render — nothing in the tree reconciles, art keeps its layer.
        if (target === current) return dir === 0 ? prev : [current, 0];
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

  // Stable handlers → memoized HeaderBar / Controls skip re-renders on slide changes.
  const handleSkip = useCallback(() => goTo(last), [goTo, last]);
  const handleCreate = useCallback(() => router.push("/register"), [router]);
  const handleGuest = useCallback(() => router.push("/guest"), [router]);
  const handleNext = useCallback(() => goTo(slide + 1), [goTo, slide]);

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
      className={`screen-h relative mx-auto flex w-full max-w-[480px] flex-col overflow-hidden text-emerald-950 sm:border-x sm:border-emerald-900/10 ${
        rtl ? "font-arabic" : "font-latin"
      }`}
      style={{
        background: "linear-gradient(180deg, #F4FBF7 0%, #E6F7EF 55%, #DCF5E6 100%)",
      }}
    >
      <Backdrop />

      <HeaderBar t={t} lang={lang} onLangChange={setLang} showSkip={!isLast} onSkip={handleSkip} />

      {/* Carousel — one full-viewport slide area, swipeable.
          Perf: AnimatePresence intentionally stays in the default (sync) mode
          here so the outgoing and incoming slides animate side-by-side — that
          overlap IS the swipe dynamic. mode="wait" is used where a cross-fade
          swap is the design (Controls below). Exiting slides are frozen by
          AnimatePresence (cached element, zero re-renders), and both live and
          exiting sections carry persistent GPU layers via transform-gpu +
          will-change-transform so the drag/spring is pure compositing with no
          first-frame layer-promotion hitch. */}
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
            className="absolute inset-0 transform-gpu backface-hidden will-change-transform cursor-grab select-none active:cursor-grabbing"
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
        onNext={handleNext}
        onCreate={handleCreate}
        onGuest={handleGuest}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Slide content: art + kicker + title + description                  */
/* ------------------------------------------------------------------ */

const SlideView = memo(function SlideView({ t, index, rtl }: { t: Copy; index: number; rtl: boolean }) {
  const s = t.slides[index];
  const Art = ART[SLIDES[index]];
  // Perf: framer-managed will-change — promotes this node to a compositor
  // layer only while its entry transform runs, releases it when settled.
  const willChange = useWillChange();

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
        style={{ willChange }}
        className="transform-gpu backface-hidden flex w-full flex-col items-center gap-2.5"
      >
        <span className="glow-amber transform-gpu backface-hidden inline-flex items-center gap-2 rounded-full border border-amber-300/50 bg-amber-100/80 px-3 py-[5px] text-[10px] font-bold text-amber-800 shadow-sm backdrop-blur-md">
          <span className="font-extrabold tabular-nums">{String(index + 1).padStart(2, "0")}</span>
          <span className="h-2.5 w-px bg-amber-500/40" />
          <span>{s.kicker}</span>
        </span>

        <h2
          className={`mx-auto max-w-[320px] text-[clamp(19px,4.6vh,24px)] font-black text-emerald-950 ${
            rtl ? "leading-[1.55]" : "leading-snug"
          }`}
        >
          {s.title}
        </h2>

        <p
          className={`mx-auto max-w-[44ch] text-[clamp(12px,3vh,13.5px)] font-medium text-emerald-900/75 ${
            rtl ? "leading-[2]" : "leading-6"
          }`}
        >
          {s.description}
        </p>

        {index < t.slides.length - 1 && (
          <motion.span
            animate={{ x: rtl ? [0, 4, 0, -4, 0] : [0, -4, 0, 4, 0] }}
            transition={{ duration: 1.8, ease: "easeInOut", repeat: Infinity }}
            className="transform-gpu backface-hidden will-change-transform mt-0.5 inline-flex items-center gap-1.5 text-[10px] font-semibold text-emerald-700/70"
          >
            <MoveHorizontal size={13} className="text-emerald-500" />
            {t.swipeHint}
          </motion.span>
        )}
      </motion.div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Sticky bottom area: glowing page dots + dynamic CTA                */
/* ------------------------------------------------------------------ */

const Controls = memo(function Controls({
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
              className="transform-gpu backface-hidden flex flex-col justify-center gap-2"
            >
              <motion.button
                type="button"
                onClick={onCreate}
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                className="glow-emerald transform-gpu backface-hidden grid h-12 w-full place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 via-emerald-500 to-green-600 text-[15px] font-black text-white transition-colors hover:from-emerald-400 hover:to-green-500"
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
                className="glass transform-gpu backface-hidden grid h-12 w-full place-items-center rounded-2xl text-[15px] font-extrabold text-emerald-900 transition-colors hover:bg-white/95"
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
              className="transform-gpu backface-hidden grid place-items-center"
            >
              <motion.button
                type="button"
                onClick={onNext}
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
                className="glow-emerald transform-gpu backface-hidden grid h-12 w-full place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-green-600 text-[15px] font-black text-white transition-colors hover:from-emerald-400 hover:to-green-500"
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
});

const PageDots = memo(function PageDots({
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
            {isActive && <span aria-hidden className="absolute h-3 w-3 animate-ping rounded-full bg-amber-400/55" />}
            <motion.span
              aria-hidden
              className={`block h-2.5 rounded-full ${
                isActive
                  ? "bg-gradient-to-r from-amber-400 via-emerald-400 to-emerald-600 shadow-[0_0_14px_rgba(16,185,129,0.8)]"
                  : "bg-emerald-900/15"
              }`}
              animate={{ width: isActive ? 28 : 10 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
            />
          </button>
        );
      })}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Ambient "Sunrise over green fields" backdrop — bright & optimistic  */
/* ------------------------------------------------------------------ */

/** Memoized + GPU-isolated: the expensive blur-3xl glow stack rasterizes once
 *  into its own composite layer and is never re-painted during swipes. */
const Backdrop = memo(function Backdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 transform-gpu backface-hidden will-change-transform z-0 overflow-hidden"
    >
      {/* Soft directional light wash */}
      <div className="absolute inset-0 bg-gradient-to-b from-white/60 via-transparent to-emerald-200/30" />

      {/* Warm sunrise/sunshine glow (top-right amber) */}
      <div className="absolute -end-20 -top-24 h-72 w-72 rounded-full bg-amber-300/40 blur-3xl" />
      <div className="absolute end-4 top-6 h-40 w-40 rounded-full bg-yellow-200/50 blur-2xl" />

      {/* Vibrant fresh-sprout green glow (top-left) */}
      <div className="absolute -start-24 -top-16 h-72 w-72 rounded-full bg-emerald-300/45 blur-3xl" />

      {/* Rich forest emerald pool (bottom) */}
      <div className="absolute -bottom-28 start-1/4 h-80 w-80 rounded-full bg-emerald-400/25 blur-3xl" />

      {/* Subtle dotted texture — like distant crop rows */}
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(6,78,59,0.12) 1px, transparent 0)",
          backgroundSize: "26px 26px",
        }}
      />
    </div>
  );
});
