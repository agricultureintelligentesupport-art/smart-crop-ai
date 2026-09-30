/**
 * The raster path of `/api/field-data`: one Sentinel Hub Process request kept
 * as per-pixel NDVI + dataMask, the transport budget, and how
 * `buildObservation` exposes the raster while still deriving the dashboard
 * heatmap's grid cells from it. The legacy grid path is pinned here too, as
 * the documented `CDSE_USE_GRID=1` fallback.
 *
 * Nothing here can reach the live service; the suite pins the contract:
 *   • the raster request is the plot polygon at 10 m, FLOAT32 GeoTIFF;
 *   • masked pixels travel as `null` + `dataMask 0` — never an estimate;
 *   • an enormous boundary coarsens the resolution honestly (and says so);
 *   • the observation carries BOTH the raster and the same-derived cells;
 *   • `CDSE_USE_GRID=1` keeps the old cell-only answer;
 *   • NASA POWER survives every satellite failure.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { bboxOf, gridCells, type Ring } from "@/lib/geo/polygon";
import { buildObservation } from "@/lib/field-data/observation";
import { readOpeneoConfig, resetTokenCache, type OpeneoConfig, type OpeneoFetch } from "@/lib/satellite/openeo";
import {
  buildProcessRequest,
  fetchNdviRaster,
  MAX_RASTER_PIXELS,
  rasterResolutionM,
  rasterSize,
  rasterSizeFor,
  tiffToNdviRaster,
} from "@/lib/satellite/sentinelhub";
import { SatelliteTrace } from "@/lib/satellite/trace";
import type { Plot } from "@/lib/field-data/types";

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

// ≈ 134 m × 134 m (≈ 1.8 ha) next to Algiers.
const RING: Ring = [
  [3.05, 36.75],
  [3.0515, 36.75],
  [3.0515, 36.7512],
  [3.05, 36.7512],
];
const BBOX = bboxOf(RING)!;

/* ---------------------------- TIFF fixture ----------------------------- */

/** Minimal classic TIFF: little-endian, uncompressed, one strip, 2 float32 bands. */
function buildTiff(width: number, height: number, bands: Float32Array[]): Uint8Array {
  const samples = bands.length;
  const stripBytes = width * height * samples * 4;
  type Entry = { tag: number; type: number; values: number[] };
  const entries: Entry[] = [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: Array(samples).fill(32) },
    { tag: 259, type: 3, values: [1] }, // compression: none
    { tag: 262, type: 3, values: [1] },
    { tag: 273, type: 4, values: [0] }, // stripOffsets, patched below
    { tag: 277, type: 3, values: [samples] },
    { tag: 278, type: 4, values: [height] }, // rows per strip
    { tag: 279, type: 4, values: [stripBytes] },
    { tag: 284, type: 3, values: [1] }, // chunky
    { tag: 339, type: 3, values: Array(samples).fill(3) }, // IEEE float
  ].sort((a, b) => a.tag - b.tag);
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataStart = 8 + ifdSize;
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
    e.values.forEach((v, k) =>
      e.type === 3 ? dv.setUint16(at + 8 + k * 2, v, true) : dv.setUint32(at + 8 + k * 4, v, true),
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

/** NDVI raster for `BBOX` at the requested 10 m size; the south-east quadrant is cloudy. */
function parcelRaster(ndvi = 0.5) {
  const { width, height } = rasterSize(BBOX);
  const n = new Float32Array(width * height);
  const valid = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cloudy = x >= width / 2 && y >= height / 2;
      n[y * width + x] = cloudy ? NaN : ndvi + (x < width / 2 ? 0 : 0.1);
      valid[y * width + x] = cloudy ? 0 : 1;
    }
  }
  return { width, height, bands: [n, valid] as Float32Array[] };
}

/* ------------------------------ fetch stubs ----------------------------- */

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

const CATALOG_OK = {
  type: "FeatureCollection",
  features: [
    { id: "a", properties: { datetime: "2026-09-25T10:30:21Z", "eo:cloud_cover": 12.4 } },
    { id: "b", properties: { datetime: "2026-09-25T10:30:21Z", "eo:cloud_cover": 3.1 } },
    { id: "c", properties: { datetime: "2026-09-20T10:30:21Z", "eo:cloud_cover": 40 } },
  ],
};

function stub(handlers: { catalog?: () => ReturnType<typeof res>; process?: () => ReturnType<typeof res> }) {
  const calls: { url: string; body?: string }[] = [];
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });
    if (url.includes("openid-connect/token")) return res(200, { access_token: "tok-XYZ", expires_in: 600 });
    if (url.includes("/catalog/")) return (handlers.catalog ?? (() => res(200, CATALOG_OK)))();
    if (url.includes("/api/v1/process")) return (handlers.process ?? (() => res(500, "unset")))();
    return res(404, "unexpected " + url);
  }) as unknown as OpeneoFetch;
  return { calls, fetchImpl };
}

const tiffResponse = () => {
  const r = parcelRaster();
  return res(200, "", buildTiff(r.width, r.height, r.bands));
};

function quietTrace() {
  const lines: string[] = [];
  const trace = new SatelliteTrace({ secrets: [CONFIG.clientId, CONFIG.clientSecret], sink: (l) => lines.push(l) });
  return { trace, lines };
}

/* -------------------------------- tests -------------------------------- */

test("a normal plot is sampled at 10 m; the request is the polygon + FLOAT32 GeoTIFF", () => {
  assert.equal(rasterResolutionM(BBOX), 10);
  const { width, height } = rasterSize(BBOX);
  assert.ok(width >= 12 && width <= 15, String(width));
  assert.ok(height >= 12 && height <= 15, String(height));
  const body = buildProcessRequest({
    bbox: BBOX,
    ring: RING,
    from: "2026-09-25T00:00:00Z",
    to: "2026-09-25T23:59:59Z",
    order: "leastCC",
    resolutionM: rasterResolutionM(BBOX),
  }) as {
    input: { bounds: { geometry: { type: string } }; data: { type: string }[] };
    output: { width: number; height: number; responses: { format: { type: string } }[] };
    evalscript: string;
  };
  assert.equal(body.input.data[0].type, "sentinel-2-l2a");
  assert.equal(body.input.bounds.geometry.type, "Polygon");
  assert.equal(body.output.width, width);
  assert.equal(body.output.height, height);
  assert.equal(body.output.responses[0].format.type, "image/tiff");
  assert.match(body.evalscript, /FLOAT32/);
});

test("an enormous boundary coarsens the resolution instead of exceeding the transport budget", () => {
  const huge = { west: 0, south: 30, east: 5, north: 35 };
  const resolution = rasterResolutionM(huge);
  assert.ok(resolution > 10, `expected coarser than 10 m, got ${resolution}`);
  const { width, height } = rasterSizeFor(huge, resolution);
  assert.ok(width * height <= MAX_RASTER_PIXELS, `${width}x${height} exceeds the budget`);
  // 5° ≈ 550 km: at 10 m that would be ~55 000 px per side.
  assert.ok(width <= 2500 && height <= 2500, "Sentinel Hub's own raster limit is respected");
});

test("fetchNdviRaster: token → catalog → one process request; pixels + dataMask + scene metadata", async () => {
  resetTokenCache();
  const { calls, fetchImpl } = stub({ process: tiffResponse });
  const { trace, lines } = quietTrace();
  const result = await fetchNdviRaster(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING },
    fetchImpl,
    trace,
  );
  assert.equal(result.ok, true);
  assert.equal(result.sceneDate, "2026-09-25");
  assert.equal(result.cloudCoverPct, 3.1);

  const raster = result.raster!;
  const { width, height } = rasterSize(BBOX);
  assert.equal(raster.width, width);
  assert.equal(raster.height, height);
  assert.equal(raster.resolutionM, 10);
  assert.deepEqual(raster.bbox, { west: BBOX.west, south: BBOX.south, east: BBOX.east, north: BBOX.north });
  assert.equal(raster.ndvi.length, width * height);
  assert.equal(raster.dataMask.length, width * height);
  // The cloudy south-east quadrant is masked, and masked means null — never a value.
  const masked = raster.dataMask.reduce((sum, m) => sum + m, 0);
  assert.ok(masked > 0 && masked < width * height, "part of the parcel is cloud-masked");
  assert.equal(result.validPixels, masked);
  for (let i = 0; i < raster.ndvi.length; i += 1) {
    if (raster.dataMask[i] === 0) assert.equal(raster.ndvi[i], null, `masked pixel ${i} carries a value`);
    else assert.ok(typeof raster.ndvi[i] === "number", `measured pixel ${i} is null`);
  }
  const values = raster.ndvi.filter((v): v is number => v !== null);
  assert.ok(values.every((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-9), "values are 3-decimal");

  // Exactly one Process request: the first pass was good enough.
  assert.equal(calls.filter((c) => c.url.includes("/api/v1/process")).length, 1);
  assert.deepEqual(trace.steps.map((s) => s.step), ["cdse-token", "sh-catalog", "sh-process"]);
  assert.ok(!lines.join("\n").includes(SECRET));
});

test("tiffToNdviRaster: a pixel the provider did not measure is null + mask 0, never a value", () => {
  const tiff = {
    width: 2,
    height: 1,
    bands: [
      Float32Array.from([0.4123, NaN]),
      Float32Array.from([1, 0]),
    ],
  };
  const raster = tiffToNdviRaster(tiff, BBOX, 10);
  assert.deepEqual(raster.ndvi, [0.412, null]);
  assert.deepEqual(raster.dataMask, [1, 0]);
});

test("a fully cloudy newest pass falls back to the older scene; a bad answer is malformed", async () => {
  resetTokenCache();
  const cloudy = parcelRaster();
  cloudy.bands[0].fill(NaN);
  cloudy.bands[1].fill(0);
  let n = 0;
  const { calls, fetchImpl } = stub({
    process: () => (n++ === 0 ? res(200, "", buildTiff(cloudy.width, cloudy.height, cloudy.bands)) : tiffResponse()),
  });
  const result = await fetchNdviRaster(CONFIG, { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING }, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.sceneDate, "2026-09-20");
  assert.equal(calls.filter((c) => c.url.includes("/api/v1/process")).length, 2);

  resetTokenCache();
  const { trace } = quietTrace();
  const bad = await fetchNdviRaster(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING },
    stub({ process: () => res(200, { hello: "not a tiff" }) }).fetchImpl,
    trace,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "malformed");
  assert.equal(bad.raster, null);
  assert.match(trace.technical()!, /not a readable float GeoTIFF/);

  const empty = await fetchNdviRaster(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING },
    stub({ catalog: () => res(200, { features: [] }) }).fetchImpl,
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "noScenes");
});

/* --------------------- buildObservation integration -------------------- */

const PLOT: Plot = {
  id: "plot-1",
  uid: "u1",
  name: "",
  ring: RING,
  areaHa: 1.8,
  centroid: [3.0507, 36.7506],
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
};

const POWER_DAILY = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [3.05, 36.75, 44.61] },
  properties: {
    parameter: {
      T2M: { "20260928": 26.05 },
      T2M_MAX: { "20260928": 31.94 },
      T2M_MIN: { "20260928": 19.09 },
      RH2M: { "20260928": 62.28 },
      WS2M: { "20260928": 3.53 },
      PS: { "20260928": 100.71 },
      ALLSKY_SFC_SW_DWN: { "20260928": 21.39 },
      PRECTOTCORR: { "20260928": 0 },
      GWETPROF: { "20260928": 0.37 },
    },
  },
  header: { fill_value: -999.0 },
  messages: [],
  times: { data: 0.58, process: 0.02 },
};
const POWER_CLIMATE = {
  properties: {
    parameter: {
      T2M_MAX: { SEP: 33.25 },
      T2M_MIN: { SEP: 19.34 },
    },
  },
};

const powerFetch = (async (url: string) => ({
  ok: true,
  status: 200,
  json: async () => (url.includes("climatology") ? POWER_CLIMATE : POWER_DAILY),
  text: async () => "",
})) as never;

function observationInput(extra: Record<string, unknown>) {
  return {
    input: {
      plot: PLOT,
      rows: 2,
      cols: 2,
      now: new Date("2026-09-30T10:00:00Z"),
      powerFetch,
      openeoConfig: CONFIG,
      ...extra,
    },
  };
}

test("buildObservation (default) carries the raster AND derives the heatmap cells from it", async () => {
  resetTokenCache();
  const { fetchImpl } = stub({ process: tiffResponse });
  const { input } = observationInput({ openeoFetch: fetchImpl });
  const result = await buildObservation(input);
  assert.equal(result.ok, true);
  const o = result.observation!;
  assert.ok(o.raster, "the raster is the primary product");
  assert.equal(o.raster!.resolutionM, 10);
  assert.equal(o.sceneDate, "2026-09-25");
  assert.equal(o.cloudCoverPct, 3.1);
  // The dashboard heatmap keeps its cells — derived from the SAME rounded
  // values the plot view paints, so the two can never disagree.
  assert.equal(o.rows, 2);
  assert.equal(o.cols, 2);
  assert.deepEqual(o.cells.map((c) => c.id), ["z-0-0", "z-0-1", "z-1-0", "z-1-1"]);
  const northWest = o.cells.find((c) => c.id === "z-0-0")!;
  const southEast = o.cells.find((c) => c.id === "z-1-1")!;
  assert.ok(Math.abs((northWest.ndvi as number) - 0.5) < 0.03, String(northWest.ndvi));
  assert.equal(southEast.ndvi, null, "the cloudy quadrant stays a missing measurement");
  assert.ok(o.climate && o.climate.source === "nasa-power");
});

test("CDSE_USE_GRID=1 keeps the legacy cell-only answer: no raster, same cells", async () => {
  resetTokenCache();
  const { fetchImpl } = stub({ process: tiffResponse });
  const { input } = observationInput({
    openeoFetch: fetchImpl,
    openeoConfig: { ...CONFIG, useGrid: true },
  });
  const result = await buildObservation(input);
  assert.equal(result.ok, true);
  const o = result.observation!;
  assert.equal(o.raster, undefined, "the grid path carries no per-pixel layer");
  assert.equal(o.cells.length, 4);
  assert.equal(o.cells.find((c) => c.id === "z-1-1")!.ndvi, null);
  assert.equal(o.sceneDate, "2026-09-25");
});

test("readOpeneoConfig: the grid fallback is opt-in and off by default", () => {
  const env = (v?: string) =>
    readOpeneoConfig({ CDSE_CLIENT_ID: "sh-a", CDSE_CLIENT_SECRET: "s", ...(v === undefined ? {} : { CDSE_USE_GRID: v }) } as unknown as NodeJS.ProcessEnv);
  assert.equal(env().useGrid, false);
  assert.equal(env("").useGrid, false);
  assert.equal(env("0").useGrid, false);
  assert.equal(env("1").useGrid, true);
  assert.equal(env("true").useGrid, true);
});

test("NASA POWER survives a raster-path failure", async () => {
  resetTokenCache();
  const { fetchImpl } = stub({ process: () => res(403, { error: { code: "ACCESS_DENIED", message: "Forbidden" } }) });
  const { input } = observationInput({ openeoFetch: fetchImpl });
  const result = await buildObservation(input);
  assert.equal(result.ok, false);
  assert.equal(result.observation, null);
  assert.equal(result.reason, "auth");
  assert.ok(result.climate, "POWER is kept");
  assert.equal(result.climate!.source, "nasa-power");
  assert.ok(result.climate!.et0 > 0);
});

test("the derived cells are cut from the plot's real geometry, exactly as the grid path cut them", () => {
  const cells = gridCells(RING, 2, 2);
  assert.equal(cells.length, 4);
  const total = cells.reduce((sum, c) => sum + c.areaHa, 0);
  assert.ok(Math.abs(total - 1.8) < 0.15, `cells tile the parcel, got ${total}`);
});
