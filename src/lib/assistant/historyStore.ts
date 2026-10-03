/**
 * PhytoScan AI — chat-history persistence: the browser/Firestore plumbing.
 *
 * `history.ts` owns the rules (what may be stored, how much, how to encode it);
 * this file only wires the two real stores to them:
 *
 *   • Firestore `assistantChats/{uid}` for a VERIFIED Firebase Auth session —
 *     the uid is read from the SDK's own session (`auth.currentUser.uid`), never
 *     from a caller, a prop or a request body, and the Firestore security rules
 *     are the server-side authority that keeps every document owner-only;
 *   • `localStorage` for guests, on-device demo accounts and unconfigured
 *     Firebase — no Firestore call is ever made from those sessions.
 *
 * A read that cannot complete (`ok: false`) leaves persistence off for that
 * session instead of risking an overwrite of a transcript we could not read.
 * Every failure is silent: nothing here throws, warns or touches the chat UI.
 */

"use client";

import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { auth, db, isAuthReady, isFirestoreReady } from "@/lib/firebase";
import {
  CHAT_HISTORY_COLLECTION,
  CHAT_HISTORY_VERSION,
  chatHistoryScope,
  clearPersistedChatHistory,
  createLocalIO,
  loadPersistedChatHistory,
  savePersistedChatHistory,
  type ChatHistoryIO,
  type ChatHistoryLoad,
  type ChatHistoryRead,
  type ChatHistoryScope,
  type StorageLike,
} from "./history";

/** How long a Firestore read may hold up hydration before it is treated as failed. */
const REMOTE_READ_CEILING_MS = 6000;

/** Resolves `work`, or `fallback` after `ms` — a hanging read must not hang the screen. */
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

/** uid of the verified Firebase session, or null (guest, demo account, SSR). */
function verifiedFirebaseUid(): string | null {
  if (!isAuthReady(auth)) return null;
  const uid = auth.currentUser?.uid;
  return typeof uid === "string" && uid.length > 0 ? uid : null;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage disabled (private mode, blocked cookies)
  }
}

async function readRemote(uid: string): Promise<ChatHistoryRead> {
  if (!isFirestoreReady()) return { ok: false, raw: null };
  try {
    const snapshot = await getDoc(doc(db, CHAT_HISTORY_COLLECTION, uid));
    if (!snapshot.exists()) return { ok: true, raw: null };
    const stored = snapshot.data() as { data?: unknown } | undefined;
    return { ok: true, raw: typeof stored?.data === "string" ? stored.data : null };
  } catch {
    return { ok: false, raw: null };
  }
}

function createIO(): ChatHistoryIO {
  return {
    ...createLocalIO(browserStorage()),
    readRemote(uid) {
      return withCeiling(readRemote(uid), { ok: false, raw: null }, REMOTE_READ_CEILING_MS);
    },
    async writeRemote(uid, raw) {
      if (!isFirestoreReady()) return;
      await setDoc(doc(db, CHAT_HISTORY_COLLECTION, uid), {
        version: CHAT_HISTORY_VERSION,
        updatedAt: new Date().toISOString(),
        data: raw,
      });
    },
    async removeRemote(uid) {
      if (!isFirestoreReady()) return;
      await deleteDoc(doc(db, CHAT_HISTORY_COLLECTION, uid));
    },
  };
}

/** The store this session is allowed to use. `localKey` namespaces localStorage only. */
export function currentChatHistoryScope(localKey: string | null): ChatHistoryScope {
  return chatHistoryScope({ uid: verifiedFirebaseUid(), firestoreReady: isFirestoreReady() }, localKey);
}

/**
 * Restores the signed-in user's conversation.
 *
 * @param localKey per-identity localStorage bucket (profile uid or guest);
 *                 it never addresses Firestore — the verified session does that.
 * @returns `{ ok, messages }`; `ok: false` means “could not read”, and the
 *          caller must not start saving over a transcript it could not read.
 */
export async function loadChatHistory(localKey: string | null): Promise<ChatHistoryLoad> {
  return loadPersistedChatHistory(createIO(), currentChatHistoryScope(localKey));
}

/** Saves the completed turns (fire-and-forget; an empty list clears the store). */
export async function saveChatHistory(localKey: string | null, messages: unknown): Promise<void> {
  await savePersistedChatHistory(createIO(), currentChatHistoryScope(localKey), messages);
}

/** Clears the stored conversation. */
export async function clearChatHistory(localKey: string | null): Promise<void> {
  await clearPersistedChatHistory(createIO(), currentChatHistoryScope(localKey));
}
