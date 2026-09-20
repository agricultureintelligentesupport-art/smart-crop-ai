import { expect, test } from "@playwright/test";
import { ASSISTANT } from "../src/lib/assistant/copy";

const copy = ASSISTANT.ar;

// Use the app's supported on-device session; no external auth/provider calls.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("smart-crop.lang.v1", "ar");
    localStorage.setItem("smart-crop.profile.v1", JSON.stringify({
      uid: "local_assistant_test",
      method: "email",
      displayName: "Test farmer",
      role: "farmer",
      wilayaCode: "07",
      updatedAt: Date.now(),
    }));
  });
});

test("chat mounts without configuration warnings and reports missing keys only after sending", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/assistant", async route => {
    requests += 1;
    await route.fulfill({
      status: 500,
      json: { error: "API keys missing on server", code: "MISSING_KEYS" },
    });
  });
  await page.goto("/assistant");
  const composer = page.getByRole("textbox");
  await expect(composer).toBeVisible();
  await expect(page.getByText(copy.chat.unavailable, { exact: true })).toHaveCount(0);
  await expect(page.getByText(copy.chat.error, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: copy.chat.retry })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("مفاتيح API");
  expect(requests).toBe(0);

  await composer.fill("كيف أسقي الطماطم؟");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText(copy.chat.unavailable, { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  await expect(page.getByRole("button", { name: copy.chat.retry })).toBeVisible();

  // A corrected server configuration recovers through the existing retry flow.
  await page.unroute("**/api/assistant");
  await page.route("**/api/assistant", route => route.fulfill({
    json: { reply: "اسقِ في الصباح الباكر.", source: "gemini", diagnosis: null },
  }));
  await page.getByRole("button", { name: copy.chat.retry }).click();
  await expect(page.getByText("اسقِ في الصباح الباكر.", { exact: true })).toBeVisible();
  await expect(page.getByText(copy.chat.unavailable, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: copy.chat.retry })).toHaveCount(0);
});

for (const failure of ["upstream", "non-json", "network"] as const) {
  test(`${failure} failure shows a retryable error, not a missing-key warning`, async ({ page }) => {
    await page.route("**/api/assistant", route => {
      if (failure === "network") return route.abort("failed");
      if (failure === "non-json") {
        return route.fulfill({ status: 500, contentType: "text/html", body: "Server error" });
      }
      return route.fulfill({
        status: 502,
        json: { error: "AI service temporarily unavailable", code: "UPSTREAM_ERROR" },
      });
    });
    await page.goto("/assistant");
    await page.getByRole("textbox").fill("كيف أسقي الطماطم؟");
    await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
    await expect(page.getByText(copy.chat.error, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.chat.unavailable, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: copy.chat.retry })).toBeVisible();
  });
}
