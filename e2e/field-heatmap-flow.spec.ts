import { expect, test } from "@playwright/test";

/**
 * The two interactive visuals added on top of the hero decision card:
 *
 *   1. the "لكل هكتار" unit pill → the step-by-step calculation flow, and
 *   2. the field heatmap with its three layers and tap-to-inspect zones.
 *
 * Reference weather is forced (Open-Meteo aborted) so every number below is the
 * deterministic wilaya baseline: Biskra (07), 55,100 L/ha and 110 m³ for 2 ha.
 */
test.beforeEach(async ({ page }) => {
  await page.route("https://api.open-meteo.com/**", (route) => route.abort());
  await page.goto("/guest");
  await expect(page.getByRole("button", { name: "لكل هكتار: عرض خطوات الحساب" })).toBeVisible();
});

test("the unit pill opens the calculation flow, which matches the card's numbers", async ({ page }) => {
  const pill = page.getByRole("button", { name: "لكل هكتار: عرض خطوات الحساب" });
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(pill).toHaveAttribute("aria-haspopup", "dialog");

  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");

  const dialog = page.getByRole("dialog", { name: "من أين جاء رقم الهكتار؟" });
  await expect(dialog).toBeVisible();

  // The five steps, in order, from the climate inputs to the parcel volume.
  for (const title of [
    "مدخلات المناخ",
    "معامل المحصول والتربة",
    "كفاءة نظام السقي",
    "النتيجة للهكتار الواحد",
    "إجمالي القطعة اليوم",
  ]) {
    await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
  }

  // The printed chain is the real one: ET0 → Kc × soil → ÷ efficiency → L/ha → m³.
  await expect(dialog.getByText("0.155").first()).toBeVisible();
  await expect(dialog.getByText("34°").first()).toBeVisible();
  await expect(dialog.getByText("0.838").first()).toBeVisible();
  await expect(dialog.getByText("1.024").first()).toBeVisible();

  // Headline figures are the card's own numbers (nothing re-derived).
  await expect(dialog.getByText("55,100", { exact: false }).first()).toBeVisible();
  await expect(dialog.getByText(/110\.0 m³/).first()).toBeVisible();
  await expect(dialog.getByText(/هما نفسهما المعروضان في بطاقة القرار/).first()).toBeVisible();

  await dialog.getByRole("button", { name: "إغلاق" }).click();
  await expect(dialog).toBeHidden();
  await expect(pill).toHaveAttribute("aria-expanded", "false");
});

test("tapping a factor highlights its term and explains its effect", async ({ page }) => {
  await page.getByRole("button", { name: "لكل هكتار: عرض خطوات الحساب" }).click();
  const dialog = page.getByRole("dialog", { name: "من أين جاء رقم الهكتار؟" });

  const humidity = dialog.getByRole("button", { name: "0.838" });
  await expect(humidity).toHaveAttribute("aria-pressed", "false");
  await humidity.click();
  await expect(humidity).toHaveAttribute("aria-pressed", "true");

  // The effect sentence spells out the multiplier's real contribution…
  await expect(dialog.getByText(/رطوبة 28% تُدخل معاملاً قدره 0.838/).first()).toBeVisible();
  // …and the animated connector is drawn from the button to the term.
  await expect(dialog.locator('[data-connector="humidity"] path').first()).toBeVisible();

  // A second tap releases it (and the connector disappears).
  await humidity.click();
  await expect(humidity).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByText(/رطوبة 28% تُدخل معاملاً قدره 0.838/)).toBeHidden();
  await expect(dialog.locator("[data-connector]")).toHaveCount(0);

  // The system-efficiency factor explains the loss-covering division.
  await dialog.getByRole("button", { name: "0.90" }).click();
  await expect(dialog.getByText(/القسمة على 0.90 ترفع الكمية بنسبة \+11\.1%/).first()).toBeVisible();
});

test("the heatmap switches layers and inspects zones", async ({ page }) => {
  const card = page.locator("section[aria-label='الخريطة الحرارية للقطعة']");
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();

  // 2 ha → a 4×4 plot: sixteen inspectable zones.
  const zones = card.getByRole("button", { name: /^المنطقة/ });
  await expect(zones).toHaveCount(16);
  await expect(zones.first()).toHaveAccessibleName(/لتر\/هكتار/);

  // Moisture layer (default): the average is the card's own per-hectare figure.
  await expect(card.getByRole("radio", { name: "الاحتياج المائي" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByText("55,100 لتر/هكتار").first()).toBeVisible();
  const panel = card.getByRole("region", { name: "المنطقة المحددة" });

  // Inspect a zone: the panel follows the selection.
  await zones.nth(5).click();
  await expect(panel).toContainText("المنطقة و");
  await expect(panel).toContainText(/لتر\/هكتار/);
  await expect(panel).toContainText(/متوسط القطعة/);

  // Thermal layer: the same parcel, a different reading and verdict vocabulary.
  await card.getByRole("radio", { name: "الإجهاد الحراري" }).click();
  await expect(card.getByRole("radio", { name: "الإجهاد الحراري" })).toHaveAttribute("aria-checked", "true");
  await expect(panel).toContainText("مؤشر من 100");
  await expect(panel).toContainText(/إجهاد (منخفض|متوسط|مرتفع|حرج)/);

  // Transpiration layer keeps the same zone selected.
  await card.getByRole("radio", { name: "مؤشر النتح" }).click();
  await expect(panel).toContainText(/مؤشر النتح هنا \d+ من 100/);
  await expect(panel).toContainText("المنطقة و");
});

test("heatmap zones are keyboard operable", async ({ page }) => {
  const card = page.locator("section[aria-label='الخريطة الحرارية للقطعة']");
  await card.scrollIntoViewIfNeeded();

  const zones = card.getByRole("button", { name: /^المنطقة/ });
  await zones.first().focus();
  await page.keyboard.press("ArrowDown"); // one row down (4 columns)
  await expect(zones.nth(4)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowLeft"); // forward in the RTL plot
  await expect(zones.nth(5)).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByRole("region", { name: "المنطقة المحددة" })).toContainText("المنطقة و");
});
