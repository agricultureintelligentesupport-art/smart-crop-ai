/**
 * The local validation that runs before any Copernicus request.
 *
 * Root cause pinned here: a boundary drawn CLOCKWISE clipped every grid cell
 * away (`gridCells` → 0 cells), and the Process API client then answered
 * "malformed" before it ever asked for a token. The client also sent a grid
 * computed from the dashboard's default 2 ha instead of the plot's real area.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { gridCells, ringAreaHa, type Ring } from "@/lib/geo/polygon";
import { gridForArea, validateAnalysisInput } from "@/lib/field-data/grid";
import { buildObservation } from "@/lib/field-data/observation";
import { resetTokenCache, type OpeneoConfig, type OpeneoFetch } from "@/lib/satellite/openeo";
import { SatelliteTrace } from "@/lib/satellite/trace";
import type { Plot } from "@/lib/field-data/types";

const CONFIG: OpeneoConfig = {
  clientId: "sh-test-client",
  clientSecret: "test-secret-value",
  openEoUrl: "https://openeo.dataspace.copernicus.eu/openeo/1.2",
  tokenUrl: "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
  collection: "SENTINEL2_L2A",
  timeoutMs: 5_000,
  processUrl: "https://sh.dataspace.copernicus.eu/api/v1/process",
  catalogUrl: "https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search",
  useOpeneo: false,
};

/** ≈ 58.3 m square next to Biskra ≈ 0.34 ha, counter-clockwise (lon = x, lat = y). */
const SIDE_M = 58.3;
const DLON = SIDE_M / (111_320 * Math.cos((34.85 * Math.PI) / 180));
const DLAT = SIDE_M / 110_574;
const CCW: Ring = [
  [5.72, 34.85],
  [5.72 + DLON, 34.85],
  [5.72 + DLON, 34.85 + DLAT],
  [5.72, 34.85 + DLAT],
];
const CW: Ring = [...CCW].reverse();

const plotOf = (ring: Ring): Plot => ({
  id: "plot-0-34-ha",
  uid: "u1",
  name: "",
  ring,
  areaHa: 0,
  centroid: [ring[0][0], ring[0][1]],
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
});

function quiet() {
  const lines: string[] = [];
  const trace = new SatelliteTrace({
    secrets: [CONFIG.clientId, CONFIG.clientSecret],
    tag: "plot=plot-0-34-ha",
    sink: (l) => lines.push(l),
  });
  return { trace, lines };
}

const powerFetch = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" })) as never;

test("the test plot really is ~0.34 ha", () => {
  assert.ok(Math.abs(ringAreaHa(CCW) - 0.34) < 0.01, String(ringAreaHa(CCW)));
  assert.ok(Math.abs(ringAreaHa(CW) - 0.34) < 0.01);
});

test("regression: a clockwise boundary is cut into cells exactly like a counter-clockwise one", () => {
  const ccw = gridCells(CCW, 2, 3);
  const cw = gridCells(CW, 2, 3);
  assert.equal(ccw.length, 6);
  assert.equal(cw.length, 6, "clockwise rings used to yield 0 cells");
  const total = (cells: typeof ccw) => cells.reduce((s, c) => s + c.areaHa, 0);
  assert.ok(Math.abs(total(cw) - total(ccw)) < 1e-6);
  assert.ok(Math.abs(total(cw) - 0.34) < 0.01);
});

test("grid for 0.34 ha: rows and cols are chosen from the real area, within 2..8, cells ~0.03–0.1 ha", () => {
  for (const ring of [CCW, CW]) {
    const v = validateAnalysisInput(ring);
    assert.equal(v.ok, true, String(v.detail));
    assert.equal(v.detail, null);
    assert.ok(v.rows >= 2 && v.rows <= 8, `rows=${v.rows}`);
    assert.ok(v.cols >= 2 && v.cols <= 8, `cols=${v.cols}`);
    assert.ok(Math.abs(v.areaHa - 0.34) < 0.01);
    assert.equal(v.ringLength, 4);
    assert.ok(v.cells.length > 0);
    const cellHa = v.areaHa / (v.rows * v.cols);
    assert.ok(cellHa >= 0.03 && cellHa <= 0.1, `cell ≈ ${cellHa.toFixed(3)} ha`);
    // It is NOT the 4×4 grid of the default 2 ha area.
    assert.ok(v.rows * v.cols < 16);
  }
});

test("gridForArea clamps every side to 2..8 and follows the plot's aspect", () => {
  assert.deepEqual(gridForArea(0.05, 50, 10), { rows: 2, cols: 2 });
  const huge = gridForArea(50, 700, 700);
  assert.ok(huge.rows <= 8 && huge.cols <= 8 && huge.rows >= 2 && huge.cols >= 2);
  const wide = gridForArea(1.8, 600, 30);
  assert.ok(wide.cols > wide.rows, JSON.stringify(wide));
  const tall = gridForArea(1.8, 30, 600);
  assert.ok(tall.rows > tall.cols, JSON.stringify(tall));
  for (const [a, w, h] of [[0.01, 1, 1], [1000, 1, 1000], [2, 0, 0], [0.34, 58, 58]] as const) {
    const g = gridForArea(a, w, h);
    assert.ok(g.rows >= 2 && g.rows <= 8 && g.cols >= 2 && g.cols <= 8, JSON.stringify([a, w, h, g]));
  }
});

test("client-sent rows/cols are ignored: the flow proceeds to the token step with the server's grid", async () => {
  resetTokenCache();
  const hosts: string[] = [];
  const fetchImpl = (async (url: string) => {
    hosts.push(new URL(url).host);
    return {
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: "invalid_client", error_description: "Invalid client credentials" }),
      headers: { get: () => null },
    };
  }) as unknown as OpeneoFetch;
  const { trace, lines } = quiet();
  // No rows/cols: the route never forwards the client's (2 ha → 4×4) values.
  const result = await buildObservation({
    plot: plotOf(CW),
    now: new Date("2026-09-30T10:00:00Z"),
    powerFetch,
    openeoConfig: CONFIG,
    openeoFetch: fetchImpl,
    trace,
  });

  // Validation passed, and the very next satellite step is the token request.
  assert.deepEqual(trace.steps.filter((s) => s.step !== "nasa-power").map((s) => s.step), ["validate", "cdse-token"]);
  assert.equal(trace.steps[0].ok, true);
  assert.deepEqual(hosts, ["identity.dataspace.copernicus.eu"]);
  assert.equal(result.reason, "auth", "the failure is the provider's, not a local one");
  assert.notEqual(result.reason, "malformed");
  assert.notEqual(result.reason, "invalid-input");
  assert.match(result.technical!, /cdse-token · identity\.dataspace\.copernicus\.eu · HTTP 401 · invalid_client/);

  const validateLine = lines.find((l) => l.includes("step=validate"))!;
  assert.match(validateLine, /^\[field-data\] plot=plot-0-34-ha step=validate ok=true detail="none" areaHa=0\.3\d\d rows=\d cols=\d ring=4 cells=\d+$/);
  assert.ok(!lines.join("\n").includes(CONFIG.clientSecret as string));
});

test("a local failure is 'invalid-input' with the exact condition — never 'malformed' — and makes no Copernicus call", async () => {
  resetTokenCache();
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    throw new Error("must not be called");
  }) as unknown as OpeneoFetch;
  // Three collinear points: a ring that encloses nothing.
  const flat: Ring = [
    [5.72, 34.85],
    [5.721, 34.85],
    [5.722, 34.85],
  ];
  const { trace, lines } = quiet();
  const result = await buildObservation({
    plot: plotOf(flat),
    now: new Date("2026-09-30T10:00:00Z"),
    powerFetch,
    openeoConfig: CONFIG,
    openeoFetch: fetchImpl,
    trace,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-input");
  assert.notEqual(result.reason, "malformed");
  assert.deepEqual(calls, [], "no token/catalog/process request after a local failure");
  assert.match(result.technical!, /^validate · invalid-input: areaHa=0 from geometry is not a positive number/);
  const line = lines.find((l) => l.includes("step=validate"))!;
  assert.match(line, /step=validate ok=false detail="areaHa=0 from geometry is not a positive number"/);
  assert.match(line, /rows=0 cols=0 ring=3 cells=0/);
});

test("zero cells is reported with rows, cols and the threshold, not as a provider problem", () => {
  // A valid but sliver-thin ring: every cell clips below the 0.02 ha minimum.
  const sliver: Ring = [
    [5.72, 34.85],
    [5.72 + DLON * 0.02, 34.85],
    [5.72 + DLON * 0.02, 34.85 + DLAT * 40],
    [5.72, 34.85 + DLAT * 40],
  ];
  const v = validateAnalysisInput(sliver, { rows: 8, cols: 8 });
  assert.equal(v.ok, false);
  assert.match(v.detail!, /gridCells produced 0 cells for rows=8 cols=8/);
  assert.match(v.detail!, /0\.02 ha/);
  assert.equal(v.ringLength, 4);
  assert.ok(v.areaHa > 0);
});
