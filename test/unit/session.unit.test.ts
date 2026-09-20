/**
 * Unit tests for the session-isolation helpers (run in plain Node — no browser
 * needed).
 *
 *   npm run test:unit
 *
 * Covers the stale-profile fix: signing in with a different account must never
 * inherit the previous user's cached role/wilaya, and sign-out must wipe the
 * whole local cache.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PROFILE_SYNC_EVENT,
  clearAllLocalCache,
  isSwitchingAccounts,
  resolveSessionBinding,
} from "../../src/lib/auth/session";
import type { DevicePrefs, StoredProfile } from "../../src/lib/auth/profile";
import type { SessionUser } from "../../src/lib/auth/types";

/* ------------------------------------------------------------------ */
/*  fixtures                                                           */
/* ------------------------------------------------------------------ */

function storedProfile(overrides: Partial<StoredProfile> = {}): StoredProfile {
  return {
    uid: "user-A",
    method: "google",
    displayName: "Farmer A",
    role: "farmer",
    wilayaCode: "16",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function session(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    uid: "user-A",
    method: "google",
    displayName: "Farmer A",
    role: null,
    wilayaCode: null,
    ...overrides,
  };
}

const devicePrefs: DevicePrefs = { role: "investor", wilayaCode: "31" };

interface MockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function mockStorage(map: Map<string, string>): MockStorage {
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
  };
}

interface MockWindow {
  local: Map<string, string>;
  session: Map<string, string>;
  events: string[];
  restore: () => void;
}

function mockWindow(): MockWindow {
  const local = new Map<string, string>();
  const sessionStore = new Map<string, string>();
  const events: string[] = [];
  const previous = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    localStorage: mockStorage(local),
    sessionStorage: mockStorage(sessionStore),
    dispatchEvent: (event: { type: string }) => {
      events.push(event.type);
      return true;
    },
  };
  return {
    local,
    session: sessionStore,
    events,
    restore: () => {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = previous;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  1. isSwitchingAccounts                                             */
/* ------------------------------------------------------------------ */

test("isSwitchingAccounts detects a different signed-in uid", () => {
  assert.equal(isSwitchingAccounts(storedProfile({ uid: "user-A" }), "user-B"), true);
  assert.equal(isSwitchingAccounts(storedProfile({ uid: "user-A" }), "user-A"), false);
});

test("isSwitchingAccounts ignores missing identities", () => {
  assert.equal(isSwitchingAccounts(null, "user-B"), false);
  assert.equal(isSwitchingAccounts(storedProfile({ uid: "user-A" }), null), false);
  assert.equal(isSwitchingAccounts(storedProfile({ uid: "user-A" }), undefined), false);
});

/* ------------------------------------------------------------------ */
/*  2. resolveSessionBinding                                           */
/* ------------------------------------------------------------------ */

test("resolveSessionBinding: account switch discards the cached identity", () => {
  const binding = resolveSessionBinding(
    session({ uid: "user-B", role: null, wilayaCode: null }),
    storedProfile({ uid: "user-A", role: "farmer", wilayaCode: "16" }),
    devicePrefs,
  );
  assert.deepEqual(binding, { role: null, wilayaCode: null, uidChanged: true });
});

test("resolveSessionBinding: account switch keeps the new session's own values", () => {
  const binding = resolveSessionBinding(
    session({ uid: "user-B", role: "agronomist", wilayaCode: "07" }),
    storedProfile({ uid: "user-A", role: "farmer", wilayaCode: "16" }),
    devicePrefs,
  );
  assert.deepEqual(binding, { role: "agronomist", wilayaCode: "07", uidChanged: true });
});

test("resolveSessionBinding: same user merges session > cached > device", () => {
  // Session values always win.
  assert.deepEqual(
    resolveSessionBinding(
      session({ uid: "user-A", role: "agronomist", wilayaCode: "07" }),
      storedProfile({ uid: "user-A", role: "farmer", wilayaCode: "16" }),
      devicePrefs,
    ),
    { role: "agronomist", wilayaCode: "07", uidChanged: false },
  );
  // Then the cached profile (e.g. onboarding completed while offline)…
  assert.deepEqual(
    resolveSessionBinding(
      session({ uid: "user-A", role: null, wilayaCode: null }),
      storedProfile({ uid: "user-A", role: "farmer", wilayaCode: "16" }),
      devicePrefs,
    ),
    { role: "farmer", wilayaCode: "16", uidChanged: false },
  );
  // …then the device prefs.
  assert.deepEqual(
    resolveSessionBinding(
      session({ uid: "user-A", role: null, wilayaCode: null }),
      null,
      devicePrefs,
    ),
    { role: "investor", wilayaCode: "31", uidChanged: false },
  );
});

/* ------------------------------------------------------------------ */
/*  3. clearAllLocalCache                                              */
/* ------------------------------------------------------------------ */

test("clearAllLocalCache wipes local + session storage and notifies listeners", () => {
  const win = mockWindow();
  try {
    win.local.set("smart-crop.profile.v1", JSON.stringify(storedProfile()));
    win.local.set("smart-crop.prefs.v1", JSON.stringify(devicePrefs));
    win.local.set("smart-crop.auth.users.v1", "{}");
    win.local.set("smart-crop.lang.v1", "fr");
    win.session.set("firebase:redirect", "pending");

    clearAllLocalCache();

    // Identity data is gone from both storages…
    assert.equal(win.local.has("smart-crop.profile.v1"), false);
    assert.equal(win.local.has("smart-crop.prefs.v1"), false);
    assert.equal(win.local.has("smart-crop.auth.users.v1"), false);
    assert.equal(win.session.size, 0);
    // …the UI language (a device preference, not identity) is preserved…
    assert.equal(win.local.get("smart-crop.lang.v1"), "fr");
    // …and mounted profile hooks are told to drop to null.
    assert.ok(win.events.includes(PROFILE_SYNC_EVENT));
  } finally {
    win.restore();
  }
});

test("clearAllLocalCache is a safe no-op without a window (SSR)", () => {
  assert.equal((globalThis as Record<string, unknown>).window, undefined);
  assert.doesNotThrow(() => clearAllLocalCache());
});
