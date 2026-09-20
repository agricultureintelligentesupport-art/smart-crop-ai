/**
 * Unit tests for the auth lib (run in plain Node — no browser needed).
 *
 *   npm run test:unit
 *
 * Node 22+ strips the types and loads the app's TS directly; `./register.mjs`
 * (via `--import`) adds a resolve hook for the extensionless relative imports
 * the app's tsc config requires.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { initializeApp } from "firebase/app";
import { GoogleAuthProvider } from "firebase/auth";
import { initializeFirestore, type Firestore } from "firebase/firestore";

import { googleProvider } from "../../src/lib/firebase";
import { AUTH_ERROR_CODES, AuthError, toAuthErrorCode } from "../../src/lib/auth/types";
import { isMobileBrowser } from "../../src/lib/auth/platform";
import { logAuthError } from "../../src/lib/auth/logging";
import { syncUserDoc } from "../../src/lib/auth/userDoc";

/* ------------------------------------------------------------------ */
/*  1. Google provider: account chooser                                */
/* ------------------------------------------------------------------ */

test("googleProvider forces the account chooser (prompt=select_account)", () => {
  assert.ok(googleProvider instanceof GoogleAuthProvider);
  assert.deepEqual(googleProvider.getCustomParameters(), { prompt: "select_account" });
});

/* ------------------------------------------------------------------ */
/*  2. Error code mapping                                              */
/* ------------------------------------------------------------------ */

const fb = (code: string) => ({ code }) as { code: string };

test("toAuthErrorCode maps the Google/OAuth failure codes", () => {
  assert.equal(toAuthErrorCode(fb("auth/popup-blocked")), "popup-blocked");
  assert.equal(toAuthErrorCode(fb("auth/unauthorized-domain")), "unauthorized-domain");
  assert.equal(
    toAuthErrorCode(fb("auth/operation-not-supported-in-this-environment")),
    "operation-not-supported",
  );
  assert.equal(toAuthErrorCode(fb("auth/popup-closed-by-user")), "popup-closed");
  assert.equal(toAuthErrorCode(fb("auth/cancelled-popup-request")), "popup-closed");
  assert.equal(toAuthErrorCode(fb("auth/cancelled-redirect")), "popup-closed");
  assert.equal(toAuthErrorCode(fb("auth/redirect-cancelled-by-user")), "popup-closed");
  assert.equal(toAuthErrorCode(fb("auth/network-request-failed")), "network");
});

test("toAuthErrorCode keeps the pre-existing mappings and falls back to unknown", () => {
  assert.equal(toAuthErrorCode(fb("auth/invalid-email")), "invalid-input");
  assert.equal(toAuthErrorCode(fb("auth/invalid-verification-code")), "invalid-code");
  assert.equal(toAuthErrorCode(fb("auth/too-many-requests")), "too-many-requests");
  assert.equal(toAuthErrorCode(fb("auth/brand-new-code")), "unknown");
  assert.equal(toAuthErrorCode(new Error("boom")), "unknown");
  assert.equal(toAuthErrorCode(new AuthError("code-expired")), "code-expired");
});

test("AUTH_ERROR_CODES contains the new Google failure codes", () => {
  const codes = AUTH_ERROR_CODES as readonly string[];
  for (const code of ["popup-blocked", "unauthorized-domain", "operation-not-supported", "popup-closed"]) {
    assert.ok(codes.includes(code), `missing ${code}`);
  }
});

/* ------------------------------------------------------------------ */
/*  3. Mobile detection (popup → redirect decision)                    */
/* ------------------------------------------------------------------ */

test("isMobileBrowser detects phones/tablets and skips desktops", () => {
  const iOS =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const android =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
  const desktop =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  assert.equal(isMobileBrowser({ userAgent: iOS }), true);
  assert.equal(isMobileBrowser({ userAgent: android }), true);
  assert.equal(isMobileBrowser({ userAgent: desktop }), false);
  assert.equal(isMobileBrowser(null), false);
  assert.equal(isMobileBrowser(undefined), false);
});

/* ------------------------------------------------------------------ */
/*  4. Reliable users/{uid} sync                                       */
/* ------------------------------------------------------------------ */

test("syncUserDoc skips (ok) when Firestore is not ready (demo/SSR)", async () => {
  const res = await syncUserDoc({ uid: "u1" }, {}, {} as Firestore);
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { uid: "u1" });
  assert.equal(res.error, undefined);
});

test(
  "syncUserDoc retries with backoff, then fails soft when Firestore is unreachable",
  { timeout: 30_000 },
  async () => {
    const app = initializeApp(
      { apiKey: "unit-test-key", projectId: "unit-test-project", appId: "unit-test-app" },
      "unit-test",
    );
    // localhost:1 is closed → instant connection refusal, a deterministic
    // "offline" Firestore backend.
    const db = initializeFirestore(app, { host: "localhost:1", ssl: false });
    const started = Date.now();
    const res = await syncUserDoc(
      { uid: "u2", displayName: "Unit", email: "unit@example.dz" },
      { role: "farmer", wilayaCode: "07" },
      db,
    );
    const elapsed = Date.now() - started;
    assert.equal(res.ok, false);
    assert.ok(res.error, "the underlying Firestore error must be surfaced");
    assert.deepEqual(res.data, { uid: "u2" });
    // Two backoff sleeps (400ms + 1200ms) prove all three attempts ran.
    assert.ok(elapsed >= 1500, `expected at least the two backoff delays, took ${elapsed}ms`);
  },
);

/* ------------------------------------------------------------------ */
/*  5. Developer-facing logging                                        */
/* ------------------------------------------------------------------ */

test("logAuthError logs the scope, the Firebase code and an actionable hint", () => {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    logAuthError("signInWithPopup", { code: "auth/unauthorized-domain" });
    logAuthError("signInWithPopup", { code: "auth/popup-blocked" });
  } finally {
    console.error = original;
  }
  const flat = calls.map((c) => c.join(" ")).join(" | ");
  assert.match(flat, /signInWithPopup/);
  assert.match(flat, /auth\/unauthorized-domain/);
  assert.match(flat, /Authorized domains/); // actionable hint for the console setup
  assert.match(flat, /auth\/popup-blocked/);
  assert.match(flat, /signInWithRedirect/); // fallback hint
});
