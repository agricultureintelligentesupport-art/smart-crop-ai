/**
 * Stage-1 manual verification (not part of the e2e suite — see the note at the
 * bottom of `e2e/field-map.spec.ts`): drives the real flow in headless
 * chromium — draw → «تم» → isolated review — and screenshots the result.
 *
 *   node tools/verify-stage1.mjs
 */
import { chromium } from "playwright-core";
import sparticuz from "@sparticuz/chromium";
import fs from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = "tools/stage1-shots";

const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const run = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: await sparticuz.executablePath(),
    args: [...sparticuz.args, "--disable-dev-shm-usage"],
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 } });

  // Deterministic, offline-friendly upstreams.
  await page.route("https://server.arcgisonline.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
  );
  await page.route("https://api.open-meteo.com/**", (route) => route.abort());
  await page.route("**/api/geocode*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"results":[]}' }));

  await page.goto(`${BASE}/guest`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/dashboard", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Open the field map from the heatmap card.
  const card = page.locator("section[aria-label='الخريطة الحرارية للقطعة']");
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "ارسم قطعتك" }).click();
  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  await dialog.waitFor();
  await page.waitForTimeout(2500);

  // Draw: draw button, four clicks on the imagery, «تم».
  await dialog.getByRole("button", { name: "رسم الحدود" }).click();
  await page.waitForTimeout(600);
  const map = dialog.locator(".leaflet-container");
  const box = await map.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // A quadrilateral roughly 120×90 px — comfortably above the 0.05 ha floor
  // at zoom 15–17.
  await tap(page, cx - 70, cy - 50);
  await tap(page, cx + 70, cy - 45);
  await tap(page, cx + 60, cy + 55);
  await tap(page, cx - 65, cy + 50);
  await page.waitForTimeout(400);
  await shot(page, `${OUT}/1-drawing.png`);

  await dialog.getByRole("button", { name: "تم" }).first().click();
  // Let fitBounds animate + the overlay fade in + the save round-trip land.
  await page.waitForTimeout(2600);
  await shot(page, `${OUT}/2-isolated.png`);

  // Assert the review state.
  const analyze = dialog.getByRole("button", { name: /تحليل القطعة/ });
  console.log("analyze visible:", await analyze.isVisible());
  console.log("analyze disabled:", await analyze.isDisabled());
  const redraw = dialog.getByRole("button", { name: "إعادة الرسم" });
  console.log("redraw visible:", await redraw.isVisible());
  const area = await dialog.getByText("مساحة القطعة").isVisible();
  console.log("area label visible:", area);
  const haText = (await dialog.locator("text=/هكتار/").last().textContent()) ?? "";
  console.log("area text:", haText.trim());
  const saved = await dialog.getByText("تم حفظ الحدود").isVisible();
  console.log("saved chip visible:", saved);

  // The mask is really in the DOM, in the right panes.
  for (const pane of ["fieldMapIsolateDim", "fieldMapIsolateBlur", "fieldMapIsolateLine"]) {
    console.log(`pane ${pane}:`, (await dialog.locator(`.leaflet-${pane}-pane`).count()) === 1);
  }
  console.log(
    "dim has evenodd hole:",
    await dialog.evaluate(() => {
      const pane = document.querySelector(".leaflet-fieldMapIsolateDim-pane");
      const path = pane?.querySelector("path");
      return path ? /z/i.test(path.getAttribute("d") ?? "") && (path.getAttribute("d").match(/z/gi) ?? []).length >= 2 : false;
    }),
  );
  console.log(
    "blur clipped:",
    await dialog.evaluate(() => {
      const pane = document.querySelector(".leaflet-fieldMapIsolateBlur-pane");
      return pane ? (pane.style.clipPath ?? "").includes("url(") : false;
    }),
  );

  // Zoom out twice through Leaflet's own control: the hole must stay glued.
  await dialog.locator(".leaflet-control-zoom-out").click();
  await page.waitForTimeout(700);
  await dialog.locator(".leaflet-control-zoom-out").click();
  await page.waitForTimeout(900);
  await shot(page, `${OUT}/3-isolated-zoomed-out.png`);

  // «إعادة الرسم» returns to drawing, old polygon still on the map.
  await redraw.click();
  await page.waitForTimeout(1200);
  console.log(
    "drawing again (undo visible):",
    await dialog.getByRole("button", { name: "تراجع" }).isVisible(),
  );
  console.log(
    "saved boundary still on map:",
    (await dialog.locator(".leaflet-overlay-pane path").count()) > 0,
  );
  console.log(
    "mask removed after redraw:",
    (await dialog.locator(".leaflet-fieldMapIsolateDim-pane path").count()) === 0,
  );
  await shot(page, `${OUT}/4-redraw.png`);

  // Draw again over the ghost and finish: the review must come back and the
  // plot count must stay at one (replacement, not duplication).
  await tap(page, cx - 50, cy - 30);
  await tap(page, cx + 55, cy - 28);
  await tap(page, cx + 48, cy + 36);
  await tap(page, cx - 46, cy + 33);
  await page.waitForTimeout(300);
  await dialog.getByRole("button", { name: "تم" }).first().click();
  await page.waitForTimeout(2200);
  await shot(page, `${OUT}/5-reisolated.png`);
  console.log("re-isolated:", await analyze.isVisible());
  console.log("footer chips:", await dialog.locator("footer ul li").count());

  await browser.close();

  async function tap(page, x, y) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  }
  async function shot(page, file) {
    await page.screenshot({ path: file });
    console.log("shot:", file);
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
