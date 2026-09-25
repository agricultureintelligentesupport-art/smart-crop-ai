/**
 * `/api/cron/daily-tasks` — phase 2 of the daily task workflow (00:00).
 *
 * Scheduled for 23:00 UTC = 00:00 Africa/Algiers the next day (see
 * `vercel.json`). For every pinned context it:
 *
 *   1. reads the 23:55 context snapshot (`/api/cron/daily-snapshot`) — or
 *      collects a fresh one when that run was missed, so the day is never
 *      left unpublished;
 *   2. sends the context payload to the LLM provider (OpenAI → Gemini) for
 *      3–5 tailored daily farming tasks as structured JSON — falling back to
 *      the local rule-based generator whenever the AI stage is offline;
 *   3. publishes the set indexed by date (`dailyTasks/{YYYY-MM-DD}/{contextKey}`
 *      in RTDB, alongside every client's LocalStorage cache).
 *
 * Auth: Vercel Cron's `Authorization: Bearer ${CRON_SECRET}` (or `?secret=`)
 * whenever `CRON_SECRET` is set. Never 500s — failures are reported per run.
 */

import { NextRequest, NextResponse } from "next/server";
import { runGeneratePhase } from "@/lib/dailyTasks/engine";
import { cronAuthorized } from "@/lib/dailyTasks/cron";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!cronAuthorized(request.headers.get("authorization"), request.nextUrl.searchParams)) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  const result = await runGeneratePhase();
  return NextResponse.json({
    ok: result.runs.every((run) => run.ok),
    ...result,
  });
}
