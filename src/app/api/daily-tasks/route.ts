/**
 * `/api/daily-tasks` — on-demand generation + published-day lookup for the
 * hero checklist (the client counterpart of the 00:00 cron publish).
 *
 *   POST `{ wilayaCode, crop, soil, areaHa, system, date? }`
 *        → collects the full context snapshot (Open-Meteo 24 h forecast →
 *          ET₀ + net irrigation m³ + watering window + crop/stage/soil/wilaya)
 *        → AI generation (OpenAI → Gemini) with the rule-based fallback,
 *        → publishes the set under `dailyTasks/{YYYY-MM-DD}/{contextKey}`
 *        → returns `{ date, context, tasks, source, generatedAt, warnings }`.
 *
 *   GET `?date=YYYY-MM-DD&wilayaCode=07&crop=wheat&soil=clayey&area=2&system=drip`
 *        → the published set for that day + context (RTDB). On a cache miss it
 *          lazily runs the same generation pipeline (so the checklist is
 *          never empty), and `202` when nothing valid could be produced.
 *
 * Like the assistant route: no HTTP 500s — every internal failure degrades to
 * the local rule engine and answers 200 with `source: "rules"`.
 */

import { NextRequest, NextResponse } from "next/server";
import type { IrrigationSystem } from "@/lib/agronomy";
import { CROPS, SOILS, getWilaya, type CropKey, type SoilKey } from "@/lib/wilayas";
import { buildDailyContext, targetDate, type DailyContext } from "@/lib/dailyTasks/context";
import { generateDailyTaskSet, publishTaskSet, readPublishedTaskSet } from "@/lib/dailyTasks/engine";
import { contextKeyFor, type DailyTask } from "@/lib/dailyTasks/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEMS: IrrigationSystem[] = ["drip", "sprinkler", "furrow"];

interface RequestContext {
  wilayaCode: string;
  crop: CropKey;
  soil: SoilKey;
  areaHa: number;
  system: IrrigationSystem;
  date: string;
}

/** Validates the loosely-typed wire payload into a real context request. */
function parseRequest(raw: Record<string, unknown>, dateFallback: string): RequestContext | null {
  const crop = String(raw.crop ?? "") as CropKey;
  if (!crop || !(crop in CROPS)) return null;
  const soilRaw = String(raw.soil ?? "");
  const wilaya = getWilaya(raw.wilayaCode == null ? null : String(raw.wilayaCode));
  const soil = (soilRaw in SOILS ? soilRaw : wilaya.soil) as SoilKey;
  const area = Number(raw.areaHa ?? raw.area);
  const areaHa = Number.isFinite(area) && area > 0 && area <= 10_000 ? area : 2;
  const system = SYSTEMS.includes(raw.system as IrrigationSystem)
    ? (raw.system as IrrigationSystem)
    : "drip";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? "")) ? String(raw.date) : dateFallback;
  return { wilayaCode: wilaya.code, crop, soil, areaHa, system, date };
}

/** The response `context` block — the exact numbers the tasks were built on. */
function contextSummary(ctx: DailyContext) {
  return {
    date: ctx.date,
    wilaya: ctx.wilaya,
    crop: ctx.crop,
    growthStage: ctx.growthStage,
    soil: ctx.soil,
    areaHa: ctx.areaHa,
    system: ctx.system,
    weather: ctx.weather,
    et0MmDay: ctx.et0MmDay,
    netMmDay: ctx.netMmDay,
    netIrrigationM3: ctx.netIrrigationM3,
    litresPerHaDay: ctx.litresPerHaDay,
    weeklyM3: ctx.irrigation.weeklyM3,
    wateringWindow: ctx.wateringWindow,
    activeRule: ctx.activeRule,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    let raw: Record<string, unknown> = {};
    try {
      raw = (await request.json()) as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const parsed = parseRequest(raw, targetDate());
    if (!parsed) {
      return NextResponse.json({ error: "Invalid context: crop is required." }, { status: 400 });
    }

    const { set, context: used, warnings } = await generateDailyTaskSet({
      wilayaCode: parsed.wilayaCode,
      crop: parsed.crop,
      soil: parsed.soil,
      areaHa: parsed.areaHa,
      system: parsed.system,
      date: parsed.date,
    });
    await publishTaskSet(set);

    return NextResponse.json({
      date: set.date,
      contextKey: set.contextKey,
      source: set.source,
      generatedAt: set.generatedAt,
      publishedAt: set.publishedAt,
      tasks: set.tasks as DailyTask[],
      context: contextSummary(used),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    // Final safety net: rule-based tasks for the default context, still 200.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[daily-tasks POST] unexpected error → rule fallback: ${detail}`);
    const ctx = buildDailyContext({
      wilayaCode: null,
      crop: "wheat",
      date: targetDate(),
    });
    const { set } = await generateDailyTaskSet({ context: ctx, crop: "wheat", wilayaCode: null });
    return NextResponse.json({
      date: set.date,
      contextKey: set.contextKey,
      source: set.source,
      generatedAt: set.generatedAt,
      publishedAt: set.publishedAt,
      tasks: set.tasks,
      context: contextSummary(ctx),
      warnings: [`Internal error — rule engine used: ${detail}`.slice(0, 300)],
    });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const q = request.nextUrl.searchParams;
    const parsed = parseRequest(
      {
        wilayaCode: q.get("wilayaCode") ?? q.get("wilaya"),
        crop: q.get("crop"),
        soil: q.get("soil"),
        areaHa: q.get("area"),
        system: q.get("system"),
        date: q.get("date"),
      },
      targetDate(),
    );
    if (!parsed) {
      return NextResponse.json({ error: "Invalid context: crop is required." }, { status: 400 });
    }

    const contextKey = contextKeyFor(parsed);
    const published = await readPublishedTaskSet(parsed.date, contextKey);
    if (published) {
      return NextResponse.json({
        date: published.date,
        contextKey,
        source: published.source,
        generatedAt: published.generatedAt,
        publishedAt: published.publishedAt,
        tasks: published.tasks,
      });
    }

    // Cache miss → lazily run the same pipeline (and publish for next time).
    const { set, warnings } = await generateDailyTaskSet({
      wilayaCode: parsed.wilayaCode,
      crop: parsed.crop,
      soil: parsed.soil,
      areaHa: parsed.areaHa,
      system: parsed.system,
      date: parsed.date,
    });
    await publishTaskSet(set);
    return NextResponse.json({
      date: set.date,
      contextKey,
      source: set.source,
      generatedAt: set.generatedAt,
      publishedAt: set.publishedAt,
      tasks: set.tasks,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[daily-tasks GET] unexpected error → rule fallback: ${detail}`);
    const ctx = buildDailyContext({ wilayaCode: null, crop: "wheat", date: targetDate() });
    const { set } = await generateDailyTaskSet({ context: ctx, crop: "wheat", wilayaCode: null });
    return NextResponse.json({
      date: set.date,
      contextKey: set.contextKey,
      source: set.source,
      generatedAt: set.generatedAt,
      publishedAt: set.publishedAt,
      tasks: set.tasks,
    });
  }
}
