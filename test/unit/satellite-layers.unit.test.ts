/**
 * The lazy Sentinel-2 layers of the plot analysis: NDMI, NDRE and true colour.
 *
 * Nothing here can reach the live service, so the suite pins the contract:
 *   • the formulas are EXACTLY (B8A−B11)/(B8A+B11) and (B8A−B05)/(B8A+B05),
 *     tested by executing the shipped evalscript's own `evaluatePixel`;
 *   • the evalscripts ask for the right bands and keep NDVI's masking
 *     semantics byte-for-byte (`dataMask` ∧ SCL ∧ sum>0 → index, else NaN);
 *   • the request is the SAME Process API pattern as NDVI: same polygon,
 *     10 m, the scene's own date, same credentials, same `step=…` logs;
 *   • the client cache key is per plot + scene + layer, memoised, deduped,
 *     never caching a failure, and superseded when a newer scene arrives;
 *   • the layer switcher config: NDVI/NDMI/NDRE/true colour selectable,
 *     moisture/thermal stay locked «قريباً», 20 m bands state their
 *     resampling, index values stay unit-free.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { bboxOf, type Ring } from "@/lib/geo/polygon";
import { resetTokenCache, type OpeneoConfig, type OpeneoFetch } from "@/lib/satellite/openeo";
import {
  buildIndexEvalscript,
  buildProcessRequest,
  EVALSCRIPT,
  fetchSatelliteLayer,
  NDMI_EVALSCRIPT,
  NDRE_EVALSCRIPT,
  rasterSize,
  SATELLITE_LAYERS,
  tiffToTrueColorRaster,
  TRUE_COLOR_EVALSCRIPT,
} from "@/lib/satellite/sentinelhub";
import { SatelliteTrace } from "@/lib/satellite/trace";
import {
  cachedPlotLayer,
  layerCacheKey,
  requestPlotLayer,
  resetPlotLayerCache,
} from "@/lib/plot/layer-fetch";
import { PLOT_LAYERS } from "@/lib/plot/ndvi-layers";

const SECRET = "s3cr3t-value-123";
const CONFIG: OpeneoConfig = {
  clientId: "sh-abc-123",
  clientSecret: SECRET,
  openEoUrl: "https://openeo.dataspace.copernicus.eu/openeo/1.2",
  tokenUrl: "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
  collection: "SENTINEL2_L2A",
  timeoutMs: 5_000,
  processUrl: "https://sh.dataspace.copernicus.eu/api/v1/process",
  catalogUrl: "https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search",
  useOpeneo: false,
  useGrid: false,
};

// ≈ 134 m × 134 m (≈ 1.8 ha) next to Algiers — the NDVI suite's parcel.
const RING: Ring = [
  [3.05, 36.75],
  [3.0515, 36.75],
  [3.0515, 36.7512],
  [3.05, 36.7512],
];
const BBOX = bboxOf(RING)!;

/* ------------------- the shipped formulas, executed --------------------- */

/** Runs the evalscript's own `evaluatePixel` on one sample. */
function evaluator(script: string): (s: Record<string, number>) => number[] {
  const match = script.match(/function evaluatePixel\(s\) \{([\s\S]*)\}\s*$/);
  assert.ok(match, "the evalscript defines evaluatePixel(s)");
  return new Function("s", match![1]) as (s: Record<string, number>) => number[];
}

test("NDMI is EXACTLY (B8A − B11) / (B8A + B11), unit-free", () => {
  const run = evaluator(NDMI_EVALSCRIPT);
  const cases: [number, number][] = [
    [0.3, 0.1],
    [0.42, 0.31],
    [0.1, 0.4],
    [0.25, 0.25],
    [0.0001, 0.0003],
  ];
  for (const [b8a, b11] of cases) {
    const [value, valid] = run({ B8A: b8a, B11: b11, SCL: 4, dataMask: 1 });
    assert.equal(valid, 1, "a clear pixel is usable");
    assert.ok(Math.abs(value - (b8a - b11) / (b8a + b11)) < 1e-6, `NDMI(${b8a}, ${b11}) = ${value}`);
    assert.ok(value >= -1 && value <= 1, "the index stays unit-free in [-1, 1]");
  }
});

test("NDRE is EXACTLY (B8A − B05) / (B8A + B05), unit-free", () => {
  const run = evaluator(NDRE_EVALSCRIPT);
  const cases: [number, number][] = [
    [0.5, 0.2],
    [0.33, 0.29],
    [0.12, 0.35],
    [0.4, 0.4],
  ];
  for (const [b8a, b05] of cases) {
    const [value, valid] = run({ B8A: b8a, B05: b05, SCL: 5, dataMask: 1 });
    assert.equal(valid, 1);
    assert.ok(Math.abs(value - (b8a - b05) / (b8a + b05)) < 1e-6, `NDRE(${b8a}, ${b05}) = ${value}`);
    assert.ok(value >= -1 && value <= 1);
  }
});

/* --------------------- dataMask / SCL gating identity -------------------- */

test("every layer keeps NDVI's dataMask logic: masked, cloudy or zero-sum pixels carry no value", () => {
  const ndvi = evaluator(EVALSCRIPT);
  const ndmi = evaluator(NDMI_EVALSCRIPT);
  const ndre = evaluator(NDRE_EVALSCRIPT);
  const trueColor = evaluator(TRUE_COLOR_EVALSCRIPT);
  const badClasses = [1, 3, 8, 9, 10, 11];

  // dataMask 0 → never a value, on ANY layer.
  assert.deepEqual([ndmi({ B8A: 0.3, B11: 0.1, SCL: 4, dataMask: 0 })[1], Number.isNaN(ndmi({ B8A: 0.3, B11: 0.1, SCL: 4, dataMask: 0 })[0])], [0, true]);
  assert.equal(ndre({ B8A: 0.3, B05: 0.1, SCL: 4, dataMask: 0 })[1], 0);
  assert.equal(trueColor({ B04: 0.2, B03: 0.2, B02: 0.1, SCL: 4, dataMask: 0 })[3], 0);
  assert.ok(Number.isNaN(trueColor({ B04: 0.2, B03: 0.2, B02: 0.1, SCL: 4, dataMask: 0 })[0]));

  // The SAME unusable SCL classes as NDVI — checked identically per layer.
  for (const cls of badClasses) {
    assert.equal(ndmi({ B8A: 0.3, B11: 0.1, SCL: cls, dataMask: 1 })[1], 0, `NDMI rejects SCL ${cls}`);
    assert.equal(ndre({ B8A: 0.3, B05: 0.1, SCL: cls, dataMask: 1 })[1], 0, `NDRE rejects SCL ${cls}`);
    assert.equal(trueColor({ B04: 0.2, B03: 0.2, B02: 0.1, SCL: cls, dataMask: 1 })[3], 0, `true colour rejects SCL ${cls}`);
    assert.equal(ndvi({ B08: 0.5, B04: 0.1, SCL: cls, dataMask: 1 })[1], 0, `NDVI rejects SCL ${cls} (reference)`);
  }
  // Vegetation / bare soil / water stay usable — a wheat field is not a cloud.
  for (const cls of [2, 4, 5, 6, 7]) {
    assert.equal(ndmi({ B8A: 0.3, B11: 0.1, SCL: cls, dataMask: 1 })[1], 1, `NDMI keeps SCL ${cls}`);
    assert.equal(trueColor({ B04: 0.2, B03: 0.2, B02: 0.1, SCL: cls, dataMask: 1 })[3], 1, `true colour keeps SCL ${cls}`);
  }

  // Zero denominators are masked, not Infinity.
  assert.equal(ndmi({ B8A: 0, B11: 0, SCL: 4, dataMask: 1 })[1], 0);
  assert.equal(ndre({ B8A: 0, B05: 0, SCL: 4, dataMask: 1 })[1], 0);
  assert.equal(trueColor({ B04: 0, B03: 0, B02: 0, SCL: 4, dataMask: 1 })[3], 0);
});

test("the index builder reproduces the NDVI evalscript byte for byte", () => {
  assert.equal(buildIndexEvalscript("B08", "B04", "NDVI"), EVALSCRIPT);
});

/* --------------------------- evalscript bands ---------------------------- */

test("each layer asks for exactly its bands, FLOAT32, with dataMask + SCL", () => {
  const inputBands = (script: string) => {
    const m = script.match(/bands: \[([^\]]+)\]/);
    assert.ok(m, "the script declares input bands");
    return m![1].split(",").map((b) => b.trim().replace(/"/g, ""));
  };
  const outputBands = (script: string) => Number(script.match(/output: \{ bands: (\d+)/)![1]);

  // The builder lists the lo band first — the exact shape of NDVI's own
  // `["B04", "B08", …]` input, which keeps every index script alike.
  assert.deepEqual(inputBands(NDMI_EVALSCRIPT), ["B11", "B8A", "SCL", "dataMask"]);
  assert.deepEqual(inputBands(NDRE_EVALSCRIPT), ["B05", "B8A", "SCL", "dataMask"]);
  assert.deepEqual(inputBands(TRUE_COLOR_EVALSCRIPT), ["B04", "B03", "B02", "SCL", "dataMask"]);
  assert.equal(outputBands(NDMI_EVALSCRIPT), 2);
  assert.equal(outputBands(NDRE_EVALSCRIPT), 2);
  assert.equal(outputBands(TRUE_COLOR_EVALSCRIPT), 4);
  for (const script of [NDMI_EVALSCRIPT, NDRE_EVALSCRIPT, TRUE_COLOR_EVALSCRIPT]) {
    assert.match(script, /FLOAT32/);
    assert.match(script, /mosaicking: "SIMPLE"/);
  }
  // The config table the fetch path reads agrees with the scripts.
  assert.deepEqual([...SATELLITE_LAYERS.ndmi.bands], ["B11", "B8A", "SCL", "dataMask"]);
  assert.deepEqual([...SATELLITE_LAYERS.ndre.bands], ["B05", "B8A", "SCL", "dataMask"]);
  assert.deepEqual([...SATELLITE_LAYERS.truecolor.bands], ["B04", "B03", "B02", "SCL", "dataMask"]);
  assert.equal(SATELLITE_LAYERS.ndmi.evalscript, NDMI_EVALSCRIPT);
  assert.equal(SATELLITE_LAYERS.ndre.evalscript, NDRE_EVALSCRIPT);
  assert.equal(SATELLITE_LAYERS.truecolor.evalscript, TRUE_COLOR_EVALSCRIPT);
  // 20 m bands are resampled explicitly; the 10 m layers leave the body alone.
  assert.equal(SATELLITE_LAYERS.ndmi.upsampling, "BILINEAR");
  assert.equal(SATELLITE_LAYERS.ndre.upsampling, "BILINEAR");
  assert.equal(SATELLITE_LAYERS.truecolor.upsampling, undefined);
});

test("the true-colour script returns R=B04, G=B03, B=B02, then the valid flag", () => {
  const run = evaluator(TRUE_COLOR_EVALSCRIPT);
  const [r, g, b, valid] = run({ B04: 0.21, B03: 0.17, B02: 0.09, SCL: 4, dataMask: 1 });
  assert.equal(valid, 1);
  assert.ok(Math.abs(r - 0.21) < 1e-6 && Math.abs(g - 0.17) < 1e-6 && Math.abs(b - 0.09) < 1e-6);
});

/* ----------------------- the Process request pattern --------------------- */

test("a layer request is the NDVI pattern: same polygon, same 10 m grid, the scene's own day, same credentials", async () => {
  resetTokenCache();
  const fixture = indexTiff();
  const { calls, fetchImpl } = stubLayer({ process: () => res(200, "", buildTiff(fixture.width, fixture.height, fixture.bands)) });
  const { trace, lines } = quietTrace();
  const result = await fetchSatelliteLayer(
    CONFIG,
    { layer: "ndmi", sceneDate: "2026-09-25", bbox: BBOX, ring: RING },
    fetchImpl,
    trace,
  );
  assert.equal(result.ok, true);
  assert.equal(result.sceneDate, "2026-09-25");
  assert.equal(result.cloudCoverPct, 3.1);

  // token → catalog → process, exactly the NDVI flow's steps.
  assert.deepEqual(trace.steps.map((s) => s.step), ["cdse-token", "sh-catalog", "sh-process"]);
  assert.ok(trace.steps.every((s) => s.ok));
  assert.ok(lines.some((l) => l.includes("step=sh-process") && l.includes("ok=true")));

  // Same credentials, in the body only, bearer on the satellite calls.
  assert.match(String(calls[0].body), /grant_type=client_credentials/);
  assert.match(String(calls[0].body), /client_id=sh-abc-123/);
  for (const c of calls.slice(1)) assert.equal(c.headers?.authorization, "Bearer tok-XYZ");
  assert.ok(!lines.join("\n").includes(SECRET));

  const processBody = JSON.parse(calls[calls.length - 1].body!) as Record<string, unknown>;
  const ndviBody = buildProcessRequest({
    bbox: BBOX,
    ring: RING,
    from: "2026-09-25T00:00:00Z",
    to: "2026-09-25T23:59:59Z",
    order: "leastCC",
  });
  // Same polygon, same bbox, SAME pixel grid as the NDVI request.
  assert.deepEqual(
    (processBody as { input: { bounds: unknown } }).input.bounds,
    (ndviBody as { input: { bounds: unknown } }).input.bounds,
  );
  assert.deepEqual(
    (processBody as { output: { width: number; height: number } }).output,
    (ndviBody as { output: { width: number; height: number } }).output,
  );
  // …and the window is the scene's own day with the same mosaicking order.
  const dataFilter = (processBody as { input: { data: { dataFilter: { timeRange: { from: string; to: string }; mosaickingOrder: string } }[] } })
    .input.data[0].dataFilter;
  assert.equal(dataFilter.timeRange.from, "2026-09-25T00:00:00Z");
  assert.equal(dataFilter.timeRange.to, "2026-09-25T23:59:59Z");
  assert.equal(dataFilter.mosaickingOrder, "leastCC");
  // The layer's own script, and bilinear resampling for the 20 m band.
  assert.equal((processBody as { evalscript: string }).evalscript, NDMI_EVALSCRIPT);
  assert.deepEqual(
    (processBody as { input: { data: { processing?: unknown }[] } }).input.data[0].processing,
    { upsampling: "BILINEAR" },
  );
  // NDVI's own body keeps NO processing block and the NDVI script (unchanged).
  assert.equal((ndviBody as { evalscript: string }).evalscript, EVALSCRIPT);
  assert.equal(
    ((ndviBody as { input: { data: Record<string, unknown>[] } }).input.data[0] as Record<string, unknown>).processing,
    undefined,
  );
});

test("the true-colour request carries no resampling block (10 m bands only)", async () => {
  resetTokenCache();
  const fixture = trueColorTiff();
  const { calls, fetchImpl } = stubLayer({ process: () => res(200, "", buildTiff(fixture.width, fixture.height, fixture.bands)) });
  const result = await fetchSatelliteLayer(
    CONFIG,
    { layer: "truecolor", sceneDate: "2026-09-25", bbox: BBOX, ring: RING },
    fetchImpl,
  );
  assert.equal(result.ok, true);
  const body = JSON.parse(calls[calls.length - 1].body!) as { input: { data: Record<string, unknown>[] } };
  assert.equal(body.input.data[0].processing, undefined);
});

/* --------------------- dataMask through the fetch path ------------------- */

test("masked pixels travel as null + dataMask 0 on every layer — never an estimate", async () => {
  resetTokenCache();
  const fixture = indexTiff();
  const { fetchImpl } = stubLayer({ process: () => res(200, "", buildTiff(fixture.width, fixture.height, fixture.bands)) });
  const result = await fetchSatelliteLayer(
    CONFIG,
    { layer: "ndre", sceneDate: "2026-09-25", bbox: BBOX, ring: RING },
    fetchImpl,
  );
  assert.equal(result.ok, true);
  const raster = result.raster!;
  assert.equal(raster.layer, "ndre");
  const { width, height } = rasterSize(BBOX);
  assert.equal(raster.width, width);
  assert.equal(raster.height, height);
  let masked = 0;
  for (let i = 0; i < raster.ndvi.length; i += 1) {
    if (raster.dataMask[i] === 0) {
      assert.equal(raster.ndvi[i], null, "a masked pixel carries no value");
      masked += 1;
    } else {
      assert.ok(typeof raster.ndvi[i] === "number" && raster.ndvi[i]! >= -1.2 && raster.ndvi[i]! <= 1.2);
    }
  }
  assert.ok(masked > 0, "the cloudy quadrant of the fixture is masked");
  assert.ok(result.validPixels > 0 && result.validPixels < raster.ndvi.length);
});

test("tiffToTrueColorRaster quantises measured pixels and keeps masked ones transparent", () => {
  const width = 2;
  const height = 2;
  const r = Float32Array.from([0.2, 1.4, NaN, 0.5]);
  const g = Float32Array.from([0.3, 0.1, 0.2, 0.5]);
  const b = Float32Array.from([0.1, 0.0, 0.4, 0.5]);
  const valid = Float32Array.from([1, 1, 1, 0]);
  const raster = tiffToTrueColorRaster({ width, height, bands: [r, g, b, valid] }, BBOX, 10, "2026-09-25");
  assert.equal(raster.layer, "truecolor");
  assert.equal(raster.sceneDate, "2026-09-25");
  assert.deepEqual(raster.rgb![0], [51, 77, 26]); // 0.2/0.3/0.1 × 255
  assert.deepEqual(raster.rgb![1], [255, 26, 0], "reflectance > 1 is a display clamp, not a rejection");
  assert.equal(raster.rgb![2], null, "a NaN channel is not measured");
  assert.equal(raster.rgb![3], null, "valid band 0 is not measured");
  assert.deepEqual(raster.dataMask, [1, 1, 0, 0]);
  assert.ok(raster.ndvi.every((v) => v === null), "an image layer carries no index values");
});

test("a fully-cloudy layer answer is noScenes; a wrong-shaped answer never invents pixels", async () => {
  resetTokenCache();
  const cloudy = indexTiff();
  cloudy.bands[0].fill(NaN);
  cloudy.bands[1].fill(0);
  const empty = await fetchSatelliteLayer(
    CONFIG,
    { layer: "ndmi", sceneDate: "2026-09-25", bbox: BBOX, ring: RING },
    stubLayer({ process: () => res(200, "", buildTiff(cloudy.width, cloudy.height, cloudy.bands)) }).fetchImpl,
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "noScenes");
  assert.equal(empty.raster, null);

  resetTokenCache();
  const oneBand = await fetchSatelliteLayer(
    CONFIG,
    { layer: "truecolor", sceneDate: "2026-09-25", bbox: BBOX, ring: RING },
    stubLayer({ process: () => res(200, "", buildTiff(2, 2, [new Float32Array(4)])) }).fetchImpl,
  );
  assert.equal(oneBand.ok, false, "a missing valid band is not silently accepted");
});

/* --------------------------- the cache key ------------------------------- */

test("the layer cache key is per plot + scene + layer — nothing else can collide", () => {
  const base = layerCacheKey("plot-1", "2026-09-25", "ndmi");
  assert.equal(layerCacheKey("plot-1", "2026-09-25", "ndmi"), base, "stable");
  assert.notEqual(layerCacheKey("plot-2", "2026-09-25", "ndmi"), base, "another plot");
  assert.notEqual(layerCacheKey("plot-1", "2026-09-20", "ndmi"), base, "another scene");
  assert.notEqual(layerCacheKey("plot-1", "2026-09-25", "ndre"), base, "another layer");
  // Components never blend into a neighbour's key.
  assert.notEqual(layerCacheKey("a·2026-09-25", "ndmi", "x" as never), layerCacheKey("a", "2026-09-25·ndmi", "x" as never));
});

/* --------------------- the client fetch + memo (stubbed) ------------------ */

function layerFetchStub(failOnce = false) {
  const calls: Record<string, unknown>[] = [];
  let failed = false;
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push(body);
    if (failOnce && !failed) {
      failed = true;
      return { ok: true, status: 200, json: async () => ({ ok: false, layer: body.layer, reason: "quota", raster: null }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        layer: body.layer,
        raster: {
          layer: body.layer,
          sceneDate: body.sceneDate,
          bbox: { west: 3.05, south: 36.75, east: 3.0515, north: 36.7512 },
          width: 2,
          height: 2,
          resolutionM: 10,
          ndvi: [0.2, null, 0.4, 0.3],
          dataMask: [1, 0, 1, 1],
        },
      }),
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const LAYER_INPUT = {
  uid: "u1",
  plotId: "plot-1",
  ring: RING,
  layer: "ndmi" as const,
  sceneDate: "2026-09-25",
};

test("a layer is fetched once per plot + scene, memoised, and never re-asked while in flight", async () => {
  resetPlotLayerCache();
  const { calls, fetchImpl } = layerFetchStub();
  const first = await requestPlotLayer(LAYER_INPUT, { fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1, "one network request");
  assert.equal(cachedPlotLayer("plot-1", "2026-09-25", "ndmi"), first.ok ? first.raster : null);

  const second = await requestPlotLayer(LAYER_INPUT, { fetchImpl });
  assert.equal(second.ok, true);
  assert.equal(calls.length, 1, "the memo answers — no second request");

  // Concurrent selections share ONE in-flight request.
  resetPlotLayerCache();
  const [a, b] = await Promise.all([
    requestPlotLayer(LAYER_INPUT, { fetchImpl }),
    requestPlotLayer(LAYER_INPUT, { fetchImpl }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(calls.length, 2, "only one more request for two concurrent selects");
});

test("a failure is NEVER cached: retry asks again; a newer scene supersedes the old one's memo", async () => {
  resetPlotLayerCache();
  const { calls, fetchImpl } = layerFetchStub(true);
  const failed = await requestPlotLayer(LAYER_INPUT, { fetchImpl });
  assert.equal(failed.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(cachedPlotLayer("plot-1", "2026-09-25", "ndmi"), null, "no failure is memoised");

  const retried = await requestPlotLayer(LAYER_INPUT, { fetchImpl, force: true });
  assert.equal(retried.ok, true, "the retry succeeds");
  assert.equal(calls.length, 2);

  // A new NDVI scene changes the key: the old memo is superseded on the next
  // successful store, so the new scene never paints the old scene's layer.
  const nextScene = await requestPlotLayer({ ...LAYER_INPUT, sceneDate: "2026-09-30" }, { fetchImpl });
  assert.equal(nextScene.ok, true);
  assert.equal(cachedPlotLayer("plot-1", "2026-09-30", "ndmi")?.sceneDate, "2026-09-30");
  assert.equal(cachedPlotLayer("plot-1", "2026-09-25", "ndmi"), null, "the old scene's memo is dropped");
});

/* ------------------------------ layer config ----------------------------- */

test("the switcher lists NDVI, NDMI, NDRE and true colour selectable; moisture and thermal stay locked", () => {
  const ids = PLOT_LAYERS.map((l) => l.id);
  assert.deepEqual(ids.slice(0, 4), ["ndvi", "ndmi", "ndre", "truecolor"]);
  const byId = Object.fromEntries(PLOT_LAYERS.map((l) => [l.id, l]));
  assert.equal(byId.ndvi.mode, "primary");
  assert.equal(byId.ndmi.mode, "lazy");
  assert.equal(byId.ndre.mode, "lazy");
  assert.equal(byId.truecolor.mode, "lazy");
  assert.equal(byId.ndmi.fetchId, "ndmi");
  assert.equal(byId.ndre.fetchId, "ndre");
  assert.equal(byId.truecolor.fetchId, "truecolor");
  assert.equal(byId.moisture.mode, "locked", "water need stays قريباً");
  assert.equal(byId.thermal.mode, "locked", "thermal stress stays قريباً");
  assert.equal(byId.moisture.available, false);
  assert.equal(byId.thermal.available, false);
});

test("index layers are unit-free, and the 20 m bands state their resampling in Arabic", () => {
  const byId = Object.fromEntries(PLOT_LAYERS.map((l) => [l.id, l]));
  assert.equal(byId.ndmi.unit, "بدون وحدة");
  assert.equal(byId.ndre.unit, "بدون وحدة");
  assert.equal(byId.truecolor.hasIndex, false, "the image layer carries no index values");
  assert.ok(byId.ndmi.captionAr!.includes("20 م مُعاد أخذ العينات"), "NDMI states the 20 m resampling");
  assert.ok(byId.ndre.captionAr!.includes("20 م مُعاد أخذ العينات"), "NDRE states the 20 m resampling");
  assert.ok(byId.ndmi.meaningAr!.length > 0 && byId.ndre.meaningAr!.length > 0 && byId.truecolor.meaningAr!.length > 0);
  assert.match(byId.ndmi.meaningAr!, /رطوبة الغطاء النباتي، لا رطوبة التربة/);
});

/* ------------------------------- fixtures -------------------------------- */

function res(status: number, body: unknown, binary?: Uint8Array) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => text,
    arrayBuffer: async () => {
      const b = binary ?? new TextEncoder().encode(text);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    headers: { get: () => null },
  };
}

/** Classic TIFF, N float32 bands: entries larger than 4 bytes are stored
    outside the IFD, exactly as Sentinel Hub's own answers lay them out. */
function buildTiff(width: number, height: number, bands: Float32Array[]): Uint8Array {
  const samples = bands.length;
  const stripBytes = width * height * samples * 4;
  type Entry = { tag: number; type: number; values: number[] };
  const entries: Entry[] = [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: Array(samples).fill(32) },
    { tag: 259, type: 3, values: [1] },
    { tag: 262, type: 3, values: [1] },
    { tag: 273, type: 4, values: [0] }, // stripOffsets, patched below
    { tag: 277, type: 3, values: [samples] },
    { tag: 278, type: 4, values: [height] },
    { tag: 279, type: 4, values: [stripBytes] },
    { tag: 284, type: 3, values: [1] },
    { tag: 339, type: 3, values: Array(samples).fill(3) },
  ].sort((a, b) => a.tag - b.tag);

  const sizeOf = (e: Entry) => e.values.length * (e.type === 3 ? 2 : 4);
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize;
  const extraAt = new Map<Entry, number>();
  for (const e of entries) {
    if (sizeOf(e) > 4) {
      extraAt.set(e, extra);
      extra += sizeOf(e);
    }
  }
  const dataStart = extra;
  const buf = new Uint8Array(dataStart + stripBytes);
  const dv = new DataView(buf.buffer);
  buf[0] = buf[1] = 0x49;
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach((e, i) => {
    const at = 10 + i * 12;
    dv.setUint16(at, e.tag, true);
    dv.setUint16(at + 2, e.type, true);
    dv.setUint32(at + 4, e.values.length, true);
    const target = extraAt.get(e) ?? at + 8;
    if (extraAt.has(e)) dv.setUint32(at + 8, target, true);
    e.values.forEach((v, k) =>
      e.type === 3 ? dv.setUint16(target + k * 2, v, true) : dv.setUint32(target + k * 4, v, true),
    );
  });
  dv.setUint32(10 + entries.findIndex((e) => e.tag === 273) * 12 + 8, dataStart, true);
  let p = dataStart;
  for (let i = 0; i < width * height; i += 1) {
    for (let s = 0; s < samples; s += 1) {
      dv.setFloat32(p, bands[s][i], true);
      p += 4;
    }
  }
  return buf;
}

/** 2-band index raster at the parcel's requested size; SE quadrant cloudy. */
function indexTiff() {
  const { width, height } = rasterSize(BBOX);
  const value = new Float32Array(width * height);
  const valid = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cloudy = x >= width / 2 && y >= height / 2;
      value[y * width + x] = cloudy ? NaN : 0.2 + (0.4 * x) / Math.max(1, width - 1);
      valid[y * width + x] = cloudy ? 0 : 1;
    }
  }
  return { width, height, bands: [value, valid] as Float32Array[] };
}

/** 4-band true-colour raster (R,G,B,valid) at the parcel's requested size. */
function trueColorTiff() {
  const { width, height } = rasterSize(BBOX);
  const r = new Float32Array(width * height);
  const g = new Float32Array(width * height);
  const b = new Float32Array(width * height);
  const valid = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cloudy = x >= width / 2 && y >= height / 2;
      r[y * width + x] = cloudy ? NaN : 0.2;
      g[y * width + x] = cloudy ? NaN : 0.35;
      b[y * width + x] = cloudy ? NaN : 0.12;
      valid[y * width + x] = cloudy ? 0 : 1;
    }
  }
  return { width, height, bands: [r, g, b, valid] as Float32Array[] };
}

const CATALOG_SCENE_DAY = {
  type: "FeatureCollection",
  features: [{ id: "a", properties: { datetime: "2026-09-25T10:30:21Z", "eo:cloud_cover": 3.1 } }],
};

function stubLayer(handlers: { process?: () => ReturnType<typeof res>; catalog?: () => ReturnType<typeof res> }) {
  const calls: { url: string; body?: string; headers?: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    calls.push({ url, body: init?.body, headers: init?.headers });
    if (url.includes("openid-connect/token")) return res(200, { access_token: "tok-XYZ", expires_in: 600 });
    if (url.includes("/catalog/")) return (handlers.catalog ?? (() => res(200, CATALOG_SCENE_DAY)))();
    if (url.includes("/api/v1/process")) return (handlers.process ?? (() => res(500, "unset")))();
    return res(404, "unexpected " + url);
  }) as unknown as OpeneoFetch;
  return { calls, fetchImpl };
}

function quietTrace() {
  const lines: string[] = [];
  const trace = new SatelliteTrace({ secrets: [CONFIG.clientId, CONFIG.clientSecret], sink: (l) => lines.push(l) });
  return { trace, lines };
}
