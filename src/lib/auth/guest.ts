/**
 * Guest mode helpers — pure and testable.
 *
 * Provides a lightweight bypass for rapid testing/development without touching
 * Firebase auth. Guest state is stored in the same `smart-crop.profile.v1`
 * slot as regular sessions but is marked with `isGuest: true` and a
 * `local_guest_*` uid that survives the Firebase `onAuthStateChanged` null
 * guard in AuthContext (which preserves any `local_*` uid).
 *
 * No Firebase SDK is imported here; callers only write to localStorage and
 * navigate.
 */

import { readProfile, writeProfile, type StoredProfile } from "./profile";
import type { Lang } from "@/lib/wilayas";

/** Separate flag for quick checks and for e2e helpers; also cleared on sign-out via clearAllLocalCache(). */
export const GUEST_KEY = "smart-crop.guest.v1";

export const GUEST_UID_PREFIX = "local_guest_";

/** Display names used when no explicit string is provided */
export const GUEST_DISPLAY_AR = "زائر";
export const GUEST_DISPLAY_FR = "Invité";
export const GUEST_ACCOUNT_AR = "حساب زائر";
export const GUEST_ACCOUNT_FR = "Compte invité";

export function isGuestProfile(profile: StoredProfile | null | undefined): boolean {
  if (!profile) return false;
  if (profile.isGuest) return true;
  if (profile.isAnonymous) return true;
  if (profile.method === "guest") return true;
  if (typeof profile.uid === "string" && profile.uid.startsWith(GUEST_UID_PREFIX)) return true;
  if (typeof profile.uid === "string" && profile.uid.startsWith("guest")) return true;
  return false;
}

export function isGuestMode(): boolean {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(GUEST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { isGuest?: unknown };
        if (parsed?.isGuest === true) return true;
      }
    } catch {
      /* ignore */
    }
  }
  const profile = readProfile();
  return isGuestProfile(profile);
}

export function createGuestProfile(lang: Lang = "ar"): StoredProfile {
  const displayName = lang === "ar" ? GUEST_DISPLAY_AR : GUEST_DISPLAY_FR;
  return {
    uid: `${GUEST_UID_PREFIX}${Date.now()}`,
    method: "guest",
    displayName,
    role: null,
    wilayaCode: null,
    isGuest: true,
    isAnonymous: true,
    updatedAt: Date.now(),
  };
}

/**
 * Persist a guest profile and flag, then return it.
 * Safe to call outside React (e.g. from an onClick).
 */
export function enterGuestMode(lang: Lang = "ar"): StoredProfile {
  const profile = createGuestProfile(lang);
  writeProfile(profile);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        GUEST_KEY,
        JSON.stringify({ isGuest: true, uid: profile.uid, displayName: profile.displayName, ts: Date.now() }),
      );
    } catch {
      /* storage blocked */
    }
    try {
      window.dispatchEvent(new CustomEvent("smart-crop:profile"));
    } catch {
      /* no-op */
    }
  }
  return profile;
}

export function clearGuestFlag(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(GUEST_KEY);
  } catch {
    /* no-op */
  }
}

export function getGuestDisplayName(lang: Lang = "ar"): string {
  return lang === "ar" ? GUEST_DISPLAY_AR : GUEST_DISPLAY_FR;
}

export function getGuestAccountLabel(lang: Lang = "ar"): string {
  return lang === "ar" ? GUEST_ACCOUNT_AR : GUEST_ACCOUNT_FR;
}
