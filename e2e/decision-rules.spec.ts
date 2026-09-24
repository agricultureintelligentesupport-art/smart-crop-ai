import { expect, test } from "@playwright/test";

// Keep the weather deterministic so the decision card uses the wilaya reference
// values rather than a live forecast that can change between test runs.
test.beforeEach(async ({ page }) => {
  await page.route("https://api.open-meteo.com/**", (route) => route.abort());
  await page.goto("/guest");
  await expect(page.getByRole("button", { name: "لماذا هذه النافذة والكمية؟" })).toBeVisible();
});

test("the active rule is the only visible card; secondary rules disclose and reset on reopen", async ({ page }) => {
  await page.getByRole("button", { name: "لماذا هذه النافذة والكمية؟" }).click();
  const dialog = page.getByRole("dialog", { name: "لماذا هذه النافذة والكمية؟" });
  const decision = dialog.getByRole("region", { name: "لماذا النافذة الصباحية؟" });
  const active = decision.getByRole("group", { name: "القاعدة النشطة اليوم" });
  const toggle = decision.getByRole("button", { name: /قواعد القرار الأخرى/ });

  // Biskra's reference temperature is 34°C: heat wins over the other rules.
  await expect(active.getByText("حرارة 33° فأكثر")).toBeVisible();
  await expect(active).toHaveClass(/bg-emerald-50/);
  await expect(active).toContainText("الحرارة اليوم 34°");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(decision.getByText("رياح 20 كم/س فأكثر")).toBeHidden();
  await expect(decision.getByText("تبخر 5 مم/يوم فأكثر")).toBeHidden();
  await expect(decision.getByText("ظروف معتدلة")).toBeHidden();

  // Keyboard operation, real aria-expanded state, and conditional (not
  // misleadingly active) copy for the secondary rules.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText(/إخفاء قواعد القرار الأخرى/);
  await expect(decision.getByText("رياح 20 كم/س فأكثر")).toBeVisible();
  await expect(decision.getByText("ظروف معتدلة")).toBeVisible();
  await expect(decision.getByText(/إذا بلغت الرياح هذه العتبة/)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(decision.getByText("رياح 20 كم/س فأكثر")).toBeHidden();

  await toggle.click();
  await dialog.getByRole("button", { name: "إغلاق" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "لماذا هذه النافذة والكمية؟" }).click();
  await expect(dialog.getByRole("button", { name: "عرض قواعد القرار الأخرى" })).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.getByText("ظروف معتدلة")).toBeHidden();
});

test("calm conditions show one green summary and a translated French disclosure", async ({ page }) => {
  await page.getByRole("button", { name: "الإعدادات" }).click();
  const settings = page.getByRole("dialog", { name: "الإعدادات" });
  await settings.getByRole("button", { name: /بسكرة/ }).click();
  await settings.getByRole("searchbox").fill("الشلف");
  await settings.getByRole("option", { name: /الشلف/ }).click();
  await settings.getByRole("button", { name: "Français" }).click();
  await page.getByRole("dialog", { name: "Réglages" }).getByRole("button", { name: "Fermer" }).click();

  await page.getByRole("button", { name: "Pourquoi cette fenêtre et ce volume ?" }).click();
  const dialog = page.getByRole("dialog", { name: "Pourquoi cette fenêtre et ce volume ?" });
  const decision = dialog.getByRole("region", { name: "Pourquoi la fenêtre du matin ?" });
  const active = decision.getByRole("group", { name: "Règle active aujourd'hui" });
  const toggle = decision.getByRole("button", { name: /autres règles de décision/ });

  await expect(active.getByText("Conditions modérées")).toBeVisible();
  await expect(active).toContainText("conditions favorables à l'irrigation aujourd'hui");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(decision.getByText("Chaleur ≥ 33 °")).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(decision.getByText("Chaleur ≥ 33 °")).toBeVisible();
  await expect(decision.getByText("Vent ≥ 20 km/h")).toBeVisible();
  await expect(decision.getByText("Évapotranspiration ≥ 5 mm/jour")).toBeVisible();
  await expect(decision.getByText(/Si ce seuil de chaleur est atteint/)).toBeVisible();
});
