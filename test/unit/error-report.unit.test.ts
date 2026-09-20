/**
 * Unit tests for the provider-error → on-screen report mapping
 * (src/lib/auth/errorReport.ts).
 *
 * The property under test: whatever the Firebase SDK throws, the UI gets a
 * report carrying the raw `error.code` and `error.message` (plus the
 * actionable hint) — never a silently swallowed error, and never a leaked
 * API key.
 *
 * Run with: npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  describeAuthError,
  formatAuthReport,
  rawAuthCode,
  reportSummary,
  sanitizeAuthMessage,
} from "../../src/lib/auth/errorReport";
import { AuthError } from "../../src/lib/auth/types";

const fbError = (code: string, message = code) => Object.assign(new Error(message), { code });

/* ------------------------------------------------------------------ */
/*  1. Raw Firebase codes reach the report verbatim                    */
/* ------------------------------------------------------------------ */

test("a FirebaseError keeps its exact code and message", () => {
  const report = describeAuthError(
    fbError("auth/unauthorized-domain", "This domain (abc.e2b.app) is not authorized"),
    "signInWithPopup",
  );
  assert.equal(report.code, "auth/unauthorized-domain");
  assert.equal(report.message, "This domain (abc.e2b.app) is not authorized");
  assert.equal(report.appCode, "unauthorized-domain");
  assert.equal(report.scope, "signInWithPopup");
  assert.match(report.hint ?? "", /Authorized domains/);
});

test("newer SDK codes map onto the app copy: popup-blocked-by-browser, web-storage-unsupported", () => {
  assert.equal(describeAuthError(fbError("auth/popup-blocked-by-browser")).appCode, "popup-blocked");
  assert.equal(describeAuthError(fbError("auth/web-storage-unsupported")).appCode, "storage-blocked");
});

test("an app AuthError keeps the provider code it was built from", () => {
  const error = new AuthError("wrong-password", "The password is invalid", "auth/wrong-password");
  const report = describeAuthError(error, "firebase/signInWithEmail");
  assert.equal(report.code, "auth/wrong-password");
  assert.equal(report.message, "The password is invalid");
  assert.equal(report.appCode, "wrong-password");
});

test("an app AuthError without a provider code is labelled app/<code>", () => {
  const report = describeAuthError(new AuthError("invalid-input"));
  assert.equal(report.code, "app/invalid-input");
  assert.equal(report.appCode, "invalid-input");
});

/* ------------------------------------------------------------------ */
/*  2. Anything can be reported — nothing throws, nothing is empty      */
/* ------------------------------------------------------------------ */

test("unknown throwables still produce a renderable report", () => {
  assert.equal(describeAuthError(undefined).code, "unknown-code");
  assert.equal(describeAuthError(undefined).message, "no message supplied by the provider");
  assert.equal(describeAuthError("boom").message, "boom");
  assert.equal(describeAuthError({ reason: "nope" }).appCode, "unknown");
  assert.equal(rawAuthCode({ code: 42 }), undefined);
  assert.equal(rawAuthCode({ code: "  " }), undefined);
});

/* ------------------------------------------------------------------ */
/*  3. Sanitising: whitespace, length, secrets                         */
/* ------------------------------------------------------------------ */

test("messages are single-line, capped and free of API keys", () => {
  assert.equal(sanitizeAuthMessage("  line one\n\tline two  "), "line one line two");

  const long = "x".repeat(400);
  const capped = sanitizeAuthMessage(long);
  assert.equal(capped.length, 240);
  assert.ok(capped.endsWith("…"));

  const leaked = sanitizeAuthMessage("Requests to https://identitytoolkit… key=AIzaSyAbb9aCsOfMkw9G5H0L58LSkbsONhix51k failed");
  assert.ok(!leaked.includes("AIzaSyAbb9aCsOfMkw9G5H0L58LSkbsONhix51k"));
  assert.match(leaked, /AIza…\(redacted\)/);
});

/* ------------------------------------------------------------------ */
/*  4. Clipboard / console block                                       */
/* ------------------------------------------------------------------ */

test("formatAuthReport carries every fact a maintainer needs", () => {
  const report = describeAuthError(fbError("auth/popup-blocked", "Popup blocked"), "signInWithPopup");
  const text = formatAuthReport({
    report,
    localizedMessage: "تعذّر فتح النافذة المنبثقة",
    diagnostics: ["backend: firebase (env)", "origin: https://x.e2b.app"],
  });
  assert.match(text, /code: auth\/popup-blocked/);
  assert.match(text, /message: Popup blocked/);
  assert.match(text, /scope: signInWithPopup/);
  assert.match(text, /hint: The browser blocked the Google sign-in popup/);
  assert.match(text, /ui: تعذّر فتح النافذة المنبثقة/);
  assert.match(text, /diagnostics:\nbackend: firebase \(env\)/);
  assert.equal(reportSummary(report), "auth/popup-blocked — Popup blocked");
});
