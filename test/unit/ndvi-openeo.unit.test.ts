/**
 * The Copernicus/openEO side: the process graph that turns a drawn polygon into
 * one mean NDVI per heatmap cell, and the defensive parsing of whatever shape
 * the back-end answers with.
 *
 * These cannot be verified against the live Copernicus Data Space from this
 * repository (see `docs/field-data.md`), so the value of the suite is in
 * pinning the contract: the graph is well-formed, and no response shape — or
 * failure — can turn into a fabricated number.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNdviGraph,
  fetchNdvi,
  isConfigured,
  parseNdviResponse,
  readOpeneoConfig,
  resetTokenCache,
  type NdviGraphOptions,
  type NdviTarget,
  type OpeneoConfig,
  type OpeneoFetch,
} from "@/lib/satellite/openeo";

const CONFIG: OpeneoConfig = {
  clientId: "sh-test",
  clientSecret: "secret",
  openEoUrl: "https://openeo.dataspace.copernicus.eu/openeo/1.2",
  tokenUrl: "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
  collection: "SENTINEL2_L2A",
  timeoutMs: 5_000,
};

const TARGETS: NdviTarget[] = [
  { id: "c-0-0", ring: [[3.0, 36.0], [3.01, 36.0], [3.01, 36.01]] },
  { id: "c-0-1", ring: [[3.01, 36.0], [3.02, 36.0], [3.02, 36.01]] },
];

const GRAPH_OPTIONS: NdviGraphOptions = {
  collection: "SENTINEL2_L2A",
  from: "2026-08-18",
  to: "2026-09-12",
  bbox: { west: 3.0, south: 36.0, east: 3.02, north: 36.01 },
  targets: TARGETS,
};

function response(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

/** A stub that answers the token request and the /result request. */
function stubFetch(resultPayload: unknown, resultStatus = 200, headers: Record<string, string> = {}): OpeneoFetch {
  return (async (url: string) => {
    if (url.includes("openid-connect/token")) {
      return response({ access_token: "tok-123", expires_in: 600 });
    }
    return response(resultPayload, resultStatus, headers);
  }) as unknown as OpeneoFetch;
}

test("readOpeneoConfig only reports configured when both credentials exist", () => {
  const full = readOpeneoConfig({
    CDSE_CLIENT_ID: "sh-a",
    CDSE_CLIENT_SECRET: "s",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(isConfigured(full), true);
  assert.equal(full.collection, "SENTINEL2_L2A");
  assert.match(full.openEoUrl, /^https:\/\//);
  assert.match(full.tokenUrl, /identity\.dataspace\.copernicus\.eu/);

  // Whitespace-only is not a credential.
  const blank = readOpeneoConfig({ CDSE_CLIENT_ID: "  ", CDSE_CLIENT_SECRET: "s" } as unknown as NodeJS.ProcessEnv);
  assert.equal(isConfigured(blank), false);
  assert.equal(isConfigured(readOpeneoConfig({} as NodeJS.ProcessEnv)), false);
});

test("the graph loads B04/B08/SCL, masks cloud, and aggregates one mean per polygon", () => {
  const graph = buildNdviGraph(GRAPH_OPTIONS);
  const load = graph.load1 as { process_id: string; arguments: Record<string, unknown> };
  assert.equal(load.process_id, "load_collection");
  assert.equal(load.arguments.id, "SENTINEL2_L2A");
  assert.deepEqual(load.arguments.bands, ["B04", "B08", "SCL"]);
  assert.deepEqual(load.arguments.spatial_extent, GRAPH_OPTIONS.bbox);
  assert.deepEqual(load.arguments.temporal_extent, ["2026-08-18", "2026-09-12"]);

  // NDVI needs red and near-infrared.
  const ndvi = graph.ndvi1 as { process_id: string; arguments: Record<string, unknown> };
  assert.equal(ndvi.process_id, "ndvi");
  assert.equal(ndvi.arguments.red, "B04");
  assert.equal(ndvi.arguments.nir, "B08");

  // The cloud mask runs off SCL and rejects the five cloudy classes.
  assert.ok(graph.scl1, "SCL band is selected");
  assert.ok(graph.mask1, "a filter runs before NDVI");
  const filter = graph.mask1 as { process_id: string; arguments: { conditions: unknown } };
  assert.equal(filter.process_id, "filter");
  const serialised = JSON.stringify(filter.arguments.conditions);
  for (const classId of [3, 8, 9, 10, 11]) {
    assert.ok(serialised.includes(`[${classId}`) || serialised.includes(`,${classId}`) || serialised.includes(`${classId}`),
      `cloud class ${classId} must be masked`);
  }

  // One geometry per cell, and a mean reducer.
  const agg = graph.agg1 as {
    process_id: string;
    result?: boolean;
    arguments: { geometries: { type: string; features: unknown[] }; reducer: { process_id: string } };
  };
  assert.equal(agg.process_id, "aggregate_spatial");
  assert.equal(agg.result, true);
  assert.equal(agg.arguments.geometries.type, "FeatureCollection");
  assert.equal(agg.arguments.geometries.features.length, 2);
  assert.equal(agg.arguments.reducer.process_id, "mean");

  // The parcel is a closed GeoJSON polygon; our rings are unclosed.
  const feature = agg.arguments.geometries.features[0] as {
    id: string;
    geometry: { type: string; coordinates: number[][][] };
  };
  assert.equal(feature.id, "c-0-0");
  assert.equal(feature.geometry.type, "Polygon");
  const ring = feature.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], "rings must be closed for GeoJSON");
  assert.equal(ring.length, TARGETS[0].ring.length + 1);
});

test("parseNdviResponse reads a GeoJSON FeatureCollection by feature id", () => {
  const { cells, sceneDate } = parseNdviResponse(
    {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { id: "c-0-0", mean: 0.62, datetime: "2026-09-08T10:35:00Z" } },
        { type: "Feature", properties: { id: "c-0-1", mean: 0.31, datetime: "2026-09-08T10:35:00Z" } },
      ],
    },
    TARGETS,
  );
  assert.equal(cells[0].ndvi, 0.62);
  assert.equal(cells[1].ndvi, 0.31);
  assert.equal(sceneDate, "2026-09-08");
});

test("parseNdviResponse matches on a bare feature id, not just on position", () => {
  const { cells } = parseNdviResponse(
    { type: "FeatureCollection", features: [{ id: "c-0-1", properties: { mean: 0.1 } }] },
    TARGETS,
  );
  assert.equal(cells[0].ndvi, null, "an unnamed cell stays unmeasured");
  assert.equal(cells[1].ndvi, 0.1, "the named cell gets its own value");
});

test("parseNdviResponse handles the data envelope and positional arrays", () => {
  // openEO temporal aggregation often returns { data: [[date, value], ...] }.
  const envelope = parseNdviResponse(
    { data: [["2026-09-08", 0.4], ["2026-09-08", 0.55]] },
    TARGETS,
  );
  assert.equal(envelope.cells[0].ndvi, 0.4);
  assert.equal(envelope.cells[1].ndvi, 0.55);
  assert.equal(envelope.sceneDate, "2026-09-08");

  // A bare array maps by position, which the spec guarantees is input order.
  const bare = parseNdviResponse([0.7, 0.2], TARGETS);
  assert.equal(bare.cells[0].ndvi, 0.7);
  assert.equal(bare.cells[1].ndvi, 0.2);
  assert.equal(bare.sceneDate, null);
});

test("parseNdviResponse never invents a value for a cell the back-end could not read", () => {
  // `null` stays null — a cloud-covered cell is a missing measurement.
  const { cells } = parseNdviResponse(
    { type: "FeatureCollection", features: [{ properties: { id: "c-0-0", mean: 0.5 } }, { properties: { id: "c-0-1" } }] },
    TARGETS,
  );
  assert.equal(cells[0].ndvi, 0.5);
  assert.equal(cells[1].ndvi, null);

  // Out-of-range and non-numeric payloads are rejected, not coerced.
  for (const bad of [999, -5, "0.5", {}, [], true, undefined, NaN]) {
    const parsed = parseNdviResponse([bad], TARGETS);
    assert.equal(parsed.cells[0].ndvi, null, `${JSON.stringify(bad)} must not become a number`);
  }
  // NDVI is bounded by construction; a legitimate value is kept.
  assert.equal(parseNdviResponse([1], TARGETS).cells[0].ndvi, 1);
  assert.equal(parseNdviResponse([-1], TARGETS).cells[0].ndvi, -1);
});

test("parseNdviResponse is safe on garbage", () => {
  for (const input of [null, undefined, 42, "nope", [], {}]) {
    const { cells } = parseNdviResponse(input, TARGETS);
    assert.equal(cells.length, 2);
    assert.ok(cells.every((c) => c.ndvi === null));
  }
  // A response with more features than targets must not write past the array.
  const extra = parseNdviResponse([0.1, 0.2, 0.3, 0.4], TARGETS);
  assert.equal(extra.cells.length, 2);
  assert.equal(extra.cells[0].ndvi, 0.1);
  assert.equal(extra.cells[1].ndvi, 0.2);
});

test("fetchNdvi reports 'not configured' without touching the network", async () => {
  resetTokenCache();
  let touched = false;
  const result = await fetchNdvi(
    { ...CONFIG, clientId: null, clientSecret: null },
    GRAPH_OPTIONS,
    (async () => {
      touched = true;
      return response({});
    }) as unknown as OpeneoFetch,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "notConfigured");
  assert.equal(touched, false, "no request may be made without credentials");
});

test("fetchNdvi maps every HTTP failure onto a reason, and never returns numbers", async () => {
  const cases: [number, string][] = [
    [401, "auth"],
    [403, "auth"],
    [402, "quota"],
    [429, "quota"],
    [408, "timeout"],
    [504, "timeout"],
    [404, "noScenes"],
    [500, "http"],
  ];
  for (const [status, reason] of cases) {
    resetTokenCache();
    const result = await fetchNdvi(CONFIG, GRAPH_OPTIONS, stubFetch({}, status));
    assert.equal(result.ok, false, `HTTP ${status} must not report success`);
    assert.equal(result.reason, reason, `HTTP ${status}`);
    assert.equal(result.status, status);
    assert.ok(result.cells.every((c) => c.ndvi === null));
  }
});

test("fetchNdvi treats a fully masked parcel as noScenes, not as zeros", async () => {
  resetTokenCache();
  const result = await fetchNdvi(CONFIG, GRAPH_OPTIONS, stubFetch({
    type: "FeatureCollection",
    features: TARGETS.map((t) => ({ properties: { id: t.id, mean: null } })),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "noScenes");
  assert.equal(result.maskedCells, 2);
  assert.ok(result.cells.every((c) => c.ndvi === null), "never substitute 0 for a missing NDVI");
});

test("fetchNdvi succeeds with a partial result and counts the masked cells", async () => {
  resetTokenCache();
  const result = await fetchNdvi(CONFIG, GRAPH_OPTIONS, stubFetch({
    type: "FeatureCollection",
    features: [
      { properties: { id: "c-0-0", mean: 0.58, datetime: "2026-09-10T10:20:00Z" } },
      { properties: { id: "c-0-1", mean: null } },
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.cells[0].ndvi, 0.58);
  assert.equal(result.cells[1].ndvi, null);
  assert.equal(result.maskedCells, 1);
  assert.equal(result.sceneDate, "2026-09-10");
});

test("fetchNdvi authenticates with the CDSE client-credentials flow and reuses the token", async () => {
  resetTokenCache();
  const calls: { url: string; auth?: string; body?: string }[] = [];
  const fetchImpl = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, auth: init?.headers?.authorization, body: init?.body });
    if (url.includes("openid-connect/token")) {
      return response({ access_token: "tok-abc", expires_in: 600 });
    }
    return response({ type: "FeatureCollection", features: [{ properties: { id: "c-0-0", mean: 0.4 } }] });
  }) as unknown as OpeneoFetch;

  await fetchNdvi(CONFIG, GRAPH_OPTIONS, fetchImpl);
  await fetchNdvi(CONFIG, GRAPH_OPTIONS, fetchImpl);

  const tokenCalls = calls.filter((c) => c.url.includes("openid-connect/token"));
  const resultCalls = calls.filter((c) => c.url.includes("/result"));
  assert.equal(tokenCalls.length, 1, "the access token is cached across calls");
  assert.equal(resultCalls.length, 2);
  // The token request is a form post with the client-credentials grant.
  assert.match(String(tokenCalls[0].body), /grant_type=client_credentials/);
  assert.match(String(tokenCalls[0].body), /client_id=sh-test/);
  // The result request carries a Bearer token, never the secret.
  assert.equal(resultCalls[0].auth, "Bearer tok-abc");
  assert.ok(!String(resultCalls[0].auth).includes("secret"));
});

test("fetchNdvi reports an auth failure when the token request is refused", async () => {
  resetTokenCache();
  const result = await fetchNdvi(CONFIG, GRAPH_OPTIONS, (async (url: string) => {
    if (url.includes("openid-connect/token")) return response({ error: "invalid_client" }, 401);
    return response({});
  }) as unknown as OpeneoFetch);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "auth");
});

test("fetchNdvi follows a 202 batch job within a bounded number of polls", async () => {
  resetTokenCache();
  let polls = 0;
  const fetchImpl = (async (url: string) => {
    if (url.includes("openid-connect/token")) return response({ access_token: "tok", expires_in: 600 });
    if (url.endsWith("/result")) {
      return response({}, 202, { location: "https://openeo.example/job/1" });
    }
    polls += 1;
    if (polls < 2) return response({}, 202, { location: "https://openeo.example/job/1" });
    return response({ type: "FeatureCollection", features: [{ properties: { id: "c-0-0", mean: 0.66 } }] });
  }) as unknown as OpeneoFetch;

  const result = await fetchNdvi(CONFIG, GRAPH_OPTIONS, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.cells[0].ndvi, 0.66);
  assert.equal(polls, 2);
});

test("fetchNdvi never throws when the network is down", async () => {
  resetTokenCache();
  const result = await fetchNdvi(CONFIG, GRAPH_OPTIONS, (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as OpeneoFetch);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
  assert.equal(result.cells.length, 0);
});
