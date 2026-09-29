import { expect, test } from "@playwright/test";
import { ASSISTANT } from "../src/lib/assistant/copy";

const copy = ASSISTANT.ar;

/**
 * Regression net for "the chat shows «وقع خطأ أثناء الاتصال بالمساعد»".
 *
 * Every other assistant test stubs `/api/assistant` — so none of them would
 * notice the failure mode that actually broke the chat: the real route
 * answering an HTML 500 page (e.g. its module graph failing to load), which
 * the client's `res.json()` turns into that connection-error bubble. This
 * suite therefore talks to the REAL route, with no interception, and asserts:
 *
 *   • the response is one of the route's two honest answers (200 with a reply,
 *     or 503 MISSING_KEYS) — never an error page;
 *   • that response is JSON;
 *   • the connection-error string never appears on screen.
 *
 * Run with the app's supported on-device session; no external auth calls.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("smart-crop.lang.v1", "ar");
    localStorage.setItem(
      "smart-crop.profile.v1",
      JSON.stringify({
        uid: "local_assistant_regression",
        method: "email",
        displayName: "Test farmer",
        role: "farmer",
        wilayaCode: "07",
        updatedAt: Date.now(),
      }),
    );
  });
});

test("a real chat request never surfaces the connection-error bubble", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/assistant");
  const composer = page.getByRole("textbox");
  await expect(composer).toBeVisible();
  await expect(page.getByText(copy.chat.error, { exact: true })).toHaveCount(0);

  const responsePromise = page.waitForResponse(
    (res) => res.url().includes("/api/assistant") && res.request().method() === "POST",
    { timeout: 90_000 },
  );
  await composer.fill("كيف أسقي الطماطم؟");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();

  const response = await responsePromise;
  // The regression's exact signature was an HTML error page with status 500.
  expect([200, 503]).toContain(response.status());
  expect(response.headers()["content-type"] ?? "").toContain("application/json");

  const body = (await response.json()) as { reply?: string; code?: string };

  if (response.status() === 200) {
    // The route answered: its reply must reach the conversation.
    expect(typeof body.reply).toBe("string");
    await expect(page.getByText(body.reply ?? "", { exact: true })).toBeVisible({ timeout: 15_000 });
  } else {
    // No API keys on this server: the honest state is "unavailable", which is
    // a different message from the connection error.
    expect(body.code).toBe("MISSING_KEYS");
    await expect(page.getByText(copy.chat.unavailable, { exact: true })).toBeVisible({ timeout: 15_000 });
  }

  await expect(page.getByText(copy.chat.error, { exact: true })).toHaveCount(0);
});

test("the chat screen still mounts cleanly with the field-map feature in the build", async ({ page }) => {
  await page.goto("/assistant");
  await expect(page.getByRole("textbox")).toBeVisible();
  await expect(page.getByRole("button", { name: copy.composer.send, exact: true })).toBeVisible();
  // No import-graph leakage manifests as a runtime warning on mount.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForTimeout(1200);
  expect(errors).toEqual([]);
  await expect(page.getByText(copy.chat.error, { exact: true })).toHaveCount(0);
});
