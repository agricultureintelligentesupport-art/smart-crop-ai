/**
 * `/api/field-data` — one measured day for one saved plot.
 *
 *   POST `{ uid, plotId, ring, areaHa, force? }` (rows/cols, if sent, are ignored)
 *     → the cached observation when one was already produced today
 *       (Africa/Algiers), otherwise a fresh NASA POWER + Sentinel-2 read.
 *
 * CACHING
 * -------
 * A satellite pass over a given parcel does not change between page loads, and
 * the Copernicus Data Space charges processing credits, so a result is reused
 * for the whole day. The cache key is `sha256(uid + rounded ring)`, stored as
 * a Firestore document id:
 *
 *   • The same parcel for the same user always hits the same document, on any
 *     server instance, with no TTL sweeper.
 *   • Because the key is a hash, a caller can only ever address their OWN
 *     cache entries — reading anyone else's would require already knowing
 *     their uid *and* their exact boundary.
 *   • The payload is derived entirely from public satellite and reanalysis
 *     data, so it carries no private information beyond the parcel's shape.
 *
 * This is capability-based cache isolation, not an authentication check. The
 * app does not run the Firebase Admin SDK, so a server-side token check is not
 * possible today; the plot itself stays private because it lives under
 * `users/{uid}/plots` and is only ever read/written by the signed-in client.
 *
 * FAILURE
 * -------
 * No HTTP 500s. An unreachable or unconfigured upstream, a cloud-covered
 * parcel or a quota exhaustion all answer `200` with `{ ok: false, reason }`
 * and no observation, so the UI can show "no data yet" instead of a number
 * nobody measured. A previously cached observation is still returned — flagged
 * `stale` with its real date — rather than blanking the screen.
 *
 * DIAGNOSTICS
 * -----------
 * Every upstream call (NASA POWER, CDSE token, Sentinel Hub catalog/process —
 * or openEO behind `CDSE_USE_OPENEO=1`) is logged as one line with its host,
 * HTTP status and the error code/message of the body, and the same records are
 * returned as `diagnostics` (+ a short `technical` string). No secrets.
 *
 * NASA POWER is independent of the satellite: when NDVI fails, the POWER day
 * is still returned as `climate` on the failure response.
 */

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { db, isFirestoreReady } from "@/lib/firebase";
import { centroidOf, ringAreaHa, validatePlot, type Ring } from "@/lib/geo/polygon";
import { readOpeneoConfig } from "@/lib/satellite/openeo";
import { buildObservation, todayIso } from "@/lib/field-data/observation";
import type { FieldDataReason, FieldObservation } from "@/lib/field-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* A Sentinel Hub catalog lookup plus one or two Process API rasters is small,
   but a cold back-end can take a while; POWER runs in parallel. */
export const maxDuration = 60;

const CACHE_COLLECTION = "fieldDataCache";

/**
 * How long a cache read/write may hold up the response.
 *
 * An unreachable Firestore must cost freshness, never the answer — the same
 * ceiling the client plot store uses (`lib/field-data/plots.ts`). Without it a
 * blackholed connection parks this request (and whatever else the shared
 * server process is serving) until the caller gives up.
 */
const REMOTE_CEILING_MS = 4000;

function withCeiling<T>(work: Promise<T>, ms = REMOTE_CEILING_MS): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("field-data: cache access timed out")), ms);
      // A pending cache miss must not keep the process warm on its own.
      (timer as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

/**
 * Content-addressed cache id. Coordinates are rounded to ~1 m (5 decimals)
 * because a 2 ha parcel is ~140 m across: below that, rounding noise would
 * create a new cache entry on every drag.
 */
export function cacheKeyFor(uid: string, ring: Ring): string {
  const canonical = ring
    .map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`)
    .sort()
    .join(";");
  return createHash("sha256").update(`${uid}|${canonical}`).digest("hex").slice(0, 40);
}

async function readCache(uid: string, ring: Ring, firestore: Firestore): Promise<FieldObservation | null> {
  if (!isFirestoreReady(firestore)) return null;
  try {
    const snap = await withCeiling(getDoc(doc(firestore, CACHE_COLLECTION, cacheKeyFor(uid, ring))));
    if (!snap.exists()) return null;
    const data = snap.data() as { observation?: FieldObservation };
    return data.observation ?? null;
  } catch {
    return null;
  }
}

async function writeCache(uid: string, ring: Ring, observation: FieldObservation, firestore: Firestore): Promise<void> {
  if (!isFirestoreReady(firestore)) return;
  try {
    await withCeiling(
      setDoc(
        doc(firestore, CACHE_COLLECTION, cacheKeyFor(uid, ring)),
        { observation, updatedAt: new Date().toISOString() },
        { merge: false },
      ),
    );
  } catch {
    /* a cache write failure must never fail the response */
  }
}

interface RequestBody {
  uid: string;
  plotId: string;
  ring: Ring;
  /** What the client believes the area is — only compared, never trusted. */
  claimedAreaHa: number | null;
  force: boolean;
}

/**
 * `rows`/`cols` in the body are ignored on purpose: the client derives them
 * from the dashboard's calculator area (default 2 ha), not from the drawn plot.
 * The server cuts the grid from the plot's real area (`lib/field-data/grid.ts`).
 */
function parseBody(raw: unknown): { ok: true; body: RequestBody } | { ok: false; detail: string } {
  if (!raw || typeof raw !== "object") return { ok: false, detail: "request body is not a JSON object" };
  const body = raw as Record<string, unknown>;
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  const plotId = typeof body.plotId === "string" ? body.plotId.trim() : "";
  // Re-validate the geometry server-side: the client's word is worth nothing.
  const ring = Array.isArray(body.ring) ? (body.ring as Ring).filter((p) => Array.isArray(p) && p.length >= 2) : [];
  if (!uid || uid.length > 128) return { ok: false, detail: "uid is missing or longer than 128 characters" };
  if (!plotId || plotId.length > 64) return { ok: false, detail: "plotId is missing or longer than 64 characters" };
  if (ring.length < 3) return { ok: false, detail: `ring has ${ring.length} usable point(s), at least 3 are required` };
  const claimed = Number(body.areaHa);
  return {
    ok: true,
    body: {
      uid,
      plotId,
      ring,
      claimedAreaHa: Number.isFinite(claimed) && claimed > 0 ? claimed : null,
      force: body.force === true,
    },
  };
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

  const validation = validatePlot(parsed.ring);
  if (!validation.ok) {
    return NextResponse.json(
      { ok: false, reason: "tooSmall" as FieldDataReason, observation: null, message: validation.detail },
      { status: 200 },
    );
  }

  const today = todayIso();

  if (!parsed.force) {
    const cached = await readCache(parsed.uid, parsed.ring, db);
    if (cached && cached.date === today) {
      return NextResponse.json({ ok: true, observation: cached, stale: false });
    }
  }

  /* The plot's REAL area comes from its geometry, not from the request: the
     dashboard's `areaHa` is the irrigation calculator's field size (default
     2 ha) and need not match the drawn boundary. The grid (`rows × cols`) is
     derived from that real area inside `buildObservation` and travels back on
     the observation, so the heatmap paints the same grid the satellite read. */
  const realAreaHa = ringAreaHa(parsed.ring);
  const centroid = centroidOf(parsed.ring) ?? parsed.ring[0];
  if (parsed.claimedAreaHa !== null && Math.abs(parsed.claimedAreaHa - realAreaHa) > 0.1 * realAreaHa) {
    console.log(
      `[field-data] note=areaHa-differs claimed=${parsed.claimedAreaHa.toFixed(2)} geometry=${realAreaHa.toFixed(2)} (geometry used)`,
    );
  }

  const result = await buildObservation({
    plot: {
      id: parsed.plotId,
      uid: parsed.uid,
      name: "",
      ring: parsed.ring,
      areaHa: Math.round(realAreaHa * 10_000) / 10_000,
      centroid: [centroid[0], centroid[1]],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  console.log(
    `[field-data] plot=${parsed.plotId.slice(0, 12)} result ok=${result.ok}${result.reason ? ` reason=${result.reason}` : ""} ` +
      `provider=${readOpeneoConfig().useOpeneo ? "openeo" : "sentinel-hub-process"} ` +
      `climate=${result.climate ? "ok" : "none"} cells=${result.cells.length} rows×cols=${result.observation?.rows ?? "-"}×${result.observation?.cols ?? "-"} areaHa=${realAreaHa.toFixed(2)}`,
  );

  if (result.ok && result.observation) {
    await writeCache(parsed.uid, parsed.ring, { ...result.observation, plotId: parsed.plotId }, db);
    return NextResponse.json({
      ok: true,
      observation: result.observation,
      stale: false,
      diagnostics: result.diagnostics,
    });
  }

  // The upstream failed. Prefer a previous real reading over a blank screen —
  // but label it with its own date so it is never mistaken for today's.
  const stale = await readCache(parsed.uid, parsed.ring, db);
  if (stale) {
    return NextResponse.json({
      ok: true,
      observation: stale,
      stale: true,
      reason: result.reason,
      message: `showing the ${stale.date} reading; today's data is unavailable`,
      ...(result.technical ? { technical: result.technical } : {}),
      diagnostics: result.diagnostics,
      climate: result.climate,
    });
  }

  return NextResponse.json({
    ok: false,
    reason: result.reason ?? ("network" as FieldDataReason),
    observation: null,
    ...(result.technical ? { technical: result.technical } : {}),
    diagnostics: result.diagnostics,
    // NASA POWER is independent: a satellite failure never discards it.
    climate: result.climate,
  });
}
