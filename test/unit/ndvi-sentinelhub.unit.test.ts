/**
 * The default satellite source: Sentinel Hub Process API on the Copernicus
 * Data Space, plus the diagnostics that make a failing step identifiable.
 *
 * Nothing here can reach the live service, so the suite pins the contract:
 *   • the request is what the docs describe (S2 L2A, bbox + polygon, ~10 m,
 *     SCL mask, FLOAT32 GeoTIFF, same token);
 *   • the GeoTIFF reader is correct for the layouts Sentinel Hub produces;
 *   • every failing step is reported with host/status/code/message, and no
 *     secret ever reaches a log line or the response;
 *   • NASA POWER survives a satellite failure;
 *   • openEO stays reachable, but only behind `CDSE_USE_OPENEO`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { gridCells, bboxOf, type Ring } from "@/lib/geo/polygon";
import { buildObservation } from "@/lib/field-data/observation";
import { readOpeneoConfig, resetTokenCache, type OpeneoConfig, type OpeneoFetch } from "@/lib/satellite/openeo";
import {
  buildCatalogRequest,
  buildProcessRequest,
  cellMeansFromRaster,
  EVALSCRIPT,
  fetchNdviProcessApi,
  parseCatalog,
  rasterSize,
} from "@/lib/satellite/sentinelhub";
import { decodeFloatTiff } from "@/lib/satellite/tiff";
import { extractErrorDetail, redact, SatelliteTrace } from "@/lib/satellite/trace";
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
};

// ≈ 134 m × 134 m (≈ 1.8 ha) next to Algiers.
const RING: Ring = [
  [3.05, 36.75],
  [3.0515, 36.75],
  [3.0515, 36.7512],
  [3.05, 36.7512],
];
const BBOX = bboxOf(RING)!;
const CELLS = gridCells(RING, 2, 2);
const TARGETS = CELLS.map((c) => ({ id: c.id, ring: c.ring }));

/* ---------------------------- TIFF fixtures ---------------------------- */

interface TiffOptions {
  little?: boolean;
  deflate?: boolean;
  predictor3?: boolean;
  rowsPerStrip?: number;
  tile?: number;
}

/** Builds a classic TIFF of 2-band float32 data, to exercise the reader. */
function buildTiff(width: number, height: number, bands: Float32Array[], o: TiffOptions = {}): Uint8Array {
  const little = o.little ?? true;
  const samples = bands.length;
  const rps = o.rowsPerStrip ?? height;
  const blocks: Uint8Array[] = [];

  const encodeRows = (x0: number, y0: number, bw: number, bh: number): Uint8Array => {
    const out: number[] = [];
    for (let r = 0; r < bh; r += 1) {
      const rowValues = bw * samples;
      const raw = new Uint8Array(rowValues * 4);
      const dv = new DataView(raw.buffer);
      for (let x = 0; x < bw; x += 1) {
        for (let s = 0; s < samples; s += 1) {
          const gx = x0 + x;
          const gy = y0 + r;
          const v = gx < width && gy < height ? bands[s][gy * width + gx] : 0;
          dv.setFloat32((x * samples + s) * 4, v, little);
        }
      }
      let row = raw;
      if (o.predictor3) {
        const planes = new Uint8Array(raw.length);
        const big = new DataView(new ArrayBuffer(4));
        for (let i = 0; i < rowValues; i += 1) {
          big.setFloat32(0, dv.getFloat32(i * 4, little), false);
          for (let b = 0; b < 4; b += 1) planes[b * rowValues + i] = big.getUint8(b);
        }
        for (let i = planes.length - 1; i >= samples; i -= 1) planes[i] = (planes[i] - planes[i - samples]) & 0xff;
        row = planes;
      }
      out.push(...row);
    }
    return Uint8Array.from(out);
  };

  if (o.tile) {
    const across = Math.ceil(width / o.tile);
    const down = Math.ceil(height / o.tile);
    for (let ty = 0; ty < down; ty += 1)
      for (let tx = 0; tx < across; tx += 1) blocks.push(encodeRows(tx * o.tile, ty * o.tile, o.tile, o.tile));
  } else {
    for (let y = 0; y < height; y += rps) blocks.push(encodeRows(0, y, width, Math.min(rps, height - y)));
  }
  const payloads = blocks.map((b) => (o.deflate ? new Uint8Array(deflateSync(b)) : b));

  type Entry = { tag: number; type: number; values: number[] };
  const tiled = Boolean(o.tile);
  const entries: Entry[] = [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: Array(samples).fill(32) },
    { tag: 259, type: 3, values: [o.deflate ? 8 : 1] },
    { tag: 262, type: 3, values: [1] },
    { tag: 277, type: 3, values: [samples] },
    { tag: 284, type: 3, values: [1] },
    { tag: 339, type: 3, values: Array(samples).fill(3) },
  ];
  if (o.predictor3) entries.push({ tag: 317, type: 3, values: [3] });
  if (tiled) {
    entries.push({ tag: 322, type: 3, values: [o.tile!] }, { tag: 323, type: 3, values: [o.tile!] });
  } else {
    entries.push({ tag: 278, type: 3, values: [rps] });
  }
  const offsetTag = tiled ? 324 : 273;
  const countTag = tiled ? 325 : 279;
  entries.push({ tag: offsetTag, type: 4, values: payloads.map(() => 0) });
  entries.push({ tag: countTag, type: 4, values: payloads.map((p) => p.length) });
  entries.sort((a, b) => a.tag - b.tag);

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
  let dataAt = extra;
  const blockOffsets = payloads.map((p) => {
    const at = dataAt;
    dataAt += p.length;
    return at;
  });
  entries.find((e) => e.tag === offsetTag)!.values = blockOffsets;

  const buf = new Uint8Array(dataAt);
  const dv = new DataView(buf.buffer);
  buf[0] = buf[1] = little ? 0x49 : 0x4d;
  dv.setUint16(2, 42, little);
  dv.setUint32(4, 8, little);
  dv.setUint16(8, entries.length, little);
  entries.forEach((e, i) => {
    const at = 10 + i * 12;
    dv.setUint16(at, e.tag, little);
    dv.setUint16(at + 2, e.type, little);
    dv.setUint32(at + 4, e.values.length, little);
    const target = extraAt.get(e) ?? at + 8;
    if (extraAt.has(e)) dv.setUint32(at + 8, target, little);
    e.values.forEach((v, k) => (e.type === 3 ? dv.setUint16(target + k * 2, v, little) : dv.setUint32(target + k * 4, v, little)));
  });
  payloads.forEach((p, i) => buf.set(p, blockOffsets[i]));
  return buf;
}

/** NDVI raster for `BBOX` at the requested 10 m size; the south-east cell is cloudy. */
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
  return { width, height, bands: [n, valid] };
}

/* ------------------------------ fetch stubs ---------------------------- */

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

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function stub(handlers: { catalog?: () => ReturnType<typeof res>; process?: () => ReturnType<typeof res>; token?: () => ReturnType<typeof res> }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: Omit<Call, "url">) => {
    calls.push({ url, ...init });
    if (url.includes("openid-connect/token")) return (handlers.token ?? (() => res(200, { access_token: "tok-XYZ", expires_in: 600 })))();
    if (url.includes("/catalog/")) return (handlers.catalog ?? (() => res(200, CATALOG_OK)))();
    if (url.includes("/api/v1/process")) return (handlers.process ?? (() => res(500, "unset")))();
    return res(404, "unexpected " + url);
  }) as unknown as OpeneoFetch;
  return { calls, fetchImpl };
}

const tiffResponse = () => res(200, "", buildTiff(...tiffArgs()));
function tiffArgs(): [number, number, Float32Array[]] {
  const r = parcelRaster();
  return [r.width, r.height, r.bands];
}

function quietTrace() {
  const lines: string[] = [];
  const trace = new SatelliteTrace({ secrets: [CONFIG.clientId, CONFIG.clientSecret], sink: (l) => lines.push(l) });
  return { trace, lines };
}

/* -------------------------------- tests -------------------------------- */

test("the Process request is Sentinel-2 L2A over the plot bbox + polygon, ~10 m, FLOAT32 GeoTIFF", () => {
  const body = buildProcessRequest({
    bbox: BBOX,
    ring: RING,
    from: "2026-09-25T00:00:00Z",
    to: "2026-09-25T23:59:59Z",
    order: "leastCC",
  }) as {
    input: { bounds: { bbox: number[]; geometry: { type: string; coordinates: number[][][] } }; data: { type: string; dataFilter: { timeRange: unknown } }[] };
    output: { width: number; height: number; responses: { format: { type: string } }[] };
    evalscript: string;
  };
  assert.equal(body.input.data[0].type, "sentinel-2-l2a");
  assert.deepEqual(body.input.bounds.bbox, [BBOX.west, BBOX.south, BBOX.east, BBOX.north]);
  const ring = body.input.bounds.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], "polygon is closed");
  assert.equal(body.output.responses[0].format.type, "image/tiff");
  // ≈ 134 m / 10 m and ≈ 133 m / 10 m.
  assert.ok(body.output.width >= 12 && body.output.width <= 15, String(body.output.width));
  assert.ok(body.output.height >= 12 && body.output.height <= 15, String(body.output.height));
  assert.match(body.evalscript, /FLOAT32/);
  assert.match(body.evalscript, /dataMask/);
  assert.match(body.evalscript, /SCL/);
  assert.match(body.evalscript, /B08 - s\.B04/);
  for (const cls of [3, 8, 9, 10, 11]) assert.ok(EVALSCRIPT.includes(String(cls)));
});

test("a huge bbox is capped at the API's raster limit", () => {
  const { width, height } = rasterSize({ west: 0, south: 30, east: 5, north: 35 });
  assert.equal(width, 2500);
  assert.equal(height, 2500);
});

test("the catalog request covers the window; its answer becomes one candidate per day, newest first", () => {
  const req = buildCatalogRequest(BBOX, "2026-08-31", "2026-09-30") as { datetime: string; collections: string[] };
  assert.equal(req.datetime, "2026-08-31T00:00:00Z/2026-09-30T23:59:59Z");
  assert.deepEqual(req.collections, ["sentinel-2-l2a"]);
  assert.deepEqual(parseCatalog(CATALOG_OK), [
    { date: "2026-09-25", cloudCoverPct: 3.1 },
    { date: "2026-09-20", cloudCoverPct: 40 },
  ]);
  assert.deepEqual(parseCatalog(null), []);
  assert.deepEqual(parseCatalog({ features: [{ properties: { datetime: "nope" } }] }), []);
});

test("the GeoTIFF reader handles LE/BE, strips, tiles, Deflate and the float predictor", () => {
  const w = 7;
  const h = 5;
  const a = Float32Array.from({ length: w * h }, (_, i) => i / 10 - 1);
  const b = Float32Array.from({ length: w * h }, (_, i) => (i % 3 === 0 ? 1 : 0));
  a[4] = NaN;
  const variants: TiffOptions[] = [
    {},
    { little: false },
    { deflate: true },
    { deflate: true, predictor3: true },
    { predictor3: true, little: false },
    { rowsPerStrip: 2 },
    { rowsPerStrip: 2, deflate: true },
    { tile: 4 },
    { tile: 4, deflate: true, predictor3: true },
  ];
  for (const variant of variants) {
    const decoded = (() => {
      try {
        return decodeFloatTiff(buildTiff(w, h, [a, b], variant));
      } catch (error) {
        throw new Error(`${JSON.stringify(variant)}: ${(error as Error).message}`);
      }
    })();
    assert.equal(decoded.width, w, JSON.stringify(variant));
    assert.equal(decoded.height, h);
    assert.equal(decoded.bands.length, 2);
    for (let i = 0; i < w * h; i += 1) {
      if (Number.isNaN(a[i])) assert.ok(Number.isNaN(decoded.bands[0][i]), `${JSON.stringify(variant)} nan @${i}`);
      else assert.equal(decoded.bands[0][i], a[i], `${JSON.stringify(variant)} band0 @${i}`);
      assert.equal(decoded.bands[1][i], b[i], `${JSON.stringify(variant)} band1 @${i}`);
    }
  }
});

test("the GeoTIFF reader rejects non-TIFFs and unsupported layouts instead of guessing", () => {
  assert.throws(() => decodeFloatTiff(new TextEncoder().encode('{"error":{"message":"nope"}} padding padding')), /not a TIFF/);
  assert.throws(() => decodeFloatTiff(new Uint8Array(4)), /too short/);
  const good = buildTiff(2, 2, [new Float32Array(4)]);
  const bigTiff = Uint8Array.from(good);
  bigTiff[2] = 43;
  assert.throws(() => decodeFloatTiff(bigTiff), /BigTIFF/);
});

test("cell means average only clear pixels inside each cell; a mostly-cloudy cell is null", () => {
  const r = parcelRaster();
  const cells = cellMeansFromRaster(r, BBOX, TARGETS);
  assert.equal(cells.length, TARGETS.length);
  const byId = Object.fromEntries(cells.map((c) => [c.id, c.ndvi]));
  // Row 0 is the north edge. The cloudy quadrant is south-east = c-1-1.
  // (A pixel centre exactly on the cell seam may land on either side, hence the tolerance.)
  assert.ok(Math.abs((byId["c-0-0"] as number) - 0.5) < 0.03, String(byId["c-0-0"]));
  assert.ok(Math.abs((byId["c-0-1"] as number) - 0.6) < 0.03, String(byId["c-0-1"]));
  assert.ok(Math.abs((byId["c-1-0"] as number) - 0.5) < 0.03, String(byId["c-1-0"]));
  assert.equal(byId["c-1-1"], null);
});

test("fetchNdviProcessApi: token → catalog → process, same credentials, newest pass, cloud cover reported", async () => {
  resetTokenCache();
  const { calls, fetchImpl } = stub({ process: tiffResponse });
  const { trace, lines } = quietTrace();
  const result = await fetchNdviProcessApi(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING, targets: TARGETS },
    fetchImpl,
    trace,
  );
  assert.equal(result.ok, true);
  assert.equal(result.sceneDate, "2026-09-25");
  assert.equal(result.cloudCoverPct, 3.1);
  assert.equal(result.maskedCells, 1);

  assert.deepEqual(
    calls.map((c) => new URL(c.url).host),
    ["identity.dataspace.copernicus.eu", "sh.dataspace.copernicus.eu", "sh.dataspace.copernicus.eu"],
  );
  assert.match(String(calls[0].body), /grant_type=client_credentials/);
  assert.match(String(calls[0].body), /client_id=sh-abc-123/);
  assert.equal(calls[0].headers?.authorization, undefined, "credentials in the body only");
  for (const c of calls.slice(1)) assert.equal(c.headers?.authorization, "Bearer tok-XYZ");
  const processBody = JSON.parse(calls[2].body!) as { input: { data: { dataFilter: { timeRange: { from: string } } }[] } };
  assert.equal(processBody.input.data[0].dataFilter.timeRange.from, "2026-09-25T00:00:00Z");

  assert.deepEqual(trace.steps.map((s) => s.step), ["cdse-token", "sh-catalog", "sh-process"]);
  assert.ok(trace.steps.every((s) => s.ok));
  const all = lines.join("\n");
  assert.ok(!all.includes(SECRET) && !all.includes("tok-XYZ"));
});

test("a 403 from the Process API is reported as auth, with host, status, code and message", async () => {
  resetTokenCache();
  const { fetchImpl } = stub({
    process: () =>
      res(403, { error: { status: 403, reason: "Forbidden", message: `Access denied for ${SECRET}`, code: "ACCESS_DENIED" } }),
  });
  const { trace, lines } = quietTrace();
  const result = await fetchNdviProcessApi(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING, targets: TARGETS },
    fetchImpl,
    trace,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "auth");
  assert.equal(result.cells.length, 0, "no numbers on failure");
  const failed = trace.firstSatelliteFailure()!;
  assert.equal(failed.step, "sh-process");
  assert.equal(failed.host, "sh.dataspace.copernicus.eu");
  assert.equal(failed.status, 403);
  assert.equal(failed.code, "ACCESS_DENIED");
  assert.match(trace.technical()!, /sh-process · sh\.dataspace\.copernicus\.eu · HTTP 403 · ACCESS_DENIED/);
  assert.ok(!JSON.stringify(trace.steps).includes(SECRET), "secret is redacted from the response payload");
  assert.ok(!lines.join("\n").includes(SECRET));
  assert.ok(lines.some((l) => l.includes("step=sh-process") && l.includes("status=403") && l.includes("code=ACCESS_DENIED")));
});

test("a rejected token is reported on the token step, and no catalog/process call follows", async () => {
  resetTokenCache();
  const { calls, fetchImpl } = stub({
    token: () => res(401, { error: "invalid_client", error_description: "Invalid client or Invalid client credentials" }),
  });
  const { trace } = quietTrace();
  const result = await fetchNdviProcessApi(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING, targets: TARGETS },
    fetchImpl,
    trace,
  );
  assert.equal(result.reason, "auth");
  assert.equal(calls.length, 1);
  assert.match(trace.technical()!, /cdse-token · identity\.dataspace\.copernicus\.eu · HTTP 401 · invalid_client/);
});

test("a failing catalog falls back to one windowed Process request (date unknown, not invented)", async () => {
  resetTokenCache();
  const { calls, fetchImpl } = stub({ catalog: () => res(500, "boom"), process: tiffResponse });
  const { trace } = quietTrace();
  const result = await fetchNdviProcessApi(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING, targets: TARGETS },
    fetchImpl,
    trace,
  );
  assert.equal(result.ok, true);
  assert.equal(result.sceneDate, null);
  assert.equal(result.cloudCoverPct, null);
  const body = JSON.parse(calls[calls.length - 1].body!) as { input: { data: { dataFilter: { mosaickingOrder: string } }[] } };
  assert.equal(body.input.data[0].dataFilter.mosaickingOrder, "mostRecent");
  assert.equal(trace.steps.find((s) => s.step === "sh-catalog")!.ok, false);
});

test("an empty catalog is noScenes; a non-TIFF answer is malformed — never numbers", async () => {
  resetTokenCache();
  const empty = await fetchNdviProcessApi(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING, targets: TARGETS },
    stub({ catalog: () => res(200, { features: [] }) }).fetchImpl,
  );
  assert.equal(empty.reason, "noScenes");

  const { trace } = quietTrace();
  const bad = await fetchNdviProcessApi(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING, targets: TARGETS },
    stub({ process: () => res(200, { hello: "world, this is not an image at all" }) }).fetchImpl,
    trace,
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "malformed");
  assert.equal(bad.cells.length, 0);
  assert.match(trace.technical()!, /not a readable float GeoTIFF/);
});

test("if the newest pass is fully cloudy the next one is tried (bounded)", async () => {
  resetTokenCache();
  const cloudy = parcelRaster();
  cloudy.bands[0].fill(NaN);
  cloudy.bands[1].fill(0);
  let n = 0;
  const { calls, fetchImpl } = stub({
    process: () => (n++ === 0 ? res(200, "", buildTiff(cloudy.width, cloudy.height, cloudy.bands)) : tiffResponse()),
  });
  const result = await fetchNdviProcessApi(
    CONFIG,
    { from: "2026-08-31", to: "2026-09-30", bbox: BBOX, ring: RING, targets: TARGETS },
    fetchImpl,
  );
  assert.equal(result.ok, true);
  assert.equal(result.sceneDate, "2026-09-20");
  assert.equal(calls.filter((c) => c.url.includes("/api/v1/process")).length, 2);
});

test("readOpeneoConfig: the openEO flag is OFF by default and only opt-in values turn it on", () => {
  const env = (v?: string) =>
    readOpeneoConfig({ CDSE_CLIENT_ID: "sh-a", CDSE_CLIENT_SECRET: "s", ...(v === undefined ? {} : { CDSE_USE_OPENEO: v }) } as unknown as NodeJS.ProcessEnv);
  assert.equal(env().useOpeneo, false);
  assert.equal(env("").useOpeneo, false);
  assert.equal(env("0").useOpeneo, false);
  assert.equal(env("1").useOpeneo, true);
  assert.equal(env("true").useOpeneo, true);
  assert.equal(env().processUrl, "https://sh.dataspace.copernicus.eu/api/v1/process");
});

test("extractErrorDetail understands Keycloak, Sentinel Hub, openEO and plain text; truncates to 300", () => {
  assert.deepEqual(extractErrorDetail('{"error":"invalid_client","error_description":"Invalid client"}'), {
    code: "invalid_client",
    message: "Invalid client",
  });
  assert.deepEqual(extractErrorDetail('{"error":{"status":403,"reason":"Forbidden","message":"nope","code":"ACCESS_DENIED"}}'), {
    code: "ACCESS_DENIED",
    message: "nope",
  });
  assert.deepEqual(extractErrorDetail('{"id":"1","code":"AuthenticationFailed","message":"bad token"}'), {
    code: "AuthenticationFailed",
    message: "bad token",
  });
  assert.equal(extractErrorDetail("<html>Bad gateway</html>").message, "<html>Bad gateway</html>");
  assert.ok((extractErrorDetail("x".repeat(2000)).message ?? "").length <= 300);
  assert.equal(redact("Authorization: Bearer abc.def.ghi client_secret=hunter2"), "Authorization: Bearer [redacted] client_secret=[redacted]");
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
  const { trace, lines } = quietTrace();
  return {
    trace,
    lines,
    input: {
      plot: PLOT,
      rows: 2,
      cols: 2,
      now: new Date("2026-09-30T10:00:00Z"),
      powerFetch,
      openeoConfig: CONFIG,
      trace,
      ...extra,
    },
  };
}

test("buildObservation uses the Process API by default and reports date + cloud cover on the same contract", async () => {
  resetTokenCache();
  const { fetchImpl, calls } = stub({ process: tiffResponse });
  const { input, trace } = observationInput({ openeoFetch: fetchImpl });
  const result = await buildObservation(input);
  assert.equal(result.ok, true);
  const o = result.observation!;
  assert.equal(o.sceneDate, "2026-09-25");
  assert.equal(o.cloudCoverPct, 3.1);
  assert.equal(o.cells.length, 4);
  assert.deepEqual(o.cells.map((c) => c.id), ["z-0-0", "z-0-1", "z-1-0", "z-1-1"]);
  assert.equal(o.cells.find((c) => c.id === "z-1-1")!.ndvi, null);
  assert.ok(o.climate && o.climate.source === "nasa-power");
  const cellHa = o.cells.reduce((s, c) => s + c.areaHa, 0);
  assert.ok(Math.abs(cellHa - 1.8) < 0.15, `cell hectares sum to the real plot area, got ${cellHa}`);
  assert.ok(!calls.some((c) => c.url.includes("openeo.dataspace")), "openEO is never contacted by default");
  assert.ok(trace.steps.some((s) => s.step === "nasa-power" && s.ok));
});

test("NASA POWER survives a satellite failure: climate is returned, the reason is technical and specific", async () => {
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
  assert.match(result.technical!, /sh-process/);
  assert.ok(result.diagnostics.some((s) => s.step === "nasa-power" && s.ok));
});

test("a satellite step that throws cannot take NASA POWER down with it", async () => {
  resetTokenCache();
  const fetchImpl = (async (url: string) => {
    if (url.includes("openid-connect/token")) throw new Error("socket hang up");
    return res(500, "");
  }) as unknown as OpeneoFetch;
  const { input } = observationInput({ openeoFetch: fetchImpl });
  const result = await buildObservation(input);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
  assert.ok(result.climate);
  assert.match(result.technical!, /cdse-token/);
});

test("CDSE_USE_OPENEO=1 routes through the legacy openEO graph instead", async () => {
  resetTokenCache();
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(new URL(url).host);
    if (url.includes("openid-connect/token")) return res(200, { access_token: "tok", expires_in: 600 });
    return res(403, { code: "AuthenticationFailed", message: "openEO says no" });
  }) as unknown as OpeneoFetch;
  const { input, trace } = observationInput({ openeoFetch: fetchImpl, openeoConfig: { ...CONFIG, useOpeneo: true } });
  const result = await buildObservation(input);
  assert.equal(result.reason, "auth");
  assert.deepEqual(calls, ["identity.dataspace.copernicus.eu", "openeo.dataspace.copernicus.eu"]);
  assert.match(trace.technical()!, /openeo-result · openeo\.dataspace\.copernicus\.eu · HTTP 403 · AuthenticationFailed/);
  assert.ok(result.climate, "POWER is kept on the openEO path too");
});
