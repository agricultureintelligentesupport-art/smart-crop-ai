/** Manual verification journey: map UX + satellite contract + assistant chat. */
import sparticuz from "@sparticuz/chromium";
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3221";
const problems = [];
const report = {};

const browser = await chromium.launch({
  executablePath: await sparticuz.executablePath(),
  args: sparticuz.args,
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, locale: "ar-DZ" });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("ERR_CONNECTION")) problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));

// Capture the exact payload the drawn polygon sends to the satellite pipeline.
const fieldDataRequests = [];
page.on("request", (r) => {
  if (r.url().includes("/api/field-data") && r.method() === "POST") {
    try {
      fieldDataRequests.push(JSON.parse(r.postData() ?? "{}"));
    } catch {
      fieldDataRequests.push({ raw: r.postData() });
    }
  }
});

// 1. Guest dashboard → open the field map.
await page.goto(`${BASE}/guest`, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => problems.push("goto: " + e.message));
const card = page.locator("section[aria-label='الخريطة الحرارية للقطعة']");
await card.scrollIntoViewIfNeeded();
await card.getByRole("button", { name: "ارسم قطعتك" }).click();
const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
await dialog.waitFor();
await page.waitForTimeout(1500);

// 2. Search box + GPS button present (Nominatim stubbed for determinism).
await page.route("https://nominatim.openstreetmap.org/**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([
      {
        place_id: 1, licence: "t", osm_type: "relation", osm_id: 1,
        boundingbox: ["34.75", "34.95", "5.65", "5.85"], lat: "34.85", lon: "5.73",
        display_name: "بسكرة, الجزائر", class: "boundary", type: "administrative",
        importance: 0.8, address: { state: "بسكرة", country: "الجزائر" },
      },
      {
        place_id: 2, licence: "t", osm_type: "relation", osm_id: 2,
        boundingbox: ["34.70", "35.00", "5.60", "5.90"], lat: "34.84", lon: "5.72",
        display_name: "ولاية بسكرة, الجزائر", class: "boundary", type: "administrative",
        importance: 0.6, address: { state: "ولاية بسكرة", country: "الجزائر" },
      },
    ]),
  }),
);
const search = dialog.getByRole("searchbox", { name: "البحث عن موقع على الخريطة" });
report.searchBox = await search.isVisible().catch(() => false);
await search.fill("بسكرة").catch(() => {});
await search.press("Enter").catch(() => {});
await page.waitForTimeout(800);
report.searchResults = await dialog.getByText("بسكرة", { exact: false }).first().isVisible().catch(() => false);
report.locateButton = await dialog.getByRole("button", { name: "موقعي" }).isVisible().catch(() => false);
// Close the geocoder results (blur) so it cannot swallow map taps. Note: the
// sheet itself closes on Escape, so blur by clicking the sheet header.
await dialog.locator("h2").first().click({ force: true }).catch(() => {});
await page.waitForTimeout(400);

// 3. Draw: four corners, undo one, replace it, finish. Live area + controls.
await dialog.getByRole("button", { name: "رسم الحدود" }).click();
const box = await page.locator(".leaflet-container").boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const pts = [[cx - 25, cy - 25], [cx + 25, cy - 25], [cx + 25, cy + 25], [cx - 25, cy + 25]];
for (const [x, y] of pts.slice(0, 3)) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(300);
}
report.undoButton = await dialog.getByRole("button", { name: "تراجع" }).isVisible().catch(() => false);
await dialog.getByRole("button", { name: "تراجع" }).click();
await page.waitForTimeout(300);
await page.mouse.click(pts[2][0], pts[2][1]);
await page.waitForTimeout(300);
await page.mouse.click(pts[3][0], pts[3][1]);
await page.waitForTimeout(400);
const areaText = await dialog.locator("div").filter({ hasText: "المساحة حتى الآن" }).last().innerText().catch(() => "");
report.liveAreaShown = areaText.includes("المساحة حتى الآن");
report.liveAreaText = areaText.split("\n")[0] ?? "";
await dialog.getByRole("button", { name: "تم" }).first().click();
await page.waitForTimeout(800);

// 4. Save the plot — this must hit /api/field-data with the pipeline contract.
const nameInput = dialog.getByPlaceholder("اسمقطعة").or(dialog.getByPlaceholder("اسم القطعة"));
const saveBtn = dialog.getByRole("button", { name: /^حفظ/ });
report.saveButtonVisible = await saveBtn.isVisible().catch(() => false);
if (!report.saveButtonVisible) {
  report.dialogExcerpt = (await dialog.innerText().catch(() => "")).slice(0, 500).replace(/\n+/g, " | ");
}
if (await nameInput.first().isVisible().catch(() => false)) await nameInput.first().fill("قطعة الاختبار");
await saveBtn.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(6000);
report.fieldDataRequests = fieldDataRequests;
report.contractShapeOk =
  fieldDataRequests.length > 0 &&
  fieldDataRequests.every(
    (b) =>
      typeof b.uid === "string" &&
      typeof b.plotId === "string" &&
      Array.isArray(b.ring) && b.ring.length >= 3 &&
      typeof b.rows === "number" &&
      typeof b.cols === "number",
  );
await page.keyboard.press("Escape");
await page.waitForTimeout(800);

// 5. Assistant chat must work with all of the above in the build.
await page.goto(`${BASE}/assistant`, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => problems.push("goto assistant: " + e.message));
await page.waitForTimeout(1200);
await page.getByRole("textbox").fill("مرحبا، كيف أسقي الطماطم؟");
await page.getByRole("button", { name: "إرسال" }).click();
await page.waitForTimeout(20000);
const body = await page.locator("main, body").first().innerText();
report.chatErrorBubble = body.includes("وقع خطأ أثناء الاتصال بالمساعد");
report.chatReply = /أهلاً|المساعد غير متاحة|تعذّر تحليل/.test(body);
report.chatExcerpt = body.slice(0, 260).replace(/\n+/g, " | ");

console.log(JSON.stringify(report, null, 2));
console.log("problems (" + problems.length + "):");
for (const p of problems.slice(0, 15)) console.log(" •", p);
await browser.close();
