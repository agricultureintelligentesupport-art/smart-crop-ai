import { expect, test, type Locator } from "@playwright/test";

/**
 * Collapsible "مهام اليوم الموصى بها (AI)" checklist inside the hero card.
 *
 * The checklist ships **collapsed**: the first (highest-priority) task stays on
 * screen and the rest wait behind the glass pill at the foot of the card, so on
 * a phone the decision card stays a quick read. This spec pins the three
 * promises of that feature:
 *
 *   1. collapsed by default → one checkbox, pill reads «عرض باقي المهام (n+) ▾»;
 *   2. expanding reveals every remaining task (badges, descriptions, boxes) and
 *      the pill flips to «طي القائمة ▴»;
 *   3. the boundary — the hero's own figures never move, and a checked task
 *      stays checked across collapse/expand and a full reload.
 *
 * Reference weather is forced (Open-Meteo aborted) so the numbers quoted below
 * are the deterministic wilaya baseline, exactly like `field-heatmap-flow`.
 */
test.beforeEach(async ({ page }) => {
  await page.route("https://api.open-meteo.com/**", (route) => route.abort());
  await page.goto("/guest");
  await expect(page.getByRole("button", { name: "لكل هكتار: عرض خطوات الحساب" })).toBeVisible();
});

/** The checklist block (its own labelled region inside the hero region). */
function checklist(page: import("@playwright/test").Page): Locator {
  return page.getByRole("region", { name: "مهام اليوم الموصى بها (AI)" });
}

/** The day's total, straight from the progress bar the card renders. */
async function taskTotal(page: import("@playwright/test").Page): Promise<number> {
  const max = await checklist(page).getByRole("progressbar").getAttribute("aria-valuemax");
  return Number(max);
}

/** The toggle pill — its accessible name flips between the two states. */
function togglePill(card: Locator): Locator {
  return card.getByRole("button", { name: /عرض باقي المهام|طي القائمة/ });
}

/** Every task title on screen, taken from the checkboxes' accessible names. */
async function taskTitles(card: Locator): Promise<string[]> {
  const labels = await card.getByRole("checkbox").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? ""),
  );
  return labels.map((label) => label.replace("تعليم المهمة كمنجزة: ", ""));
}

test("the checklist is collapsed by default: first task only, pill at the foot", async ({ page }) => {
  const card = checklist(page);
  const total = await taskTotal(page);
  expect(total).toBeGreaterThanOrEqual(3);

  // Header copy stays: the section title, the progress counter and the bar.
  await expect(card.getByRole("heading", { name: "مهام اليوم الموصى بها (AI)" })).toBeVisible();
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuemax", String(total));

  // Exactly one checkable row — the generator's first, highest-priority task.
  const boxes = card.getByRole("checkbox");
  await expect(boxes).toHaveCount(1);
  await expect(boxes.first()).toHaveAccessibleName(/تعليم المهمة كمنجزة: /);

  // The pill carries the live hidden count and the collapsed chevron.
  const pill = togglePill(card);
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(pill).toContainText(`عرض باقي المهام (${total - 1}+)`);
  await expect(pill).toContainText("▾");

  // 44px touch target, and it never pushes the card sideways on a phone.
  const box = await pill.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("expanding reveals every task and collapsing puts them back", async ({ page }) => {
  const card = checklist(page);
  const total = await taskTotal(page);
  const pill = togglePill(card);

  // The hero's own numbers, captured before the toggle — they must not move.
  const need = page.getByRole("region", { name: "قرار اليوم" }).getByText("حاجة القطعة اليوم").locator("..");
  const needBefore = await need.innerText();
  const perHaBefore = await page.getByRole("button", { name: "لكل هكتار: عرض خطوات الحساب" }).innerText();

  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(pill).toContainText("طي القائمة");

  // Every task is now rendered, in full: titles, badges and descriptions.
  const boxes = card.getByRole("checkbox");
  await expect(boxes).toHaveCount(total);
  await expect(card.getByText("💧 سقي").first()).toBeVisible();
  await expect(card.getByText("🚜 تسميد/صيانة").first()).toBeVisible();
  await expect(card.getByText(/عالية|عادية/).first()).toBeVisible();
  await expect(card.getByText("✨ تم تحديث المهام بواسطة الذكاء الاصطناعي - اليوم 00:00")).toBeVisible();

  // Nothing above the checklist was recomputed by opening it.
  expect(await need.innerText()).toBe(needBefore);
  expect(await page.getByRole("button", { name: "لكل هكتار: عرض خطوات الحساب" }).innerText()).toBe(perHaBefore);

  // Collapse again — with the keyboard this time: the pill is a real button,
  // focusable and operable with Enter.
  await pill.focus();
  await page.keyboard.press("Enter");
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(pill).toContainText(`عرض باقي المهام (${total - 1}+)`);
  await expect(card.getByRole("checkbox")).toHaveCount(1);
});

test("a checked task keeps its tick through collapse, expand and reload", async ({ page }) => {
  const card = checklist(page);
  const total = await taskTotal(page);
  const pill = togglePill(card);

  await pill.click();
  await expect(card.getByRole("checkbox")).toHaveCount(total);
  const titles = await taskTitles(card);
  const second = titles[1];

  // Tick the second task the way a farmer does — on the row itself.
  await card.getByText(second, { exact: true }).click();
  await expect(card.getByRole("checkbox").nth(1)).toBeChecked();

  // Checked state survives the collapse (its row is unmounted)…
  await pill.click();
  await expect(card.getByRole("checkbox")).toHaveCount(1);
  await pill.click();
  await expect(card.getByRole("checkbox").nth(1)).toBeChecked();
  // …and the plan itself is untouched: same tasks, same order.
  expect(await taskTitles(card)).toEqual(titles);

  // …and a full reload: cached set + per-day done map come back.
  await page.reload();
  await expect(pill).toBeVisible();
  await expect(card.getByRole("checkbox")).toHaveCount(1);
  await pill.click();
  await expect(card.getByRole("checkbox")).toHaveCount(total);
  await expect(card.getByRole("checkbox").nth(1)).toBeChecked();
  expect(await taskTitles(card)).toEqual(titles);
});

// Narrow phones: 360×640 is the smallest target the design rules commit to,
// 320px is the stress case the redesign screenshots already cover.
for (const width of [320, 360, 412]) {
  test(`stays usable at ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const card = checklist(page);
    const pill = togglePill(card);

    await expect(card.getByRole("heading", { name: "مهام اليوم الموصى بها (AI)" })).toBeVisible();
    await expect(card.getByRole("checkbox")).toHaveCount(1);
    const box = await pill.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // Expanding at this width keeps the same guarantees.
    await pill.click();
    await expect(pill).toContainText("طي القائمة");
    await expect(card.getByRole("checkbox").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
}

// Reduced motion (WCAG 2.2 AA, design rules §5): the height travel is dropped
// for a short fade, but the feature itself must still work end to end.
test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the toggle still reveals and hides every task without travel", async ({ page }) => {
    const card = checklist(page);
    const total = await taskTotal(page);
    const pill = togglePill(card);

    await expect(card.getByRole("checkbox")).toHaveCount(1);
    await pill.click();
    await expect(pill).toHaveAttribute("aria-expanded", "true");
    await expect(card.getByRole("checkbox")).toHaveCount(total);
    await pill.click();
    await expect(pill).toHaveAttribute("aria-expanded", "false");
    await expect(card.getByRole("checkbox")).toHaveCount(1);
  });
});
