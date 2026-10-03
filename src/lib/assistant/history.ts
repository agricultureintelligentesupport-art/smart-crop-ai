/**
 * PhytoScan AI — chat-history persistence core.
 *
 * A saved conversation is a plain, dependency-free value: sanitize → encode →
 * store. This module owns the *rules* (what may be persisted, how much, where
 * it is stored) and the *pure* orchestration over an injected {@link ChatHistoryIO},
 * which makes every one of them testable without a browser, Firestore or React.
 * The browser/Firestore plumbing lives next door in `historyStore.ts`.
 *
 * WHAT IS STORED
 * --------------
 * Only COMPLETED turns: a failed/retry bubble (`error: true`) and any in-flight
 * state are never written. Attached photos are never written either — not the
 * data URL, not the base64 — an image turn keeps the literal ``صورة``
 * placeholder instead. Every message is capped ({@link MAX_TEXT_CHARS}) and the
 * payload is capped in BYTES ({@link MAX_PAYLOAD_BYTES}, measured on the exact
 * JSON string that is stored), so a full transcript stays far below Firestore's
 * 1 MiB document limit even with Arabic text (2 bytes per character in UTF-8).
 *
 * WHERE IT IS STORED
 * ------------------
 *   • verified Firebase session → Firestore `assistantChats/{uid}`, one document
 *     per user, `{ version, updatedAt, data }` where `data` is this JSON string;
 *   • anyone else (guest, on-device demo account, no session) → `localStorage`
 *     under `smart-crop.assistant.chat.v1.{localKey}` — no Firestore write ever.
 *
 * The Firestore uid is NEVER taken from the caller or from a request body: it
 * comes from the verified Firebase Auth session inside `historyStore.ts`, and
 * Firestore security rules are the server-side authority (see the PR notes).
 *
 * FAILURES ARE SILENT
 * -------------------
 * No function here throws, logs message text or surfaces an error to the chat:
 * a blocked localStorage, an unreachable Firestore or a rejected security rule
 * degrade to “history is simply not restored”, never to a broken conversation.
 * A read that cannot be completed reports `ok: false` so the caller can decide
 * not to overwrite a transcript it could not read.
 */

import type { AnalysisSource } from "@/lib/assistant/analysis";
import type {
  AssistantDiagnosis,
  AssistantPreprocessing,
  AssistantSource,
} from "@/lib/assistant/types";
import type { Lang } from "@/lib/wilayas";

/* ------------------------------------------------------------------ */
/*  Storage contract                                                   */
/* ------------------------------------------------------------------ */

/** New top-level collection: `assistantChats/{uid}` — nothing existing is touched. */
export const CHAT_HISTORY_COLLECTION = "assistantChats";
/** Version of the stored payload shape; unknown versions are ignored, never guessed at. */
export const CHAT_HISTORY_VERSION = 1;
/** localStorage namespace for guests and on-device (demo) accounts. */
export const LOCAL_HISTORY_PREFIX = "smart-crop.assistant.chat.v1.";
/** Local bucket used when no session identity is available (guest). */
export const GUEST_LOCAL_KEY = "guest";

/* ------------------------------------------------------------------ */
/*  Limits — keep the transcript small and predictable                 */
/* ------------------------------------------------------------------ */

/** Only the newest turns survive a save. */
export const MAX_MESSAGES = 100;
/** Longest stored body per message (characters, not bytes). */
export const MAX_TEXT_CHARS = 1200;
/** Ceiling for one message after its extras are dropped. */
export const MAX_MESSAGE_BYTES = 8 * 1024;
/** Ceiling for the whole payload — ~12% of Firestore's 1 MiB document limit. */
export const MAX_PAYLOAD_BYTES = 128 * 1024;
/** Text stored in place of an attached photo. Images themselves are never persisted. */
export const IMAGE_PLACEHOLDER = "صورة";

/** Bilingual labels for the “مسح المحادثة” action (the assistant copy module is untouched). */
export const CHAT_HISTORY_COPY: Record<Lang, { clear: string; clearConfirm: string }> = {
  ar: {
    clear: "مسح المحادثة",
    clearConfirm: "هل تريد مسح هذه المحادثة؟ لا يمكن التراجع عن هذا الإجراء.",
  },
  fr: {
    clear: "Effacer la conversation",
    clearConfirm: "Effacer cette conversation ? Cette action est irréversible.",
  },
};

/* ------------------------------------------------------------------ */
/*  Stored shapes                                                      */
/* ------------------------------------------------------------------ */

export interface StoredChatMessage {
  id: string;
  author: "user" | "assistant";
  text: string;
  /** Always exactly {@link IMAGE_PLACEHOLDER} when the turn carried a photo. */
  image?: string;
  diagnosis?: AssistantDiagnosis;
  source?: AssistantSource;
  analysisSource?: AnalysisSource;
  preprocessing?: AssistantPreprocessing;
}

export interface ChatHistoryPayload {
  version: number;
  updatedAt: string;
  messages: StoredChatMessage[];
}

/** Result of a read: `ok: false` means the source could not be reached. */
export interface ChatHistoryRead {
  ok: boolean;
  raw: string | null;
}

/** A finished load — `messages` is empty whenever `ok` is false. */
export interface ChatHistoryLoad {
  ok: boolean;
  messages: StoredChatMessage[];
}

export type ChatHistoryScope = { kind: "remote"; uid: string } | { kind: "local"; key: string };

export interface ChatHistorySession {
  /** uid of the VERIFIED Firebase Auth session, or null for guests/demo accounts. */
  uid: string | null;
  /** Whether the Firestore SDK is usable in this environment. */
  firestoreReady: boolean;
}

/* ------------------------------------------------------------------ */
/*  Small guards                                                       */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function utf8Bytes(value: string): number {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
  // Worst case without TextEncoder: assume two bytes per character.
  return value.length * 2;
}

function clampText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS - 1).trimEnd()}…`;
}

/** Truthy only when an image really was attached; the bytes themselves are dropped. */
function asImagePlaceholder(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? IMAGE_PLACEHOLDER : undefined;
}

function asDiagnosis(value: unknown): AssistantDiagnosis | undefined {
  if (!isPlainObject(value)) return undefined;
  const diagnosis = value as Partial<AssistantDiagnosis>;
  if (typeof diagnosis.label !== "string" || typeof diagnosis.labelAr !== "string") return undefined;
  if (typeof diagnosis.confidence !== "number" || typeof diagnosis.healthy !== "boolean") return undefined;
  if (!Array.isArray(diagnosis.candidates)) return undefined;
  const candidatesOk = diagnosis.candidates.every(
    (candidate) =>
      isPlainObject(candidate) &&
      typeof (candidate as { label?: unknown }).label === "string" &&
      typeof (candidate as { score?: unknown }).score === "number",
  );
  if (!candidatesOk) return undefined;
  return value as unknown as AssistantDiagnosis;
}

function asPreprocessing(value: unknown): AssistantPreprocessing | undefined {
  if (!isPlainObject(value)) return undefined;
  const status = value.status;
  if (status !== "cropped" && status !== "no-leaf" && status !== "unavailable" && status !== "skipped") {
    return undefined;
  }
  return value as unknown as AssistantPreprocessing;
}

function asSource(value: unknown): AssistantSource | undefined {
  return value === "hybrid" || value === "llm" || value === "direct" ? value : undefined;
}

function asAnalysisSource(value: unknown): AnalysisSource | undefined {
  return value === "gemini" || value === "mobilenet" ? value : undefined;
}

/* ------------------------------------------------------------------ */
/*  Sanitizing                                                         */
/* ------------------------------------------------------------------ */

/** Drops optional extras — then the body — until one message fits the ceiling. */
function shrinkMessage(message: StoredChatMessage): StoredChatMessage {
  if (utf8Bytes(JSON.stringify(message)) <= MAX_MESSAGE_BYTES) return message;
  const trimmed: StoredChatMessage = { ...message };
  delete trimmed.preprocessing;
  delete trimmed.diagnosis;
  if (utf8Bytes(JSON.stringify(trimmed)) <= MAX_MESSAGE_BYTES) return trimmed;
  let text = trimmed.text;
  while (text.length > 0 && utf8Bytes(JSON.stringify({ ...trimmed, text })) > MAX_MESSAGE_BYTES) {
    text = text.slice(0, Math.floor(text.length / 2));
  }
  return { ...trimmed, text };
}

function toStoredMessage(raw: unknown, index: number): StoredChatMessage | null {
  if (!isPlainObject(raw)) return null;
  // Never persist a failed or retryable bubble: only completed turns are saved.
  if (raw.error === true) return null;
  const author = raw.author === "user" || raw.author === "assistant" ? raw.author : null;
  if (!author) return null;

  const text = clampText(raw.text);
  const image = asImagePlaceholder(raw.imageUrl ?? raw.image);
  const diagnosis = asDiagnosis(raw.diagnosis);
  const preprocessing = asPreprocessing(raw.preprocessing);
  if (!text && !image && !diagnosis) return null;

  const message: StoredChatMessage = {
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `restored-${index}`,
    author,
    text,
  };
  if (image) message.image = image;
  if (diagnosis) message.diagnosis = diagnosis;
  const source = asSource(raw.source);
  if (source) message.source = source;
  const analysisSource = asAnalysisSource(raw.analysisSource);
  if (analysisSource) message.analysisSource = analysisSource;
  if (preprocessing) message.preprocessing = preprocessing;
  return shrinkMessage(message);
}

/**
 * Normalizes an untrusted list of turns into what may be persisted (or shown
 * back): last {@link MAX_MESSAGES} turns, completed messages only, trimmed text,
 * no images, no oversized payload. Accepts live view messages (`imageUrl`) as
 * well as previously stored ones (`image`), so the same rules apply on the way
 * in and on the way out.
 */
export function sanitizeChatHistory(input: unknown): StoredChatMessage[] {
  if (!Array.isArray(input)) return [];
  const kept: StoredChatMessage[] = [];
  const window = input.slice(-MAX_MESSAGES);
  for (let index = 0; index < window.length; index += 1) {
    const message = toStoredMessage(window[index], index);
    if (message) kept.push(message);
  }
  // Byte ceiling: drop the oldest turns until the serialized payload fits.
  while (kept.length > 1 && utf8Bytes(JSON.stringify(kept)) > MAX_PAYLOAD_BYTES) kept.shift();
  return kept;
}

/** The exact JSON string that is stored (localStorage and the Firestore `data` field). */
export function serializeChatHistory(input: unknown, now: Date = new Date()): string | null {
  const messages = sanitizeChatHistory(input);
  if (messages.length === 0) return null;
  const payload: ChatHistoryPayload = {
    version: CHAT_HISTORY_VERSION,
    updatedAt: now.toISOString(),
    messages,
  };
  return JSON.stringify(payload);
}

/** Reads a stored payload back. Anything malformed, unknown or empty reads as `[]`. */
export function parseChatHistory(raw: string | null | undefined): StoredChatMessage[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return [];
    if (parsed.version !== CHAT_HISTORY_VERSION) return [];
    return sanitizeChatHistory(parsed.messages);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Scope resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Which store this session may use.
 *
 * `remote` requires a uid that came from the verified Firebase Auth session
 * (`historyStore.ts` reads it from the SDK, never from a caller) AND a usable
 * Firestore SDK. Everything else — guest, on-device demo account, unconfigured
 * Firebase, SSR — is local-only, so a guest can never cause a Firestore write.
 *
 * `localKey` only namespaces the localStorage fallback; it can never influence
 * the Firestore path, which is why a hostile value here changes nothing.
 */
export function chatHistoryScope(session: ChatHistorySession, localKey: string | null | undefined): ChatHistoryScope {
  const uid = typeof session.uid === "string" ? session.uid.trim() : "";
  if (uid && session.firestoreReady) return { kind: "remote", uid };
  const key = typeof localKey === "string" && localKey.trim().length > 0 ? localKey.trim() : GUEST_LOCAL_KEY;
  return { kind: "local", key };
}

/* ------------------------------------------------------------------ */
/*  Injected I/O                                                       */
/* ------------------------------------------------------------------ */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChatHistoryIO {
  readLocal(key: string): ChatHistoryRead;
  writeLocal(key: string, raw: string): void;
  removeLocal(key: string): void;
  readRemote(uid: string): Promise<ChatHistoryRead>;
  writeRemote(uid: string, raw: string): Promise<void>;
  removeRemote(uid: string): Promise<void>;
}

/** localStorage half of the I/O — SSR-safe, quota-safe, never throws. */
export function createLocalIO(storage: StorageLike | null): Pick<ChatHistoryIO, "readLocal" | "writeLocal" | "removeLocal"> {
  return {
    readLocal(key) {
      if (!storage) return { ok: false, raw: null };
      try {
        return { ok: true, raw: storage.getItem(LOCAL_HISTORY_PREFIX + key) };
      } catch {
        return { ok: false, raw: null };
      }
    },
    writeLocal(key, raw) {
      if (!storage) return;
      try {
        storage.setItem(LOCAL_HISTORY_PREFIX + key, raw);
      } catch {
        /* quota or private mode: history is simply not persisted */
      }
    },
    removeLocal(key) {
      if (!storage) return;
      try {
        storage.removeItem(LOCAL_HISTORY_PREFIX + key);
      } catch {
        /* storage unavailable: nothing to remove */
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Orchestration                                                      */
/* ------------------------------------------------------------------ */

/** Loads + validates the stored conversation. Never throws; `ok: false` on failure. */
export async function loadPersistedChatHistory(
  io: ChatHistoryIO,
  scope: ChatHistoryScope,
): Promise<ChatHistoryLoad> {
  try {
    const read = scope.kind === "remote" ? await io.readRemote(scope.uid) : io.readLocal(scope.key);
    return { ok: read.ok, messages: read.ok ? parseChatHistory(read.raw) : [] };
  } catch {
    return { ok: false, messages: [] };
  }
}

/**
 * Persists the completed conversation. An empty result CLEARS the store instead
 * of writing an empty document. Never throws.
 */
export async function savePersistedChatHistory(
  io: ChatHistoryIO,
  scope: ChatHistoryScope,
  messages: unknown,
): Promise<void> {
  try {
    const raw = serializeChatHistory(messages);
    if (scope.kind === "remote") {
      if (raw) await io.writeRemote(scope.uid, raw);
      else await io.removeRemote(scope.uid);
    } else if (raw) {
      io.writeLocal(scope.key, raw);
    } else {
      io.removeLocal(scope.key);
    }
  } catch {
    /* a failed save must never disturb the conversation */
  }
}

/** Removes the stored conversation for this scope. Never throws. */
export async function clearPersistedChatHistory(io: ChatHistoryIO, scope: ChatHistoryScope): Promise<void> {
  try {
    if (scope.kind === "remote") await io.removeRemote(scope.uid);
    else io.removeLocal(scope.key);
  } catch {
    /* nothing to clear or nothing reachable */
  }
}
