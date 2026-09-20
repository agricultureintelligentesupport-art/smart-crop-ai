import { expect, test, type Page } from "@playwright/test";

/* ------------------------------------------------------------------ */
/*  Google redirect RETURN handling (getRedirectResult + auth state)   */
/* ------------------------------------------------------------------ */

/**
 * These specs drive the exact bug that reset the wizard to Step 1 (“الطريقة”)
 * after picking a Google account on the redirect path: the page reloads,
 * and only `getRedirectResult()` (or, failing that, the Firebase session
 * restored via `onAuthStateChanged`) can capture the sign-in.
 *
 * A real Google chooser cannot be completed headlessly (see auth-flow.spec
 * §3), so instead the two Firebase SDK entry points are stubbed AT THE SDK
 * FUNCTION inside the dev-server JS chunks (the function source is verbatim
 * in `next dev` output), plus `syncUserDoc` in the app chunk so the
 * users/{uid} write is observable without touching the network. Everything
 * above those seams — the mount effect in `useAuthFlow`, the return gate,
 * afterAuth, the wizard — is the real app code.
 *
 * Dev-only by design: the stubs match Turbopack's readable dev output;
 * against a production build the anchors vanish and the tests fail loudly
 * (they never silently pass).
 */

const GOOGLE_USER = {
  uid: "mock-google-uid-777",
  displayName: "سمير الفلاح",
  email: "samir.fallah@gmail.com",
  photoURL: "https://lh3.googleusercontent.com/a/mock-avatar=s96-c",
  providerData: [{ providerId: "google.com" }],
  phoneNumber: null,
} as const;

type MockConfig = {
  /** What getRedirectResult() should hand back on this load (null = payload lost). */
  redirectUser: typeof GOOGLE_USER | null;
  /** What the restored Firebase session (onAuthStateChanged) looks like. */
  authedUser: typeof GOOGLE_USER | null;
};

async function stubFirebaseReturn(page: Page, config: MockConfig) {
  await page.addInitScript(cfg => {
    const w = window as unknown as Record<string, unknown>;
    w.__mockFirebase = true;
    w.__mockRedirectUser = cfg.redirectUser;
    w.__mockAuthUser = cfg.authedUser;
    w.__syncCalls = [];
  }, config);

  await page.route(/_next\/static\/chunks\//, async route => {
    const response = await route.fetch();
    const original = await response.text();
    let body = original;

    // 1 · firebase/auth chunk — getRedirectResult()
    body = body.replace(
      "async function getRedirectResult(auth, resolver) {",
      'async function getRedirectResult(auth, resolver) { if (window.__mockFirebase) { return window.__mockRedirectUser ? { user: window.__mockRedirectUser, operationType: "signInViaRedirect" } : null; }',
    );
    // 1 · firebase/auth chunk — onAuthStateChanged()
    body = body.replace(
      "function onAuthStateChanged(auth, nextOrObserver, error, completed) {",
      'function onAuthStateChanged(auth, nextOrObserver, error, completed) { if (window.__mockFirebase) { const __u = window.__mockAuthUser || null; const __id = setTimeout(() => { if (typeof nextOrObserver === "function") nextOrObserver(__u); else nextOrObserver?.next?.(__u); }, 30); return () => clearTimeout(__id); }',
    );
    // 2 · app chunk — syncUserDoc(): record the users/{uid} sync, resolve offline
    body = body.replace(
      /async function syncUserDoc\(([^\n]*)\) \{/,
      (m) =>
        m +
        " if (window.__mockFirebase) { (window.__syncCalls = window.__syncCalls || []).push({ input: arguments[0], patch: arguments[1] }); await new Promise((r) => setTimeout(r, 120)); return { ok: true, data: Object.assign({}, arguments[0], arguments[1]) }; }",
    );

    if (body === original) {
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({
      response,
      body,
      headers: { ...response.headers(), "content-type": "application/javascript" },
    });
  });
}

const syncCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __syncCalls: unknown[] }).__syncCalls);

const storedProfile = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("smart-crop.profile.v1") ?? "null"));

test.describe("google redirect return", () => {
  test("the getRedirectResult payload completes the sign-in and lands on Step 2 (“الصفة”)", async ({
    page,
  }) => {
    await stubFirebaseReturn(page, { redirectUser: GOOGLE_USER, authedUser: GOOGLE_USER });
    await page.goto("/auth");

    // The wizard advances automatically — no click, no reset back to step 1.
    await expect(page.getByRole("heading", { name: "تحديد صفة المستخدم" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("radio")).toHaveCount(3);
    await expect(page).toHaveURL(/\/auth/);

    // The active step on the ladder is #2 “الصفة”.
    await expect(page.locator('button[aria-current="step"]')).toContainText("الصفة");

    // users/{uid} was synced with the Google account info.
    const calls = await syncCalls(page);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(calls[0])).toContain(GOOGLE_USER.email);
    expect(JSON.stringify(calls[0])).toContain(GOOGLE_USER.photoURL);

    // The session + Google profile data (displayName, email, photoURL) landed.
    const profile = await storedProfile(page);
    expect(profile).not.toBeNull();
    expect(profile.uid).toBe(GOOGLE_USER.uid);
    expect(profile.method).toBe("google");
    expect(profile.displayName).toBe(GOOGLE_USER.displayName);
    expect(profile.email).toBe(GOOGLE_USER.email);
    expect(profile.photoURL).toBe(GOOGLE_USER.photoURL);
  });

  test("a lost redirect payload still completes via the restored Firebase session", async ({
    page,
  }) => {
    // Exactly the failure mode that was reported: getRedirectResult() comes
    // back with nothing (payload lost in the round-trip) while Firebase Auth
    // DID restore the signed-in user.
    await stubFirebaseReturn(page, { redirectUser: null, authedUser: GOOGLE_USER });
    await page.goto("/auth");

    await expect(page.getByRole("heading", { name: "تحديد صفة المستخدم" })).toBeVisible({
      timeout: 15_000,
    });
    const profile = await storedProfile(page);
    expect(profile.uid).toBe(GOOGLE_USER.uid);
    expect(profile.email).toBe(GOOGLE_USER.email);
  });

  test("neither a payload nor a session keeps the wizard on Step 1 (never a fake advance)", async ({
    page,
  }) => {
    await stubFirebaseReturn(page, { redirectUser: null, authedUser: null });
    await page.goto("/auth");
    await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();

    // Give any stray completion attempt time to fire, then re-assert.
    await page.waitForTimeout(1500);
    await expect(page.getByRole("heading", { name: "تحديد صفة المستخدم" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
    expect(await storedProfile(page)).toBeNull();
  });
});
