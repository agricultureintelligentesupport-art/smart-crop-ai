import { expect, test, type Page } from "@playwright/test";

/* ------------------------------------------------------------------ */
/*  Google sign-in failures are reported ON SCREEN                     */
/* ------------------------------------------------------------------ */

/**
 * The bug this spec pins: a rejected `signInWithPopup` /
 * `signInWithRedirect` / `getRedirectResult` used to be visible only in the
 * browser console (the button just stopped spinning). Now every failure renders
 * `error.code`, `error.message`, the actionable hint and the Firebase
 * diagnostics under the Google button.
 *
 * A real Google chooser cannot be completed headlessly, so — exactly like
 * `google-redirect.spec.ts` — the two SDK entry points are stubbed at the
 * function source inside the dev-server JS chunks. Everything above the seam
 * (runGoogleSignIn, useAuthFlow, the panel) is the real app code.
 *
 * Dev-only by design: the anchors match Turbopack's readable dev output, so
 * against a production build the tests fail loudly instead of passing silently.
 */

const FAILURE = {
  code: "auth/unauthorized-domain",
  message: "This domain (preview-host.e2b.app) is not authorized to run this operation.",
};

async function stubGoogleFailure(page: Page) {
  await page.addInitScript(failure => {
    (window as unknown as Record<string, unknown>).__googleFailure = failure;
  }, FAILURE);

  await page.route(/_next\/static\/chunks\//, async route => {
    const response = await route.fetch();
    const original = await response.text();
    const throwMock = `if (window.__googleFailure) { throw Object.assign(new Error(window.__googleFailure.message), { code: window.__googleFailure.code }); }`;

    const body = original
      .replace(
        "async function signInWithPopup(auth, provider, resolver) {",
        `async function signInWithPopup(auth, provider, resolver) { ${throwMock}`,
      )
      .replace(
        "function signInWithRedirect(auth, provider, resolver) {",
        `function signInWithRedirect(auth, provider, resolver) { ${throwMock}`,
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

/** The panel is the only `role="alert"` carrying the provider code. */
function errorPanel(page: Page) {
  return page.locator('[role="alert"]').filter({ hasText: FAILURE.code });
}

test.describe("google failure reporting", () => {
  test("a rejected popup/redirect shows error.code, error.message, the hint and the diagnostics", async ({
    page,
  }) => {
    const logs: string[] = [];
    page.on("console", message => logs.push(message.text()));

    await stubGoogleFailure(page);
    await page.goto("/auth");
    await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();

    await page.getByRole("button", { name: /Google/ }).click();

    const panel = errorPanel(page);
    await expect(panel).toBeVisible();

    // 1 · the raw provider facts are on screen, verbatim
    await expect(panel).toContainText(FAILURE.code);
    await expect(panel).toContainText(FAILURE.message);

    // 2 · plus the localised copy and the actionable hint
    await expect(panel).toContainText("نطاق هذا الموقع غير مصرّح به");
    await expect(panel).toContainText(/Authorized domains/i);

    // 3 · the diagnostics table explains the environment behind the failure
    await panel.getByText("تشخيص Firebase").click();
    await expect(panel).toContainText("http://localhost:3000"); // origin
    await expect(panel).toContainText("persistence"); // browserLocalPersistence state
    await expect(panel).toContainText("backend"); // firebase | demo

    // 4 · a copy-details action exists for support hand-offs
    await expect(panel.getByRole("button", { name: /نسخ التفاصيل/ })).toBeVisible();

    // 5 · the raw failure is also logged with its code, never swallowed
    expect(logs.some(line => line.includes(FAILURE.code))).toBe(true);
  });

  test("browserLocalPersistence is enabled before the popup/redirect is attempted", async ({ page }) => {
    const logs: string[] = [];
    page.on("console", message => logs.push(message.text()));

    await stubGoogleFailure(page);
    await page.goto("/auth");
    await page.getByRole("button", { name: /Google/ }).click();
    await expect(errorPanel(page)).toBeVisible();

    // The app always tries first (the popup path logs "signInWithPopup",
    // the mobile path "signInWithRedirect"). The strict ordering guarantee —
    // persistence awaited BEFORE the SDK call — is pinned in
    // test/unit/google-flow.unit.test.ts; here we prove a real browser really
    // runs setPersistence(auth, browserLocalPersistence).
    expect(
      logs.some(line => /browserLocalPersistence/.test(line)),
      `persistence was never attempted before the sign-in:\n${logs.join("\n")}`,
    ).toBe(true);
  });

  test("a failure keeps the wizard on step 1 (never a fake advance)", async ({ page }) => {
    await stubGoogleFailure(page);
    await page.goto("/auth");
    await page.getByRole("button", { name: /Google/ }).click();
    await expect(errorPanel(page)).toBeVisible();

    await expect(page.getByRole("heading", { name: "تحديد صفة المستخدم" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
  });
});
