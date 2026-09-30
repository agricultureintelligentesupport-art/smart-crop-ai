import { test, expect, type Page } from "@playwright/test";
import sharp from "sharp";

// Explicit mobile emulation (touch/device scale), not just a resized desktop.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
test.setTimeout(90_000);
const view = (page: Page) => page.getByTestId("plot-view");
const map = (page: Page) => page.getByRole("dialog", { name: "خريطة الحقول" });

async function setup(page: Page, zoom = 19) {
  await page.route("https://api.open-meteo.com/**", r => r.abort());
  // No live cloud credentials or upstream analysis needed for this UI test.
  await page.route("**/api/field-data", r => r.fulfill({ json: { ok: false, reason: "notConfigured" } }));
  await page.route("https://server.arcgisonline.com/**", r => r.abort());
  await page.addInitScript((zoom) => {
    localStorage.setItem("smart-crop.map.v1", JSON.stringify({ lat: 34.82, lng: 5.72, zoom }));
    // Suppress late GPS reframing; do not alter the map implementation.
    navigator.geolocation.getCurrentPosition = (_ok, error) => error?.({ code: 1, message: "Test denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  }, zoom);
  await page.goto("/guest");
  const card = page.locator("section[aria-label='الخريطة الحرارية للقطعة']");
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "ارسم قطعتك" }).click();
  await expect(map(page).getByRole("button", { name: "رسم الحدود" })).toBeEnabled();
}

async function draw(page: Page, points = [[-106,-78],[95,-56],[74,107],[-85,71]], alreadyDrawing = false) {
  if (!alreadyDrawing) await map(page).getByRole("button", { name: "رسم الحدود" }).click();
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  // Real Leaflet pointer events in mobile Chromium, no React/Leaflet mocks.
  for (const [x,y] of points) {
    await page.mouse.move(box.x + box.width / 2 + x, box.y + box.height / 2 + y);
    // Let Leaflet's transparent mouse marker track the pointer before down/up,
    // especially with global reduced-motion transitions near zero.
    await page.waitForTimeout(60);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(300); // Leaflet.draw's own new-marker debounce.
  }
  await map(page).getByRole("button", { name: "تم", exact: true }).first().tap();
  await expect(view(page)).toBeVisible({ timeout: 15_000 });
  await expect(view(page)).toHaveCSS("opacity", "1");
}
async function stored(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("smart-crop.plots.v1.local_guest") ?? "[]"));
}
async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `docs/plot-view/${name}.png` });
}

// Deliberately synthetic imagery for deterministic coverage/clip testing.
// Never label these tiles as a real satellite capture in the test report.
async function tileFixture() {
  const data = Buffer.alloc(256 * 256 * 3);
  for (let y=0;y<256;y++) for(let x=0;x<256;x++) {
    const i=(y*256+x)*3, patch=(Math.floor(x/45)+Math.floor(y/60))%3;
    data[i]=[72,135,98][patch]+x%9; data[i+1]=[111,125,135][patch]+y%7; data[i+2]=[52,68,60][patch];
  }
  return sharp(data,{raw:{width:256,height:256,channels:3}}).png().toBuffer();
}

test("Done saves once, full-screen fallback, inline rename persists, back, redraw and delete", async ({page}) => {
  await setup(page);
  await draw(page);
  const saved = await stored(page);
  expect(saved).toHaveLength(1);
  expect(saved[0].areaHa).toBeCloseTo(0.17, 2);
  const box = (await view(page).boundingBox())!;
  expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await expect(view(page).locator(".leaflet-container, .leaflet-control, input[role='combobox']")).toHaveCount(0);
  await expect(page.locator(".leaflet-container")).toBeHidden();
  await expect(page.getByTestId("plot-art")).toHaveAttribute("data-imagery", "fallback", {timeout: 15000});
  await expect(view(page).getByRole("button", {name: /تحليل القطعة/})).toBeDisabled();
  for (const button of await view(page).locator("footer button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await screenshot(page, "01-mobile-fallback");
  await view(page).getByRole("button", {name: "تعديل اسم القطعة"}).tap();
  await view(page).getByRole("textbox", {name:"اسم القطعة"}).fill("قطعة الزيتون");
  await view(page).getByRole("button", {name:"حفظ الاسم"}).tap();
  await expect(view(page).getByRole("heading", {name:"قطعة الزيتون", exact:true})).toBeVisible({timeout:10000});
  const renamed = (await stored(page))[0];
  expect(renamed.id).toBe(saved[0].id); expect(renamed.ring).toEqual(saved[0].ring); expect(renamed.createdAt).toBe(saved[0].createdAt);
  await page.locator(".plot-view__scroll").evaluate(el=>el.scrollTop=el.scrollHeight);
  await screenshot(page, "02-mobile-details");
  await view(page).getByRole("button", {name:"العودة إلى خريطة الرسم"}).tap();
  await expect(view(page)).toHaveCount(0);
  await expect(map(page).locator(".leaflet-container")).toBeVisible();
  await map(page).getByRole("button", {name:/قطعة الزيتون ·/}).tap();
  await expect(view(page)).toBeVisible();
  await view(page).getByRole("button", {name:"إعادة الرسم"}).tap();
  await expect(view(page)).toHaveCount(0);
  await expect(map(page).getByRole("button",{name:"تراجع"})).toBeVisible();
  await draw(page,[[-70,-70],[90,-70],[30,90]],true);
  expect(await stored(page)).toHaveLength(1);
  expect((await stored(page))[0].id).toBe(saved[0].id);
  await view(page).getByRole("button",{name:"حذف القطعة",exact:true}).tap();
  await page.getByRole("alertdialog").getByRole("button",{name:"إلغاء",exact:true}).tap();
  expect(await stored(page)).toHaveLength(1);
  await view(page).getByRole("button",{name:"حذف القطعة",exact:true}).tap();
  await page.getByRole("alertdialog").getByRole("button",{name:"حذف القطعة",exact:true}).tap();
  await expect(view(page)).toHaveCount(0,{timeout:10000});
  expect(await stored(page)).toHaveLength(0);
  await page.reload();
  expect(await stored(page)).toHaveLength(0);
});

for(const scenario of [
  {label:"small",zoom:19,points:[[-85,-82],[85,-82],[85,82],[-85,82]],expected:0.17,width:390,height:844},
  {label:"large",zoom:15,points:[[-85,-76.5],[85,-76.5],[85,76.5],[-85,76.5]],expected:40.01,width:390,height:844},
]) {
  test(`${scenario.label} plot: highest available parent tile, shape, mobile and responsive screenshots`,async({page})=>{
    await setup(page,scenario.zoom);
    const tile=await tileFixture();
    const unavailable=await sharp(Buffer.from('<svg width="256" height="256"><rect width="256" height="256" fill="#ccc"/><text x="10" y="120" fill="#555">Map data not yet available</text></svg>')).png().toBuffer();
    const zooms:number[]=[];
    const availableZoom = scenario.zoom;
    // No coverage metadata: exercise checked imagery fallback, including HTTP200 placeholder.
    await page.route("**/MapServer/tilemap/**",r=>r.fulfill({status:404,body:""}));
    await page.route("**/MapServer/tile/**?blankTile=false",r=>{
      const z=Number(new URL(r.request().url()).pathname.split("/").at(-3));zooms.push(z);
      return r.fulfill({contentType:"image/png",body:z>availableZoom?unavailable:tile,headers:{"access-control-allow-origin":"*"}});
    });
    await draw(page,scenario.points);
    expect((await stored(page))[0].areaHa).toBeCloseTo(scenario.expected,1);
    await expect(page.getByTestId("plot-art")).toHaveAttribute("data-imagery","satellite",{timeout:15000});
    await expect(page.getByTestId("plot-art")).toHaveAttribute("data-min-zoom",String(availableZoom));
    expect(Math.max(...zooms)).toBeGreaterThan(availableZoom);
    expect(zooms.length).toBeLessThanOrEqual(100);
    await expect(view(page).locator("clipPath polygon")).toHaveCount(1);
    const svg=view(page).getByRole("img");
    await expect(svg).toHaveAttribute("preserveAspectRatio","xMidYMid meet");
    await screenshot(page,`03-${scenario.label}-fixture-mobile`);
    await page.setViewportSize({width:320,height:740});
    await expect(view(page)).toHaveCSS("width","320px");
    expect(await view(page).evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await screenshot(page,`04-${scenario.label}-fixture-320`);
    await page.setViewportSize({width:1280,height:900});
    await screenshot(page,`05-${scenario.label}-fixture-desktop`);
  });
}

test("reduced motion, focus trap, Escape returns to drawing map and invalid shape never saves",async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});
  await setup(page);
  await map(page).getByRole("button",{name:"رسم الحدود"}).click();
  await map(page).getByRole("button",{name:"تم",exact:true}).first().click();
  await expect(view(page)).toHaveCount(0);expect(await stored(page)).toHaveLength(0);
  await map(page).getByRole("button",{name:"مسح",exact:true}).click();
  await draw(page);
  await expect(view(page)).toHaveCSS("transform","none");
  await expect(view(page).getByRole("button",{name:"العودة إلى خريطة الرسم"})).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(view(page).getByRole("button",{name:"حذف القطعة",exact:true})).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  await expect(map(page)).toBeVisible();
});

test("coverage metadata skips absent zooms, mixed coverage stretches parents, then a failed tile falls back", async ({page}) => {
  await setup(page);
  const tile = await tileFixture();
  const requests: number[] = [];
  await page.route("**/MapServer/tilemap/**", r => {
    const parts = new URL(r.request().url()).pathname.split("/");
    const [z, , , width, height] = parts.slice(-5).map(Number);
    return r.fulfill({json:{data:Array(width*height).fill(z <= 20 ? 1 : 0)}});
  });
  await page.route("**/MapServer/tile/**?blankTile=false", r => {
    const z = Number(new URL(r.request().url()).pathname.split("/").at(-3)); requests.push(z);
    // An advertised child still fails: use the ancestor, never publish a hole.
    if (z === 20 && requests.length % 2) return r.fulfill({ status: 404, body: "" });
    return r.fulfill({contentType:"image/png",body:tile,headers:{"access-control-allow-origin":"*"}});
  });
  await draw(page);
  await expect(page.getByTestId("plot-art")).toHaveAttribute("data-imagery","satellite",{timeout:15000});
  expect(Math.max(...requests)).toBe(20);
  await expect(page.getByTestId("plot-art")).toHaveAttribute("data-min-zoom","19");
  await expect(page.getByTestId("plot-art")).toHaveAttribute("data-max-zoom","20");
  await view(page).getByRole("button",{name:"العودة إلى خريطة الرسم"}).tap();
  await expect(view(page)).toHaveCount(0);
  await page.unroute("**/MapServer/tile/**?blankTile=false");
  await page.route("**/MapServer/tile/**?blankTile=false", r=>r.fulfill({contentType:"text/html",body:"unavailable"}));
  await map(page).getByRole("button",{name:/قطعتي ·/}).tap();
  await expect(page.getByTestId("plot-art")).toHaveAttribute("data-imagery","fallback",{timeout:15000});
  await expect(view(page).locator("svg image")).toHaveCount(0);
});
