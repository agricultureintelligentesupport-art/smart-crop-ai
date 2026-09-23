import { expect, test, type Browser, type Page } from "@playwright/test";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Signs in through the demo phone OTP so the setup steps can be tested. */
async function signInViaDemoOtp(page: Page, digits: string) {
  await page.getByRole("textbox", { name: "الهاتف" }).fill(digits);
  await page.getByRole("button", { name: /إرسال رمز SMS/ }).click();
  await page.getByLabel("رمز التحقق").fill("123456");
  await page.getByRole("button", { name: /تحقّق ودخول/ }).click();
}

/** Walks method → role → wilaya and lands on the farm step. */
async function reachFarmStep(page: Page, wilaya = "بسكرة") {
  await page.goto("/auth");
  await signInViaDemoOtp(page, "661223344");
  await page.getByRole("radio", { name: /صاحب مزرعة/ }).click();
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.getByRole("searchbox", { name: "البحث عن ولاية" }).fill(wilaya);
  await page.getByRole("button", { name: new RegExp(wilaya) }).first().click();
  await page.getByRole("button", { name: "تأكيد الولاية" }).click();
  await page.getByRole("heading", { name: "مزرعتك" }).waitFor();
}

async function storedProfile(page: Page) {
  const raw = await page.evaluate(() => window.localStorage.getItem("smart-crop.profile.v1"));
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/* ------------------------------------------------------------------ */
/*  1. Farm step: crop + land size                                      */
/* ------------------------------------------------------------------ */

test.describe("farm profile step", () => {
  test("the ladder grows to 4 steps and the wilaya crops are suggested first", async ({
    page,
  }) => {
    await reachFarmStep(page, "بسكرة");
    await expect(page.getByRole("listitem")).toHaveCount(4);
    await expect(page.getByText("مقترحة لولايتك")).toBeVisible();
    // Biskra grows tomatoes: the wilaya suggestion is offered as a chip…
    await expect(page.getByRole("radio", { name: "الطماطم" })).toBeVisible();
    // …alongside the full shared crop table.
    await expect(page.getByText("كل المحاصيل")).toBeVisible();
    await expect(page.getByRole("radio", { name: "القمح الصلب" })).toBeVisible();
  });

  test("filling crop + land size persists them to the profile and the summary", async ({
    page,
  }) => {
    await reachFarmStep(page, "بسكرة");

    await page.getByRole("radio", { name: "الطماطم" }).click();
    await expect(page.getByRole("radio", { name: "الطماطم" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByLabel("حجم الأرض").fill("3.5");
    await page.getByRole("button", { name: "تأكيد وإتمام" }).click();

    await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor();
    await expect(page.getByText("الطماطم").first()).toBeVisible();
    await expect(page.getByText("3.5 هكتار")).toBeVisible();

    const profile = await storedProfile(page);
    expect(profile?.wilayaCode).toBe("07");
    expect(profile?.preferredCrop).toBe("tomato");
    expect(profile?.landSizeHa).toBe(3.5);

    // The dashboard still opens behind the completed profile.
    await page.getByRole("button", { name: /الدخول إلى لوحة التحكم/ }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("skipping leaves the wilaya defaults in place and never blocks", async ({ page }) => {
    await reachFarmStep(page, "بسكرة");
    await page.getByRole("button", { name: "تخطي", exact: true }).click();

    await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor();
    await expect(page.getByText("لم يُحدد")).toHaveCount(2);

    const profile = await storedProfile(page);
    expect(profile?.wilayaCode).toBe("07");
    // Skip keeps the historical behaviour: the wilaya's first crop fills in.
    expect(profile?.preferredCrop).toBe("dates");
    expect(profile?.landSizeHa ?? null).toBe(null);
  });

  test("an invalid land size blocks confirm but never blocks skip", async ({ page }) => {
    await reachFarmStep(page);

    await page.getByLabel("حجم الأرض").fill("0");
    await page.getByRole("button", { name: "تأكيد وإتمام" }).click();
    await expect(page.getByText(/أدخل مساحة صحيحة/)).toBeVisible();
    // Still on the farm step.
    await expect(page.getByRole("heading", { name: "مزرعتك" })).toBeVisible();

    // Skip ignores the invalid value and completes the flow.
    await page.getByRole("button", { name: "تخطي", exact: true }).click();
    await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor();
  });

  test("back returns to the wilaya step without losing the flow", async ({ page }) => {
    await reachFarmStep(page);
    await page.getByRole("button", { name: "رجوع" }).click();
    await expect(page.getByRole("heading", { name: "اختيار الولاية" })).toBeVisible();
    await page.getByRole("button", { name: "تأكيد الولاية" }).click();
    await expect(page.getByRole("heading", { name: "مزرعتك" })).toBeVisible();
  });

  test("the farm step is fully bilingual (AR ⇄ FR)", async ({ page }) => {
    await reachFarmStep(page);
    await page.getByRole("button", { name: "Français" }).click();
    await expect(page.getByRole("heading", { name: "Votre exploitation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Passer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmer et terminer" })).toBeVisible();
    await page.getByLabel("Surface cultivée").fill("2,5");
    await page.getByRole("button", { name: "Confirmer et terminer" }).click();
    await expect(page.getByText("2.5 ha")).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  2. Wilaya auto-detection (geolocation)                             */
/* ------------------------------------------------------------------ */

test.describe("wilaya auto-detection", () => {
  test("granted permission pre-selects the nearest wilaya", async ({ browser }: { browser: Browser }) => {
    const ctx = await browser.newContext({
      geolocation: { latitude: 36.75, longitude: 3.06 }, // Algiers
      permissions: ["geolocation"],
    });
    const page = await ctx.newPage();
    try {
      await page.goto("/auth");
      await signInViaDemoOtp(page, "550112233");
      await page.getByRole("radio", { name: /مستثمر/ }).click();
      await page.getByRole("button", { name: "متابعة" }).click();

      await page.getByRole("button", { name: "استخدام موقعي الحالي" }).click();
      await expect(page.getByText("تم تحديد ولايتك: الجزائر")).toBeVisible();
      // The preview panel follows the auto-detected wilaya…
      await expect(page.getByText("الولاية المختارة")).toBeVisible();
      // …and the flow continues onto the farm step with Algiers stored.
      await page.getByRole("button", { name: "تأكيد الولاية" }).click();
      await page.getByRole("heading", { name: "مزرعتك" }).waitFor();
      await page.getByRole("button", { name: "تخطي", exact: true }).click();
      await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor();
      expect((await storedProfile(page))?.wilayaCode).toBe("16");
    } finally {
      await ctx.close();
    }
  });

  test("denied permission falls back to the manual search without blocking", async ({
    page,
  }) => {
    await page.goto("/auth");
    await signInViaDemoOtp(page, "770112233");
    await page.getByRole("radio", { name: /مستثمر/ }).click();
    await page.getByRole("button", { name: "متابعة" }).click();

    // No geolocation permission granted → the browser denies the lookup.
    await page.getByRole("button", { name: "استخدام موقعي الحالي" }).click();
    await expect(page.getByText(/تعذّر الوصول إلى الموقع/)).toBeVisible();

    // Manual search still works and the flow completes.
    await page.getByRole("searchbox", { name: "البحث عن ولاية" }).fill("وهران");
    await page.getByRole("button", { name: /وهران/ }).first().click();
    await page.getByRole("button", { name: "تأكيد الولاية" }).click();
    await page.getByRole("heading", { name: "مزرعتك" }).waitFor();
    await page.getByRole("button", { name: "تخطي", exact: true }).click();
    await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor();
    expect((await storedProfile(page))?.wilayaCode).toBe("31");
  });
});
