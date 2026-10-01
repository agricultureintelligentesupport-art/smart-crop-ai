/**
 * `/api/field-data/layer` — ONE lazily-requested satellite layer for a plot.
 *
 *   POST `{ uid, plotId, ring, layer, sceneDate }`
 *     → the per-pixel raster of that layer, read over the SAME polygon, the
 *       SAME 10 m grid and the SAME Sentinel-2 scene whose date the client
 *       sends (the date of the plot's NDVI raster).
 *
 * The client asks for a layer only when the farmer selects it the first time
 * and caches the answer in memory per plot + scene; this route is therefore
 * STATELESS — no Firestore, no daily cache. A repeated read costs one Process
 * request, exactly like the NDVI read it mirrors.
 *
 * Same contract as `/api/field-data` everywhere else: the CDSE credentials
 * come from `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (server-only), every
 * upstream step is traced (`cdse-token`, `sh-catalog`, `sh-process`), and no
 * failure becomes an HTTP 500 or an invented number — a layer the scene
 * cannot answer is `{ ok: false, reason }`.
 */

import { NextRequest, NextResponse } from "next/server";
import { centroidOf, validatePlot, type Ring } from "@/lib/geo/polygon";
import { bboxOf } from "@/lib/geo/polygon";
import { readOpeneoConfig } from "@/lib/satellite/openeo";
import { fetchSatelliteLayer } from "@/lib/satellite/sentinelhub";
import { SatelliteTrace } from "@/lib/satellite/trace";
import type { FieldDataReason, FieldLayerId, FieldLayerResponse } from "@/lib/field-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* One token + one catalog + one Process request; the NDVI route's budget. */
export const maxDuration = 60;

const LAYER_IDS: readonly FieldLayerId[] = ["ndmi", "ndre", "truecolor"];

interface RequestBody {
  uid: string;
  plotId: string;
  ring: Ring;
  layer: FieldLayerId;
  /** `YYYY-MM-DD` of the NDVI scene this layer must match. */
  sceneDate: string;
}

function parseBody(raw: unknown): { ok: true; body: RequestBody } | { ok: false; detail: string } {
  if (!raw || typeof raw !== "object") return { ok: false, detail: "request body is not a JSON object" };
  const body = raw as Record<string, unknown>;
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  const plotId = typeof body.plotId === "string" ? body.plotId.trim() : "";
  const layer = typeof body.layer === "string" ? body.layer : "";
  const sceneDate = typeof body.sceneDate === "string" ? body.sceneDate.trim() : "";
  const ring = Array.isArray(body.ring) ? (body.ring as Ring).filter((p) => Array.isArray(p) && p.length >= 2) : [];
  if (!uid || uid.length > 128) return { ok: false, detail: "uid is missing or longer than 128 characters" };
  if (!plotId || plotId.length > 64) return { ok: false, detail: "plotId is missing or longer than 64 characters" };
  if (!LAYER_IDS.includes(layer as FieldLayerId)) {
    return { ok: false, detail: `layer must be one of ${LAYER_IDS.join(", ")}` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sceneDate)) {
    return { ok: false, detail: "sceneDate must be the NDVI scene's YYYY-MM-DD date" };
  }
  if (ring.length < 3) return { ok: false, detail: `ring has ${ring.length} usable point(s), at least 3 are required` };
  return { ok: true, body: { uid, plotId, ring, layer: layer as FieldLayerId, sceneDate } };
}

/** A local rejection: `invalid-input` + the exact condition, never "malformed". */
function invalidInput(detail: string, plotId?: string) {
  console.log(
    `[field-data]${plotId ? ` plot=${plotId.slice(0, 12)}` : ""} step=validate ok=false detail=${JSON.stringify(detail)}`,
  );
  return NextResponse.json(
    {
      ok: false,
      reason: "invalid-input" as FieldDataReason,
      observation: null,
      technical: `validate · invalid-input: ${detail}`.slice(0, 150),
      message: detail,
    },
    { status: 400 },
  );
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidInput("request body is not valid JSON");
  }
  const result0 = parseBody(body);
  if (!result0.ok) return invalidInput(result0.detail);
  const parsed = result0.body;

  // The same server-side geometry check `/api/field-data` applies.
  const validation = validatePlot(parsed.ring);
  if (!validation.ok) {
    return NextResponse.json(
      { ok: false, layer: parsed.layer, reason: "tooSmall" as FieldDataReason, raster: null, message: validation.detail },
      { status: 200 },
    );
  }

  const config = readOpeneoConfig();
  const trace = new SatelliteTrace({
    secrets: [config.clientId, config.clientSecret],
    tag: `plot=${parsed.plotId.slice(0, 12)} layer=${parsed.layer}`,
  });
  const bbox = bboxOf(parsed.ring);
  if (!bbox) return invalidInput("ring does not span an area", parsed.plotId);
  const centroid = centroidOf(parsed.ring) ?? parsed.ring[0];

  const result = await fetchSatelliteLayer(
    config,
    { layer: parsed.layer, sceneDate: parsed.sceneDate, bbox, ring: parsed.ring },
    undefined,
    trace,
  );

  const raster = result.raster;
  const rasterNote = raster
    ? ` raster=${raster.width}x${raster.height}@${raster.resolutionM}m valid=${raster.dataMask.reduce((sum, m) => sum + m, 0)}/${raster.width * raster.height}`
    : "";
  console.log(
    `[field-data] plot=${parsed.plotId.slice(0, 12)} layer=${parsed.layer} step=result ok=${result.ok}` +
      `${result.reason ? ` reason=${result.reason}` : ""} provider=sentinel-hub-process scene=${result.sceneDate ?? "-"}${rasterNote} ` +
      `centroid=${centroid[1].toFixed(4)},${centroid[0].toFixed(4)}`,
  );

  if (result.ok && result.raster) {
    const payload: FieldLayerResponse = {
      ok: true,
      layer: result.layer,
      raster: result.raster,
      diagnostics: trace.steps,
    };
    return NextResponse.json(payload);
  }

  const payload: FieldLayerResponse = {
    ok: false,
    layer: result.layer,
    reason: (result.reason ?? "network") as FieldDataReason,
    raster: null,
    technical: trace.technical() ?? undefined,
    diagnostics: trace.steps,
  };
  return NextResponse.json(payload);
}
