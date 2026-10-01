import { test, expect, type Page } from "@playwright/test";

/**
 * Lazy satellite layers in the plot analysis flow.
 *
 * The field-data API is mocked with ONE synthetic scene, so this spec asserts
 * the behaviour, not the upstream:
 *   – NDVI arrives with the analysis itself; NDMI / NDRE / true colour are
 *     requested ONLY the first time their chip is selected (counted calls).
 *   – every layer rides the SAME polygon, grid and scene date as the NDVI.
 *   – per-layer error + retry, in-memory caching, locked "قريباً" layers.
 *   – 390/360/430 px RTL screenshots of every layer (docs/plot-view/).
 */

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
test.setTimeout(90_000);

const view = (page: Page) => page.getByTestId("plot-view");
const map = (page: Page) => page.getByRole("dialog", { name: "خريطة الحقول" });
const sheet = (page: Page) => page.getByTestId("plot-analysis");

/* ----------------------------- synthetic scene ---------------------------- */

const SCENE = "2026-09-25";
const W = 24;
const H = 22;
const N = W * H;

type BBox = { west: number; south: number; east: number; north: number };
type Ring = [number, number][];

/** The real server reads the raster over the plot's own bbox — do the same. */
const bboxOf = (ring: Ring): BBox => ({
  west: Math.min(...ring.map((p) => p[0])),
  south: Math.min(...ring.map((p) => p[1])),
  east: Math.max(...ring.map((p) => p[0])),
  north: Math.max(...ring.map((p) => p[1])),
});

/** A diagonal cloud band — the same pixels are masked on every layer. */
const masked = (i: number) => Math.abs((i % W) - Math.floor(i / W) * 0.6 - 4) < 1.6;

function indexRaster(bbox: BBox, values: (i: number) => number, layer: string) {
  const ndvi: (number | null)[] = new Array(N);
  const dataMask: number[] = new Array(N);
  for (let i = 0; i < N; i += 1) {
    const m = masked(i);
    ndvi[i] = m ? null : Number(values(i).toFixed(3));
    dataMask[i] = m ? 0 : 1;
  }
  return { bbox, width: W, height: H, resolutionM: 10, ndvi, dataMask, layer, sceneDate: SCENE };
}

const ndviFixture = (bbox: BBox) => {
  const { ndvi, dataMask } = indexRaster(bbox, (i) => 0.1 + 0.62 * ((i % W) / (W - 1)) + 0.06 * Math.sin(i / 9), "ndvi");
  return { bbox, width: W, height: H, resolutionM: 10, ndvi, dataMask };
};

const trueColorFixture = (bbox: BBox) => {
  const ndvi: (number | null)[] = new Array(N).fill(null);
  const dataMask: number[] = new Array(N);
  const rgb: ([number, number, number] | null)[] = new Array(N);
  for (let i = 0; i < N; i += 1) {
    const m = masked(i);
    const x = i % W;
    const y = Math.floor(i / W);
    dataMask[i] = m ? 0 : 1;
    rgb[i] = m ? null : [70 + 4 * x, 96 + 4 * y, 58 + 2 * ((x + y) % 7)];
  }
  return { bbox, width: W, height: H, resolutionM: 10, ndvi, dataMask, rgb, layer: "truecolor", sceneDate: SCENE };
};

const CLIMATE = {
  source: "nasa-power", date: SCENE, et0: 3.4, et0Method: "penman-monteith", et0Hargreaves: 3.1,
  tempC: 22.4, tempMaxC: 28.9, tempMinC: 15.2, humidityPct: 58, windMs: 2.6, rainMm: 0,
  soilWetness: 0.31, radiationMj: 18.7, elevationM: 612, gridDeg: { lat: 34.8125, lon: 5.6875 },
  latitude: 34.82, longitude: 5.72,
};

const observation = (plotId: string, ring: Ring) => ({
  plotId,
  date: SCENE,
  sceneDate: SCENE,
  cells: [],
  raster: ndviFixture(bboxOf(ring)),
  climate: CLIMATE,
  cloudCoverPct: 3.2,
  partial: false,
  fetchedAt: new Date().toISOString(),
});

/* ------------------------------ plot drawing ------------------------------ */

async function setup(page: Page, zoom = 19) {
  await page.route("https://api.open-meteo.com/**", (r) => r.abort());
  await page.route("https://server.arcgisonline.com/**", (r) => r.abort());
  await page.addInitScript((zoom) => {
    localStorage.setItem("smart-crop.map.v1", JSON.stringify({ lat: 34.82, lng: 5.72, zoom }));
    navigator.geolocation.getCurrentPosition = (_ok, error) =>
      error?.({ code: 1, message: "Test denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  }, zoom);
  await page.goto("/guest");
  // Current dashboard entry point: the single plot card's draw action
  // (label as shipped — the string lives in the untouched dashboard copy).
  const draw = page.getByRole("button", { name: "ارسم قطتك" });
  await draw.scrollIntoViewIfNeeded();
  await draw.click();
  await expect(map(page).getByRole("button", { name: "رسم الحدود" })).toBeEnabled();
}

async function draw(page: Page) {
  await map(page).getByRole("button", { name: "رسم الحدود" }).click();
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  for (const [x, y] of [[-106, -78], [95, -56], [74, 107], [-85, 71]]) {
    await page.mouse.move(box.x + box.width / 2 + x, box.y + box.height / 2 + y);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  await map(page).getByRole("button", { name: "تم", exact: true }).first().tap();
  await expect(view(page)).toBeVisible({ timeout: 15_000 });
  await expect(view(page)).toHaveCSS("opacity", "1");
}

/* ------------------------------ route mocks ------------------------------- */

async function mockSatellite(page: Page, layerCalls: Array<{ layer: string; sceneDate: string }>, failOnce = false) {
  const layerRequests: string[] = [];
  await page.route("**/api/field-data", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    const body = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true, observation: observation(body.plotId ?? "plot-test", body.ring as Ring) } });
  });
  await page.route("**/api/field-data/layer", async (r) => {
    const body = r.request().postDataJSON();
    layerCalls.push({ layer: body.layer, sceneDate: body.sceneDate });
    if (failOnce && !layerRequests.includes(body.layer)) {
      layerRequests.push(body.layer);
      await r.fulfill({
        json: { ok: false, layer: body.layer, reason: "noScenes", raster: null, message: "Scene unavailable (fixture)" },
      });
      return;
    }
    const bbox = bboxOf(body.ring as Ring);
    const raster = body.layer === "truecolor" ? trueColorFixture(bbox) : indexRaster(
      bbox,
      body.layer === "ndmi" ? (i) => -0.34 + 0.72 * (Math.floor(i / W) / (H - 1)) : (i) => 0.04 + 0.5 * ((i % W) / (W - 1)),
      body.layer,
    );
    await r.fulfill({ json: { ok: true, layer: body.layer, raster } });
  });
}

async function openAnalysis(page: Page) {
  await page.getByRole("button", { name: /تحليل القطعة/ }).tap();
  await expect(sheet(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("plot-ndvi-layer")).toBeVisible({ timeout: 20_000 });
}

async function openMapsTab(page: Page) {
  await sheet(page).getByRole("tab", { name: "الخرائط" }).tap();
}

async function settle(page: Page) {
  // Let the sheet/legend entrance animations finish before capturing.
  await page.waitForTimeout(700);
}

/* --------------------------------- tests ---------------------------------- */

test("layers are lazy, share the NDVI scene, cache, and every layer renders", async ({ page }) => {
  const layerCalls: Array<{ layer: string; sceneDate: string }> = [];
  await setup(page);
  await mockSatellite(page, layerCalls);
  await draw(page);
  await openAnalysis(page);
  await openMapsTab(page);

  // NDVI arrived with the analysis itself — NOTHING lazy was requested yet.
  expect(layerCalls).toEqual([]);

  await settle(page);
  await page.screenshot({ path: "docs/plot-view/layer-ndvi-390.png" });

  // NDMI: first chip selection buys exactly one request, on the scene's date.
  await page.getByTestId("plot-layer-chip-ndmi").tap();
  await expect(page.getByTestId("plot-layer-ndmi")).toBeVisible({ timeout: 15_000 });
  expect(layerCalls).toEqual([{ layer: "ndmi", sceneDate: SCENE }]);
  await settle(page);
  await page.screenshot({ path: "docs/plot-view/layer-ndmi-390.png" });

  // NDRE.
  await page.getByTestId("plot-layer-chip-ndre").tap();
  await expect(page.getByTestId("plot-layer-ndre")).toBeVisible({ timeout: 15_000 });
  expect(layerCalls.at(-1)).toEqual({ layer: "ndre", sceneDate: SCENE });
  await settle(page);
  await page.screenshot({ path: "docs/plot-view/layer-ndre-390.png" });

  // True colour: an image layer, and the value probe has nothing to read.
  await page.getByTestId("plot-layer-chip-truecolor").tap();
  await expect(page.getByTestId("plot-layer-truecolor")).toBeVisible({ timeout: 15_000 });
  expect(layerCalls.at(-1)).toEqual({ layer: "truecolor", sceneDate: SCENE });
  await settle(page);
  await page.screenshot({ path: "docs/plot-view/layer-truecolor-390.png" });

  // Back and forth costs nothing: the per plot+scene cache answers locally.
  await page.getByTestId("plot-layer-chip-ndvi").tap();
  await expect(page.getByTestId("plot-ndvi-layer")).toBeVisible();
  await page.getByTestId("plot-layer-chip-ndmi").tap();
  await expect(page.getByTestId("plot-layer-ndmi")).toBeVisible();
  expect(layerCalls.filter((c) => c.layer === "ndmi")).toHaveLength(1);
  expect(layerCalls).toHaveLength(3);

  // Moisture and thermal stay locked "قريباً".
  await expect(page.getByTestId("plot-layer-chip-moisture")).toBeDisabled();
  await expect(page.getByTestId("plot-layer-chip-thermal")).toBeDisabled();
});

test("a failed layer shows its own error card and retry recovers", async ({ page }) => {
  const layerCalls: Array<{ layer: string; sceneDate: string }> = [];
  await setup(page);
  await mockSatellite(page, layerCalls, true); // first answer per layer fails
  await draw(page);
  await openAnalysis(page);
  await openMapsTab(page);

  await page.getByTestId("plot-layer-chip-ndmi").tap();
  await expect(sheet(page).getByRole("button", { name: "إعادة المحاولة" })).toBeVisible({ timeout: 15_000 });

  await sheet(page).getByRole("button", { name: "إعادة المحاولة" }).tap();
  await expect(page.getByTestId("plot-layer-ndmi")).toBeVisible({ timeout: 15_000 });
  expect(layerCalls.filter((c) => c.layer === "ndmi")).toHaveLength(2);
});

test.describe("RTL widths", () => {
  for (const width of [360, 430]) {
    test(`maps tab with an active layer at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const layerCalls: Array<{ layer: string; sceneDate: string }> = [];
      await setup(page);
      await mockSatellite(page, layerCalls);
      await draw(page);
      await openAnalysis(page);
      await openMapsTab(page);
      await page.getByTestId("plot-layer-chip-ndmi").tap();
      await expect(page.getByTestId("plot-layer-ndmi")).toBeVisible({ timeout: 15_000 });
      await settle(page);
      await page.screenshot({ path: `docs/plot-view/layer-ndmi-${width}.png` });
    });
  }
});
