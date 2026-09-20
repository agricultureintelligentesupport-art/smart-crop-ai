import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { db } from "../firebase";
import { getWilaya } from "../wilayas";
import { logAuthError, logAuthInfo } from "./logging";
import type { AuthRole } from "./types";

/**
 * Reliable Firestore profile sync for `users/{uid}`.
 *
 * Called after EVERY successful real sign-in — the Google popup path, the
 * Google redirect path (`getRedirectResult`) and the Firebase adapter's
 * gateway method — so the document is created/refreshed no matter how the
 * user got in.
 *
 * Guarantees:
 * - reads the existing document and merges, never clobbers a role/wilaya the
 *   user already picked,
 * - retries transient failures (first-boot offline, flaky network, quota
 *   blips) with a short backoff,
 * - never throws: it returns `{ ok, data, error }` and logs every attempt
 *   (including the underlying Firebase code) so a final failure is diagnosable
 *   from the console without blocking the user's session.
 */

export interface UserDocInput {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  photoURL?: string | null;
}

export interface UserDocPatch {
  role?: AuthRole | null;
  wilayaCode?: string | null;
  preferredCrop?: string | null;
  createdAt?: string;
  lastLoginAt?: string;
}

export interface UserDocData {
  uid: string;
  displayName?: string;
  email?: string;
  photoURL?: string | null;
  role?: AuthRole | null;
  wilaya?: string | null;
  wilayaCode?: string | null;
  preferredCrop?: string | null;
  createdAt?: string;
  lastLoginAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface UserDocResult {
  ok: boolean;
  /** Merged profile data (existing document ∪ new values). */
  data: UserDocData;
  error?: unknown;
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200];

function isFirestoreReady(firestore: Firestore): boolean {
  return Boolean(firestore && (firestore as unknown as { app?: unknown }).app);
}

/**
 * @param firestore injectable for unit tests; defaults to the app database.
 */
export async function syncUserDoc(
  input: UserDocInput,
  patch: UserDocPatch = {},
  firestore: Firestore = db,
): Promise<UserDocResult> {
  if (!isFirestoreReady(firestore)) {
    // Demo / SSR environment: nothing to persist — the local profile
    // (see profile.ts) already carries the session.
    logAuthInfo("userDoc", `Firestore not ready — skipped users/${input.uid} sync (demo or SSR environment).`);
    return { ok: true, data: { uid: input.uid } };
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const ref = doc(firestore, "users", input.uid);
      const data = await readAndMerge(ref, firestore, input, patch);
      if (attempt > 1) logAuthInfo("userDoc", `users/${input.uid} saved on attempt ${attempt}/${MAX_ATTEMPTS}.`);
      return { ok: true, data };
    } catch (error) {
      lastError = error;
      logAuthError(`userDoc users/${input.uid} (attempt ${attempt}/${MAX_ATTEMPTS})`, error);
      const backoff = BACKOFF_MS[attempt - 1];
      if (backoff) await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  return { ok: false, data: { uid: input.uid }, error: lastError };
}

async function readAndMerge(
  ref: ReturnType<typeof doc>,
  firestore: Firestore,
  input: UserDocInput,
  patch: UserDocPatch,
): Promise<UserDocData> {
  const snap = await getDoc(ref);
  const existing = (snap.exists() ? snap.data() : {}) as Partial<UserDocData>;

  // Keep the wilaya the user already chose; only apply the patch when the
  // caller actually carries a value (null means "not picked yet").
  const wilayaCode: string | null =
    patch.wilayaCode ?? (existing.wilayaCode ?? existing.wilaya ?? null);
  const wilayaData = wilayaCode ? getWilaya(wilayaCode) : null;
  const preferredCrop: string | null =
    patch.preferredCrop ?? (existing.preferredCrop ?? wilayaData?.crops?.[0] ?? null);

  const data: UserDocData = {
    uid: input.uid,
    displayName: input.displayName ?? existing.displayName ?? "",
    email: input.email ?? existing.email ?? "",
    photoURL: input.photoURL ?? existing.photoURL ?? null,
    role: patch.role !== undefined ? (patch.role ?? null) : (existing.role ?? null),
    wilaya: wilayaCode,
    wilayaCode,
    preferredCrop,
    updatedAt: new Date().toISOString(),
  };
  const createdAt = existing.createdAt ?? patch.createdAt;
  if (createdAt) data.createdAt = createdAt;
  if (patch.lastLoginAt) data.lastLoginAt = patch.lastLoginAt;

  await setDoc(ref, data, { merge: true });
  return data;
}
