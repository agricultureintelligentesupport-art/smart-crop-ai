import { expect, test } from "@playwright/test";
import { ASSISTANT } from "../src/lib/assistant/copy";
import { CHAT_HISTORY_COPY, IMAGE_PLACEHOLDER, LOCAL_HISTORY_PREFIX } from "../src/lib/assistant/history";

/**
 * Chat-history persistence, at the size the farmer actually uses (390 px).
 *
 * The conversation must survive leaving and coming back — and must do so
 * without changing what the assistant receives: the restored turns are shown
 * on screen but never enter the request payload, which is exactly the payload
 * this session typed (same keys, same `history` window as today).
 *
 * Uses the app's on-device session: the persistence fallback under test is the
 * localStorage one (uid `local_…`, no Firebase user), so Firestore is never
 * called from here.
 */
const copy = ASSISTANT.ar;
const historyCopy = CHAT_HISTORY_COPY.ar;
/** Kept in sync with the profile seeded in `beforeEach`. */
const UID = "local_chat_history_e2e";
const STORAGE_KEY = `${LOCAL_HISTORY_PREFIX}${UID}`;
/** 4×4 green PNG — enough for the picker, the decoder and the request path. */
const PNG_4x4 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEElEQVQImWNQ6laCIwbiOABQowzxW+OR5QAAAABJRU5ErkJggg==";

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("smart-crop.lang.v1", "ar");
    localStorage.setItem(
      "smart-crop.profile.v1",
      JSON.stringify({
        uid: "local_chat_history_e2e",
        method: "email",
        displayName: "Test farmer",
        role: "farmer",
        wilayaCode: "07",
        updatedAt: Date.now(),
      }),
    );
  });
});

test("the conversation is restored after a reload and the next reply is normal", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  let replies = 0;
  await page.route("**/api/assistant", async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    replies += 1;
    await route.fulfill({ json: { reply: `الرد ${replies}`, source: "llm", diagnosis: null } });
  });

  await page.goto("/assistant");
  const composer = page.getByRole("textbox");
  await composer.fill("كيف أسقي الطماطم؟");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText("الرد 1", { exact: true })).toBeVisible();
  expect(bodies[0].history).toEqual([]);

  // Leave and come back: both turns are still there.
  await page.reload();
  await expect(page.getByText("كيف أسقي الطماطم؟", { exact: true })).toBeVisible();
  await expect(page.getByText("الرد 1", { exact: true })).toBeVisible();

  await composer.fill("وماذا عن السماد؟");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText("الرد 2", { exact: true })).toBeVisible();

  const next = bodies.at(-1) as Record<string, unknown>;
  // The request is the one this session typed — unchanged keys, unchanged window.
  expect(Object.keys(next).sort()).toEqual(["context", "history", "message"]);
  expect(next.message).toBe("وماذا عن السماد؟");
  expect(next.image).toBeUndefined();
  // Restored turns are on screen, never fed to the model.
  expect(next.history).toEqual([]);
});

test("«مسح المحادثة» asks for confirmation, then clears for good", async ({ page }) => {
  await page.route("**/api/assistant", (route) =>
    route.fulfill({ json: { reply: "الرد", source: "llm", diagnosis: null } }),
  );

  await page.goto("/assistant");
  await page.getByRole("textbox").fill("سؤال");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText("الرد", { exact: true })).toBeVisible();

  const clearButton = page.getByRole("button", { name: historyCopy.clear });
  await expect(clearButton).toBeVisible();

  // Declining the confirmation keeps everything.
  page.once("dialog", (dialog) => dialog.dismiss());
  await clearButton.click();
  await expect(page.getByText("سؤال", { exact: true })).toBeVisible();

  // Accepting it clears the screen, the store, and the next visit.
  page.once("dialog", (dialog) => dialog.accept());
  await clearButton.click();
  await expect(page.getByText("سؤال", { exact: true })).toHaveCount(0);
  await expect(page.getByText(copy.hero.greeting)).toBeVisible();
  await expect(clearButton).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("سؤال", { exact: true })).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
});

test("an attached photo is never persisted — only the «صورة» placeholder", async ({ page }) => {
  await page.route("**/api/assistant", (route) =>
    route.fulfill({ json: { reply: "شُخّصت الورقة", source: "hybrid", diagnosis: null } }),
  );

  await page.goto("/assistant");
  await page.setInputFiles('input[type="file"]', {
    name: "leaf.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_4x4, "base64"),
  });
  await expect(page.getByText(copy.composer.imageAlt)).toBeVisible();

  await page.getByRole("textbox").fill("ما هذا المرض؟");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText("شُخّصت الورقة", { exact: true })).toBeVisible();

  const stored = (await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)) ?? "";
  expect(stored).toContain(IMAGE_PLACEHOLDER);
  expect(stored).not.toContain("base64");
  expect(stored).not.toContain("data:image");
  expect(stored).not.toContain("iVBOR");

  // The turn is still restored (as the placeholder, without the photo).
  await page.reload();
  await expect(page.getByText("ما هذا المرض؟", { exact: true })).toBeVisible();
});
