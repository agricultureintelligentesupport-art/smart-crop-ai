/**
 * `/api/field-data` — one measured day for one saved plot.
 *
 *   POST `{ uid, plotId, ring, rows, cols, areaHa, force? }`
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
 */

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { doc, getDoc, setDoc, type Firestore } from "firebase/firestore";
import { db, isFirestoreReady } from "@/lib/firebase";
import { validatePlot, type Ring } from "@/lib/geo/polygon";
import { buildObservation, todayIso } from "@/lib/field-data/observation";
import type { FieldDataReason, FieldObservation } from "@/lib/field-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* A synchronous openEO aggregation over a handful of polygons is small, but a
   cold cache on a busy back-end can take a while; POWER runs in parallel. */
export const maxDuration = 60;

const CACHE_COLLECTION = "fieldDataCache";
/** Rows/cols are bounded so a hostile payload cannot ask for a huge graph. */
const MAX_ROWS = 6;
const MAX_COLS = 6;

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
  rows: number;
  cols: number;
  force: boolean;
}

function parseBody(raw: unknown): RequestBody | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  const plotId = typeof body.plotId === "string" ? body.plotId.trim() : "";
  // Re-validate the geometry server-side: the client's word is worth nothing.
  const ring = Array.isArray(body.ring) ? (body.ring as Ring).filter((p) => Array.isArray(p) && p.length >= 2) : [];
  if (!uid || uid.length > 128 || !plotId || plotId.length > 64) return null;
  if (ring.length < 3) return null;
  const rows = Math.min(MAX_ROWS, Math.max(1, Number(body.rows) || 4));
  const cols = Math.min(MAX_COLS, Math.max(1, Number(body.cols) || 4));
  return { uid, plotId, ring, rows, cols, force: body.force === true };
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "malformed" as FieldDataReason, observation: null }, { status: 400 });
  }
  const parsed = parseBody(body);
  if (!parsed) {
    return NextResponse.json({ ok: false, reason: "malformed" as FieldDataReason, observation: null }, { status: 400 });
  }

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

  const result = await buildObservation({
    plot: {
      id: parsed.plotId,
      uid: parsed.uid,
      name: "",
      ring: parsed.ring,
      areaHa: 0,
      centroid: [parsed.ring[0][0], parsed.ring[0][1]],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    rows: parsed.rows,
    cols: parsed.cols,
  });

  if (result.ok && result.observation) {
    await writeCache(parsed.uid, parsed.ring, { ...result.observation, plotId: parsed.plotId }, db);
    return NextResponse.json({ ok: true, observation: result.observation, stale: false });
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
    });
  }

  return NextResponse.json({
    ok: false,
    reason: result.reason ?? ("network" as FieldDataReason),
    observation: null,
  });
}
