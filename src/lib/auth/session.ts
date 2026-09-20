/**
 * Session isolation helpers — pure and unit-testable.
 *
 * The bug this fixes: signing in with a different Google account kept showing
 * the PREVIOUS user's profile, because the wizard merged the cached on-device
 * profile (`smart-crop.profile.v1`) and device prefs into the new session, and
 * sign-out left that cache behind for the next account to inherit.
 *
 * The rules, enforced by `useAuthFlow` and `AuthContext`:
 *   1. Sign-out wipes the whole local cache (`clearAllLocalCache`) and every
 *      sign-out path resets its in-memory user state to the Step-1 defaults.
 *   2. A fresh session is only ever merged with cached values that belong to
 *      the SAME uid (`resolveSessionBinding`); on an account switch the cached
 *      identity is discarded and the profile resolves strictly from the
 *      Firestore-backed session (`users/{uid}`).
 *
 * NOTE: value-import free on purpose (only `import type`), so plain
 * `node --test` can load this module with no browser and no path aliases.
 */

import type { DevicePrefs, StoredProfile } from "./profile";
import type { SessionUser } from "./types";

/** Same-tab sync event `useProfile()` listens to (mirrors profile.ts). */
export const PROFILE_SYNC_EVENT = "smart-crop:profile";

/** Device UI preference, not identity: the one key that survives the wipe. */
const LANG_KEY = "smart-crop.lang.v1";

/**
 * Complete local cache wipe for sign-out.
 *
 * Drops everything `localStorage` and `sessionStorage` hold — the stored
 * profile, device prefs, on-device demo users, Firebase redirect leftovers —
 * so the next account starts from a clean slate and can never inherit this
 * identity. The UI language is restored afterwards (it is a device
 * preference, not profile data, and keeping it avoids a jarring reset).
 *
 * Also dispatches the profile sync event, so every mounted `useProfile()`
 * drops its React state to `null` even when the caller forgets an explicit
 * hook reset. Never throws; a no-op without `window` (SSR).
 */
export function clearAllLocalCache(): void {
  if (typeof window === "undefined") return;
  let lang: string | null = null;
  try {
    lang = window.localStorage.getItem(LANG_KEY);
  } catch {
    /* unreadable storage: nothing to preserve */
  }
  try {
    window.localStorage.clear();
  } catch {
    /* private mode / blocked storage: session stays in memory only */
  }
  try {
    window.sessionStorage.clear();
  } catch {
    /* private mode / blocked storage */
  }
  if (lang === "ar" || lang === "fr") {
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* private mode / blocked storage */
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(PROFILE_SYNC_EVENT));
  } catch {
    /* event dispatch unavailable */
  }
}

/**
 * True when `nextUid` belongs to a different signed-in user than the cached
 * profile. Guest records (no uid) never count as a switch: a guest upgrading
 * to a real account keeps their on-device choices (wilaya, role).
 */
export function isSwitchingAccounts(
  previous: StoredProfile | null,
  nextUid: string | null | undefined,
): boolean {
  if (!previous || previous.isGuest) return false;
  if (!previous.uid || !nextUid) return false;
  return previous.uid !== nextUid;
}

export interface SessionBinding {
  role: SessionUser["role"];
  wilayaCode: SessionUser["wilayaCode"];
  /** True when the cached identity was discarded (account switch). */
  uidChanged: boolean;
}

/**
 * Strict UID-bound profile resolution for a freshly authenticated session.
 *
 * Same user (or guest upgrade): the Firestore-backed session wins, with the
 * cached profile and device prefs as fallbacks for values the document does
 * not carry yet (e.g. onboarding completed while offline).
 *
 * Different user: the cached role/wilaya are DISCARDED — the session (synced
 * from `users/{uid}` before this runs) is the sole source of truth, and a
 * brand-new user with an empty document is routed into onboarding instead of
 * silently inheriting the previous account's role + wilaya.
 */
export function resolveSessionBinding(
  session: Pick<SessionUser, "uid" | "role" | "wilayaCode">,
  previous: StoredProfile | null,
  device: DevicePrefs | null,
): SessionBinding {
  if (isSwitchingAccounts(previous, session.uid)) {
    return {
      role: session.role ?? null,
      wilayaCode: session.wilayaCode ?? null,
      uidChanged: true,
    };
  }
  return {
    role: session.role ?? previous?.role ?? device?.role ?? null,
    wilayaCode: session.wilayaCode ?? previous?.wilayaCode ?? device?.wilayaCode ?? null,
    uidChanged: false,
  };
}
