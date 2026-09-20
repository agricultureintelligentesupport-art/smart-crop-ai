/**
 * Unit tests for the Firebase runtime environment resolution
 * (src/lib/firebase-env.ts).
 *
 * The properties under test:
 *   1. `NEXT_PUBLIC_FIREBASE_*` values win over the documented fallback;
 *   2. a blank/absent variable is reported (never silently ignored);
 *   3. `NEXT_PUBLIC_AUTH_BACKEND` is trimmed/case-insensitive, understands
 *      `demo` | `firebase` | `auto`, and never silently swallows a typo;
 *   4. the diagnostics table names the exact keys that fell back, warns about
 *      unauthorized origins and iframes, and never leaks a full API key.
 *
 * Run with: npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_FIREBASE_CONFIG,
  FIREBASE_ENV_KEYS,
  firebaseDiagnostics,
  readFirebaseEnv,
  redactFirebaseValue,
  resolveAuthBackend,
  resolveFirebaseEnv,
  type FirebaseEnv,
} from "../../src/lib/firebase-env";

const FULL_ENV: FirebaseEnv = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaSyENV-only-key-000000",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "env-project.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "env-project",
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "env-project.firebasestorage.app",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "999999999999",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:999999999999:web:envapp",
  NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: "G-ENVONLY",
};

/* ------------------------------------------------------------------ */
/*  1. env first, documented fallback second                           */
/* ------------------------------------------------------------------ */

test("every NEXT_PUBLIC_FIREBASE_* value is taken from the environment when present", () => {
  const env = resolveFirebaseEnv(FULL_ENV);
  assert.equal(env.config.apiKey, FULL_ENV.NEXT_PUBLIC_FIREBASE_API_KEY);
  assert.equal(env.config.authDomain, "env-project.firebaseapp.com");
  assert.equal(env.config.projectId, "env-project");
  assert.equal(env.config.measurementId, "G-ENVONLY");
  assert.ok(env.entries.every((entry) => entry.source === "env"), "no fallback should be used");
  assert.equal(env.allFromEnv, true);
  assert.equal(env.customProject, true);
  assert.deepEqual(env.missingRequired, []);
  assert.deepEqual(env.missingAll, []);
  assert.equal(env.ready, true);
});

test("an empty environment falls back safely AND reports every required key", () => {
  const env = resolveFirebaseEnv({});
  assert.equal(env.config.apiKey, FALLBACK_FIREBASE_CONFIG.apiKey);
  assert.equal(env.config.projectId, FALLBACK_FIREBASE_CONFIG.projectId);
  assert.equal(env.allFromEnv, false);
  assert.equal(env.customProject, false);
  assert.equal(env.ready, true, "the fallback project keeps the build and preview alive");
  assert.deepEqual(env.missingRequired, [
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
  ]);
  assert.equal(env.missingAll.length, FIREBASE_ENV_KEYS.length);
});

test("blank strings count as missing (whitespace is not a config)", () => {
  const env = resolveFirebaseEnv({ ...FULL_ENV, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "   " });
  assert.equal(env.config.authDomain, FALLBACK_FIREBASE_CONFIG.authDomain);
  const entry = env.entries.find((e) => e.key === "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
  assert.equal(entry?.source, "fallback");
  assert.deepEqual(env.missingRequired, ["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"]);
});

test("values are trimmed before they reach initializeApp()", () => {
  const env = resolveFirebaseEnv({ ...FULL_ENV, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "  env-project \n" });
  assert.equal(env.config.projectId, "env-project");
});

/* ------------------------------------------------------------------ */
/*  2. stdlib env access is static (Next.js can inline it)             */
/* ------------------------------------------------------------------ */

test("readFirebaseEnv() reads the live process.env through static property access", () => {
  const before = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "unit-test-project";
  try {
    assert.equal(readFirebaseEnv().NEXT_PUBLIC_FIREBASE_PROJECT_ID, "unit-test-project");
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    else process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = before;
  }
});

/* ------------------------------------------------------------------ */
/*  3. NEXT_PUBLIC_AUTH_BACKEND                                        */
/* ------------------------------------------------------------------ */

test("NEXT_PUBLIC_AUTH_BACKEND=firebase selects Firebase Auth (trimmed, case-insensitive)", () => {
  for (const raw of ["firebase", " Firebase ", "FIREBASE"]) {
    const env = resolveFirebaseEnv(FULL_ENV, raw);
    assert.equal(env.backend, "firebase", `raw=${JSON.stringify(raw)}`);
    assert.equal(env.backendSource, "env");
  }
});

test("NEXT_PUBLIC_AUTH_BACKEND=demo selects the on-device gateway", () => {
  const env = resolveFirebaseEnv(FULL_ENV, "demo");
  assert.equal(env.backend, "demo");
  assert.equal(env.backendSource, "env");
});

test("an unset backend defaults to demo and flags a configured-but-unused Firebase project", () => {
  const env = resolveFirebaseEnv(FULL_ENV, undefined);
  assert.equal(env.backend, "demo");
  assert.equal(env.backendSource, "default");
  assert.match(env.backendNote, /NEXT_PUBLIC_AUTH_BACKEND is not set/);
  assert.match(env.backendNote, /NEXT_PUBLIC_FIREBASE_\* is configured/);
});

test("an unrecognised backend value is surfaced, never silently ignored", () => {
  const env = resolveFirebaseEnv(FULL_ENV, "Firebse");
  assert.equal(env.backend, "demo");
  assert.equal(env.backendSource, "unknown");
  assert.match(env.backendNote, /Firebse/);
});

test('backend "auto" uses Firebase only with a complete config', () => {
  assert.equal(resolveFirebaseEnv(FULL_ENV, "auto").backend, "firebase");
  const incomplete = resolveFirebaseEnv(
    { NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaSyENV" },
    "auto",
  );
  // apiKey alone is not enough: authDomain/projectId/appId come from the
  // fallback project, so the two halves must not be mixed implicitly.
  assert.equal(incomplete.backend, "firebase", "fallbacks complete the config");
  const broken = resolveAuthBackend("auto", { apiKey: "", authDomain: "", projectId: "", appId: "" });
  assert.equal(broken.backend, "demo");
  assert.equal(broken.backendSource, "auto");
});

/* ------------------------------------------------------------------ */
/*  4. Diagnostics                                                     */
/* ------------------------------------------------------------------ */

test("diagnostics list the backend, project, env gaps and never print a full API key", () => {
  const env = resolveFirebaseEnv({ ...FULL_ENV, NEXT_PUBLIC_FIREBASE_APP_ID: "" }, "firebase");
  const lines = firebaseDiagnostics(env);
  const byLabel = new Map(lines.map((line) => [line.label, line]));

  assert.match(byLabel.get("backend")?.value ?? "", /^firebase \(env\)$/);
  assert.equal(byLabel.get("projectId")?.value, "env-project");
  assert.equal(byLabel.get("authDomain")?.value, "env-project.firebaseapp.com");
  assert.match(byLabel.get("env")?.value ?? "", /NEXT_PUBLIC_FIREBASE_APP_ID/);
  assert.equal(byLabel.get("env")?.tone, "warn");
  assert.equal(byLabel.get("apiKey")?.value, redactFirebaseValue(FULL_ENV.NEXT_PUBLIC_FIREBASE_API_KEY!));
  assert.ok(!(byLabel.get("apiKey")?.value ?? "").includes(FULL_ENV.NEXT_PUBLIC_FIREBASE_API_KEY!));
});

test("diagnostics warn about origins that are not authorized for Firebase Auth", () => {
  const env = resolveFirebaseEnv(FULL_ENV, "firebase");

  const preview = firebaseDiagnostics(env, {
    origin: "https://4123-abc.e2b.app",
    hostname: "4123-abc.e2b.app",
    inIframe: true,
  });
  const authorized = preview.find((line) => line.label === "authorized domains");
  assert.equal(authorized?.tone, "warn");
  assert.match(authorized?.value ?? "", /Authorized domains/);
  assert.match(authorized?.value ?? "", /https:\/\/4123-abc\.e2b\.app/);

  const framed = preview.find((line) => line.label === "iframe");
  assert.equal(framed?.tone, "warn");

  const local = firebaseDiagnostics(env, { origin: "http://localhost:3000", hostname: "localhost" });
  assert.equal(local.find((line) => line.label === "origin")?.tone, "ok");
  assert.equal(local.find((line) => line.label === "authorized domains"), undefined);
  assert.equal(local.find((line) => line.label === "iframe"), undefined);
});

test("redactFirebaseValue keeps a preview, never the whole secret", () => {
  assert.equal(redactFirebaseValue(""), "(empty)");
  assert.equal(redactFirebaseValue("short"), "short");
  assert.equal(redactFirebaseValue("AIzaSyAbb9aCsOfMkw9G5H0L58LSkbsONhix51k"), "AIzaSy…x51k");
});
