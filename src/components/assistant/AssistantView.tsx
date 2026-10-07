"use client";

import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from "framer-motion";
import {
  ImagePlus,
  LoaderCircle,
  Menu,
  Plus,
  RotateCcw,
  ScanSearch,
  Scissors,
  Send,
  TriangleAlert,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import AppBar, { AppBarAction, AppBarBrand } from "@/components/app/AppBar";
import TabBar from "@/components/app/TabBar";
import { SHELL_COLUMN } from "@/components/app/shell";
import { EASE_OUT, FOCUS_RING, GPU, SPRING } from "@/components/auth/ui";
import { useAuth } from "@/context/AuthContext";
import { ASSISTANT } from "@/lib/assistant/copy";
import type { AnalysisSource } from "@/lib/assistant/analysis";
import { type StoredChatMessage } from "@/lib/assistant/history";
import {
  groupConversationsByRecency,
  makeConversationId,
  markRestored,
  type ConversationMeta,
} from "@/lib/assistant/conversations";
import {
  deleteAllConversations,
  deleteConversation,
  loadConversationById,
  loadConversationList,
  renameConversation,
  saveConversation,
  setActiveConversationId as persistActiveConversationId,
} from "@/lib/assistant/conversationStore";
import { HISTORY_COPY } from "@/lib/assistant/historyCopy";
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
import { AssistantAvatar, EmptyHero, PhytoScanLogo, POP, TypingIndicator, bubbleVariants } from "./ChatParts";
import DiagnosisCard from "./DiagnosisCard";
import HistoryDrawer from "./HistoryDrawer";
import HistorySkeleton from "./HistorySkeleton";
import Markdown from "./Markdown";
import "./assistant.css";

/** History UX tuning — storage-layer/presentation only, no effect on what is sent to the model. */
const SAVE_DEBOUNCE_MS = 800;
const MIN_BOOT_SKELETON_MS = 300;

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
  /** Display only — which image engine produced `diagnosis` (from the API response). */
  analysisSource?: AnalysisSource | null;
  /** Step 0 detection & cropping report (image requests only). */
  preprocessing?: AssistantPreprocessing | null;
  error?: boolean;
  /** Loaded from storage, not just produced: render instantly, skip every entrance/reveal/result animation. */
  isRestored?: boolean;
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

/**
 * A stored turn rendered back on screen. Photos are never persisted, so a turn
 * that carried one shows the stored «صورة» placeholder (or its own text) instead
 * of a preview — everything else is exactly the bubble it was.
 */
function restoredChatMessage(message: StoredChatMessage): ChatMessage {
  return {
    id: message.id,
    author: message.author,
    text: message.text || message.image || "",
    diagnosis: message.diagnosis ?? null,
    source: message.source,
    analysisSource: message.analysisSource ?? null,
    preprocessing: message.preprocessing ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  View                                                               */
/* ------------------------------------------------------------------ */

export default function AssistantView() {
  const router = useRouter();
  const { lang } = useLang("ar");
  const t = ASSISTANT[lang];
  const shell = APP_SHELL[lang];
  const { profile, ready } = useProfile();
  const { user: authUser, profile: authProfile, loading: authLoading } = useAuth();
  const { isGuest } = useGuest();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** Turns restored from history: shown in the conversation, never sent to the model. */
  const [restoredMessages, setRestoredMessages] = useState<ChatMessage[]>([]);
  /** True once the conversation list could be read — gates saving (never overwrite an unread store). */
  const [persistReady, setPersistReady] = useState(false);
  /** UI boot state: a short skeleton while the active conversation restores, then the real screen either way. */
  const [bootPhase, setBootPhase] = useState<"loading" | "ready">("loading");
  /** Which saved conversation is open — `null` is a fresh, not-yet-saved chat. */
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  /** Metadata only (id/title/updatedAt) for every saved conversation — the sidebar list. */
  const [conversationMetas, setConversationMetas] = useState<ConversationMeta[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  /** History hydration happens once per mount, after the session is settled. */
  const hydratedRef = useRef(false);
  /** The next save effect run only re-writes what was just read/switched to — skip it once. */
  const skipNextSaveRef = useRef(true);
  /** Debounced save timer (~800 ms of inactivity) — see the save effect below. */
  const saveTimerRef = useRef<number | null>(null);
  /** The pending debounced save, runnable immediately (tab hidden/closed must not lose the last turn). */
  const flushSaveRef = useRef<() => void>(() => {});
  /** A restore (boot or conversation switch) just happened: scroll instantly, never smoothly, for this paint. */
  const justRestoredRef = useRef(false);
  /** Always-fresh metadata list for the debounced save closure, without making it a reactive dependency. */
  const conversationMetasRef = useRef<ConversationMeta[]>([]);
  useEffect(() => {
    conversationMetasRef.current = conversationMetas;
  }, [conversationMetas]);

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

  // Pin the conversation to the newest message — instantly right after a
  // restore (boot or switching conversations), smoothly for a live reply.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const instant = justRestoredRef.current;
    justRestoredRef.current = false;
    el.scrollTo({ top: el.scrollHeight, behavior: instant ? "auto" : "smooth" });
  }, [messages, restoredMessages, busy]);

  /* ------------------------------------------------------------------ */
  /*  Chat history (Firestore for verified members, localStorage else)    */
  /*  Multiple conversations, one open at a time. Restored turns render   */
  /*  above the live ones and are deliberately NOT fed into `send`'s      */
  /*  history: the request payload stays exactly what this session typed, */
  /*  like today — switching conversations never changes that.            */
  /* ------------------------------------------------------------------ */

  /** Namespaces the localStorage fallback only — Firestore takes its uid from the session. */
  const localHistoryKey = profile?.uid ?? authUser?.uid ?? null;

  // Load on mount, once the session is resolved (Firebase Auth included).
  // `hydratedRef` makes this a once-per-mount read (double-invoked effects
  // included); a late answer for a screen that is gone is simply ignored by
  // React, never applied to another mount's state. On any failure this still
  // settles into a usable, empty new chat — never an error, never a stuck
  // skeleton (see `MIN_BOOT_SKELETON_MS` below).
  useEffect(() => {
    if (hydratedRef.current || authLoading || !ready || !authenticated) return;
    hydratedRef.current = true;
    const startedAt = Date.now();
    void (async () => {
      const index = await loadConversationList(localHistoryKey);
      setConversationMetas(index.conversations);
      setPersistReady(index.ok);

      const openId = index.ok && index.activeId && index.conversations.some((item) => item.id === index.activeId)
        ? index.activeId
        : null;
      if (openId) {
        const loaded = await loadConversationById(localHistoryKey, openId);
        if (loaded.conversation) {
          justRestoredRef.current = true;
          setActiveConversationId(openId);
          setRestoredMessages(markRestored(loaded.conversation.messages.map(restoredChatMessage)));
        }
      }

      skipNextSaveRef.current = true;
      const elapsed = Date.now() - startedAt;
      window.setTimeout(() => setBootPhase("ready"), Math.max(0, MIN_BOOT_SKELETON_MS - elapsed));
    })();
  }, [authLoading, ready, authenticated, localHistoryKey]);

  // Debounced save (~800 ms of inactivity; completed turns only — failed/retry
  // bubbles are stripped by the sanitizer). A conversation is created lazily:
  // `send` assigns `activeConversationId` on the FIRST message of a new chat,
  // so nothing is ever saved before it holds something.
  useEffect(() => {
    if (!persistReady || !activeConversationId) {
      flushSaveRef.current = () => {};
      return;
    }
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      if (messages.length === 0) {
        flushSaveRef.current = () => {};
        return;
      }
    }
    const runSave = () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const combined = [...restoredMessages, ...messages];
      const titleHint = conversationMetasRef.current.find((item) => item.id === activeConversationId)?.title;
      void saveConversation(localHistoryKey, activeConversationId, titleHint, combined, {
        activeId: activeConversationId,
        conversations: conversationMetasRef.current,
      }).then((result) => {
        if (result) setConversationMetas(result.conversations);
      });
    };
    flushSaveRef.current = runSave;
    saveTimerRef.current = window.setTimeout(runSave, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [persistReady, activeConversationId, restoredMessages, messages, localHistoryKey]);

  // The debounce must never cost the farmer their last turn: flush it the
  // instant the tab is hidden/closed/backgrounded (localStorage writes are
  // synchronous; a Firestore write at least starts before the page is gone).
  useEffect(() => {
    const flush = () => flushSaveRef.current();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  /** Switches to a saved conversation — loads instantly, no animation (isRestored, see `ChatParts`/render below). */
  const openConversation = useCallback(
    async (id: string) => {
      if (id === activeConversationId) return;
      const loaded = await loadConversationById(localHistoryKey, id);
      if (!loaded.conversation) return;
      skipNextSaveRef.current = true;
      justRestoredRef.current = true;
      setMessages([]);
      setRestoredMessages(markRestored(loaded.conversation.messages.map(restoredChatMessage)));
      setActiveConversationId(id);
      void persistActiveConversationId(localHistoryKey, id, { conversations: conversationMetasRef.current });
    },
    [activeConversationId, localHistoryKey],
  );

  /** Starts a fresh, empty conversation — saved only once the first message is actually sent. */
  const startNewChat = useCallback(() => {
    if (activeConversationId === null && messages.length === 0 && restoredMessages.length === 0) return;
    skipNextSaveRef.current = true;
    justRestoredRef.current = true;
    setMessages([]);
    setRestoredMessages([]);
    setActiveConversationId(null);
    void persistActiveConversationId(localHistoryKey, null, { conversations: conversationMetasRef.current });
  }, [activeConversationId, messages.length, restoredMessages.length, localHistoryKey]);

  const renameConversationById = useCallback(
    (id: string, title: string) => {
      void renameConversation(localHistoryKey, id, title, {
        activeId: activeConversationId,
        conversations: conversationMetasRef.current,
      }).then((updated) => {
        if (updated) setConversationMetas(updated);
      });
    },
    [localHistoryKey, activeConversationId],
  );

  const deleteConversationById = useCallback(
    (id: string) => {
      const wasActive = activeConversationId === id;
      void deleteConversation(localHistoryKey, id, {
        activeId: activeConversationId,
        conversations: conversationMetasRef.current,
      }).then((result) => {
        setConversationMetas(result.conversations);
        if (wasActive) {
          justRestoredRef.current = true;
          setMessages([]);
          setRestoredMessages([]);
          setActiveConversationId(null);
          skipNextSaveRef.current = true;
        }
      });
    },
    [localHistoryKey, activeConversationId],
  );

  const deleteAllConversationsNow = useCallback(() => {
    void deleteAllConversations(localHistoryKey, { conversations: conversationMetasRef.current }).then(() => {
      justRestoredRef.current = true;
      setConversationMetas([]);
      setMessages([]);
      setRestoredMessages([]);
      setActiveConversationId(null);
      skipNextSaveRef.current = true;
    });
  }, [localHistoryKey]);

  const conversationGroups = useMemo(() => groupConversationsByRecency(conversationMetas), [conversationMetas]);

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

      // A brand-new chat only becomes a real, saved conversation once it
      // actually holds a message — assigned here, once, on the first send.
      if (activeConversationId === null) setActiveConversationId(makeConversationId());

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
          // SERVER_BUSY (503) is the deadline guard: the request outran the
          // server's 40 s budget — transient, a retry is the remedy.
          const failure = await res.json().catch(() => null);
          if (failure?.code === "MISSING_KEYS") {
            errorMessage = t.chat.unavailable;
          } else if (failure?.code === "SERVER_BUSY") {
            errorMessage = t.chat.busy;
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
            analysisSource: payload.analysisSource ?? null,
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
    [busy, buildContext, messages, activeConversationId, t.chat.error, t.chat.unavailable, t.chat.busy],
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

  /** Input stays disabled until the active conversation finished loading (see `HistorySkeleton`). */
  const composerDisabled = busy || bootPhase === "loading";
  const canSend = (draft.trim().length > 0 || pendingImage !== null) && !composerDisabled;
  /** Restored turns first, then the live session — one conversation on screen. */
  const conversation = restoredMessages.length > 0 ? [...restoredMessages, ...messages] : messages;
  const emptyChat = conversation.length === 0;
  /** Presentation only: collapses entrance motion for users who ask for less. */
  const reduceMotion = useReducedMotion();
  const hc = HISTORY_COPY[lang];
  const booting = bootPhase === "loading";

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
            icon={<PhytoScanLogo size={18} strokeWidth={2.4} className="text-white" aria-hidden />}
            title={t.header.title}
            subtitle={t.header.subtitle}
          />
        }
        trailing={
          <>
            <AppBarAction label={hc.newChat} onClick={startNewChat}>
              <Plus size={18} strokeWidth={2.4} aria-hidden />
            </AppBarAction>
            <AppBarAction label={hc.menu} onClick={() => setDrawerOpen(true)}>
              <Menu size={18} strokeWidth={2.4} aria-hidden />
            </AppBarAction>
          </>
        }
      />

      <HistoryDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        lang={lang}
        copy={hc}
        groups={conversationGroups}
        activeId={activeConversationId}
        savedOnAccount={!guestActive}
        onSelect={(id) => void openConversation(id)}
        onNewChat={startNewChat}
        onRename={renameConversationById}
        onDeleteOne={deleteConversationById}
        onDeleteAll={deleteAllConversationsNow}
      />

      {/* Conversation */}
      <main
        ref={scrollRef}
        className="scroll-area scroll-pad-top relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-live="polite"
      >
        {booting ? (
          <HistorySkeleton label={hc.loading} />
        ) : (
        <div className={`${SHELL_COLUMN} flex flex-col gap-4 px-4 pb-12 pt-3`}>
          {emptyChat && <EmptyHero greeting={t.hero.greeting} intro={t.hero.intro} />}

          <AnimatePresence initial={false}>
            {conversation.map((msg) => {
              const isUser = msg.author === "user";
              // A message loaded from history renders in its final state immediately —
              // no entrance motion, no typewriter reveal, no repeated result animation.
              const skipAnimation = Boolean(msg.isRestored) || reduceMotion;
              return (
                <motion.div
                  key={msg.id}
                  variants={bubbleVariants}
                  initial={msg.isRestored ? false : "hidden"}
                  animate="show"
                  exit="exit"
                  transition={skipAnimation ? { duration: 0 } : SPRING}
                  className={`${GPU} flex items-end gap-2.5 ${
                    isUser
                      ? "justify-end origin-bottom-right rtl:origin-bottom-left"
                      : "justify-start origin-bottom-left rtl:origin-bottom-right"
                  }`}
                >
                  {!isUser && <AssistantAvatar />}

                  <div
                    className={`min-w-0 max-w-[88%] sm:max-w-[76%] ${
                      isUser
                        ? "chat-bubble-user px-4 py-3"
                        : `chat-bubble-assistant px-4 py-3.5 ${msg.error ? "chat-bubble-error" : ""}`
                    }`}
                  >
                    {!isUser && (
                      <p className="mb-2 flex items-center gap-1.5 text-[10.5px] font-black uppercase tracking-[0.08em] text-emerald-700/70">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {t.chat.assistant}
                      </p>
                    )}

                    {msg.imageUrl && (
                      <motion.div
                        initial={skipAnimation ? false : { opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.08, duration: 0.4, ease: EASE_OUT }}
                        className="chat-image mb-2.5 overflow-hidden rounded-2xl"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- local data-URL preview, next/image cannot optimise it */}
                        <img
                          src={msg.imageUrl}
                          alt={t.composer.imageAlt}
                          className="max-h-60 w-full object-cover"
                        />
                      </motion.div>
                    )}

                    <div>
                      {!isUser && msg.preprocessing?.status === "cropped" && (
                        <p
                          className="chat-note mb-2.5 flex items-start gap-1.5 rounded-xl px-2.5 py-1.5 text-[10.5px] font-bold leading-4 text-emerald-800"
                          title={msg.preprocessing.detector ?? undefined}
                        >
                          <Scissors size={11} strokeWidth={2.8} aria-hidden className="mt-[2px] shrink-0 text-emerald-600" />
                          {t.chat.cropApplied}
                        </p>
                      )}
                      {!isUser && msg.preprocessing?.status === "no-leaf" && (
                        <p className="chat-note-muted mb-2.5 flex items-start gap-1.5 rounded-xl px-2.5 py-1.5 text-[10.5px] font-bold leading-4 text-emerald-900/70">
                          <ScanSearch size={11} strokeWidth={2.8} aria-hidden className="mt-[2px] shrink-0 text-emerald-600" />
                          {t.chat.cropNotFound}
                        </p>
                      )}

                      {msg.diagnosis && (
                        <div className="mb-3">
                          <DiagnosisCard
                            diagnosis={msg.diagnosis}
                            analysisSource={msg.analysisSource}
                            copy={t.diagnosis}
                            animate={!msg.isRestored}
                          />
                        </div>
                      )}

                      {!isUser ? (
                        <Markdown text={msg.text} animate={!msg.isRestored} />
                      ) : (
                        msg.text && (
                          <p className="whitespace-pre-wrap text-[14px] font-bold leading-6 [text-shadow:0_1px_0_rgba(0,0,0,0.08)]">
                            {msg.text}
                          </p>
                        )
                      )}

                      {msg.source === "direct" && (
                        <p className="mt-2.5 flex items-start gap-1.5 rounded-xl bg-amber-50 px-2.5 py-1.5 text-[10.5px] font-bold leading-4 text-amber-800 ring-1 ring-amber-200/70">
                          <TriangleAlert size={11} strokeWidth={2.8} aria-hidden className="mt-[2px] shrink-0 text-amber-500" />
                          {t.chat.visionOnlyNote}
                        </p>
                      )}
                      {msg.error && (
                        <motion.button
                          type="button"
                          whileHover={{ y: -1 }}
                          whileTap={{ scale: 0.96 }}
                          transition={POP}
                          onClick={retryLast}
                          className={`mt-3 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 px-3.5 py-2 text-[11.5px] font-black text-white shadow-[0_10px_22px_-12px_rgba(5,150,105,0.9)] ${FOCUS_RING}`}
                        >
                          <RotateCcw size={12} strokeWidth={2.8} aria-hidden />
                          {t.chat.retry}
                        </motion.button>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>

          <AnimatePresence>
            {busy && (
              <TypingIndicator
                key="typing"
                label={
                  busyWithImage
                    ? visionPhase === 0
                      ? t.chat.thinkingDetect
                      : t.chat.thinkingVision
                    : t.chat.thinking
                }
              />
            )}
          </AnimatePresence>
        </div>
        )}
      </main>

      {/* Composer */}
      <footer className={`${SHELL_COLUMN} relative z-20 shrink-0 px-4 pb-[calc(var(--app-tab-h)+0.75rem+env(safe-area-inset-bottom,0px))]`}>
        <span aria-hidden className="chat-composer-fade" />

        <div className="chat-composer p-2">
          <AnimatePresence>
            {pendingImage && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.28, ease: EASE_OUT }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-3 px-1.5 pb-2.5 pt-1.5">
                  <motion.div
                    initial={reduceMotion ? false : { scale: 0.7, opacity: 0, rotate: -4 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    transition={POP}
                    className="relative w-fit shrink-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- local data-URL preview */}
                    <img
                      src={pendingImage.previewUrl}
                      alt={t.composer.imageAlt}
                      className="chat-thumb h-[76px] w-[76px] rounded-2xl object-cover"
                    />
                    <span
                      aria-hidden
                      className="absolute -bottom-1.5 -start-1.5 grid h-6 w-6 place-items-center rounded-full bg-white text-emerald-600 shadow-md ring-1 ring-emerald-100"
                    >
                      <ImagePlus size={12} strokeWidth={2.8} />
                    </span>
                    <motion.button
                      type="button"
                      onClick={() => setPendingImage(null)}
                      aria-label={t.composer.removeImage}
                      initial={reduceMotion ? false : { scale: 0, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ ...POP, delay: 0.12 }}
                      whileHover={{ scale: 1.08 }}
                      whileTap={{ scale: 0.9 }}
                      className={`absolute -end-2 -top-2 grid h-7 w-7 place-items-center rounded-full bg-emerald-950 text-white shadow-[0_6px_14px_-4px_rgba(4,47,46,0.7)] transition-colors hover:bg-emerald-800 ${FOCUS_RING}`}
                    >
                      <X size={13} strokeWidth={3} aria-hidden />
                    </motion.button>
                  </motion.div>
                  <motion.p
                    initial={reduceMotion ? false : { opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1, duration: 0.3, ease: EASE_OUT }}
                    className="min-w-0 text-[11.5px] font-bold leading-5 text-emerald-900/60"
                  >
                    {t.composer.imageAlt}
                  </motion.p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {composerError && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, y: -4, height: 0 }}
                animate={{ opacity: 1, y: 0, height: "auto" }}
                exit={{ opacity: 0, y: -4, height: 0 }}
                transition={{ duration: 0.22, ease: EASE_OUT }}
                className="mx-2 overflow-hidden text-[11px] font-bold text-orange-600"
              >
                <span className="block pb-1.5">{composerError}</span>
              </motion.p>
            )}
          </AnimatePresence>

          <div className="flex items-end gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void onPickFile(e)}
            />
            <motion.button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label={t.composer.attach}
              disabled={composerDisabled}
              whileHover={composerDisabled ? undefined : { scale: 1.04 }}
              whileTap={composerDisabled ? undefined : { scale: 0.92 }}
              transition={POP}
              className={`chat-attach ${GPU} ${FOCUS_RING} grid h-11 w-11 shrink-0 place-items-center rounded-full disabled:opacity-50 ${
                pendingImage ? "chat-attach-filled" : ""
              }`}
            >
              <ImagePlus size={17} strokeWidth={2.4} aria-hidden />
            </motion.button>

            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKeyDown}
              placeholder={booting ? hc.loading : t.composer.placeholder}
              rows={1}
              disabled={composerDisabled}
              className="max-h-32 min-h-[44px] flex-1 resize-none bg-transparent px-2.5 py-2.5 text-[14px] font-bold leading-6 text-emerald-950 outline-none transition-opacity placeholder:text-emerald-900/40 disabled:opacity-60"
            />

            <motion.button
              type="button"
              whileHover={canSend ? { scale: 1.04 } : undefined}
              whileTap={canSend ? { scale: 0.9 } : undefined}
              transition={POP}
              onClick={() => void send(draft, pendingImage)}
              disabled={!canSend}
              aria-label={t.composer.send}
              className={`chat-send ${GPU} ${FOCUS_RING} relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full disabled:cursor-not-allowed ${
                canSend ? "chat-send-armed" : ""
              }`}
            >
              <AnimatePresence mode="wait" initial={false}>
                {busy ? (
                  <motion.span
                    key="busy"
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={{ duration: 0.18, ease: EASE_OUT }}
                    className="grid"
                  >
                    <LoaderCircle size={17} strokeWidth={2.6} className="animate-spin text-emerald-700" aria-hidden />
                  </motion.span>
                ) : (
                  <motion.span
                    key="send"
                    initial={{ opacity: 0, scale: 0.6, rotate: lang === "ar" ? 20 : -20 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={POP}
                    className="grid"
                  >
                    <Send
                      size={16}
                      strokeWidth={2.5}
                      className={`${lang === "ar" ? "-scale-x-100" : ""} ${canSend ? "-translate-y-px translate-x-px" : ""}`}
                      aria-hidden
                    />
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          </div>
        </div>
      </footer>

      <TabBar active="assistant" lang={lang} />
    </div>
  );
}
