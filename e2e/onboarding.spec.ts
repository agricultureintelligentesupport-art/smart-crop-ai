import { expect, test, type Page } from "@playwright/test";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function noOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
}

async function activeStepLabel(page: Page) {
  return page.locator("main section").getAttribute("aria-label");
}

/* ------------------------------------------------------------------ */
/*  1. Stability: fixed viewport, no page scroll, safe touch targets   */
/* ------------------------------------------------------------------ */

test.describe("viewport stability", () => {
  test("fits the mobile viewport with zero page scroll and 48px+ buttons", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "تشخيص فوري للأمراض" })).toBeVisible();

    expect(await noOverflow(page)).toBe(0);
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.body).overflow === "hidden" &&
          document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const tooSmall = await page.evaluate(() =>
      [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().height < 48).length,
    );
    expect(tooSmall).toBe(0);
  });

  test("still fits a tiny 320×568 viewport", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "تشخيص فوري للأمراض" })).toBeVisible();
    expect(await noOverflow(page)).toBe(0);
    await ctx.close();
  });
});

/* ------------------------------------------------------------------ */
/*  2. RTL default & header layout                                     */
/* ------------------------------------------------------------------ */

test.describe("Arabic RTL defaults", () => {
  test("document is rtl/arabic and header slots are mirrored", async ({ page }) => {
    await page.goto("/");
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("ar");

    const badge = page.locator("header .glass").first();
    const skip = page.getByRole("button", { name: "تخطي" });
    await expect(badge).toBeVisible();
    await expect(skip).toBeVisible();

    const badgeBox = await badge.boundingBox();
    const skipBox = await skip.boundingBox();
    expect(badgeBox!.x).toBeGreaterThan(skipBox!.x); // badge right, skip left in RTL
  });
});

/* ------------------------------------------------------------------ */
/*  3. Carousel mechanics                                              */
/* ------------------------------------------------------------------ */

test.describe("3-step carousel", () => {
  test("Next advances slides; final step swaps to the two CTAs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "التالي" })).toBeVisible();
    await expect(activeStepLabel(page)).resolves.toContain("1");

    await page.getByRole("button", { name: "التالي" }).click();
    await expect(page.getByRole("heading", { name: "سقي ذكي واقتصاد المياه" })).toBeVisible();

    await page.getByRole("button", { name: "التالي" }).click();
    await expect(page.getByRole("heading", { name: "مراقبة المزرعة بالأقمار" })).toBeVisible();

    // Primary CTA morphs into the action options; skip disappears on the final step
    await expect(page.getByRole("button", { name: "التالي" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "تخطي" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "إنشاء حساب" })).toBeVisible();
    await expect(page.getByRole("button", { name: "متابعة كزائر" })).toBeVisible();
  });

  test("swipe (pointer drag) navigates, RTL-aware", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "تشخيص فوري للأمراض" })).toBeVisible();
    await page.waitForTimeout(500); // let the entry spring settle before dragging

    // During transitions both slides exist → always scope gestures to the live one
    const slide = page.locator("main section").first();
    const box = (await slide.boundingBox())!;
    const midY = box.y + box.height * 0.5;
    const drag = async (fromPct: number, toPct: number) => {
      await page.mouse.move(box.x + box.width * fromPct, midY);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * toPct, midY, { steps: 12 });
      await page.mouse.up();
    };

    // RTL: dragging content to the right advances to the next step
    await drag(0.25, 0.78);
    await expect(page.getByRole("heading", { name: "سقي ذكي واقتصاد المياه" })).toBeVisible({
      timeout: 4000,
    });

    // and a flick back returns to step 1
    await page.waitForTimeout(400);
    await drag(0.78, 0.2);
    await expect(page.getByRole("heading", { name: "تشخيص فوري للأمراض" })).toBeVisible({
      timeout: 4000,
    });
  });

  test("dots jump directly to a slide", async ({ page }) => {
    await page.goto("/");
    await page.locator("button[aria-label*='خطوة 3']").click();
    await expect(page.getByRole("heading", { name: "مراقبة المزرعة بالأقمار" })).toBeVisible();
  });

  test("skip jumps straight to the final action step", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "تخطي" }).click();
    await expect(page.getByRole("button", { name: "إنشاء حساب" })).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  4. Language switch                                                  */
/* ------------------------------------------------------------------ */

test.describe("AR ⇄ FR language switch", () => {
  test("switches dir/lang, strings, and keeps layout stable", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Français" }).click();

    expect(await page.evaluate(() => document.documentElement.dir)).toBe("ltr");
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("fr");

    await expect(
      page.getByRole("heading", { name: "Diagnostic IA des Maladies" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Passer" })).toBeVisible();
    expect(await noOverflow(page)).toBe(0);

    // Badge now on the LEFT, skip on the RIGHT (mirrored)
    const badge = page.locator("header .glass").first();
    const skip = page.getByRole("button", { name: "Passer" });
    expect((await badge.boundingBox())!.x).toBeLessThan((await skip.boundingBox())!.x);

    // Back to Arabic
    await page.getByRole("button", { name: "العربية" }).click();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
  });

  test("French final step shows French CTAs", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Français" }).click();
    await page.locator("button[aria-label*='Étape 3']").click();
    await expect(page.getByRole("button", { name: "Créer un compte" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continuer comme invité" })).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  5. CTA destinations                                                 */
/* ------------------------------------------------------------------ */

test.describe("action step wiring", () => {
  test("create-account and guest CTAs navigate to their routes", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "تخطي" }).click();
    await page.getByRole("button", { name: "إنشاء حساب" }).click();
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByRole("heading", { name: "إنشاء حساب جديد" })).toBeVisible();

    // The register screen is the live flow: header navigation goes back home…
    await page.getByRole("link", { name: /الرئيسية/ }).click();
    await expect(page).toHaveURL(/\/$/);

    // …and the guest CTA lands on the working dashboard, not a placeholder.
    await page.getByRole("button", { name: "تخطي" }).click();
    await page.getByRole("button", { name: "متابعة كزائر" }).click();
    await expect(page).toHaveURL(/\/guest/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("زائر");
    await expect(page.getByRole("heading", { name: "حاسبة السقي" })).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  6. Health                                                           */
/* ------------------------------------------------------------------ */

test("no console errors or page errors during the flow", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto("/");
  await page.getByRole("button", { name: "التالي" }).click();
  await page.getByRole("button", { name: "Français" }).click();
  await page.getByRole("button", { name: "Suivant" }).click();
  await page.getByRole("button", { name: "Créer un compte" }).click();

  expect(problems).toEqual([]);
});
