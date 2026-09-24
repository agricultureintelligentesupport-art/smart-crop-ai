/**
 * Unit tests for the daily-task API + cron route handlers (run in plain Node):
 *
 *   npm run test:unit
 *
 * Pins the handler contracts around the AI task engine:
 *   - `POST /api/daily-tasks` NEVER returns 500 — every failure degrades to
 *     the rule engine with `source: "rules"` and a valid 3–5 task set;
 *   - the response carries the context block the tasks were built on
 *     (ET₀, net irrigation m³, watering window, growth stage, soil, wilaya);
 *   - `GET /api/cron/daily-snapshot` / `GET /api/cron/daily-tasks` enforce
 *     `CRON_SECRET` when configured and report per-run results.
 *
 * Provider env vars are scrubbed and fetch is mocked to throw — no network.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server";

import { POST as dailyTasksPost, GET as dailyTasksGet } from "../../src/app/api/daily-tasks/route";
import { GET as snapshotCronGet } from "../../src/app/api/cron/daily-snapshot/route";
import { GET as generateCronGet } from "../../src/app/api/cron/daily-tasks/route";

const SCRUBBED_ENV_PATTERN =
  /^(GEMINI_API_KEY|GEMINI_MODEL|OPENAI_API_KEY|OPENAI_MODEL|HUGGINGFACE_API_KEY|HF_TOKEN|CRON_SECRET|FIREBASE_DATABASE_URL|FIREBASE_DATABASE_AUTH|NEXT_PUBLIC_FIREBASE_DATABASE_URL|DAILY_TASK_CONTEXTS)/;

const originalKeys: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (SCRUBBED_ENV_PATTERN.test(name)) originalKeys[name] = value;
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (SCRUBBED_ENV_PATTERN.test(name)) delete process.env[name];
  }
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(originalKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/daily-tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface TaskJson {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  priority: string;
}

interface DailyTasksBody {
  date: string;
  source: string;
  publishedAt: string;
  tasks: TaskJson[];
  context: Record<string, unknown>;
  warnings?: string[];
}

test("POST /api/daily-tasks answers 200 with rule tasks when every AI stage is down", async () => {
  const res = await dailyTasksPost(
    postRequest({ wilayaCode: "07", crop: "wheat", soil: "clayey", areaHa: 2, system: "drip" }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as DailyTasksBody;
  assert.equal(body.source, "rules");
  assert.equal(body.publishedAt, "00:00");
  assert.ok(body.tasks.length >= 3 && body.tasks.length <= 5);
  assert.ok(body.tasks.every((t) => t.id && t.title && t.subtitle));
  assert.ok(body.tasks.every((t) => ["high", "normal"].includes(t.priority)));

  // The context block quotes the same numbers the tasks were built on.
  const ctx = body.context;
  assert.deepEqual(ctx.wateringWindow, { from: "05:30", to: "08:30" });
  assert.equal((ctx.crop as { ar: string }).ar, "القمح الصلب");
  assert.equal((ctx.wilaya as { nameAr: string }).nameAr, "بسكرة");
  assert.ok(typeof ctx.netIrrigationM3 === "number");
  assert.ok(typeof ctx.et0MmDay === "number");
  assert.ok(typeof ctx.growthStage === "object");
  assert.ok(typeof ctx.soil === "object");
  assert.ok((body.warnings ?? []).length >= 1);
});

test("POST /api/daily-tasks rejects a payload without a valid crop", async () => {
  const res = await dailyTasksPost(postRequest({ wilayaCode: "07", areaHa: 2 }));
  assert.equal(res.status, 400);
});

test("POST /api/daily-tasks survives an empty / malformed body (never 500)", async () => {
  const req = new NextRequest("http://localhost/api/daily-tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not json{{",
  });
  const res = await dailyTasksPost(req);
  assert.equal(res.status, 400); // graceful bad-request, not a crash
});

test("GET /api/daily-tasks lazily generates and returns a valid set", async () => {
  const res = await dailyTasksGet(
    new NextRequest(
      "http://localhost/api/daily-tasks?date=2026-09-25&wilayaCode=07&crop=wheat&soil=clayey&area=2&system=drip",
    ),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as DailyTasksBody;
  assert.equal(body.date, "2026-09-25");
  assert.ok(body.tasks.length >= 3 && body.tasks.length <= 5);
});

test("cron endpoints enforce CRON_SECRET and run both workflow phases", async () => {
  process.env.CRON_SECRET = "s3cret";
  const unauthorized = await snapshotCronGet(new NextRequest("http://localhost/api/cron/daily-snapshot"));
  assert.equal(unauthorized.status, 401);
  const unauthorized2 = await generateCronGet(new NextRequest("http://localhost/api/cron/daily-tasks"));
  assert.equal(unauthorized2.status, 401);

  // Phase 1 — 23:55 context snapshot.
  const snapRes = await snapshotCronGet(
    new NextRequest("http://localhost/api/cron/daily-snapshot", {
      headers: { Authorization: "Bearer s3cret" },
    }),
  );
  assert.equal(snapRes.status, 200);
  const snapBody = (await snapRes.json()) as { ok: boolean; phase: string; date: string; runs: Array<{ ok: boolean }> };
  assert.equal(snapBody.phase, "snapshot");
  assert.ok(snapBody.ok);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(snapBody.date));
  assert.ok(snapBody.runs.every((r) => r.ok));

  // Phase 2 — 00:00 AI generation + publish (rules fallback with fetch down).
  const genRes = await generateCronGet(
    new NextRequest("http://localhost/api/cron/daily-tasks?token=s3cret"),
  );
  assert.equal(genRes.status, 200);
  const genBody = (await genRes.json()) as {
    ok: boolean;
    phase: string;
    date: string;
    runs: Array<{ ok: boolean; source?: string; taskCount?: number }>;
  };
  assert.equal(genBody.phase, "generate");
  assert.ok(genBody.ok);
  assert.equal(genBody.date, snapBody.date);
  assert.ok(genBody.runs.every((r) => r.source === "rules" && (r.taskCount ?? 0) >= 3));
});
