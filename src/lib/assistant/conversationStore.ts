/**
 * PhytoScan AI — multi-conversation history: the browser/Firestore plumbing.
 *
 * `conversations.ts` owns the rules (index shape, per-conversation shape,
 * caps, legacy import, CRUD); this file only wires the two real stores to it —
 * identically to how `historyStore.ts` wires the single-conversation rules:
 *
 *   • Firestore for a VERIFIED Firebase Auth session — the INDEX lives at the
 *     exact same document the single-conversation feature already used
 *     (`assistantChats/{uid}`), each conversation gets its own document under
 *     `assistantChats/{uid}/conversations/{id}`. The uid is read from the
 *     SDK's own session, never from a caller;
 *   • `localStorage` for guests/on-device demo accounts/unconfigured Firebase.
 *     The INDEX reuses the exact key `historyStore.ts` already used (via
 *     `createLocalIO` from `history.ts`); each conversation gets its own key
 *     under {@link LOCAL_CONVERSATIONS_DOC_PREFIX}.
 *
 * Every failure is silent, exactly like `historyStore.ts`: nothing here
 * throws, logs message text, or surfaces an error to the chat UI.
 */

"use client";

import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db, isAuthReady, isFirestoreReady } from "@/lib/firebase";
import { CHAT_HISTORY_COLLECTION, chatHistoryScope, createLocalIO, type ChatHistoryRead, type ChatHistoryScope, type StorageLike } from "./history";
import {
  LOCAL_CONVERSATIONS_DOC_PREFIX,
  deleteAllConversations as deleteAllConversationsCore,
  deleteConversation as deleteConversationCore,
  loadConversation as loadConversationCore,
  loadConversationIndex as loadConversationIndexCore,
  renameConversation as renameConversationCore,
  saveConversation as saveConversationCore,
  setActiveConversationId as setActiveConversationIdCore,
  type ConversationIndexLoad,
  type ConversationMeta,
  type ConversationsIO,
  type SaveConversationResult,
  type StoredConversation,
} from "./conversations";

/** Mirrors `historyStore.ts`'s ceiling: a hanging read must not hang the screen. */
const REMOTE_READ_CEILING_MS = 6000;

function withCeiling<T>(work: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function verifiedFirebaseUid(): string | null {
  if (!isAuthReady(auth)) return null;
  const uid = auth.currentUser?.uid;
  return typeof uid === "string" && uid.length > 0 ? uid : null;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function localConversationKey(key: string, id: string): string {
  return `${LOCAL_CONVERSATIONS_DOC_PREFIX}${key}:${id}`;
}

function readLocalRaw(storage: StorageLike | null, fullKey: string): ChatHistoryRead {
  if (!storage) return { ok: false, raw: null };
  try {
    return { ok: true, raw: storage.getItem(fullKey) };
  } catch {
    return { ok: false, raw: null };
  }
}

async function readConversationRemote(uid: string, id: string): Promise<ChatHistoryRead> {
  if (!isFirestoreReady()) return { ok: false, raw: null };
  try {
    const snapshot = await getDoc(doc(db, CHAT_HISTORY_COLLECTION, uid, "conversations", id));
    if (!snapshot.exists()) return { ok: true, raw: null };
    const stored = snapshot.data() as { raw?: unknown } | undefined;
    return { ok: true, raw: typeof stored?.raw === "string" ? stored.raw : null };
  } catch {
    return { ok: false, raw: null };
  }
}

async function readIndexRemote(uid: string): Promise<ChatHistoryRead> {
  if (!isFirestoreReady()) return { ok: false, raw: null };
  try {
    const snapshot = await getDoc(doc(db, CHAT_HISTORY_COLLECTION, uid));
    if (!snapshot.exists()) return { ok: true, raw: null };
    const stored = snapshot.data() as { data?: unknown; raw?: unknown } | undefined;
    // The legacy single-conversation doc stored its payload under `data`;
    // the new index stores its own payload under `raw` at the same path.
    const raw = typeof stored?.raw === "string" ? stored.raw : typeof stored?.data === "string" ? stored.data : null;
    return { ok: true, raw };
  } catch {
    return { ok: false, raw: null };
  }
}

function createIO(): ConversationsIO {
  const storage = browserStorage();
  const legacyLocal = createLocalIO(storage); // same key history.ts already used — reused for the index
  return {
    readIndexLocal: (key) => legacyLocal.readLocal(key),
    writeIndexLocal: (key, raw) => legacyLocal.writeLocal(key, raw),
    removeIndexLocal: (key) => legacyLocal.removeLocal(key),
    readConversationLocal: (key, id) => readLocalRaw(storage, localConversationKey(key, id)),
    writeConversationLocal: (key, id, raw) => {
      if (!storage) return;
      try {
        storage.setItem(localConversationKey(key, id), raw);
      } catch {
        /* quota or private mode: this conversation is simply not persisted */
      }
    },
    removeConversationLocal: (key, id) => {
      if (!storage) return;
      try {
        storage.removeItem(localConversationKey(key, id));
      } catch {
        /* storage unavailable: nothing to remove */
      }
    },

    readIndexRemote: (uid) => withCeiling(readIndexRemote(uid), { ok: false, raw: null }, REMOTE_READ_CEILING_MS),
    async writeIndexRemote(uid, raw) {
      if (!isFirestoreReady()) return;
      await setDoc(doc(db, CHAT_HISTORY_COLLECTION, uid), { version: 2, updatedAt: new Date().toISOString(), raw });
    },
    async removeIndexRemote(uid) {
      if (!isFirestoreReady()) return;
      await deleteDoc(doc(db, CHAT_HISTORY_COLLECTION, uid));
    },
    readConversationRemote: (uid, id) => withCeiling(readConversationRemote(uid, id), { ok: false, raw: null }, REMOTE_READ_CEILING_MS),
    async writeConversationRemote(uid, id, raw) {
      if (!isFirestoreReady()) return;
      await setDoc(doc(db, CHAT_HISTORY_COLLECTION, uid, "conversations", id), { raw });
    },
    async removeConversationRemote(uid, id) {
      if (!isFirestoreReady()) return;
      await deleteDoc(doc(db, CHAT_HISTORY_COLLECTION, uid, "conversations", id));
    },
  };
}

/** The store this session is allowed to use. `localKey` namespaces localStorage only. */
export function currentConversationsScope(localKey: string | null): ChatHistoryScope {
  return chatHistoryScope({ uid: verifiedFirebaseUid(), firestoreReady: isFirestoreReady() }, localKey);
}

/** Loads the conversation list (titles/metadata only), importing a legacy single conversation once if present. */
export async function loadConversationList(localKey: string | null): Promise<ConversationIndexLoad> {
  return loadConversationIndexCore(createIO(), currentConversationsScope(localKey));
}

/** Loads one conversation's messages. `conversation: null` means it does not exist. */
export async function loadConversationById(
  localKey: string | null,
  id: string,
): Promise<{ ok: boolean; conversation: StoredConversation | null }> {
  return loadConversationCore(createIO(), currentConversationsScope(localKey), id);
}

/** Saves the completed turns of one conversation (fire-and-forget); never creates an empty conversation. */
export async function saveConversation(
  localKey: string | null,
  id: string,
  titleHint: string | undefined,
  messages: unknown,
  currentIndex: { activeId: string | null; conversations: ConversationMeta[] },
): Promise<SaveConversationResult | null> {
  return saveConversationCore(createIO(), currentConversationsScope(localKey), id, titleHint, messages, currentIndex);
}

/** Renames a conversation. `null` when the id is unknown or the title is empty. */
export async function renameConversation(
  localKey: string | null,
  id: string,
  title: string,
  currentIndex: { activeId: string | null; conversations: ConversationMeta[] },
): Promise<ConversationMeta[] | null> {
  return renameConversationCore(createIO(), currentConversationsScope(localKey), id, title, currentIndex);
}

/** Deletes one conversation. */
export async function deleteConversation(
  localKey: string | null,
  id: string,
  currentIndex: { activeId: string | null; conversations: ConversationMeta[] },
): Promise<{ activeId: string | null; conversations: ConversationMeta[] }> {
  return deleteConversationCore(createIO(), currentConversationsScope(localKey), id, currentIndex);
}

/** Deletes every conversation. */
export async function deleteAllConversations(
  localKey: string | null,
  currentIndex: { conversations: ConversationMeta[] },
): Promise<void> {
  return deleteAllConversationsCore(createIO(), currentConversationsScope(localKey), currentIndex);
}

/** Persists which conversation is open, so a reload restores the same one. */
export async function setActiveConversationId(
  localKey: string | null,
  id: string | null,
  currentIndex: { conversations: ConversationMeta[] },
): Promise<void> {
  return setActiveConversationIdCore(createIO(), currentConversationsScope(localKey), id, currentIndex);
}
