/**
 * Unit tests for guest mode (run in plain Node — no browser needed).
 *
 *   npm run test:unit
 *
 * Covers the "المتابعة كزائر" bypass: the flag lives in its own storage
 * key, validates strictly, is wiped by the sign-out cache clear, and never
 * collides with the member profile cache (whose legacy-guest guard must
 * keep rejecting old profile-key records).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  GUEST_KEY,
  GUEST_SYNC_EVENT,
  GUEST_UID,
  clearGuest,
  createGuestSession,
  enterGuestMode,
  guestDisplayName,
  isGuestSession,
  readGuest,
  writeGuest,
} from "../../src/lib/auth/guest";
import { readProfile, PROFILE_KEY } from "../../src/lib/auth/profile";
import { clearAllLocalCache, PROFILE_SYNC_EVENT } from "../../src/lib/auth/session";

/* ------------------------------------------------------------------ */
/*  fixtures — same lightweight window mock as session.unit.test.ts    */
/* ------------------------------------------------------------------ */

interface MockWindow {
  local: Map<string, string>;
  events: string[];
  restore: () => void;
}

function mockWindow(): MockWindow {
  const local = new Map<string, string>();
  const events: string[] = [];
  const previous = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string) => (local.has(key) ? (local.get(key) as string) : null),
      setItem: (key: string, value: string) => {
        local.set(key, value);
      },
      removeItem: (key: string) => {
        local.delete(key);
      },
      clear: () => {
        local.clear();
      },
    },
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    },
    dispatchEvent: (event: { type: string }) => {
      events.push(event.type);
      return true;
    },
  };
  return {
    local,
    events,
    restore: () => {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = previous;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  1. Session shape                                                   */
/* ------------------------------------------------------------------ */

test("createGuestSession is a mock anonymous user labelled زائر", () => {
  const session = createGuestSession();
  assert.equal(session.isGuest, true);
  assert.equal(session.user.isAnonymous, true);
  assert.equal(session.user.displayName, "زائر");
  assert.equal(session.user.uid, GUEST_UID);
  assert.equal(typeof session.enteredAt, "number");
});

test("guestDisplayName localises the UI label", () => {
  assert.equal(guestDisplayName("ar"), "زائر");
  assert.equal(guestDisplayName("fr"), "Invité");
});

/* ------------------------------------------------------------------ */
/*  2. Structural guard                                                */
/* ------------------------------------------------------------------ */

test("isGuestSession accepts only the current guest shape", () => {
  assert.equal(isGuestSession(createGuestSession()), true);
  assert.equal(
    isGuestSession({ isGuest: true, user: { isAnonymous: true, displayName: "زائر" } }),
    true,
  );
});

test("isGuestSession rejects junk, legacy profiles and partial records", () => {
  assert.equal(isGuestSession(null), false);
  assert.equal(isGuestSession(undefined), false);
  assert.equal(isGuestSession("guest"), false);
  assert.equal(isGuestSession({}), false);
  assert.equal(isGuestSession({ isGuest: true }), false);
  assert.equal(isGuestSession({ isGuest: true, user: {} }), false);
  assert.equal(isGuestSession({ isGuest: true, user: { isAnonymous: false, displayName: "x" } }), false);
  assert.equal(isGuestSession({ isGuest: "yes", user: { isAnonymous: true, displayName: "x" } }), false);
  // Legacy profile-key guest record (uid: null, method: "guest") — never a
  // valid current guest session either.
  assert.equal(
    isGuestSession({ uid: null, isGuest: true, method: "guest", displayName: "زائر" }),
    false,
  );
});

/* ------------------------------------------------------------------ */
/*  3. Storage round-trip                                              */
/* ------------------------------------------------------------------ */

test("writeGuest persists under its own key and notifies listeners", () => {
  const win = mockWindow();
  try {
    const session = writeGuest(createGuestSession());
    assert.equal(win.local.has(GUEST_KEY), true);
    assert.equal(win.local.has(PROFILE_KEY), false, "guest state must not touch the profile key");
    assert.ok(win.events.includes(GUEST_SYNC_EVENT));
    assert.deepEqual(readGuest(), { ...session });
  } finally {
    win.restore();
  }
});

test("readGuest returns null for missing, malformed and foreign payloads", () => {
  const win = mockWindow();
  try {
    assert.equal(readGuest(), null);

    win.local.set(GUEST_KEY, "{not json");
    assert.equal(readGuest(), null);

    win.local.set(GUEST_KEY, JSON.stringify({ isGuest: true }));
    assert.equal(readGuest(), null);

    win.local.set(GUEST_KEY, JSON.stringify({ uid: null, isGuest: true, method: "guest" }));
    assert.equal(readGuest(), null);
  } finally {
    win.restore();
  }
});

test("clearGuest drops the flag and notifies listeners", () => {
  const win = mockWindow();
  try {
    writeGuest(createGuestSession());
    clearGuest();
    assert.equal(win.local.has(GUEST_KEY), false);
    assert.ok(win.events.includes(GUEST_SYNC_EVENT));
    assert.equal(readGuest(), null);
  } finally {
    win.restore();
  }
});

test("readGuest is a safe null without a window (SSR)", () => {
  assert.equal((globalThis as Record<string, unknown>).window, undefined);
  assert.equal(readGuest(), null);
});

/* ------------------------------------------------------------------ */
/*  4. enterGuestMode vs. the member profile cache                     */
/* ------------------------------------------------------------------ */

test("enterGuestMode claims the flag and drops a stale cached profile", () => {
  const win = mockWindow();
  try {
    win.local.set(
      PROFILE_KEY,
      JSON.stringify({
        uid: "local_stale",
        method: "email",
        displayName: "Stale farmer",
        role: "farmer",
        wilayaCode: "16",
        updatedAt: Date.now(),
      }),
    );

    const session = enterGuestMode();

    assert.equal(session.isGuest, true);
    assert.equal(readGuest()?.user.isAnonymous, true);
    // The cached member identity is gone so the guest UI is unambiguous…
    assert.equal(win.local.has(PROFILE_KEY), false);
    assert.equal(readProfile(), null);
    // …and the guest record never lived in the profile key anyway.
    const raw = win.local.get(PROFILE_KEY);
    assert.equal(raw === undefined || !String(raw).includes("isGuest"), true);
  } finally {
    win.restore();
  }
});

/* ------------------------------------------------------------------ */
/*  5. Sign-out interplay                                               */
/* ------------------------------------------------------------------ */

test("clearAllLocalCache wipes the guest flag and announces the sync", () => {
  const win = mockWindow();
  try {
    enterGuestMode();
    assert.ok(readGuest());

    clearAllLocalCache();

    assert.equal(win.local.has(GUEST_KEY), false);
    assert.equal(readGuest(), null);
    assert.ok(win.events.includes(PROFILE_SYNC_EVENT));
  } finally {
    win.restore();
  }
});
