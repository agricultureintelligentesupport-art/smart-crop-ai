import { expect, test, type Locator, type Page } from "@playwright/test";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const ACCOUNT = {
  name: "محمد بن علي",
  email: "mohamed@example.dz",
  password: "tomate2026",
};

/**
 * `locator.fill()` is a no-op on `input[type=range]`, so drive the parcel
 * slider the way a keyboard user would. `ArrowUp` is used instead of
 * `ArrowRight` because the app is RTL by default and browsers flip the
 * horizontal arrows for range inputs under `dir="rtl"`.
 */
async function setArea(slider: Locator, hectares: number) {
  await slider.focus();
  const target = Math.round(hectares * 2);
  for (let guard = 0; guard < 80; guard += 1) {
    if (Math.round(Number(await slider.inputValue()) * 2) >= target) return;
    await slider.press("ArrowUp");
  }
  throw new Error("slider did not reach the requested area");
}

/** Maps an Algerian mobile to its national digits as the field expects them. */
async function enterPhone(page: Page, digits: string) {
  await page.getByRole("textbox", { name: "الهاتف" }).fill(digits);
}

async function openAccountTab(page: Page) {
  await page.getByRole("button", { name: "تبويب إنشاء حساب" }).click();
}

async function openEmailChannel(page: Page) {
  await page.getByRole("tab", { name: "البريد الإلكتروني" }).click();
}

/** Walks method → role → wilaya → success and returns on the success panel. */
async function completeSetup(page: Page, wilaya = "بسكرة") {
  await page.getByRole("heading", { name: "تحديد صفة المستخدم" }).waitFor();
  await page.getByRole("radio", { name: /صاحب مزرعة/ }).click();
  await page.getByRole("button", { name: "متابعة" }).click();
  await page.getByRole("heading", { name: "اختيار الولاية" }).waitFor();
  await page.getByRole("searchbox", { name: "البحث عن ولاية" }).fill(wilaya);
  await page.getByRole("button", { name: new RegExp(wilaya) }).first().click();
  await page.getByRole("button", { name: "تأكيد الولاية" }).click();
  await page.getByRole("heading", { name: /أهلاً بك/ }).waitFor();
}

/* ------------------------------------------------------------------ */
/*  1. Routes render the real flow (no placeholder screens)            */
/* ------------------------------------------------------------------ */

test.describe("auth routes", () => {
  test("/auth, /login and /register all render the live flow", async ({ page }) => {
    for (const [route, heading] of [
      ["/auth", "تسجيل الدخول"],
      ["/login", "تسجيل الدخول"],
      ["/register", "إنشاء حساب جديد"],
    ] as const) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      // Google + both channels are always offered
      await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
      await expect(page.getByRole("tab", { name: "الهاتف" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "البريد الإلكتروني" })).toBeVisible();
    }
  });

  test("does not ship any 'coming soon' placeholder copy", async ({ page }) => {
    for (const route of ["/auth", "/login", "/register"]) {
      await page.goto(route);
      const body = (await page.locator("body").innerText()).toLowerCase();
      expect(body).not.toContain("bientôt");
      expect(body).not.toContain("قريبًا");
      expect(body).not.toContain("coming soon");
    }
  });

  test("header navigation reaches the landing page and back", async ({ page }) => {
    await page.goto("/register");
    await page.getByRole("link", { name: /الرئيسية/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("button", { name: "تخطي" }).click();
    await page.getByRole("button", { name: "إنشاء حساب" }).click();
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByRole("heading", { name: "إنشاء حساب جديد" })).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  2. Email sign-up: validation, role, wilaya, dashboard              */
/* ------------------------------------------------------------------ */

test.describe("email registration", () => {
  test("validates every field before advancing", async ({ page }) => {
    await page.goto("/register");
    await openAccountTab(page);
    await openEmailChannel(page);

    await page.getByRole("button", { name: "إنشاء الحساب" }).click();
    await expect(page.getByText("هذا الحقل مطلوب").first()).toBeVisible();

    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill("nope");
    await page.getByLabel("كلمة المرور", { exact: true }).fill("abc");
    await page.getByRole("button", { name: "إنشاء الحساب" }).click();
    await expect(page.getByText(/أدخل بريداً إلكترونياً صحيحاً/)).toBeVisible();
    await expect(page.getByText(/كلمة المرور ضعيفة/)).toBeVisible();
    await expect(page.getByText(/حرف واحد على الأقل/)).toBeVisible();

    await page.getByLabel("الاسم الكامل").fill(ACCOUNT.name);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(ACCOUNT.email);
    await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNT.password);
    await page.getByLabel("تأكيد كلمة المرور").fill("different1");
    await page.getByRole("button", { name: "إنشاء الحساب" }).click();
    await expect(page.getByText(/غير متطابقتين/)).toBeVisible();
    // Still on step 1: the flow never advances while the form is invalid
    await expect(page.getByRole("heading", { name: "إنشاء حساب جديد" })).toBeVisible();
  });

  test("password toggle reveals the value and the meter reacts", async ({ page }) => {
    await page.goto("/register");
    await openAccountTab(page);
    await openEmailChannel(page);

    const password = page.getByLabel("كلمة المرور", { exact: true });
    await password.fill("tomate2026");
    await expect(page.getByRole("group", { name: "قوة كلمة المرور" })).toBeVisible();
    await expect(page.getByText("قوية")).toBeVisible();

    await page.getByRole("button", { name: "إظهار كلمة المرور" }).first().click();
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "إخفاء كلمة المرور" }).first().click();
    await expect(password).toHaveAttribute("type", "password");
  });

  test("full path lands on the dashboard with the chosen wilaya", async ({ page }) => {
    await page.goto("/register");
    await openAccountTab(page);
    await openEmailChannel(page);
    await page.getByLabel("الاسم الكامل").fill(ACCOUNT.name);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(ACCOUNT.email);
    await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNT.password);
    await page.getByLabel("تأكيد كلمة المرور").fill(ACCOUNT.password);
    await page.getByRole("button", { name: "إنشاء الحساب" }).click();

    await completeSetup(page, "خنشلة");
    await page.getByRole("button", { name: /الدخول إلى لوحة التحكم/ }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: /مرحباً/ })).toBeVisible();
    await expect(page.getByText(/خنشلة/).first()).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  3. Role selection                                                  */
/* ------------------------------------------------------------------ */

/**
 * Signs in through the demo phone OTP so the setup steps can be tested.
 * The Google button is intentionally NOT driven here: it opens a real
 * Firebase OAuth popup (strict auth — the wizard never advances without a
 * real Firebase user), which cannot be completed headlessly.
 */
async function signInViaDemoOtp(page: Page, digits: string) {
  await enterPhone(page, digits);
  await page.getByRole("button", { name: /إرسال رمز SMS/ }).click();
  await page.getByLabel("رمز التحقق").fill("123456");
  await page.getByRole("button", { name: /تحقّق ودخول/ }).click();
}

test.describe("role selection", () => {
  test("shows all three profiles and requires a choice", async ({ page }) => {
    await page.goto("/auth");
    await signInViaDemoOtp(page, "661223344");

    await expect(page.getByRole("heading", { name: "تحديد صفة المستخدم" })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(3);
    await expect(page.getByRole("radio", { name: /صاحب مزرعة/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /مهندس زراعي/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /مستثمر/ })).toBeVisible();

    await expect(page.getByRole("button", { name: "متابعة" })).toBeDisabled();
    await page.getByRole("radio", { name: /مهندس زراعي/ }).click();
    await expect(page.getByRole("radio", { name: /مهندس زراعي/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("button", { name: "متابعة" })).toBeEnabled();
  });
});

/* ------------------------------------------------------------------ */
/*  4. Wilaya picker                                                   */
/* ------------------------------------------------------------------ */

test.describe("wilaya selection", () => {
  test("searches in Arabic and French, and previews the climate", async ({ page }) => {
    await page.goto("/auth");
    await signInViaDemoOtp(page, "550112233");
    await page.getByRole("radio", { name: /مستثمر/ }).click();
    await page.getByRole("button", { name: "متابعة" }).click();

    const search = page.getByRole("searchbox", { name: "البحث عن ولاية" });
    await expect(page.getByText("58 ولاية")).toBeVisible();

    // French spelling with accents resolved from plain ASCII
    await search.fill("Bejaia");
    await expect(page.getByRole("button", { name: /بجاية/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /بسكرة/ })).toHaveCount(0);

    // Arabic root letters
    await search.fill("وادي");
    await expect(page.getByRole("button", { name: /الوادي/ })).toBeVisible();

    await search.fill("9999");
    await expect(page.getByText("لا توجد نتائج مطابقة")).toBeVisible();

    await search.fill("ورقلة");
    await page.getByRole("button", { name: /ورقلة/ }).first().click();
    await expect(page.getByText("الولاية المختارة")).toBeVisible();
    await expect(page.getByText(/نخيل التمر/).first()).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  5. Phone + OTP                                                     */
/* ------------------------------------------------------------------ */

test.describe("phone authentication", () => {
  test("rejects an invalid Algerian mobile", async ({ page }) => {
    await page.goto("/auth");
    await enterPhone(page, "123");
    await page.getByRole("button", { name: /إرسال رمز SMS/ }).click();
    await expect(page.getByText(/رقم جوال جزائري صحيح/)).toBeVisible();
  });

  test("verifies the 6-digit code and rejects a wrong one", async ({ page }) => {
    await page.goto("/auth");
    await enterPhone(page, "661223344");
    await page.getByRole("button", { name: /إرسال رمز SMS/ }).click();

    const otp = page.getByLabel("رمز التحقق");
    await expect(otp).toBeVisible();
    await expect(page.getByText(/أرسلنا رمزاً من 6 أرقام/)).toBeVisible();

    await otp.fill("000000");
    await page.getByRole("button", { name: /تحقّق ودخول/ }).click();
    await expect(page.getByText(/الرمز غير صحيح/)).toBeVisible();

    await otp.fill("123456");
    await page.getByRole("button", { name: /تحقّق ودخول/ }).click();
    await expect(page.getByRole("heading", { name: "تحديد صفة المستخدم" })).toBeVisible();
  });

  test("resend is rate limited and the number can be changed", async ({ page }) => {
    await page.goto("/auth");
    await enterPhone(page, "770112233");
    await page.getByRole("button", { name: /إرسال رمز SMS/ }).click();
    await page.getByLabel("رمز التحقق").waitFor();

    await expect(page.getByRole("button", { name: /إعادة الإرسال بعد/ })).toBeDisabled();
    await page.getByRole("button", { name: "تغيير الرقم" }).click();
    await expect(page.getByRole("textbox", { name: "الهاتف" })).toBeEnabled();
  });
});

/* ------------------------------------------------------------------ */
/*  6. Email sign-in                                                   */
/* ------------------------------------------------------------------ */

test.describe("email sign-in", () => {
  test("reports wrong password and unknown accounts", async ({ page }) => {
    await page.goto("/register");
    await openAccountTab(page);
    await openEmailChannel(page);
    await page.getByLabel("الاسم الكامل").fill(ACCOUNT.name);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(ACCOUNT.email);
    await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNT.password);
    await page.getByLabel("تأكيد كلمة المرور").fill(ACCOUNT.password);
    await page.getByRole("button", { name: "إنشاء الحساب" }).click();
    await completeSetup(page);
    await page.getByRole("button", { name: /الدخول إلى لوحة التحكم/ }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Sign out and come back with a bad password
    await page.getByRole("button", { name: "تسجيل الخروج" }).click();
    await expect(page).toHaveURL(/\/auth/);
    await openEmailChannel(page);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(ACCOUNT.email);
    await page.getByLabel("كلمة المرور", { exact: true }).fill("wrongpass9");
    await page.locator("#channel-panel-email").getByRole("button", { name: "تسجيل الدخول" }).click();
    await expect(page.getByText(/كلمة المرور غير صحيحة/)).toBeVisible();

    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill("ghost@example.dz");
    await page.locator("#channel-panel-email").getByRole("button", { name: "تسجيل الدخول" }).click();
    await expect(page.getByText(/لا يوجد حساب بهذا البريد/)).toBeVisible();
  });

  test("a returning account signs straight in once the profile is complete", async ({ page }) => {
    await page.goto("/register");
    await openAccountTab(page);
    await openEmailChannel(page);
    await page.getByLabel("الاسم الكامل").fill(ACCOUNT.name);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(ACCOUNT.email);
    await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNT.password);
    await page.getByLabel("تأكيد كلمة المرور").fill(ACCOUNT.password);
    await page.getByRole("button", { name: "إنشاء الحساب" }).click();
    await completeSetup(page);
    await page.getByRole("button", { name: /الدخول إلى لوحة التحكم/ }).click();
    await page.getByRole("button", { name: "تسجيل الخروج" }).click();

    // Known device (role + wilaya remembered) → the ladder collapses to one step
    await page.getByRole("button", { name: "تبويب تسجيل الدخول" }).click();
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await openEmailChannel(page);
    await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(ACCOUNT.email);
    await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNT.password);
    await page.locator("#channel-panel-email").getByRole("button", { name: "تسجيل الدخول" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

/* ------------------------------------------------------------------ */
/*  7. Auth-gated dashboard (guest mode removed)                       */
/* ------------------------------------------------------------------ */

/**
 * Signs in through the demo phone OTP, walks the setup steps and lands on
 * the member dashboard. Every dashboard feature below is verified behind
 * the session gate.
 */
async function openDashboard(page: Page, wilaya = "بسكرة") {
  await page.goto("/auth");
  await signInViaDemoOtp(page, "661223344");
  await completeSetup(page, wilaya);
  await page.getByRole("button", { name: /الدخول إلى لوحة التحكم/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("dashboard session guard", () => {
  test("unauthenticated /dashboard redirects straight to the auth wizard", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth/);
    await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
  });

  test("/guest is gone: the old route forwards to the auth wizard", async ({ page }) => {
    await page.goto("/guest");
    await expect(page).toHaveURL(/\/auth/);
    await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
  });

  test("the auth wizard offers no guest escape hatch", async ({ page }) => {
    await page.goto("/auth");
    await expect(page.getByRole("button", { name: /زائر/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /زائر/ })).toHaveCount(0);
  });
});

test.describe("member dashboard", () => {
  test("a signed-in member gets the full dashboard, not a placeholder", async ({ page }) => {
    await openDashboard(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/مرحباً/);
    await expect(page.getByRole("heading", { name: "الطقس والاحتياج المائي" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "حاسبة السقي" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "تشخيص صحة النبات" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "مؤشر الغطاء النباتي" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "مهام اليوم" })).toBeVisible();
  });

  test("irrigation calculator reacts to crop, area and system", async ({ page }) => {
    await openDashboard(page);
    const perDay = page.getByText("لكل قطعة يومياً").locator("..").getByText(/m³/).first();
    const before = await perDay.textContent();

    await setArea(page.getByRole("slider", { name: "المساحة بالسقي" }), 9);
    await expect(perDay).not.toHaveText(before ?? "");

    const dripValue = await perDay.textContent();
    await page.getByRole("radio", { name: "بالرشّ" }).click();
    await expect(perDay).not.toHaveText(dripValue ?? "");

    // Nudge buttons move the same value, and the whole dashboard follows it
    await page.getByRole("button", { name: "المساحة بالسقي +" }).click();
    await expect(page.getByText(/على 9.5 هكتار/)).toBeVisible();
    await page.getByRole("button", { name: "المساحة بالسقي −" }).click();
    await expect(page.getByText(/على 9.0 هكتار/)).toBeVisible();
  });

  test("leaf scan produces a diagnosis with field advice", async ({ page }) => {
    await openDashboard(page);
    await page.setInputFiles('input[type="file"]', {
      name: "leaf.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await page.getByRole("button", { name: "تشخيص صحة النبات" }).click();
    await expect(page.getByText("التوصية الميدانية")).toBeVisible();
    await expect(page.getByText("درجة الثقة")).toBeVisible();
    await page.getByRole("button", { name: "صورة جديدة" }).click();
    await expect(page.getByText("اختر صورة الورقة")).toBeVisible();
  });

  test("personalising the wilaya updates the header and can be persisted", async ({ page }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: /تعديل/ }).click();
    const picker = page.getByRole("button", { name: /الولاية/ });
    await expect(picker).toBeVisible();
    await picker.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("searchbox", { name: "بحث" }).fill("تقرت");
    await page.getByRole("option", { name: /تقرت/ }).first().click();
    await page.waitForTimeout(300);

    await page.reload();
    await expect(page.getByText(/تقرت/).first()).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/*  8. Language, layout and health                                     */
/* ------------------------------------------------------------------ */

test.describe("bilingual chrome", () => {
  test("AR ⇄ FR switches direction, copy and keeps the layout stable", async ({ page }) => {
    await page.goto("/auth");
    await page.getByRole("button", { name: "Français" }).click();

    expect(await page.evaluate(() => document.documentElement.dir)).toBe("ltr");
    await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Téléphone" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Envoyer le code SMS" })).toBeVisible();

    await page.getByRole("button", { name: "العربية" }).click();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
  });

  test("French dashboard copy is complete", async ({ page }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: "Français" }).click();
    await expect(page.getByRole("heading", { name: "Météo et besoin en eau" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Calculateur d'irrigation" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Diagnostic de la feuille" })).toBeVisible();
  });
});

test("no console or page errors while walking the whole flow", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto("/register");
  await openAccountTab(page);
  await openEmailChannel(page);
  await page.getByLabel("الاسم الكامل").fill(ACCOUNT.name);
  await page.getByRole("textbox", { name: "البريد الإلكتروني" }).fill(ACCOUNT.email);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(ACCOUNT.password);
  await page.getByLabel("تأكيد كلمة المرور").fill(ACCOUNT.password);
  await page.getByRole("button", { name: "إنشاء الحساب" }).click();
  await completeSetup(page);
  await page.getByRole("button", { name: /الدخول إلى لوحة التحكم/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  expect(problems).toEqual([]);
});
