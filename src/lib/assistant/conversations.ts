/**
 * PhytoScan AI — multi-conversation history (storage layer only).
 *
 * `history.ts` already owns the rules for a SINGLE stored conversation
 * (sanitizing, capping, encoding, where it may live). This module builds the
 * multi-conversation model on top of those exact rules — nothing about what
 * may be persisted changes, only *how many* conversations and *which one* is
 * open right now.
 *
 * STORAGE SHAPE
 * -------------
 * Two kinds of record, both reusing {@link ChatHistoryScope} from `history.ts`
 * (so the remote-vs-local decision, and the uid it comes from, are the exact
 * same verified-session logic that already shipped and is already tested):
 *
 *   • an INDEX — `{ version, activeId, conversations: [{id, title, updatedAt}] }`
 *     — metadata only, so the conversation LIST can be loaded without ever
 *     reading a single message body. It lives at the *same* location the
 *     single-conversation feature already used (`assistantChats/{uid}` for a
 *     member, the existing localStorage slot for a guest) — see
 *     {@link loadConversationIndex} for the one-time legacy import.
 *   • a CONVERSATION DOCUMENT per id — `{ version, title, updatedAt, data }`,
 *     where `data` is exactly the string `history.ts#serializeChatHistory`
 *     already produces (same caps, same sanitizing, same “no photos, no
 *     failed bubbles” rules). Only fetched when that conversation is opened.
 *
 * CAPS
 * ----
 * At most {@link MAX_CONVERSATIONS} conversations survive a save — the oldest
 * (by `updatedAt`) are dropped first, mirroring how `history.ts` drops the
 * oldest MESSAGES once a conversation itself is too large. Title length is
 * capped by {@link TITLE_MAX_CHARS}.
 *
 * Every function here is pure over an injected {@link ConversationsIO} and
 * never throws — a failed read/write degrades to "nothing changed", exactly
 * like the single-conversation module it sits on top of.
 */

import {
  IMAGE_PLACEHOLDER,
  parseChatHistory,
  sanitizeChatHistory,
  serializeChatHistory,
  type ChatHistoryRead,
  type ChatHistoryScope,
  type StoredChatMessage,
} from "./history";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Shape version for the lightweight list ({@link ConversationIndexPayload}). */
export const CONVERSATIONS_INDEX_VERSION = 2;
/** Shape version for one conversation document ({@link ConversationDocPayload}). */
export const CONVERSATION_DOC_VERSION = 2;
/** At most this many conversations are kept — the oldest are dropped first. */
export const MAX_CONVERSATIONS = 30;
/** Longest auto-derived/renamed title kept (characters, not bytes). */
export const TITLE_MAX_CHARS = 40;
/** Used only when a conversation document exists but carries no usable title. */
export const DEFAULT_CONVERSATION_TITLE = "محادثة جديدة";
/** localStorage namespace for a guest's per-conversation documents (the INDEX reuses `history.ts`'s existing slot). */
export const LOCAL_CONVERSATIONS_DOC_PREFIX = "smart-crop.assistant.conversations.doc.v1.";

/* ------------------------------------------------------------------ */
/*  Shapes                                                             */
/* ------------------------------------------------------------------ */

export interface ConversationMeta {
  id: string;
  title: string;
  /** ISO timestamp of the conversation's own last activity (never bumped by a rename). */
  updatedAt: string;
}

export interface StoredConversation {
  id: string;
  title: string;
  updatedAt: string;
  messages: StoredChatMessage[];
}

export interface ConversationIndexPayload {
  version: number;
  activeId: string | null;
  conversations: ConversationMeta[];
}

interface ConversationDocPayload {
  version: number;
  title: string;
  updatedAt: string;
  data: string | null;
}

/* ------------------------------------------------------------------ */
/*  Titles                                                             */
/* ------------------------------------------------------------------ */

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Trims a title to {@link TITLE_MAX_CHARS}, collapsing internal whitespace/newlines. */
export function truncateTitle(value: unknown, max: number = TITLE_MAX_CHARS): string {
  if (typeof value !== "string") return "";
  const clean = collapseWhitespace(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}

/**
 * A conversation's display title: the first USER turn, trimmed to
 * {@link TITLE_MAX_CHARS} — or the «صورة» placeholder when that turn was a
 * photo with no caption. Falls back to {@link DEFAULT_CONVERSATION_TITLE}
 * only when there is no user turn at all (should not happen for a saved
 * conversation, since one is only ever created on the first sent message).
 */
export function deriveConversationTitle(
  input: unknown,
  fallback: string = DEFAULT_CONVERSATION_TITLE,
): string {
  const messages = Array.isArray(input) ? sanitizeChatHistory(input) : [];
  const firstUser = messages.find((message) => message.author === "user");
  if (!firstUser) return fallback;
  if (firstUser.text && firstUser.text.trim().length > 0) return truncateTitle(firstUser.text);
  if (firstUser.image) return IMAGE_PLACEHOLDER;
  return fallback;
}

/* ------------------------------------------------------------------ */
/*  Ids                                                                */
/* ------------------------------------------------------------------ */

let idSequence = 0;

/** A new, locally-unique conversation id (timestamp + a per-process counter + noise). */
export function makeConversationId(now: number = Date.now()): string {
  idSequence += 1;
  const noise = Math.random().toString(36).slice(2, 8);
  return `conv-${now}-${idSequence}-${noise}`;
}

/* ------------------------------------------------------------------ */
/*  Ordering, capping, grouping                                        */
/* ------------------------------------------------------------------ */

function parsedTime(value: string): number {
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
}

/** Newest activity first. */
export function sortConversationsByRecency(list: ConversationMeta[]): ConversationMeta[] {
  return [...list].sort((a, b) => parsedTime(b.updatedAt) - parsedTime(a.updatedAt));
}

/** Keeps the {@link MAX_CONVERSATIONS} most recently active conversations; the rest are reported as `dropped`. */
export function capConversationMetas(
  list: ConversationMeta[],
  max: number = MAX_CONVERSATIONS,
): { kept: ConversationMeta[]; dropped: ConversationMeta[] } {
  const sorted = sortConversationsByRecency(list);
  return { kept: sorted.slice(0, max), dropped: sorted.slice(max) };
}

export type RecencyGroupKey = "today" | "yesterday" | "week" | "older";

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Which recency bucket a timestamp falls into, relative to `now` (local calendar days). */
export function recencyGroupKey(updatedAt: string, now: Date = new Date()): RecencyGroupKey {
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return "older";
  const dayDiff = Math.round((startOfDay(now) - startOfDay(new Date(ts))) / 86_400_000);
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "yesterday";
  if (dayDiff <= 7) return "week";
  return "older";
}

export interface ConversationGroup {
  key: RecencyGroupKey;
  items: ConversationMeta[];
}

/** Buckets conversations into اليوم / أمس / آخر 7 أيام / أقدم (newest first within each). Empty buckets are omitted. */
export function groupConversationsByRecency(
  list: ConversationMeta[],
  now: Date = new Date(),
): ConversationGroup[] {
  const sorted = sortConversationsByRecency(list);
  const order: RecencyGroupKey[] = ["today", "yesterday", "week", "older"];
  const buckets: Record<RecencyGroupKey, ConversationMeta[]> = { today: [], yesterday: [], week: [], older: [] };
  for (const meta of sorted) buckets[recencyGroupKey(meta.updatedAt, now)].push(meta);
  return order.map((key) => ({ key, items: buckets[key] })).filter((group) => group.items.length > 0);
}

/* ------------------------------------------------------------------ */
/*  Encoding / decoding                                                */
/* ------------------------------------------------------------------ */

/** The exact string stored for one conversation, or `null` when there is nothing worth keeping. */
export function serializeConversation(
  titleHint: unknown,
  messages: unknown,
  now: Date = new Date(),
): string | null {
  const data = serializeChatHistory(messages, now);
  if (!data) return null;
  const sanitizedMessages = parseChatHistory(data);
  const title = typeof titleHint === "string" && titleHint.trim().length > 0
    ? truncateTitle(titleHint)
    : deriveConversationTitle(sanitizedMessages);
  const payload: ConversationDocPayload = {
    version: CONVERSATION_DOC_VERSION,
    title,
    updatedAt: now.toISOString(),
    data,
  };
  return JSON.stringify(payload);
}

/** Reads a conversation document back. Anything malformed/unknown-version reads as `null` (never throws). */
export function parseConversationDoc(
  raw: string | null | undefined,
): { title: string; updatedAt: string; messages: StoredChatMessage[] } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const payload = parsed as Partial<ConversationDocPayload>;
    if (payload.version !== CONVERSATION_DOC_VERSION) return null;
    const messages = parseChatHistory(typeof payload.data === "string" ? payload.data : null);
    const title = typeof payload.title === "string" && payload.title.trim().length > 0
      ? truncateTitle(payload.title)
      : deriveConversationTitle(messages);
    const updatedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : new Date(0).toISOString();
    return { title, updatedAt, messages };
  } catch {
    return null;
  }
}

/** The exact string stored for the index (metadata only — never a message body). */
export function serializeConversationIndex(
  activeId: string | null,
  conversations: ConversationMeta[],
): string {
  const { kept } = capConversationMetas(conversations);
  const payload: ConversationIndexPayload = {
    version: CONVERSATIONS_INDEX_VERSION,
    activeId: activeId !== null && kept.some((meta) => meta.id === activeId) ? activeId : null,
    conversations: kept,
  };
  return JSON.stringify(payload);
}

/** Reads the index back. Returns `null` for anything that is not THIS shape (legacy payloads included — see {@link loadConversationIndex}). */
export function parseConversationIndex(raw: string | null | undefined): ConversationIndexPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const payload = parsed as Partial<ConversationIndexPayload>;
    if (payload.version !== CONVERSATIONS_INDEX_VERSION || !Array.isArray(payload.conversations)) return null;
    const conversations: ConversationMeta[] = [];
    for (const item of payload.conversations) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      const title = (item as { title?: unknown }).title;
      const updatedAt = (item as { updatedAt?: unknown }).updatedAt;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof title !== "string" || typeof updatedAt !== "string") continue;
      conversations.push({ id, title: truncateTitle(title), updatedAt });
    }
    const { kept } = capConversationMetas(conversations);
    const activeId = typeof payload.activeId === "string" && kept.some((meta) => meta.id === payload.activeId)
      ? (payload.activeId as string)
      : null;
    return { version: CONVERSATIONS_INDEX_VERSION, activeId, conversations: kept };
  } catch {
    return null;
  }
}

/** Builds the first conversation out of a pre-existing single-conversation transcript. `null` when there is nothing to import. */
export function importLegacyConversation(messages: unknown, now: Date = new Date()): StoredConversation | null {
  const sanitized = sanitizeChatHistory(messages);
  if (sanitized.length === 0) return null;
  return {
    id: makeConversationId(now.getTime()),
    title: deriveConversationTitle(sanitized),
    updatedAt: now.toISOString(),
    messages: sanitized,
  };
}

/* ------------------------------------------------------------------ */
/*  Injected I/O                                                       */
/* ------------------------------------------------------------------ */

export interface ConversationsIO {
  readIndexLocal(key: string): ChatHistoryRead;
  writeIndexLocal(key: string, raw: string): void;
  removeIndexLocal(key: string): void;
  readConversationLocal(key: string, id: string): ChatHistoryRead;
  writeConversationLocal(key: string, id: string, raw: string): void;
  removeConversationLocal(key: string, id: string): void;

  readIndexRemote(uid: string): Promise<ChatHistoryRead>;
  writeIndexRemote(uid: string, raw: string): Promise<void>;
  removeIndexRemote(uid: string): Promise<void>;
  readConversationRemote(uid: string, id: string): Promise<ChatHistoryRead>;
  writeConversationRemote(uid: string, id: string, raw: string): Promise<void>;
  removeConversationRemote(uid: string, id: string): Promise<void>;
}

async function readIndexRaw(io: ConversationsIO, scope: ChatHistoryScope): Promise<ChatHistoryRead> {
  try {
    return scope.kind === "remote" ? await io.readIndexRemote(scope.uid) : io.readIndexLocal(scope.key);
  } catch {
    return { ok: false, raw: null };
  }
}

async function writeIndexRaw(io: ConversationsIO, scope: ChatHistoryScope, raw: string): Promise<void> {
  try {
    if (scope.kind === "remote") await io.writeIndexRemote(scope.uid, raw);
    else io.writeIndexLocal(scope.key, raw);
  } catch {
    /* a failed save must never disturb the conversation list */
  }
}

async function removeIndexRaw(io: ConversationsIO, scope: ChatHistoryScope): Promise<void> {
  try {
    if (scope.kind === "remote") await io.removeIndexRemote(scope.uid);
    else io.removeIndexLocal(scope.key);
  } catch {
    /* nothing to clear or nothing reachable */
  }
}

async function readConversationRaw(io: ConversationsIO, scope: ChatHistoryScope, id: string): Promise<ChatHistoryRead> {
  try {
    return scope.kind === "remote" ? await io.readConversationRemote(scope.uid, id) : io.readConversationLocal(scope.key, id);
  } catch {
    return { ok: false, raw: null };
  }
}

async function writeConversationRaw(io: ConversationsIO, scope: ChatHistoryScope, id: string, raw: string): Promise<void> {
  try {
    if (scope.kind === "remote") await io.writeConversationRemote(scope.uid, id, raw);
    else io.writeConversationLocal(scope.key, id, raw);
  } catch {
    /* a failed save must never disturb the conversation */
  }
}

async function removeConversationRaw(io: ConversationsIO, scope: ChatHistoryScope, id: string): Promise<void> {
  try {
    if (scope.kind === "remote") await io.removeConversationRemote(scope.uid, id);
    else io.removeConversationLocal(scope.key, id);
  } catch {
    /* nothing to clear or nothing reachable */
  }
}

/* ------------------------------------------------------------------ */
/*  Orchestration                                                       */
/* ------------------------------------------------------------------ */

export interface ConversationIndexLoad {
  ok: boolean;
  activeId: string | null;
  conversations: ConversationMeta[];
  /** True exactly once: the legacy single-conversation payload was just imported as the first conversation. */
  migrated: boolean;
}

/**
 * Loads the conversation list (titles/metadata only).
 *
 * Backward compatibility: the index lives at the exact spot the OLD
 * single-conversation feature used. The first time that spot is read and it
 * is still in the old shape (`{version:1, updatedAt, messages}` from
 * `history.ts`), those messages become the first conversation — written once
 * to its own new document — and the spot is rewritten as the new index. Every
 * later read simply sees the new shape.
 *
 * Never throws; `ok:false` means unreadable (caller must not overwrite it).
 */
export async function loadConversationIndex(
  io: ConversationsIO,
  scope: ChatHistoryScope,
  now: Date = new Date(),
): Promise<ConversationIndexLoad> {
  const read = await readIndexRaw(io, scope);
  if (!read.ok) return { ok: false, activeId: null, conversations: [], migrated: false };

  const index = parseConversationIndex(read.raw);
  if (index) return { ok: true, activeId: index.activeId, conversations: index.conversations, migrated: false };

  // Not the new shape yet — see if it is the legacy single-conversation payload.
  const legacyMessages = parseChatHistory(read.raw);
  const imported = importLegacyConversation(legacyMessages, now);
  if (!imported) {
    // Brand-new identity (or genuinely empty/corrupt legacy data): nothing to migrate.
    return { ok: true, activeId: null, conversations: [], migrated: false };
  }

  const conversationRaw = serializeConversation(imported.title, imported.messages, now);
  if (conversationRaw) await writeConversationRaw(io, scope, imported.id, conversationRaw);
  const meta: ConversationMeta = { id: imported.id, title: imported.title, updatedAt: imported.updatedAt };
  await writeIndexRaw(io, scope, serializeConversationIndex(imported.id, [meta]));
  return { ok: true, activeId: imported.id, conversations: [meta], migrated: true };
}

/** Loads one conversation's messages. `conversation: null` means it does not exist (not an error). */
export async function loadConversation(
  io: ConversationsIO,
  scope: ChatHistoryScope,
  id: string,
): Promise<{ ok: boolean; conversation: StoredConversation | null }> {
  const read = await readConversationRaw(io, scope, id);
  if (!read.ok) return { ok: false, conversation: null };
  const parsed = parseConversationDoc(read.raw);
  if (!parsed) return { ok: true, conversation: null };
  return { ok: true, conversation: { id, title: parsed.title, updatedAt: parsed.updatedAt, messages: parsed.messages } };
}

export interface SaveConversationResult {
  meta: ConversationMeta;
  activeId: string;
  conversations: ConversationMeta[];
}

/**
 * Persists one conversation's completed turns, then updates the index (title,
 * `updatedAt`, recency order) and enforces {@link MAX_CONVERSATIONS} — the
 * oldest overflow conversations are deleted, never the newest. An empty
 * result (no completed turns) saves NOTHING and returns `null`: a conversation
 * is only ever created once it actually holds something.
 */
export async function saveConversation(
  io: ConversationsIO,
  scope: ChatHistoryScope,
  id: string,
  titleHint: string | undefined,
  messages: unknown,
  currentIndex: { activeId: string | null; conversations: ConversationMeta[] },
  now: Date = new Date(),
): Promise<SaveConversationResult | null> {
  const raw = serializeConversation(titleHint, messages, now);
  if (!raw) return null;
  const parsed = parseConversationDoc(raw);
  if (!parsed) return null;

  await writeConversationRaw(io, scope, id, raw);
  const meta: ConversationMeta = { id, title: parsed.title, updatedAt: parsed.updatedAt };
  const withoutThis = currentIndex.conversations.filter((item) => item.id !== id);
  const { kept, dropped } = capConversationMetas([meta, ...withoutThis]);
  for (const stale of dropped) await removeConversationRaw(io, scope, stale.id);

  await writeIndexRaw(io, scope, serializeConversationIndex(id, kept));
  return { meta, activeId: id, conversations: kept };
}

/** Renames a conversation (title only — `updatedAt`/recency order is untouched). `null` when the id is unknown or the title is empty. */
export async function renameConversation(
  io: ConversationsIO,
  scope: ChatHistoryScope,
  id: string,
  rawTitle: unknown,
  currentIndex: { activeId: string | null; conversations: ConversationMeta[] },
): Promise<ConversationMeta[] | null> {
  const title = truncateTitle(rawTitle);
  if (!title) return null;
  if (!currentIndex.conversations.some((item) => item.id === id)) return null;

  const conversations = currentIndex.conversations.map((item) => (item.id === id ? { ...item, title } : item));
  await writeIndexRaw(io, scope, serializeConversationIndex(currentIndex.activeId, conversations));

  // Best-effort: keep the conversation document's own title field in sync too.
  const read = await readConversationRaw(io, scope, id);
  const doc = read.ok ? parseConversationDoc(read.raw) : null;
  if (doc) {
    const patched: ConversationDocPayload = {
      version: CONVERSATION_DOC_VERSION,
      title,
      updatedAt: doc.updatedAt,
      data: serializeChatHistory(doc.messages, new Date(doc.updatedAt)),
    };
    await writeConversationRaw(io, scope, id, JSON.stringify(patched));
  }
  return conversations;
}

/** Deletes one conversation and drops it from the index. Clears `activeId` if it was the active one. */
export async function deleteConversation(
  io: ConversationsIO,
  scope: ChatHistoryScope,
  id: string,
  currentIndex: { activeId: string | null; conversations: ConversationMeta[] },
): Promise<{ activeId: string | null; conversations: ConversationMeta[] }> {
  await removeConversationRaw(io, scope, id);
  const conversations = currentIndex.conversations.filter((item) => item.id !== id);
  const activeId = currentIndex.activeId === id ? null : currentIndex.activeId;
  await writeIndexRaw(io, scope, serializeConversationIndex(activeId, conversations));
  return { activeId, conversations };
}

/** Deletes every conversation and the index itself (also clears a not-yet-migrated legacy payload at that spot). */
export async function deleteAllConversations(
  io: ConversationsIO,
  scope: ChatHistoryScope,
  currentIndex: { conversations: ConversationMeta[] },
): Promise<void> {
  for (const item of currentIndex.conversations) await removeConversationRaw(io, scope, item.id);
  await removeIndexRaw(io, scope);
}

/** Persists which conversation is open, so a reload restores the same one. Silently ignored for an unknown id. */
export async function setActiveConversationId(
  io: ConversationsIO,
  scope: ChatHistoryScope,
  id: string | null,
  currentIndex: { conversations: ConversationMeta[] },
): Promise<void> {
  if (id !== null && !currentIndex.conversations.some((item) => item.id === id)) return;
  await writeIndexRaw(io, scope, serializeConversationIndex(id, currentIndex.conversations));
}

/* ------------------------------------------------------------------ */
/*  View-layer helper                                                  */
/* ------------------------------------------------------------------ */

/**
 * Tags every item as restored (`isRestored: true`) so a UI message component
 * can skip its entrance/typewriter/result animation for turns that were
 * already on screen before — only a freshly produced reply should ever
 * animate. Pure and generic: the view owns the actual message shape.
 */
export function markRestored<T extends object>(items: readonly T[]): (T & { isRestored: true })[] {
  return items.map((item) => ({ ...item, isRestored: true as const }));
}
