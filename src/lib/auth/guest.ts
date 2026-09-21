"use client";

/**
 * Guest mode — a local-only bypass around full authentication.
 *
 * "المتابعة كزائر" / "Continue as Guest" claims a mock, on-device session so
 * the dashboard and assistant guards accept the visitor without any Firebase
 * call. The state lives in its OWN storage key (`smart-crop.guest.v1`),
 * deliberately separate from the member profile cache (`smart-crop.profile.v1`
 *), whose guard rejects legacy `isGuest` records and must keep doing so.
 *
 * Rules:
 *   1. Nothing here ever talks to Firebase — no sign-in, no sign-out, no
 *      config. Existing auth flows and session management stay untouched.
 *   2. A real member session (Firebase user or stored gateway profile)
 *      always wins over the guest flag for display: a stale flag left behind
 *      after signing in can never mask a signed-in identity.
 *   3. The flag is wiped with everything else by `clearAllLocalCache()` on
 *      sign-out (same-tab listeners are notified through
 *      `PROFILE_SYNC_EVENT`), so guest mode never outlives a session wipe.
 *
 * The `useGuest` hook reads storage during the FIRST render (server renders
 * `null`, so the SSR markup matches) and only *subscribes* to later changes
 * in its effect — mirroring `useProfile()`. Guards can therefore trust
 * `isGuest` before their first effect runs; no extra ready-flag bounce.
 */

import { useCallback, useEffect, useState } from "react";
import { clearProfile } from "./profile";
import { PROFILE_SYNC_EVENT } from "./session";

/** Own storage key — never the profile key (which rejects guest records). */
export const GUEST_KEY = "smart-crop.guest.v1";
/** Same-tab sync event `useGuest()` listens to (mirrors profile.ts). */
export const GUEST_SYNC_EVENT = "smart-crop:guest";
/** Local-only uid: never a Firebase identifier, prefix marks it on-device. */
export const GUEST_UID = "local_guest";

export type GuestLang = "ar" | "fr";

/** The mock identity guards and UI copy render for a guest. */
export interface GuestUser {
  isAnonymous: true;
  uid: string;
  displayName: string;
}

export interface GuestSession {
  isGuest: true;
  user: GuestUser;
  enteredAt: number;
}

/** Localised display label for UI areas that expect a user name. */
export function guestDisplayName(lang: GuestLang): string {
  return lang === "fr" ? "Invité" : "زائر";
}

/** Fresh guest session: `{ isGuest: true, user: { isAnonymous: true, … } }`. */
export function createGuestSession(): GuestSession {
  return {
    isGuest: true,
    user: { isAnonymous: true, uid: GUEST_UID, displayName: guestDisplayName("ar") },
    enteredAt: Date.now(),
  };
}

/** Structural guard: only our own guest shape counts (legacy junk never does). */
export function isGuestSession(value: unknown): value is GuestSession {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<GuestSession>;
  if (v.isGuest !== true) return false;
  const user = v.user as Partial<GuestUser> | undefined;
  return (
    Boolean(user) &&
    user?.isAnonymous === true &&
    typeof user.displayName === "string" &&
    user.displayName.length > 0
  );
}

/** Reads the guest flag; `null` without a window (SSR) or on any bad payload. */
export function readGuest(): GuestSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isGuestSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persists the flag and notifies same-tab listeners. Never throws. */
export function writeGuest(session: GuestSession): GuestSession {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(GUEST_KEY, JSON.stringify(session));
    } catch {
      /* private mode / blocked storage: guards fall back to a fresh visit */
    }
    try {
      window.dispatchEvent(new CustomEvent(GUEST_SYNC_EVENT));
    } catch {
      /* event dispatch unavailable */
    }
  }
  return session;
}

/**
 * Claim guest mode from the auth screen: drop any cached member profile so
 * the guest identity is unambiguous, then persist the guest flag. This only
 * touches local storage — Firebase sessions (if any) are left exactly as
 * they are, and a real signed-in user keeps precedence in every UI surface.
 */
export function enterGuestMode(): GuestSession {
  try {
    clearProfile();
  } catch {
    /* storage unavailable */
  }
  return writeGuest(createGuestSession());
}

/** Removes the flag (sign-out wipes it too, via `clearAllLocalCache`). */
export function clearGuest(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(GUEST_KEY);
  } catch {
    /* no-op */
  }
  try {
    window.dispatchEvent(new CustomEvent(GUEST_SYNC_EVENT));
  } catch {
    /* event dispatch unavailable */
  }
}

/**
 * Reactive guest state for guards and UI.
 *
 * First render reads localStorage directly (server renders `null`, so the
 * markup matches); the effect below only *subscribes* to later changes —
 * same contract as `useProfile()`. The redirect guards therefore see the
 * real flag before their first effect, and a guest is never bounced to
 * `/auth` on the first tick.
 */
export function useGuest() {
  const [guest, setGuest] = useState<GuestSession | null>(() => readGuest());

  useEffect(() => {
    const sync = () => setGuest(readGuest());
    window.addEventListener(GUEST_SYNC_EVENT, sync);
    // Sign-out wipes every storage key and announces itself with this event.
    window.addEventListener(PROFILE_SYNC_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(GUEST_SYNC_EVENT, sync);
      window.removeEventListener(PROFILE_SYNC_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const clear = useCallback(() => {
    clearGuest();
    setGuest(null);
  }, []);

  return { guest, isGuest: guest !== null, clear };
}
