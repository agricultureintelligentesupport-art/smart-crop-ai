import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import sharp from "sharp";

// Reproducible photographed-leaf-like test image, rasterized in memory. Not an AI assessment.
const leafSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720">
<defs>
 <linearGradient id="paper" x2=".8" y2="1"><stop stop-color="#ece8dd"/><stop offset="1" stop-color="#d4d3c3"/></linearGradient>
 <linearGradient id="leaf" x1=".2" y1="1" x2=".9" y2="0"><stop stop-color="#26492e"/><stop offset=".5" stop-color="#568245"/><stop offset="1" stop-color="#8a9c52"/></linearGradient>
 <radialGradient id="spot"><stop stop-color="#4b3729"/><stop offset=".55" stop-color="#81583c"/><stop offset=".78" stop-color="#b0974c"/><stop offset="1" stop-color="#8e9c47" stop-opacity="0"/></radialGradient>
 <filter id="shadow"><feGaussianBlur stdDeviation="14"/></filter>
 <filter id="texture"><feTurbulence type="fractalNoise" baseFrequency=".055" numOctaves="3" seed="7" result="noise"/><feColorMatrix in="noise" type="saturate" values="0"/><feBlend in="SourceGraphic" mode="soft-light"/></filter>
 <clipPath id="shape"><path d="M160 620C86 404 170 224 394 166C557 126 689 84 797 80C861 256 795 491 571 575C399 640 268 653 160 620Z"/></clipPath>
</defs>
<rect width="960" height="720" fill="url(#paper)"/>
<path d="M176 637C84 405 198 226 415 176C605 118 710 91 807 97C883 301 792 535 581 596C391 671 263 674 176 637Z" fill="#343d20" opacity=".22" filter="url(#shadow)"/>
<path d="M132 700C151 629 268 541 370 464" fill="none" stroke="#667a3d" stroke-width="12" stroke-linecap="round"/>
<g clip-path="url(#shape)">
 <path d="M160 620C86 404 170 224 394 166C557 126 689 84 797 80C861 256 795 491 571 575C399 640 268 653 160 620Z" fill="url(#leaf)" filter="url(#texture)"/>
 <g fill="none" stroke="#b2bc72" stroke-width="3" opacity=".65">
  <path d="M160 620Q420 365 795 81" stroke-width="6"/>
  <path d="M237 547Q174 400 199 305M237 547Q350 589 428 608M343 452Q308 273 363 175M343 452Q485 515 576 558M447 365Q428 212 503 142M447 365Q615 425 727 438M553 278Q558 151 626 111M553 278Q690 315 809 295M667 182Q720 172 822 190"/>
 </g>
 <g fill="url(#spot)"><ellipse cx="479" cy="268" rx="92" ry="67"/><ellipse cx="321" cy="437" rx="77" ry="79"/><ellipse cx="668" cy="210" rx="53" ry="47"/></g>
 <g fill="#69482f" opacity=".85"><path d="m454 247 19-18 33 12 10 25-16 30-30-4-18-22Z"/><path d="m293 418 30-20 29 15 5 27-25 31-28-8-17-20Z"/></g>
 <g fill="none" stroke="#b29a59" opacity=".5"><ellipse cx="480" cy="269" rx="31" ry="22"/><ellipse cx="319" cy="438" rx="23" ry="29"/></g>
</g>
</svg>`;
const photo = sharp(Buffer.from(leafSvg)).resize(2400, 1800).jpeg({ quality: 91 }).toBuffer();
const healthyPhoto = sharp(Buffer.from(leafSvg
  .replace(/<g fill="url\(#spot\)">[\s\S]*?<\/g>/, "")
  .replace(/<g fill="#69482f"[\s\S]*?<\/g>/, "")
  .replace(/<g fill="none" stroke="#b29a59"[\s\S]*?<\/g>/, "")))
  .resize(2400, 1800).jpeg({ quality: 91 }).toBuffer();
const diseased = {
  isPlant: true, plantNameAr: "طماطم", verdict: "diseased", diseaseNameAr: "اللفحة المبكرة",
  confidence: 0.84, findings: [
    { labelAr: "بقع بنية", box: [300, 420, 440, 585], severity: "medium" },
    { labelAr: "تلف النسيج", box: [530, 245, 680, 420], severity: "high" },
    { labelAr: "اصفرار موضعي", box: [235, 650, 350, 755], severity: "low" },
  ],
};
const healthy = { isPlant: true, plantNameAr: "طماطم", verdict: "healthy", diseaseNameAr: "", confidence: 0.94, findings: [] };

function card(page: Page) { return page.getByRole("region", { name: "تشخيص صحة النبات" }); }
function state(page: Page) { return card(page).getByTestId("leaf-diagnose-card"); }
async function pick(page: Page, bytes?: Buffer, mimeType = "image/jpeg") {
  await card(page).locator('input[type="file"]').setInputFiles({ name: "leaf-photo", mimeType, buffer: bytes ?? await photo });
  await expect(state(page)).toHaveAttribute("data-state", "ready");
  await card(page).scrollIntoViewIfNeeded();
}
async function scan(page: Page) { await card(page).getByRole("button", { name: "بدء الفحص" }).click(); }
async function mockDiagnosis(page: Page, response: unknown = diseased) {
  await page.route("**/api/leaf-diagnose", (route) => route.fulfill({ json: response }));
}
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await card(page).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  const box = await card(page).boundingBox();
  expect(box).not.toBeNull();
  const path = testInfo.outputPath(`390-${name}.png`);
  await page.screenshot({ path, clip: { x: 0, y: Math.max(0, box!.y - 6), width: 390, height: box!.height + 12 } });
  await testInfo.attach(`390px ${name} (mock diagnosis)`, { path, contentType: "image/png" });
}
async function withinFrame(labels: Locator, frame: Locator) {
  const outer = (await frame.boundingBox())!;
  for (const label of await labels.all()) {
    const box = (await label.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(outer.x);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
    expect(box.y).toBeGreaterThanOrEqual(outer.y);
    expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 960 });
  await page.addInitScript(() => localStorage.setItem("smart-crop.lang.v1", "ar"));
  await page.route("https://api.open-meteo.com/**", (route) => route.abort());
  await page.goto("/guest");
  await expect(card(page)).toBeVisible();
  await card(page).scrollIntoViewIfNeeded();
});

test("idle upload keeps the honest privacy text and does not contact either AI route", async ({ page }, testInfo) => {
  let requests = 0;
  page.on("request", (request) => { if (/\/api\/(assistant|leaf-diagnose)$/.test(request.url())) requests += 1; });
  await expect(state(page)).toHaveAttribute("data-state", "idle");
  await expect(card(page)).toContainText("تُرسل الصورة إلى خدمة التحليل لحظة الفحص ولا تُحفظ");
  await expect(card(page)).not.toContainText("تُعالج محلياً");
  await expect(card(page).locator('input[type="file"]')).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
  await screenshot(page, testInfo, "idle");
  expect(requests).toBe(0);
});

test("minimum scan, staggered reveal, compact sheet, chip/arrow zoom and toggle-out", async ({ page }, testInfo) => {
  await mockDiagnosis(page);
  await pick(page);
  const start = Date.now();
  await scan(page);
  await expect(state(page)).toHaveAttribute("data-state", "scanning");
  await expect(card(page).getByRole("status")).toContainText("يحلل الورقة…");
  await screenshot(page, testInfo, "scanning");
  await expect(card(page).getByTestId("leaf-result-sheet")).toHaveCount(0);
  await expect(card(page).getByTestId("leaf-finding-label")).toHaveCount(0);
  await expect(card(page).getByRole("status")).toContainText("يفحص الأنسجة…", { timeout: 2200 });
  await expect(state(page)).toHaveAttribute("data-state", "revealing", { timeout: 5000 });
  expect(Date.now() - start).toBeGreaterThanOrEqual(2400);
  const labels = card(page).getByTestId("leaf-finding-label");
  await expect(labels).toHaveCount(1);
  await page.waitForTimeout(460);
  await screenshot(page, testInfo, "mid-reveal");
  await expect(labels).toHaveCount(3);
  await expect(state(page)).toHaveAttribute("data-state", "complete");
  const sheet = card(page).getByTestId("leaf-result-sheet");
  await expect(sheet).toContainText("اللفحة المبكرة");
  await expect(sheet).toContainText("مصابة");
  await expect(sheet).toContainText("طماطم");
  await expect(sheet.getByRole("meter")).toHaveAttribute("aria-valuenow", "84");
  await expect(card(page)).toContainText("تقدير بصري لا يغني عن مهندس زراعي");
  await expect(card(page)).not.toContainText("التوصية الميدانية");
  await withinFrame(labels, card(page).getByTestId("leaf-image-frame"));
  await screenshot(page, testInfo, "final");

  await labels.first().click();
  await expect(labels.first()).toHaveAttribute("aria-pressed", "true");
  await expect(card(page).getByTestId("leaf-image-frame")).toHaveAttribute("data-zoomed", "true");
  await expect(labels.nth(1)).toHaveCSS("opacity", "0.28");
  await page.waitForTimeout(500);
  expect(await card(page).getByTestId("leaf-image-plane").evaluate((el) => getComputedStyle(el).transform)).not.toBe("matrix(1, 0, 0, 1, 0, 0)");
  await screenshot(page, testInfo, "zoomed");
  await labels.first().click();
  await expect(card(page).getByTestId("leaf-image-frame")).toHaveAttribute("data-zoomed", "false");
  await card(page).getByRole("button", { name: "تكبير موضع: تلف النسيج", exact: true }).press("Enter");
  await expect(labels.nth(1)).toHaveAttribute("aria-pressed", "true");
  await card(page).getByRole("button", { name: "عرض الكل" }).click();
  await expect(card(page).getByTestId("leaf-image-plane")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
});

test("client compresses/resizes to JPEG <=1280 before uploading, without user filename", async ({ page }) => {
  let inspected = false;
  await page.route("**/api/leaf-diagnose", async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = Uint8Array.from(route.request().postDataBuffer()!);
    const form = await new Response(body, { headers: { "Content-Type": route.request().headers()["content-type"] } }).formData();
    const file = form.get("image") as File;
    expect([...form.keys()]).toEqual(["image"]);
    expect(file.name).toBe("leaf.jpg");
    expect(file.type).toBe("image/jpeg");
    expect(file.size).toBeLessThanOrEqual(4 * 1024 * 1024);
    const metadata = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
    expect(metadata.width).toBe(1280);
    expect(metadata.height).toBe(960);
    inspected = true;
    await route.fulfill({ json: healthy });
  });
  await pick(page);
  await scan(page);
  await expect(card(page).getByTestId("leaf-result-sheet")).toBeVisible({ timeout: 7000 });
  expect(inspected).toBe(true);
});

test("healthy state is calm green with a check and no annotations", async ({ page }, testInfo) => {
  await mockDiagnosis(page, healthy);
  await pick(page, await healthyPhoto);
  await scan(page);
  const sheet = card(page).getByTestId("leaf-result-sheet");
  await expect(sheet).toBeVisible({ timeout: 7000 });
  await expect(sheet).toHaveAttribute("data-verdict", "healthy");
  await expect(sheet).toContainText("ورقة تبدو سليمة");
  await expect(card(page).getByText("سليمة بصريًا")).toBeVisible();
  await expect(card(page).getByTestId("leaf-finding-label")).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: /^تكبير موضع:/ })).toHaveCount(0);
  await screenshot(page, testInfo, "healthy");
});

test("uncertain does not invent or display a disease", async ({ page }) => {
  await mockDiagnosis(page, { ...diseased, verdict: "uncertain", diseaseNameAr: "", confidence: 0.36 });
  await pick(page);
  await scan(page);
  const sheet = card(page).getByTestId("leaf-result-sheet");
  await expect(sheet).toBeVisible({ timeout: 8000 });
  await expect(sheet).toContainText("غير مؤكد");
  await expect(sheet).toContainText("لم تتضح الإصابة");
  await expect(sheet).not.toContainText("اللفحة المبكرة");
});

test("busy provider has a technical reason and retry uses the same prepared image", async ({ page }, testInfo) => {
  let requests = 0;
  await page.route("**/api/leaf-diagnose", (route) => {
    requests += 1;
    return requests === 1 ? route.fulfill({ status: 503, json: { error: "provider-busy" } }) : route.fulfill({ json: healthy });
  });
  await pick(page);
  const imageUrl = await card(page).getByRole("img").getAttribute("src");
  await scan(page);
  const error = card(page).getByTestId("leaf-error");
  await expect(error).toBeVisible({ timeout: 6000 });
  await expect(error).toContainText("provider-busy");
  await screenshot(page, testInfo, "error");
  await card(page).getByRole("button", { name: "إعادة المحاولة" }).click();
  await expect(card(page).getByTestId("leaf-result-sheet")).toBeVisible({ timeout: 6000 });
  expect(await card(page).getByRole("img").getAttribute("src")).toBe(imageUrl);
  expect(requests).toBe(2);
});

test("not-a-plant is a friendly retry state, not a diagnosis sheet", async ({ page }) => {
  await mockDiagnosis(page, { isPlant: false, plantNameAr: "", verdict: "uncertain", diseaseNameAr: "", confidence: 0.98, findings: [] });
  await pick(page);
  await scan(page);
  await expect(card(page).getByTestId("leaf-error")).toBeVisible({ timeout: 6000 });
  await expect(card(page)).toContainText("لا يظهر نبات في هذه الصورة");
  await expect(card(page)).toContainText("not-a-plant");
  await expect(card(page).getByTestId("leaf-result-sheet")).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "إعادة المحاولة" })).toBeEnabled();
});

test("network failure can retry without inventing a result", async ({ page }) => {
  await page.route("**/api/leaf-diagnose", (route) => route.abort("failed"));
  await pick(page);
  await scan(page);
  await expect(card(page).getByTestId("leaf-error")).toBeVisible({ timeout: 6000 });
  await expect(card(page).getByTestId("leaf-error")).toContainText("network");
  await expect(card(page).getByTestId("leaf-result-sheet")).toHaveCount(0);
  await page.unroute("**/api/leaf-diagnose");
  await mockDiagnosis(page, healthy);
  await card(page).getByRole("button", { name: "إعادة المحاولة" }).click();
  await expect(card(page).getByTestId("leaf-result-sheet")).toBeVisible({ timeout: 6000 });
});

for (const kind of ["oversize", "unsupported", "spoofed"] as const) {
  test(`client ${kind} input has a clear error and sends no image`, async ({ page }) => {
    let requests = 0;
    await page.route("**/api/leaf-diagnose", (route) => { requests += 1; return route.fulfill({ json: healthy }); });
    const buffer = kind === "oversize" ? Buffer.alloc(4 * 1024 * 1024 + 1) : kind === "unsupported" ? Buffer.from("<svg/>") : Buffer.from("not a JPEG");
    await card(page).locator('input[type="file"]').setInputFiles({ name: "bad-image", mimeType: kind === "unsupported" ? "image/svg+xml" : "image/jpeg", buffer });
    await expect(state(page)).toHaveAttribute("data-state", "error");
    await expect(card(page).getByTestId("leaf-error")).toContainText(kind === "oversize" ? "too-large" : "invalid-input");
    expect(requests).toBe(0);
  });
}

test("reduced motion is a static scan, simultaneous reveal, and instant zoom", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDiagnosis(page);
  await pick(page);
  await scan(page);
  await expect(state(page)).toHaveAttribute("data-reduced-motion", "true");
  const scanner = card(page).getByTestId("leaf-scanner");
  expect(await scanner.evaluate((element) => [...element.querySelectorAll("*")].every((child) => getComputedStyle(child).animationName === "none"))).toBe(true);
  await page.waitForTimeout(1800);
  await expect(card(page).getByRole("status")).toContainText("يحلل الورقة…");
  await expect(card(page).getByTestId("leaf-result-sheet")).toBeVisible({ timeout: 2500 });
  await expect(card(page).getByTestId("leaf-finding-label")).toHaveCount(3);
  await card(page).getByTestId("leaf-finding-label").first().click();
  await expect(card(page).getByTestId("leaf-image-plane")).toHaveCSS("transition-duration", "0s");
  await card(page).getByRole("button", { name: "عرض الكل" }).click();
  await expect(card(page).getByTestId("leaf-image-plane")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
});

for (const width of [360, 390, 430]) {
  test(`${width}px RTL keeps all five labels inside the frame with usable targets`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await mockDiagnosis(page, { ...diseased, findings: [...diseased.findings,
      { labelAr: "حافة جافة", box: [610, 520, 780, 670], severity: "low" },
      { labelAr: "بقعة صغيرة", box: [100, 760, 220, 900], severity: "medium" },
    ] });
    await pick(page);
    await scan(page);
    await expect(card(page).getByTestId("leaf-result-sheet")).toBeVisible({ timeout: 9000 });
    await expect(card(page).getByTestId("leaf-finding-label")).toHaveCount(5);
    expect(await state(page).evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
    const bounds = (await card(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await state(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await withinFrame(card(page).getByTestId("leaf-finding-label"), card(page).getByTestId("leaf-image-frame"));
  });
}

test("changing/resetting/unmounting the card revokes its object URLs", async ({ page }) => {
  await page.evaluate(() => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revoked.push(url); original(url); };
    (window as unknown as { leafRevokedUrls: string[] }).leafRevokedUrls = revoked;
  });
  await pick(page);
  const first = await card(page).getByRole("img").getAttribute("src");
  await pick(page);
  await expect.poll(() => page.evaluate((url) => (window as unknown as { leafRevokedUrls: string[] }).leafRevokedUrls.includes(url!), first)).toBe(true);
  const second = await card(page).getByRole("img").getAttribute("src");
  await card(page).getByRole("button", { name: "فحص صورة أخرى" }).click();
  await expect.poll(() => page.evaluate((url) => (window as unknown as { leafRevokedUrls: string[] }).leafRevokedUrls.includes(url!), second)).toBe(true);
  await pick(page);
  const third = await card(page).getByRole("img").getAttribute("src");
  // Client-side navigation exercises unmount cleanup without replacing the document.
  await page.getByRole("link", { name: "المساعد", exact: true }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
  expect(await page.evaluate((url) => (window as unknown as { leafRevokedUrls: string[] }).leafRevokedUrls.includes(url!), third)).toBe(true);
});

test("reset during a pending scan cancels it and ignores a late result", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/leaf-diagnose", async (route) => {
    await gate;
    await route.fulfill({ json: diseased }).catch(() => {});
  });
  await pick(page);
  await scan(page);
  await expect(state(page)).toHaveAttribute("data-state", "scanning");
  await card(page).getByRole("button", { name: "فحص صورة أخرى" }).click();
  release();
  await page.waitForTimeout(400);
  await expect(state(page)).toHaveAttribute("data-state", "idle");
  await expect(card(page).getByTestId("leaf-result-sheet")).toHaveCount(0);
});

test("the real new route rejects malformed image bytes with JSON, not an HTML error", async ({ request }) => {
  const response = await request.post("/api/leaf-diagnose", { multipart: {
    image: { name: "bad.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image") },
  } });
  expect(response.status()).toBe(400);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual({ error: "invalid-input" });
});
