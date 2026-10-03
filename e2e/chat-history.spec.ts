import { expect, test } from "@playwright/test";
import { ASSISTANT } from "../src/lib/assistant/copy";
import { HISTORY_COPY } from "../src/lib/assistant/historyCopy";
import { CHAT_HISTORY_COPY, IMAGE_PLACEHOLDER, LOCAL_HISTORY_PREFIX } from "../src/lib/assistant/history";
import { LOCAL_CONVERSATIONS_DOC_PREFIX } from "../src/lib/assistant/conversations";

/**
 * Chat-history persistence + the conversation drawer, at the size the farmer
 * actually uses (390 px).
 *
 * The conversation must survive leaving and coming back — and must do so
 * without changing what the assistant receives: the restored turns are shown
 * on screen but never enter the request payload, which is exactly the payload
 * this session typed (same keys, same `history` window as today). Switching
 * between saved conversations must not change that either.
 *
 * Uses the app's on-device session: the persistence fallback under test is the
 * localStorage one (uid `local_…`, no Firebase user), so Firestore is never
 * called from here.
 */
const copy = ASSISTANT.ar;
const hc = HISTORY_COPY.ar;
/** Kept in sync with the profile seeded in `beforeEach`. */
const UID = "local_chat_history_e2e";
/** The INDEX reuses the exact slot the single-conversation feature used (see `conversations.ts`). */
const INDEX_STORAGE_KEY = `${LOCAL_HISTORY_PREFIX}${UID}`;
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

/** Every localStorage value stored under a per-conversation key for this identity (never the index). */
async function conversationDocValues(page: import("@playwright/test").Page, uid: string): Promise<string[]> {
  return page.evaluate((args) => {
    const [prefix, theUid] = args;
    const values: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`${prefix}${theUid}:`)) {
        const value = localStorage.getItem(key);
        if (value) values.push(value);
      }
    }
    return values;
  }, [LOCAL_CONVERSATIONS_DOC_PREFIX, uid] as const);
}

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

  // Leave and come back: both turns are still there, instantly (no re-typing).
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

test("the header has no trash button — history lives in the drawer instead", async ({ page }) => {
  await page.route("**/api/assistant", (route) =>
    route.fulfill({ json: { reply: "الرد", source: "llm", diagnosis: null } }),
  );
  await page.goto("/assistant");
  await expect(page.getByRole("banner").getByRole("button", { name: hc.menu })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("button", { name: hc.newChat })).toBeVisible();
  await expect(page.getByRole("button", { name: CHAT_HISTORY_COPY.ar.clear })).toHaveCount(0);
});

test("the drawer switches between conversations instantly and a new chat starts clean", async ({ page }) => {
  let n = 0;
  await page.route("**/api/assistant", async (route) => {
    n += 1;
    await route.fulfill({ json: { reply: `رد ${n}`, source: "llm", diagnosis: null } });
  });

  await page.goto("/assistant");
  const composer = page.getByRole("textbox");

  // First conversation.
  await composer.fill("ما هو أفضل سماد؟");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText("رد 1", { exact: true })).toBeVisible();

  // A fresh chat, started from the header shortcut, shows neither old turn.
  await page.getByRole("banner").getByRole("button", { name: hc.newChat }).click();
  await expect(page.getByText("ما هو أفضل سماد؟")).toHaveCount(0);
  await composer.fill("كيف أحمي القمح من الآفات؟");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText("رد 2", { exact: true })).toBeVisible();

  // Both conversations are listed, newest first, grouped under «اليوم».
  await page.getByRole("banner").getByRole("button", { name: hc.menu }).click();
  const drawer = page.getByRole("dialog", { name: hc.drawerTitle });
  await expect(drawer.getByText(hc.groups.today)).toBeVisible();
  await expect(drawer.getByText("كيف أحمي القمح من الآفات؟")).toBeVisible();
  await expect(drawer.getByText("ما هو أفضل سماد؟")).toBeVisible();

  // Switching back is instant — no re-typing, no empty flash.
  await drawer.getByText("ما هو أفضل سماد؟").click();
  await expect(page.getByText("ما هو أفضل سماد؟")).toBeVisible();
  await expect(page.getByText("رد 1", { exact: true })).toBeVisible();
  await expect(page.getByText("كيف أحمي القمح من الآفات؟")).toHaveCount(0);
});

test("renaming and deleting one conversation from the drawer work, with confirmation for delete", async ({ page }) => {
  await page.route("**/api/assistant", (route) =>
    route.fulfill({ json: { reply: "رد", source: "llm", diagnosis: null } }),
  );
  await page.goto("/assistant");
  await page.getByRole("textbox").fill("سؤال للتسمية");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText("رد", { exact: true })).toBeVisible();

  await page.getByRole("banner").getByRole("button", { name: hc.menu }).click();
  const drawer = page.getByRole("dialog", { name: hc.drawerTitle });
  await drawer.getByRole("button", { name: hc.itemMenu }).click();
  await drawer.getByRole("menuitem", { name: hc.rename }).click();
  const renameInput = drawer.getByRole("textbox");
  await renameInput.fill("اسم مخصص");
  await renameInput.press("Enter");
  await expect(drawer.getByText("اسم مخصص")).toBeVisible();

  await drawer.getByRole("button", { name: hc.itemMenu }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await drawer.getByRole("menuitem", { name: hc.deleteOne }).click();
  await expect(drawer.getByText(hc.emptyList)).toBeVisible();
});

test("«حذف كل المحادثات» asks for confirmation, then clears everything for good", async ({ page }) => {
  await page.route("**/api/assistant", (route) =>
    route.fulfill({ json: { reply: "الرد", source: "llm", diagnosis: null } }),
  );

  await page.goto("/assistant");
  await page.getByRole("textbox").fill("سؤال");
  await page.getByRole("button", { name: copy.composer.send, exact: true }).click();
  await expect(page.getByText("الرد", { exact: true })).toBeVisible();

  await page.getByRole("banner").getByRole("button", { name: hc.menu }).click();
  const drawer = page.getByRole("dialog", { name: hc.drawerTitle });
  const deleteAllButton = drawer.getByRole("button", { name: hc.deleteAll });
  await expect(deleteAllButton).toBeVisible();

  // Declining the confirmation keeps everything.
  page.once("dialog", (dialog) => dialog.dismiss());
  await deleteAllButton.click();
  await expect(page.getByText("سؤال", { exact: true })).toBeVisible();

  // Accepting it clears the screen, the store, and the next visit.
  page.once("dialog", (dialog) => dialog.accept());
  await deleteAllButton.click();
  await expect(page.getByText("سؤال", { exact: true })).toHaveCount(0);
  await expect(page.getByText(copy.hero.greeting)).toBeVisible();

  await page.reload();
  await expect(page.getByText("سؤال", { exact: true })).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), INDEX_STORAGE_KEY)).toBeNull();
  expect(await conversationDocValues(page, UID)).toEqual([]);
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

  // Give the ~800ms debounce (or the pagehide flush on reload) time to land.
  await expect(async () => {
    const values = await conversationDocValues(page, UID);
    expect(values.some((v) => v.includes(IMAGE_PLACEHOLDER))).toBe(true);
  }).toPass({ timeout: 5000 });

  const values = await conversationDocValues(page, UID);
  const blob = values.join("\n");
  expect(blob).toContain(IMAGE_PLACEHOLDER);
  expect(blob).not.toContain("base64");
  expect(blob).not.toContain("data:image");
  expect(blob).not.toContain("iVBOR");

  // The turn is still restored (as the placeholder, without the photo).
  await page.reload();
  await expect(page.getByText("ما هذا المرض؟", { exact: true })).toBeVisible();
});
