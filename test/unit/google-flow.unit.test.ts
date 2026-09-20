/**
 * Unit tests for the strict Google sign-in gate (src/lib/auth/googleFlow.ts).
 *
 * The property under test: the onboarding wizard may advance ONLY when
 * `runGoogleSignIn` yields `signed-in`, which requires a valid Firebase user
 * object — never on a mock session, a cancelled popup or an error.
 *
 * Run with: npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { User } from "firebase/auth";
import { runGoogleSignIn, type GoogleAuthRunner } from "../../src/lib/auth/googleFlow";

const fbError = (code: string) => Object.assign(new Error(code), { code });
const fakeUser = (uid: string): User => ({ uid }) as unknown as User;

type Runner = GoogleAuthRunner & { calls: string[] };

function makeRunner(opts: {
  isMobile?: boolean;
  popup?: () => Promise<{ user: User }>;
  redirect?: () => Promise<void>;
  persistence?: () => Promise<boolean | void>;
}): Runner {
  const calls: string[] = [];
  return {
    calls,
    isMobile: opts.isMobile,
    ensurePersistence:
      opts.persistence ??
      (async () => {
        calls.push("persistence");
        return true;
      }),
    signInWithPopup: async () => {
      calls.push("popup");
      return (opts.popup ?? (() => Promise.reject(fbError("auth/popup-closed-by-user"))))();
    },
    signInWithRedirect: async () => {
      calls.push("redirect");
      return (opts.redirect ?? (async () => {}))();
    },
    onRedirectStart: () => calls.push("redirect-start"),
  };
}

/* ------------------------------------------------------------------ */
/*  Mobile: full-page redirect from the start                          */
/* ------------------------------------------------------------------ */

test("mobile: starts the redirect immediately and never attempts the popup", async () => {
  let popupCalled = false;
  const runner = makeRunner({
    isMobile: true,
    popup: async () => {
      popupCalled = true;
      return { user: fakeUser("should-not-be-used") };
    },
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "redirect-started");
  assert.equal(popupCalled, false, "the popup must never be attempted on mobile");
  assert.deepEqual(runner.calls, ["persistence", "redirect-start", "redirect"]);
});

test("mobile: a redirect that fails maps to a typed failure (no sign-in)", async () => {
  const runner = makeRunner({
    isMobile: true,
    redirect: async () => {
      throw fbError("auth/unauthorized-domain");
    },
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.code, "unauthorized-domain");
    assert.equal(outcome.report.code, "auth/unauthorized-domain");
    assert.equal(outcome.report.scope, "signInWithRedirect");
    assert.match(outcome.report.hint ?? "", /Authorized domains/);
  }
});

/* ------------------------------------------------------------------ */
/*  Desktop popup: success requires a valid Firebase user object       */
/* ------------------------------------------------------------------ */

test("desktop: resolves `signed-in` only with a valid Firebase user", async () => {
  const user = fakeUser("uid-123");
  const runner = makeRunner({
    isMobile: false,
    popup: async () => ({ user }),
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "signed-in");
  if (outcome.kind === "signed-in") assert.equal(outcome.user, user);
  assert.deepEqual(runner.calls, ["persistence", "popup"], "persistence is awaited BEFORE the popup");
});

test("desktop: a popup resolving without a user object is a failure, not a sign-in", async () => {
  const runner = makeRunner({
    isMobile: false,
    popup: async () => ({ user: {} as User }),
  });
  const outcome = await runGoogleSignIn(runner);
  assert.notEqual(outcome.kind, "signed-in");
  assert.equal(outcome.kind, "failed");
});

test("desktop: a popup resolving with an empty credential is a failure", async () => {
  const runner = makeRunner({
    isMobile: false,
    popup: async () => ({} as unknown as { user: User }),
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "failed");
});

/* ------------------------------------------------------------------ */
/*  Desktop popup: cancellations stay on step 1 (no redirect)          */
/* ------------------------------------------------------------------ */

for (const code of [
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/cancelled-redirect",
  "auth/redirect-cancelled-by-user",
]) {
  test(`desktop: ${code} → user-cancelled, no redirect, no sign-in`, async () => {
    let redirectCalled = false;
    const runner = makeRunner({
      isMobile: false,
      popup: async () => {
        throw fbError(code);
      },
      redirect: async () => {
        redirectCalled = true;
      },
    });
    const outcome = await runGoogleSignIn(runner);
    assert.equal(outcome.kind, "user-cancelled");
    if (outcome.kind === "user-cancelled") {
      assert.equal(outcome.report.code, code, "the raw Firebase code must reach the UI report");
      assert.equal(outcome.report.appCode, "popup-closed");
      assert.equal(outcome.report.scope, "signInWithPopup");
    }
    assert.equal(redirectCalled, false, "a cancelled popup must never trigger a redirect");
    assert.deepEqual(runner.calls, ["persistence", "popup"]);
  });
}

/* ------------------------------------------------------------------ */
/*  Desktop popup: setup errors are surfaced, never retried            */
/* ------------------------------------------------------------------ */

test("desktop: auth/unauthorized-domain → dedicated outcome, no redirect", async () => {
  let redirectCalled = false;
  const runner = makeRunner({
    isMobile: false,
    popup: async () => {
      throw fbError("auth/unauthorized-domain");
    },
    redirect: async () => {
      redirectCalled = true;
    },
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "unauthorized-domain");
  if (outcome.kind === "unauthorized-domain") {
    assert.equal(outcome.report.code, "auth/unauthorized-domain");
    assert.equal(outcome.report.appCode, "unauthorized-domain");
  }
  assert.equal(redirectCalled, false);
});

/* ------------------------------------------------------------------ */
/*  Desktop popup: blocked/unsupported → redirect fallback             */
/* ------------------------------------------------------------------ */

for (const code of ["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"]) {
  test(`desktop: ${code} → falls back to the full-page redirect`, async () => {
    const runner = makeRunner({
      isMobile: false,
      popup: async () => {
        throw fbError(code);
      },
    });
    const outcome = await runGoogleSignIn(runner);
    assert.equal(outcome.kind, "redirect-started");
    assert.deepEqual(runner.calls, ["persistence", "popup", "persistence", "redirect-start", "redirect"]);
  });
}

test("desktop: network failure on the popup still falls back to the redirect", async () => {
  const runner = makeRunner({
    isMobile: false,
    popup: async () => {
      throw fbError("auth/network-request-failed");
    },
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "redirect-started");
});

test("desktop: when the redirect fallback also fails, a typed failure is returned", async () => {
  const runner = makeRunner({
    isMobile: false,
    popup: async () => {
      throw fbError("auth/popup-blocked");
    },
    redirect: async () => {
      throw fbError("auth/network-request-failed");
    },
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.code, "network");
    assert.equal(outcome.report.code, "auth/network-request-failed");
    assert.equal(outcome.report.scope, "signInWithRedirect", "the redirect attempt is reported last");
  }
  assert.deepEqual(runner.calls, ["persistence", "popup", "persistence", "redirect-start", "redirect"]);
});

/* ------------------------------------------------------------------ */
/*  No outcome may both "sign in" and come from anything but a user    */
/* ------------------------------------------------------------------ */

test("signed-in is only ever produced from the popup success path", async () => {
  const scenarios = [
    makeRunner({ isMobile: true }),
    makeRunner({ isMobile: false, popup: async () => ({ user: {} as User }) }),
    makeRunner({ isMobile: false }), // default: popup rejects popup-closed
  ];
  for (const runner of scenarios) {
    const outcome = await runGoogleSignIn(runner);
    assert.notEqual(outcome.kind, "signed-in", `unexpected sign-in: ${JSON.stringify(outcome)}`);
  }
});

/* ------------------------------------------------------------------ */
/*  Persistence runs BEFORE any popup/redirect, and never blocks it     */
/* ------------------------------------------------------------------ */

test("persistence is enabled before the popup — order is guaranteed", async () => {
  const runner = makeRunner({ isMobile: false, popup: async () => ({ user: fakeUser("uid-1") }) });
  await runGoogleSignIn(runner);
  assert.deepEqual(runner.calls, ["persistence", "popup"]);
});

test("a persistence failure is logged but still attempts the popup", async () => {
  const runner = makeRunner({
    isMobile: false,
    persistence: async () => false,
    popup: async () => ({ user: fakeUser("uid-2") }),
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "signed-in");
});

test("a thrown persistence error never aborts the sign-in attempt", async () => {
  const runner = makeRunner({
    isMobile: true,
    persistence: async () => {
      throw fbError("auth/web-storage-unsupported");
    },
    redirect: async () => {},
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "redirect-started");
});

/* ------------------------------------------------------------------ */
/*  Popup failure reports carry the raw code + message to the UI        */
/* ------------------------------------------------------------------ */

test("an unexpected popup rejection is reported with code, message and scope", async () => {
  const runner = makeRunner({
    isMobile: false,
    popup: async () => {
      const error = Object.assign(new Error("The popup has been blocked by the browser"), {
        code: "auth/popup-blocked-by-browser",
      });
      throw error;
    },
    redirect: async () => {
      throw Object.assign(new Error("Redirect sign-in is not supported"), {
        code: "auth/operation-not-supported-in-this-environment",
      });
    },
  });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.code, "operation-not-supported");
    assert.equal(outcome.report.code, "auth/operation-not-supported-in-this-environment");
    assert.equal(outcome.report.message, "Redirect sign-in is not supported");
    assert.equal(outcome.report.scope, "signInWithRedirect");
    assert.match(outcome.report.hint ?? "", /headless browser|iframe|mobile web views/);
  }
});

test("a popup resolving without a user produces an on-screen report, never a sign-in", async () => {
  const runner = makeRunner({ isMobile: false, popup: async () => ({ user: {} as User }) });
  const outcome = await runGoogleSignIn(runner);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.equal(outcome.report.code, "auth/internal-error");
    assert.match(outcome.report.message, /without a Firebase user/);
    assert.equal(outcome.report.scope, "signInWithPopup");
  }
});
