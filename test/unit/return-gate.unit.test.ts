/**
 * Unit tests for the Google/redirect RETURN gate (src/lib/auth/returnGate.ts).
 *
 * The property under test: on a fresh load of the wizard, at most ONE
 * completion is produced, and only from a real Firebase user — either the
 * `getRedirectResult()` payload (redirect return) or the restored
 * `onAuthStateChanged` session (payload lost mid-return). The wizard must
 * never advance without one of those, and must never DOUBLE-advance when
 * both fire.
 *
 * Run with: npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { User } from "firebase/auth";
import { methodForFirebaseUser, resolveGoogleReturn } from "../../src/lib/auth/returnGate";

const fbUser = (uid: string, extra: Partial<User> = {}): User =>
  ({ uid, providerData: [], phoneNumber: null, ...(extra as object) }) as unknown as User;

const base = {
  redirectUser: null,
  authedUser: null,
  handledUid: null,
  manualSignInActive: false,
  onMethodStep: true,
} as const;

/* ------------------------------------------------------------------ */
/*  Redirect payload: the authoritative path                           */
/* ------------------------------------------------------------------ */

test("return: a getRedirectResult user completes as the redirect source", () => {
  const user = fbUser("uid-redirect");
  const decision = resolveGoogleReturn({ ...base, redirectUser: user });
  assert.equal(decision.kind, "complete");
  if (decision.kind === "complete") {
    assert.equal(decision.user, user);
    assert.equal(decision.source, "redirect");
  }
});

test("return: the redirect payload wins over an older restored session", () => {
  const fresh = fbUser("uid-fresh");
  const stale = fbUser("uid-stale");
  const decision = resolveGoogleReturn({ ...base, redirectUser: fresh, authedUser: stale });
  assert.equal(decision.kind, "complete");
  if (decision.kind === "complete") {
    assert.equal(decision.user, fresh, "the account chosen at Google must be the one captured");
    assert.equal(decision.source, "redirect");
  }
});

test("return: the redirect payload is captured even mid manual sign-in / past step 1", () => {
  const user = fbUser("uid-redirect");
  for (const extra of [
    { manualSignInActive: true },
    { onMethodStep: false },
    { manualSignInActive: true, onMethodStep: false },
  ]) {
    const decision = resolveGoogleReturn({ ...base, ...extra, redirectUser: user });
    assert.equal(decision.kind, "complete", `must not drop a live credential: ${JSON.stringify(extra)}`);
  }
});

/* ------------------------------------------------------------------ */
/*  Restored-session adoption (the fix for the "resets to step 1" bug) */
/* ------------------------------------------------------------------ */

test("return: a lost payload + restored Firebase session adopts (auth-state source)", () => {
  const restored = fbUser("uid-restored");
  const decision = resolveGoogleReturn({ ...base, authedUser: restored });
  assert.equal(decision.kind, "complete");
  if (decision.kind === "complete") {
    assert.equal(decision.user, restored);
    assert.equal(decision.source, "auth-state");
  }
});

test("return: restored-session adoption never hijacks a manual e-mail/OTP sign-in", () => {
  const decision = resolveGoogleReturn({
    ...base,
    authedUser: fbUser("uid-x"),
    manualSignInActive: true,
  });
  assert.deepEqual(decision, { kind: "ignore", reason: "manual-sign-in" });
});

test("return: restored-session adoption only fires while the wizard is on step 1", () => {
  const decision = resolveGoogleReturn({
    ...base,
    authedUser: fbUser("uid-x"),
    onMethodStep: false,
  });
  assert.deepEqual(decision, { kind: "ignore", reason: "not-method-step" });
});

/* ------------------------------------------------------------------ */
/*  Dedupe + strict gates                                              */
/* ------------------------------------------------------------------ */

test("return: an already-claimed uid is never completed twice", () => {
  const user = fbUser("uid-claim");
  for (const input of [
    { redirectUser: user },
    { authedUser: user },
    { redirectUser: user, authedUser: user },
  ]) {
    const decision = resolveGoogleReturn({ ...base, ...input, handledUid: "uid-claim" });
    assert.deepEqual(decision, { kind: "ignore", reason: "already-handled" });
  }
});

test("return: no user anywhere keeps the wizard on step 1", () => {
  assert.deepEqual(resolveGoogleReturn({ ...base }), { kind: "ignore", reason: "no-session" });
});

test("return: a user object without a uid is never a sign-in (strict gate)", () => {
  for (const junk of [{} as User, { uid: "" } as User]) {
    assert.deepEqual(resolveGoogleReturn({ ...base, redirectUser: junk }), { kind: "ignore", reason: "no-session" });
    assert.deepEqual(resolveGoogleReturn({ ...base, authedUser: junk }), { kind: "ignore", reason: "no-session" });
  }
});

/* ------------------------------------------------------------------ */
/*  Method detection from provider data                                */
/* ------------------------------------------------------------------ */

test("methodForFirebaseUser: google / phone / email from providerData", () => {
  assert.equal(
    methodForFirebaseUser(fbUser("u", { providerData: [{ providerId: "google.com" }] as User["providerData"] })),
    "google",
  );
  assert.equal(
    methodForFirebaseUser(fbUser("u", { providerData: [{ providerId: "phone" }] as User["providerData"] })),
    "phone",
  );
  assert.equal(
    methodForFirebaseUser(fbUser("u", { providerData: [{ providerId: "password" }] as User["providerData"] })),
    "email",
  );
  assert.equal(methodForFirebaseUser(fbUser("u", { phoneNumber: "+213661223344" })), "phone");
  assert.equal(methodForFirebaseUser(fbUser("u")), "email");
});
