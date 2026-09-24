/**
 * `/api/cron/daily-snapshot` — phase 1 of the daily task workflow (23:55).
 *
 * Scheduled for 22:55 UTC = 23:55 Africa/Algiers (see `vercel.json`). For
 * every pinned context it collects the FULL context snapshot for the upcoming
 * day:
 *
 *   1. Open-Meteo 24-hour forecast — temp max/min, rain probability,
 *      humidity, wind speed;
 *   2. Calculated ET₀, net irrigation need (m³) and the optimal watering
 *      window (the exact `computeIrrigation` chain the hero card renders);
 *   3. Selected crop, growth stage, soil type and wilaya.
 *
 * The snapshot is stored under `dailySnapshots/{date}/{contextKey}` (RTDB when
 * `FIREBASE_DATABASE_URL` is configured, instance memory otherwise) and is
 * consumed at 00:00 by `/api/cron/daily-tasks`.
 *
 * Auth: Vercel Cron's `Authorization: Bearer ${CRON_SECRET}` (or `?secret=`)
 * whenever `CRON_SECRET` is set. Never 500s — failures are reported per run.
 */

import { NextRequest, NextResponse } from "next/server";
import { runSnapshotPhase } from "@/lib/dailyTasks/engine";
import { cronAuthorized } from "@/lib/dailyTasks/cron";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!cronAuthorized(request.headers.get("authorization"), request.nextUrl.searchParams)) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  const result = await runSnapshotPhase();
  return NextResponse.json({
    ok: result.runs.every((run) => run.ok),
    ...result,
  });
}
