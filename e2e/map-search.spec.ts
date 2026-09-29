import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * The field map's place search — the custom `MapSearch` component that
 * replaced `leaflet-control-geocoder`.
 *
 * Runs on the Mobile Chrome (Pixel 7) project: the search is a touch surface
 * first. `/api/geocode` is stubbed at the network boundary with responses in
 * the exact shape the route emits (the sandbox has no Nominatim egress, and a
 * green run must never depend on it), so what is under test here is the UI
 * contract: debounce, states, the fly-only selection, and that NOTHING is
 * ever drawn for a search result.
 */

/** Khenchela, shaped the way `/api/geocode` returns it (see geo/places.ts). */
const KHENCHELA_RESULTS = {
  results: [
    { id: "52639528-0", name: "خنشلة", secondary: null, lat: 34.9133455, lng: 6.9059431 },
    { id: "55236293-1", name: "خنشلة", secondary: "دائرة خنشلة، خنشلة", lat: 35.430154, lng: 7.145711 },
  ],
};

const BISKRA_RESULTS = {
  results: [{ id: "1-0", name: "بسكرة", secondary: "بسكرة", lat: 34.85, lng: 5.72805 }],
};

const SEARCH_INPUT = "البحث عن موقع على الخريطة";

test.beforeEach(async ({ page }) => {
  // Reference weather and tiles: the sandbox cannot reach either upstream.
  await page.route("https://api.open-meteo.com/**", (route) => route.abort());
  await page.route("https://server.arcgisonline.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    }),
  );
  await page.goto("/guest");
  const card = page.locator("section[aria-label='الخريطة الحرارية للقطعة']");
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "ارسم قطعتك" }).click();
  await expect(page.getByRole("dialog", { name: "خريطة الحقول" })).toBeVisible();
  await expect(page.getByRole("dialog").locator(".leaflet-container")).toBeVisible();
});

/** All /api/geocode calls answered with `payload` (or a failure mode). */
async function stubGeocode(page: Page, payload: object | "abort"): Promise<{ requests: URL[] }> {
  const requests: URL[] = [];
  await page.route("**/api/geocode*", (route: Route) => {
    requests.push(new URL(route.request().url()));
    if (payload === "abort") return route.abort();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  return { requests };
}

function searchBox(page: Page) {
  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  return dialog.getByRole("combobox", { name: SEARCH_INPUT });
}

/** The map pane's transform is reset when a zoom animation ends, so a fly is
 * proven instead by the tiles the map asks for — their z/y/x encode exactly
 * where the view landed. */
function expectedTile(lat: number, lng: number, zoom: number): string {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n);
  return `/${zoom}/${y}/${x}`;
}

test("the custom pill replaces the geocoder control, icon on the right (RTL), 48px tall", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  // The old Leaflet control is gone from the DOM entirely.
  await expect(dialog.locator(".leaflet-control-geocoder")).toHaveCount(0);

  const input = searchBox(page);
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("placeholder", "ابحث عن مكان في الجزائر…");

  // The pill is 48px tall and floats at the top of the map area, above the
  // Leaflet panes (the sheet header sits above it, hence the loose y bound).
  const pill = input.locator("xpath=ancestor::div[1]");
  const pillBox = await pill.boundingBox();
  const canvasBox = await dialog.locator(".leaflet-container").boundingBox();
  expect(pillBox).not.toBeNull();
  expect(Math.round(pillBox!.height)).toBe(48);
  expect(pillBox!.y).toBeLessThan(canvasBox!.y + 40);

  // RTL: the search icon (first child of the pill) hugs the right edge.
  const icon = pill.locator("span").first();
  const iconBox = await icon.boundingBox();
  expect(iconBox!.x + iconBox!.width).toBeGreaterThan(pillBox!.x + pillBox!.width * 0.75);
});

test("typing خنشلة searches once (debounced), then lists name + wilaya rows at 48px", async ({ page }) => {
  const { requests } = await stubGeocode(page, KHENCHELA_RESULTS);
  const input = searchBox(page);

  // Fewer than 3 characters must never hit the API.
  await input.pressSequentially("خن");
  await page.waitForTimeout(900);
  expect(requests).toHaveLength(0);

  await input.pressSequentially("شلة");
  await expect
    .poll(() => requests.length, { timeout: 5_000, message: "one debounced request after typing stops" })
    .toBe(1);
  expect(requests[0].searchParams.get("q")).toBe("خنشلة");
  expect(requests[0].searchParams.get("lang")).toBe("ar");

  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  const options = dialog.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText("خنشلة");
  await expect(options.nth(1)).toContainText("دائرة خنشلة، خنشلة");
  const rowBox = await options.first().boundingBox();
  expect(rowBox!.height).toBeGreaterThanOrEqual(48);
});

test("tapping a result flies the map, closes the dropdown, blurs, and draws nothing", async ({ page }) => {
  // The fly is proven by the tile the map requests once it lands: Khenchela
  // city at zoom 16 has exactly one covering tile.
  const tiles: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("server.arcgisonline.com")) tiles.push(request.url());
  });
  await stubGeocode(page, KHENCHELA_RESULTS);
  const input = searchBox(page);
  await input.fill("خنشلة");
  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  await expect(dialog.getByRole("option").first()).toBeVisible();

  const markerCount = await dialog.locator(".leaflet-marker-pane > *").count();
  const tileBefore = tiles.length;

  await dialog.getByRole("option").nth(1).click(); // Khenchela city, 35.43 / 7.1457

  // Fly, not pin: the dropdown closes, the input blurs (mobile keyboard down).
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await expect(input).not.toBeFocused();

  // The map now requests the Khenchela tile at zoom 16 (single-field scale).
  await expect
    .poll(() => tiles.slice(tileBefore).some((url) => url.includes(expectedTile(35.430154, 7.145711, 16))), {
      timeout: 10_000,
      message: "the covering tile of the selected place is fetched at zoom 16",
    })
    .toBe(true);

  // Nothing was drawn for the search — no marker, no overlay geometry.
  expect(await dialog.locator(".leaflet-marker-pane > *").count()).toBe(markerCount);
  await expect(dialog.locator(".leaflet-marker-pane > *")).toHaveCount(0);
});

test("a search with zero answers says لا توجد نتائج", async ({ page }) => {
  await stubGeocode(page, { results: [] });
  const input = searchBox(page);
  await input.fill("ززززز");
  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  await expect(dialog.getByText("لا توجد نتائج")).toBeVisible();
});

test("a failed search offers إعادة المحاولة, and the retry recovers", async ({ page }) => {
  const { requests } = await stubGeocode(page, "abort");
  const input = searchBox(page);
  await input.fill("بسكرة");
  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  await expect(dialog.getByText("تعذّر إتمام البحث. تحقّق من الاتصال.")).toBeVisible({ timeout: 10_000 });

  await page.unroute("**/api/geocode*");
  await stubGeocode(page, BISKRA_RESULTS);
  await dialog.getByRole("button", { name: "إعادة المحاولة" }).click();
  await expect(dialog.getByRole("option").first()).toContainText("بسكرة");
  expect(requests.length).toBeGreaterThanOrEqual(1);
});

test("results are cached: re-searching the same place sends no second request", async ({ page }) => {
  const { requests } = await stubGeocode(page, KHENCHELA_RESULTS);
  const input = searchBox(page);
  await input.fill("خنشلة");
  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  await expect(dialog.getByRole("option").first()).toBeVisible();

  await dialog.getByRole("button", { name: "مسح البحث" }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();

  await input.fill("خنشلة");
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(requests).toHaveLength(1);
});

test("the clear button empties and the dropdown does not linger outside taps", async ({ page }) => {
  await stubGeocode(page, KHENCHELA_RESULTS);
  const input = searchBox(page);
  await input.fill("خنشلة");
  const dialog = page.getByRole("dialog", { name: "خريطة الحقول" });
  await expect(dialog.getByRole("option").first()).toBeVisible();

  // A tap on the map (outside the search root) collapses the dropdown.
  await dialog.locator(".leaflet-container").click({ position: { x: 60, y: 320 } });
  await expect(dialog.getByRole("option")).toHaveCount(0);
  // The text stays, so the ✕ remains available to start over.
  await expect(input).toHaveValue("خنشلة");
});
