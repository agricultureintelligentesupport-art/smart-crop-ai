import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The quick-access widgets — the 2-column grid that replaced the two long
 * inline weather / calculator sections directly under the decision card.
 *
 * Pinned here:
 *   1. the grid sits directly under the hero and reprints the hero's own
 *      figures (never a second source of truth);
 *   2. each widget opens the matching detail sheet, which holds the complete
 *      view (hourly strip, 7-day forecast, every calculator control);
 *   3. the sheet's edits land in the widget and the decision card in the same
 *      render (shared parcel state);
 *   4. the sheets close by ✕, by Escape and by dragging the handle down; and
 *   5. the grid stays usable at 320/360/412px with 44px+ targets.
 *
 * Reference weather is forced (Open-Meteo aborted), exactly like the other
 * specs, so the figures below are the deterministic Biskra baseline: 34 °C,
 * 28 %, 14 km/h and 110.0 m³ for 2 ha of drip-irrigated dates.
 */
test.beforeEach(async ({ page }) => {
  await page.route("https://api.open-meteo.com/**", (route) => route.abort());
  await page.goto("/guest");
  await expect(page.getByRole("button", { name: /^فتح تفاصيل الطقس/ })).toBeVisible();
});

/** Widget A — weather + forecast. */
function weatherWidget(page: Page): Locator {
  return page.getByRole("button", { name: /^فتح تفاصيل الطقس/ });
}

/** Widget B — irrigation calculator. */
function calculatorWidget(page: Page): Locator {
  return page.getByRole("button", { name: /^فتح حاسبة السقي/ });
}

/** The hero decision card (one container, two zones). */
function hero(page: Page): Locator {
  return page.getByRole("region", { name: "قرار اليوم" });
}

/**
 * Waits out the sheet's slide-up spring (~400ms) and returns the handle's box:
 * a drag has to start from where the handle has actually come to rest.
 */
async function settledHandle(handle: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await handle.page().waitForTimeout(800);
  return (await handle.boundingBox())!;
}

/** The volume a surface advertises, e.g. "110.0 m³" → "110.0". */
async function volume(locator: Locator): Promise<string> {
  const match = (await locator.innerText()).match(/([\d.,]+)\s*m³/);
  if (!match) throw new Error(`no m³ figure in: ${await locator.innerText()}`);
  return match[1];
}

test("the grid sits under the decision card and reprints its figures", async ({ page }) => {
  const weather = weatherWidget(page);
  const calculator = calculatorWidget(page);
  await expect(weather).toBeVisible();
  await expect(calculator).toBeVisible();

  // Two columns on one row, directly under the hero card. (Order is not
  // asserted: the dashboard is RTL by default, so the first widget sits on the
  // right — only "same row, side by side, beneath the card" is the contract.)
  const weatherBox = (await weather.boundingBox())!;
  const calculatorBox = (await calculator.boundingBox())!;
  const heroBox = (await hero(page).boundingBox())!;
  expect(Math.abs(weatherBox.y - calculatorBox.y)).toBeLessThan(4);
  const sideBySide =
    weatherBox.x + weatherBox.width <= calculatorBox.x + 4 ||
    calculatorBox.x + calculatorBox.width <= weatherBox.x + 4;
  expect(sideBySide).toBe(true);
  expect(weatherBox.y).toBeGreaterThan(heroBox.y + heroBox.height - 4);

  // Widget A carries the live weather, its summary chips and its callout.
  await expect(weather).toContainText("الطقس والتوقعات");
  await expect(weather).toContainText("34.0°C");
  await expect(weather).toContainText("28%");
  await expect(weather).toContainText("14 km/h");
  await expect(weather).toContainText("توقعات 7 أيام والاحتياج");

  // Widget B carries the selected crop, the parcel size and the quick output.
  await expect(calculator).toContainText("حاسبة السقي");
  await expect(calculator).toContainText("نخيل التمر");
  await expect(calculator).toContainText("2.0");
  await expect(calculator).toContainText("هكتار");
  await expect(calculator).toContainText("110.0 m³");
  await expect(calculator).toContainText("تعديل الحسابات والنظام");

  // …and that output is the decision card's own figure, not a re-derivation.
  await expect(hero(page)).toContainText("110.0");
  expect(await volume(calculator)).toBe("110.0");
});

test("the weather widget opens the complete forecast view", async ({ page }) => {
  const widget = weatherWidget(page);
  await expect(widget).toHaveAttribute("aria-expanded", "false");
  await widget.click();
  await expect(widget).toHaveAttribute("aria-expanded", "true");

  const sheet = page.getByRole("dialog", { name: "الطقس والاحتياج المائي" });
  await expect(sheet).toBeVisible();

  // Every block of the old inline card survived the move.
  await expect(sheet.getByText("الآن")).toBeVisible();
  await expect(sheet.getByText("الرطوبة", { exact: true })).toBeVisible();
  await expect(sheet.getByText("الرياح", { exact: true })).toBeVisible();
  await expect(sheet.getByText("أمطار سنوية")).toBeVisible();
  await expect(sheet.getByText("تبخر مرجعي")).toBeVisible();
  await expect(sheet.getByText("الساعات القادمة")).toBeVisible();
  await expect(sheet.getByText("الأيام السبعة القادمة")).toBeVisible();
  await expect(sheet.getByText("أحد", { exact: true })).toBeVisible();
  await expect(sheet.getByText("سبت", { exact: true })).toBeVisible();
  // The advisory line is the shared cascade's heat rule (34 °C ≥ 33 °C).
  await expect(sheet.getByText(/موجة حرارة/)).toBeVisible();
  // Reference mode says so, honestly.
  await expect(sheet.getByText(/تعذّر الوصول إلى الطقس الحيّ/)).toBeVisible();

  // Escape closes the sheet and releases the widget's state.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(widget).toHaveAttribute("aria-expanded", "false");
});

test("calculator edits reach the widget and the decision card in real time", async ({ page }) => {
  const widget = calculatorWidget(page);
  const before = await volume(widget);

  await widget.click();
  const sheet = page.getByRole("dialog", { name: "حاسبة السقي" });
  await expect(sheet).toBeVisible();

  // 1. The crop select re-labels the widget's tag and re-computes the volume.
  await sheet.getByLabel("المحصول").selectOption({ label: "الطماطم" });
  await expect(widget).toContainText("الطماطم");
  const tomatoVolume = await volume(widget);
  expect(tomatoVolume).not.toBe(before);
  await expect(hero(page)).toContainText(tomatoVolume);

  // 2. The system toggle changes the applied efficiency (sprinkler < drip).
  await sheet.getByRole("radio", { name: "بالرشّ" }).click();
  const sprinklerVolume = await volume(widget);
  expect(sprinklerVolume).not.toBe(tomatoVolume);
  await expect(hero(page)).toContainText(sprinklerVolume);

  // 3. The area slider moves the parcel figure on the widget and the card.
  const slider = sheet.getByRole("slider", { name: "المساحة بالسقي" });
  await slider.focus();
  for (let step = 0; step < 4; step += 1) await slider.press("ArrowUp");
  await expect(widget).toContainText("4.0");

  // 4. Closing keeps everything: reopening shows the same parcel.
  await sheet.getByRole("button", { name: "إغلاق" }).click();
  await expect(sheet).toBeHidden();
  await expect(widget).toContainText("4.0");
  await expect(widget).toContainText("الطماطم");

  await widget.click();
  await expect(page.getByRole("dialog", { name: "حاسبة السقي" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "حاسبة السقي" }).getByLabel("المحصول")).toHaveValue("tomato");
  await page.keyboard.press("Escape");
});

test("the sheets dismiss by dragging the handle down", async ({ page }) => {
  await calculatorWidget(page).click();
  const sheet = page.getByRole("dialog", { name: "حاسبة السقي" });
  await expect(sheet).toBeVisible();

  const box = await settledHandle(sheet.locator("[data-sheet-handle]"));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // The panel follows the finger with 0.5 elastic, so the onDragEnd threshold
  // (120px of travel) needs a ~240px+ gesture — one deliberate downward swipe.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let step = 1; step <= 18; step += 1) {
    await page.mouse.move(cx, cy + step * 18);
  }
  await page.mouse.up();

  await expect(sheet).toBeHidden();
  await expect(calculatorWidget(page)).toHaveAttribute("aria-expanded", "false");
});

// 360×640 is the smallest target the design rules commit to; 320px is the
// stress case the redesign screenshots already cover.
for (const width of [320, 360, 412]) {
  test(`stays usable at ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });

    const widget = weatherWidget(page);
    const calculator = calculatorWidget(page);
    for (const target of [widget, calculator]) {
      const box = (await target.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(120);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // The sheets are usable at this width too — no horizontal overflow.
    await widget.click();
    const sheet = page.getByRole("dialog", { name: "الطقس والاحتياج المائي" });
    await expect(sheet).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await sheet.getByRole("button", { name: "إغلاق" }).click();
    await expect(sheet).toBeHidden();
  });
}

// Reduced motion (WCAG 2.2 AA): the sheets still work, without travel.
test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("widgets and sheets stay fully operable", async ({ page }) => {
    await calculatorWidget(page).click();
    const sheet = page.getByRole("dialog", { name: "حاسبة السقي" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("slider", { name: "المساحة بالسقي" })).toBeVisible();
    await sheet.getByRole("button", { name: "إغلاق" }).click();
    await expect(sheet).toBeHidden();
  });
});
