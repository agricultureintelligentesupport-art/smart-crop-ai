"use client";

/**
 * On-device session/profile persistence.
 *
 * Mirrors what Firestore holds for a signed-in user (`users/{uid}`), so the
 * role + wilaya picked during onboarding immediately shape the dashboard.
 * Guests get the same record with `isGuest: true` and a null uid.
 */

import { useCallback, useEffect, useState } from "react";
import type { Lang } from "@/lib/wilayas";
import type { AuthMethod, AuthRole, SessionUser } from "./types";

export const PROFILE_KEY = "smart-crop.profile.v1";
const PROFILE_EVENT = "smart-crop:profile";
/** Device-level preferences that survive signing out (no identity in here). */
const PREFS_KEY = "smart-crop.prefs.v1";

export interface StoredProfile {
  uid: string | null;
  method: AuthMethod | "guest";
  displayName: string;
  email?: string;
  phone?: string;
  role: AuthRole | null;
  wilayaCode: string | null;
  isGuest: boolean;
  lang?: Lang;
  updatedAt: number;
}

function isProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<StoredProfile>;
  return typeof v.displayName === "string" && typeof v.isGuest === "boolean";
}

export function readProfile(): StoredProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeProfile(profile: StoredProfile): StoredProfile {
  const next: StoredProfile = { ...profile, updatedAt: Date.now() };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(PROFILE_EVENT));
    } catch {
      /* private mode: keep it in memory for this session */
    }
  }
  return next;
}

export function patchStoredProfile(patch: Partial<StoredProfile>): StoredProfile | null {
  const current = readProfile();
  if (!current) return null;
  return writeProfile({ ...current, ...patch });
}

export function clearProfile(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PROFILE_KEY);
    window.dispatchEvent(new CustomEvent(PROFILE_EVENT));
  } catch {
    /* no-op */
  }
}

export function profileFromUser(user: SessionUser, extra: Partial<StoredProfile> = {}): StoredProfile {
  return {
    uid: user.uid,
    method: user.method,
    displayName: user.displayName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    wilayaCode: user.wilayaCode,
    isGuest: user.isGuest,
    updatedAt: Date.now(),
    ...extra,
  };
}

export function guestProfile(extra: Partial<StoredProfile> = {}): StoredProfile {
  return {
    uid: null,
    method: "guest",
    displayName: "زائر",
    role: null,
    wilayaCode: null,
    isGuest: true,
    updatedAt: Date.now(),
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/*  Device preferences (survive sign-out)                              */
/* ------------------------------------------------------------------ */

export interface DevicePrefs {
  role: AuthRole | null;
  wilayaCode: string | null;
  lang?: Lang;
}

const EMPTY_PREFS: DevicePrefs = { role: null, wilayaCode: null };

export function readPrefs(): DevicePrefs {
  if (typeof window === "undefined") return EMPTY_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return EMPTY_PREFS;
    const parsed = JSON.parse(raw) as Partial<DevicePrefs>;
    return {
      role: (parsed.role as AuthRole | null) ?? null,
      wilayaCode: typeof parsed.wilayaCode === "string" ? parsed.wilayaCode : null,
      lang: parsed.lang,
    };
  } catch {
    return EMPTY_PREFS;
  }
}

export function writePrefs(patch: Partial<DevicePrefs>): DevicePrefs {
  const next: DevicePrefs = { ...readPrefs(), ...patch };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  }
  return next;
}

/**
 * Reads the stored profile after mount (never during SSR, which would
 * desynchronise the HTML) and keeps every consumer in sync through a
 * same-tab custom event plus the cross-tab `storage` event.
 */
export function useProfile() {
  // First render reads localStorage directly (server renders `null`, so the
  // markup matches); the effect below only *subscribes* to later changes.
  const [profile, setProfileState] = useState<StoredProfile | null>(() => readProfile());
  /** Always true after mount: kept for callers that gate redirects on hydration. */
  const ready = true;

  useEffect(() => {
    const sync = () => setProfileState(readProfile());
    window.addEventListener(PROFILE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PROFILE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const save = useCallback((next: StoredProfile) => {
    setProfileState(writeProfile(next));
  }, []);

  const patch = useCallback((next: Partial<StoredProfile>) => {
    setProfileState((current) => (current ? writeProfile({ ...current, ...next }) : current));
  }, []);

  const clear = useCallback(() => {
    clearProfile();
    setProfileState(null);
  }, []);

  return { profile, ready, save, patch, clear };
}
