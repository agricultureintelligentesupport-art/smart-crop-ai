"use client";

import { AnimatePresence, motion, useMotionValueEvent, useScroll } from "framer-motion";
import {
  Bot,
  ImagePlus,
  LoaderCircle,
  ScanSearch,
  Scissors,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import AppBar, { AppBarBrand } from "@/components/app/AppBar";
import TabBar from "@/components/app/TabBar";
import { SHELL_COLUMN } from "@/components/app/shell";
import LanguageSwitch from "@/components/auth/LanguageSwitch";
import { EASE_OUT, FOCUS_RING, GPU } from "@/components/auth/ui";
import { useAuth } from "@/context/AuthContext";
import { ASSISTANT } from "@/lib/assistant/copy";
import type {
  AssistantPreprocessing,
  AssistantResponseBody,
  AssistantSource,
  AssistantDiagnosis,
  AssistantHistoryTurn,
} from "@/lib/assistant/types";
import { useProfile } from "@/lib/auth/profile";
import { guestDisplayName, useGuest } from "@/lib/auth/guest";
import { CROPS, getWilaya, wilayaName, type CropKey } from "@/lib/wilayas";
import { APP_SHELL } from "@/lib/app/copy";
import { useLang } from "@/lib/use-lang";
import DiagnosisCard from "./DiagnosisCard";
import Markdown from "./Markdown";

/* ------------------------------------------------------------------ */
/*  Local chat model                                                   */
/* ------------------------------------------------------------------ */

interface PendingImage {
  /** Full data-URL for the <img> preview. */
  previewUrl: string;
  /** Raw base64 (no prefix) sent to the API. */
  data: string;
  mimeType: string;
}

interface ChatMessage {
  id: string;
  author: "user" | "assistant";
  text: string;
  imageUrl?: string;
  diagnosis?: AssistantDiagnosis | null;
  source?: AssistantSource;
  /** Step 0 detection & cropping report (image requests only). */
  preprocessing?: AssistantPreprocessing | null;
  error?: boolean;
}

let idCounter = 0;
const nextId = () => `msg-${Date.now()}-${idCounter++}`;

/** Max source file accepted from the picker (before downscaling). */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Longest edge sent to the API — plenty for leaf classification. */
const MAX_EDGE_PX = 1024;

/**
 * Read + downscale a photo on-device so a 12 MP phone shot becomes a compact
 * JPEG (~150–400 KB) before it travels to `/api/assistant`.
 */
async function prepareImage(file: File): Promise<PendingImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("decode-failed"));
    el.src = dataUrl;
  });

  const scale = Math.min(1, MAX_EDGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale >= 1 && file.size < 1024 * 1024) {
    const [prefix, data] = dataUrl.split(",", 2);
    const mimeType = /^data:([^;]+)/.exec(prefix)?.[1] ?? file.type ?? "image/jpeg";
    return { previewUrl: dataUrl, data: data ?? "", mimeType };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("decode-failed");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpegUrl = canvas.toDataURL("image/jpeg", 0.88);
  return { previewUrl: jpegUrl, data: jpegUrl.split(",", 2)[1] ?? "", mimeType: "image/jpeg" };
}

/* ------------------------------------------------------------------ */
/*  View                                                               */
/* ------------------------------------------------------------------ */

export default function AssistantView() {
  const router = useRouter();
  const { lang, setLang } = useLang("ar");
  const t = ASSISTANT[lang];
  const shell = APP_SHELL[lang];
  const { profile, ready } = useProfile();
  const { user: authUser, profile: authProfile } = useAuth();
  const { isGuest } = useGuest();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [busy, setBusy] = useState(false);
  /** Whether the in-flight request carries a photo (drives the thinking label). */
  const [busyWithImage, setBusyWithImage] = useState(false);
  /**
   * Two-phase thinking indicator for photo requests: the Detection & Cropping
   * pre-step (Step 0) runs first on the server, then classification + the LLM.
   */
  const [visionPhase, setVisionPhase] = useState<0 | 1>(0);
  const [composerError, setComposerError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** App-bar elevation, driven by the conversation's own scroll region. */
  const [elevated, setElevated] = useState(false);
  const { scrollY } = useScroll({ container: scrollRef });
  useMotionValueEvent(scrollY, "change", (value) => setElevated(value > 8));

  /** Snapshot of the last request so the retry chip can resend it. */
  const lastRequestRef = useRef<{ message: string; image: PendingImage | null } | null>(null);

  // Same session gate as the dashboard: assistant answers are personalised,
  // so an authenticated profile — or the local guest bypass — is required.
  // A real member session always wins over a stale guest flag.
  const member = Boolean(authUser) || (profile?.uid ?? null) !== null;
  const guestActive = isGuest && !member;
  const authenticated = member || isGuest;
  useEffect(() => {
    if (!ready) return;
    if (!authenticated) router.replace("/auth");
  }, [authenticated, ready, router]);

  // Pin the conversation to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Photo requests take visibly longer now (detect → crop → classify): walk
  // the thinking label through the real pipeline phases so the farmer always
  // sees what the server is doing. Phase 0 (detection) is typically 1–9 s,
  // so after a short beat the label switches to the classification phase.
  // (visionPhase itself is reset in `send`, an event handler.)
  useEffect(() => {
    if (!busyWithImage) return;
    const timer = window.setTimeout(() => setVisionPhase(1), 2600);
    return () => window.clearTimeout(timer);
  }, [busyWithImage]);

  const wilayaCode = profile?.wilayaCode ?? authProfile?.wilayaCode ?? authProfile?.wilaya ?? null;
  const wilaya = wilayaCode ? getWilaya(wilayaCode) : null;
  // The onboarding farm step stores the explicit crop choice on the local
  // profile (gateway sessions) and in Firestore (Firebase sessions); the
  // wilaya default only fills the gap when the step was skipped.
  const preferredCropKey =
    (profile?.preferredCrop as CropKey | undefined) ??
    (authProfile?.preferredCrop as CropKey | undefined) ??
    wilaya?.crops[0];
  const landSizeHa = profile?.landSizeHa ?? authProfile?.landSizeHa ?? null;
  const role = profile?.role ?? (authProfile?.role as string | null) ?? null;

  const buildContext = useCallback(
    () => ({
      wilayaCode,
      wilayaName: wilaya ? wilayaName(wilaya, lang) : null,
      crop:
        preferredCropKey && preferredCropKey in CROPS
          ? CROPS[preferredCropKey as CropKey][lang]
          : null,
      landSizeHa,
      role,
      lang,
      displayName: guestActive
        ? guestDisplayName(lang)
        : profile?.displayName ?? authProfile?.displayName ?? null,
    }),
    [
      wilayaCode,
      wilaya,
      preferredCropKey,
      landSizeHa,
      role,
      lang,
      guestActive,
      profile?.displayName,
      authProfile?.displayName,
    ],
  );

  const send = useCallback(
    async (messageText: string, image: PendingImage | null) => {
      const text = messageText.trim();
      if ((!text && !image) || busy) return;

      lastRequestRef.current = { message: text, image };
      const history: AssistantHistoryTurn[] = messages
        .filter((item) => item.text.trim().length > 0)
        .slice(-10)
        .map((item) => ({
          role: item.author === "user" ? "user" : "assistant",
          content: item.text,
        }));

      setMessages((prev) => [
        ...prev,
        { id: nextId(), author: "user", text, imageUrl: image?.previewUrl },
      ]);
      setDraft("");
      setPendingImage(null);
      setComposerError(null);
      setBusy(true);
      setBusyWithImage(image !== null);
      // Photo requests start over at the detection phase of the thinking
      // indicator (Step 0 → classification), every single time.
      setVisionPhase(0);

      let errorMessage = t.chat.error;
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            image: image ? { data: image.data, mimeType: image.mimeType } : undefined,
            context: buildContext(),
            history,
          }),
        });
        if (!res.ok) {
          // Configuration is known only by the server, never inferred on mount.
          // The route signals it with code MISSING_KEYS (503 — the API never
          // returns 500 anymore; it degrades to direct replies instead).
          const failure = await res.json().catch(() => null);
          if (failure?.code === "MISSING_KEYS") {
            errorMessage = t.chat.unavailable;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const payload = (await res.json()) as AssistantResponseBody;
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            author: "assistant",
            text: payload.reply,
            diagnosis: payload.diagnosis ?? null,
            source: payload.source,
            preprocessing: payload.preprocessing ?? null,
          },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), author: "assistant", text: errorMessage, error: true },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, buildContext, messages, t.chat.error, t.chat.unavailable],
  );

  const retryLast = useCallback(() => {
    const last = lastRequestRef.current;
    if (!last || busy) return;
    // Drop the failed bubble + its user message duplicate stays (history is honest).
    setMessages((prev) => prev.filter((m) => !m.error));
    void send(last.message, last.image);
  }, [busy, send]);

  const onPickFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        setComposerError(t.composer.imageTooLarge);
        return;
      }
      try {
        setComposerError(null);
        setPendingImage(await prepareImage(file));
        textareaRef.current?.focus();
      } catch {
        setComposerError(t.composer.imageUnreadable);
      }
    },
    [t.composer.imageTooLarge, t.composer.imageUnreadable],
  );

  const onChip = useCallback(
    (chip: { message: string; withImage?: boolean }) => {
      if (chip.withImage && !pendingImage) {
        setDraft(chip.message);
        fileInputRef.current?.click();
        return;
      }
      void send(chip.message, pendingImage);
    },
    [pendingImage, send],
  );

  const onComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send(draft, pendingImage);
      }
    },
    [draft, pendingImage, send],
  );

  const canSend = (draft.trim().length > 0 || pendingImage !== null) && !busy;
  const emptyChat = messages.length === 0;

  return (
    <div
      dir={lang === "ar" ? "rtl" : "ltr"}
      className={`screen-h app-canvas relative flex flex-col overflow-hidden text-emerald-950 ${
        lang === "ar" ? "font-arabic" : "font-latin"
      }`}
    >

      {/* Header */}
      <AppBar
        label={shell.barLabel}
        elevated={elevated}
        leading={
          <AppBarBrand
            icon={<Bot size={17} strokeWidth={2.4} className="text-white" aria-hidden />}
            title={t.header.title}
            subtitle={t.header.subtitle}
          />
        }
        trailing={
          <LanguageSwitch
            lang={lang}
            onChange={setLang}
            ariaLabel={lang === "ar" ? "اختيار اللغة" : "Choix de la langue"}
            labels={{ ar: t.header.langAr, fr: t.header.langFr }}
            layoutId="assistant-lang-thumb"
          />
        }
      />

      {/* Conversation */}
      <main
        ref={scrollRef}
        className="scroll-area scroll-pad-top relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-live="polite"
      >
        <div className={`${SHELL_COLUMN} flex flex-col gap-3 px-4 pb-4 pt-2`}>
          {emptyChat && (
            <motion.section
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: EASE_OUT }}
              className={`app-surface ${GPU} mt-4 p-5 sm:mt-8 sm:p-6`}
            >
              <span className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-700 shadow-[0_0_28px_rgba(16,185,129,0.45)]">
                <Sparkles size={24} strokeWidth={2.2} className="text-white" aria-hidden />
              </span>
              <h1 className="text-[19px] font-black leading-7 text-emerald-950">{t.hero.greeting}</h1>
              <p className="mt-1.5 max-w-[52ch] text-[13px] font-semibold leading-6 text-emerald-900/70">
                {t.hero.intro}
              </p>
            </motion.section>
          )}

          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.32, ease: EASE_OUT }}
                className={`${GPU} flex ${msg.author === "user" ? "justify-start flex-row-reverse" : "justify-start"}`}
              >
                <div
                  className={`max-w-[92%] sm:max-w-[78%] ${
                    msg.author === "user"
                      ? "rounded-3xl rounded-es-lg bg-gradient-to-br from-emerald-500 to-green-600 px-4 py-3 text-white shadow-[0_10px_28px_rgba(16,185,129,0.32)]"
                      : "app-surface rounded-[1.35rem] rounded-ss-lg px-4 py-3.5"
                  }`}
                >
                  {msg.author === "assistant" && (
                    <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black text-emerald-700/70">
                      <Bot size={11} strokeWidth={2.8} aria-hidden />
                      {t.chat.assistant}
                    </p>
                  )}

                  {msg.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- local data-URL preview, next/image cannot optimise it
                    <img
                      src={msg.imageUrl}
                      alt={t.composer.imageAlt}
                      className="mb-2 max-h-56 w-full rounded-2xl object-cover"
                    />
                  )}

                  {msg.author === "assistant" && msg.preprocessing?.status === "cropped" && (
                    <p
                      className="mb-2 flex items-start gap-1.5 rounded-2xl bg-emerald-50/80 px-2.5 py-1.5 text-[10px] font-bold leading-4 text-emerald-800 ring-1 ring-emerald-200/70"
                      title={msg.preprocessing.detector ?? undefined}
                    >
                      <Scissors size={11} strokeWidth={2.8} aria-hidden className="mt-[2px] shrink-0 text-emerald-600" />
                      {t.chat.cropApplied}
                    </p>
                  )}
                  {msg.author === "assistant" && msg.preprocessing?.status === "no-leaf" && (
                    <p className="mb-2 flex items-start gap-1.5 rounded-2xl bg-white/70 px-2.5 py-1.5 text-[10px] font-bold leading-4 text-emerald-900/70 ring-1 ring-[#E2F1E8]">
                      <ScanSearch size={11} strokeWidth={2.8} aria-hidden className="mt-[2px] shrink-0 text-emerald-600" />
                      {t.chat.cropNotFound}
                    </p>
                  )}

                  {msg.diagnosis && (
                    <div className="mb-3">
                      <DiagnosisCard diagnosis={msg.diagnosis} copy={t.diagnosis} />
                    </div>
                  )}

                  {msg.author === "assistant" ? (
                    <Markdown text={msg.text} />
                  ) : (
                    msg.text && (
                      <p className="whitespace-pre-wrap text-[13.5px] font-bold leading-6">{msg.text}</p>
                    )
                  )}

                  {msg.source === "direct" && (
                    <p className="mt-2 text-[10px] font-bold text-amber-700/80">⚠️ {t.chat.visionOnlyNote}</p>
                  )}
                  {msg.error && (
                    <button
                      type="button"
                      onClick={retryLast}
                      className={`mt-2 rounded-xl bg-emerald-100 px-3 py-1.5 text-[11px] font-black text-emerald-800 transition-colors hover:bg-emerald-200 ${FOCUS_RING}`}
                    >
                      {t.chat.retry}
                    </button>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {busy && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className={`${GPU} flex justify-start`}
            >
              <div className="app-surface flex items-center gap-2.5 rounded-[1.35rem] rounded-ss-lg px-4 py-3">
                <LoaderCircle size={15} strokeWidth={2.6} className="animate-spin text-emerald-600" aria-hidden />
                <span className="text-[12px] font-bold text-emerald-900/70">
                  {busyWithImage
                    ? visionPhase === 0
                      ? t.chat.thinkingDetect
                      : t.chat.thinkingVision
                    : t.chat.thinking}
                </span>
              </div>
            </motion.div>
          )}
        </div>
      </main>

      {/* Composer */}
      <footer className={`${SHELL_COLUMN} relative z-20 shrink-0 px-4 pb-[calc(var(--app-tab-h)+0.75rem+env(safe-area-inset-bottom,0px))]`}>
        {/* Quick-action chips */}
        <div className="scroll-area mb-2 flex gap-1.5 overflow-x-auto pb-0.5">
          {t.chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              disabled={busy}
              onClick={() => onChip(chip)}
              className={`app-surface ${GPU} ${FOCUS_RING} shrink-0 whitespace-nowrap rounded-full px-4 py-2.5 text-[12px] font-black text-emerald-800 transition-colors hover:border-emerald-300 disabled:opacity-50`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="app-surface p-2">
          <AnimatePresence>
            {pendingImage && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.24, ease: EASE_OUT }}
                className="overflow-hidden"
              >
                <div className="relative m-1 mb-2 w-fit">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local data-URL preview */}
                  <img
                    src={pendingImage.previewUrl}
                    alt={t.composer.imageAlt}
                    className="h-24 w-24 rounded-2xl object-cover ring-2 ring-emerald-200"
                  />
                  <button
                    type="button"
                    onClick={() => setPendingImage(null)}
                    aria-label={t.composer.removeImage}
                    className={`absolute -end-2 -top-2 grid h-7 w-7 place-items-center rounded-full bg-emerald-900 text-white shadow-md transition-colors hover:bg-emerald-700 ${FOCUS_RING}`}
                  >
                    <X size={13} strokeWidth={3} aria-hidden />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {composerError && (
            <p role="alert" className="mx-2 mb-1.5 text-[11px] font-bold text-orange-600">
              {composerError}
            </p>
          )}

          <div className="flex items-end gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void onPickFile(e)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label={t.composer.attach}
              disabled={busy}
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100 transition-colors hover:bg-emerald-100 disabled:opacity-50 ${FOCUS_RING}`}
            >
              <ImagePlus size={17} strokeWidth={2.4} aria-hidden />
            </button>

            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={t.composer.placeholder}
              rows={1}
              disabled={busy}
              className="max-h-32 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2.5 text-[13.5px] font-bold leading-6 text-emerald-950 outline-none placeholder:text-emerald-900/40 disabled:opacity-60"
            />

            <motion.button
              type="button"
              whileTap={canSend ? { scale: 0.92 } : undefined}
              onClick={() => void send(draft, pendingImage)}
              disabled={!canSend}
              aria-label={t.composer.send}
              className={`glow-emerald ${GPU} ${FOCUS_RING} grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 via-emerald-500 to-green-600 text-white transition-all hover:from-emerald-400 hover:to-green-500 disabled:cursor-not-allowed disabled:opacity-45`}
            >
              {busy ? (
                <LoaderCircle size={17} strokeWidth={2.6} className="animate-spin" aria-hidden />
              ) : (
                <Send size={16} strokeWidth={2.5} className={lang === "ar" ? "-scale-x-100" : ""} aria-hidden />
              )}
            </motion.button>
          </div>
        </div>
      </footer>

      <TabBar active="assistant" lang={lang} />
    </div>
  );
}
