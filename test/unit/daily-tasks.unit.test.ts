/**
 * Unit tests for the Daily AI Task engine (run in plain Node):
 *
 *   npm run test:unit
 *
 * Pins the 23:55 → 00:00 workflow contracts:
 *   - the context snapshot aggregates (Open-Meteo 24 h) and the derived
 *     ET₀ / net irrigation m³ / watering window — the same `computeIrrigation`
 *     chain the hero card renders;
 *   - the rule-based fallback generator (3–5 tailored tasks, bilingual, the
 *     exact JSON shape the AI is asked for) — the "always have valid tasks"
 *     guarantee;
 *   - the AI response parsing/normalization (structured JSON → `DailyTask[]`,
 *     priority `medium` → `normal`, ids re-indexed, unusable output → null);
 *   - the LocalStorage stores indexed by `YYYY-MM-DD` (task sets + checked
 *     state) and their day rollover;
 *   - the API/cron handlers' never-500 + fallback behaviour.
 *
 * No network and no paid provider is ever contacted: fetch implementations
 * are injected/mocked and every provider env var is scrubbed.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { computeIrrigation, weatherFor } from "../../src/lib/agronomy";
import { DASHBOARD } from "../../src/lib/dashboard/copy";
import {
  buildDailyContext,
  collectDailyContext,
  contextForecastUrl,
  localDate,
  targetDate,
  weather24hFromOpenMeteo,
  weather24hFromSnapshot,
  OPTIMAL_WINDOW,
  type Weather24h,
} from "../../src/lib/dailyTasks/context";
import { cropGroupFor, growthStageFor } from "../../src/lib/dailyTasks/growth";
import { generateRuleTasks } from "../../src/lib/dailyTasks/rules";
import {
  buildTaskPrompt,
  extractTasksJson,
  generateAiTasks,
  normalizePriority,
  normalizeTasks,
  type FetchLike,
} from "../../src/lib/dailyTasks/ai";
import { contextKeyFor, taskText, type DailyTask, type DailyTaskSet } from "../../src/lib/dailyTasks/types";
import {
  generateDailyTaskSet,
  pinnedContexts,
  publishTaskSet,
  readPublishedTaskSet,
  readSnapshot,
  runGeneratePhase,
  runSnapshotPhase,
} from "../../src/lib/dailyTasks/engine";
import {
  pruneOldDays as storePrune,
  readDoneState as storeReadDone,
  readTaskSet as storeRead,
  toggleTaskDone as storeToggle,
  writeDoneState as storeWriteDone,
  writeTaskSet as storeWrite,
  type StorageLike,
} from "../../src/lib/dailyTasks/store";
import { CROPS } from "../../src/lib/wilayas";
import { cronAuthorized } from "../../src/lib/dailyTasks/cron";

/* ------------------------------------------------------------------ */
/*  env hygiene — no test may accidentally call a paid provider        */
/* ------------------------------------------------------------------ */

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
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(originalKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const throwingFetch: FetchLike = async () => {
  throw new Error("Unexpected upstream request");
};

/** In-memory Storage shim for the persistence tests. */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

/** A dry, mild 24-h day → the plain "pump in the window" irrigation task. */
const DRY_DAY: Weather24h = {
  date: "2026-09-25",
  tempMaxC: 30,
  tempMinC: 18,
  rainProbabilityPct: 15,
  humidityPct: 55,
  windKph: 12,
  live: true,
};

/** Minimal Open-Meteo-shaped payload covering one day (24 hourly slots). */
function openMeteoPayload(date: string): unknown {
  const times: string[] = [];
  const temp: number[] = [];
  const hum: number[] = [];
  const wind: number[] = [];
  const rain: (number | null)[] = [];
  for (let h = 0; h < 24; h += 1) {
    times.push(`${date}T${String(h).padStart(2, "0")}:00`);
    temp.push(20 + h * 0.5); // 20 … 31.5
    hum.push(50 + h); // 50 … 73 → mean 61.5 → 62
    wind.push(5 + h); // max 28
    rain.push(h === 13 ? 69 : 10); // max 69
  }
  return {
    timezone: "Africa/Algiers",
    current: { time: `${date}T12:00`, temperature_2m: 28.4, relative_humidity_2m: 60, wind_speed_10m: 14 },
    hourly: {
      time: times,
      temperature_2m: temp,
      relative_humidity_2m: hum,
      wind_speed_10m: wind,
      precipitation_probability: rain,
    },
    daily: {
      time: [date],
      temperature_2m_min: [18.4],
      temperature_2m_max: [33.2],
      precipitation_probability_max: [69],
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Growth stage calendar                                             */
/* ------------------------------------------------------------------ */

test("growthStageFor is deterministic and covers every crop/month", () => {
  for (const crop of Object.keys(CROPS) as Array<keyof typeof CROPS>) {
    for (let month = 0; month < 12; month += 1) {
      const a = growthStageFor(crop, month);
      const b = growthStageFor(crop, month);
      assert.deepEqual(a, b);
      assert.ok(a.ar.length > 0 && a.fr.length > 0);
    }
    assert.ok(cropGroupFor(crop).length > 0);
  }
});

test("durum wheat is in its tillering stage in January; date palm is Rutab in August", () => {
  assert.equal(growthStageFor("wheat", 0).ar, "مرحلة التشجير");
  assert.equal(growthStageFor("dates", 7).ar, "الرطب");
});

/* ------------------------------------------------------------------ */
/*  23:55 context snapshot                                            */
/* ------------------------------------------------------------------ */

test("targetDate lands both cron phases (23:55 and 00:00) on the same upcoming day", () => {
  // Africa/Algiers = UTC+1 all year.
  const at2355 = Date.UTC(2026, 8, 24, 22, 55); // 2026-09-24 23:55 Algiers
  const at0000 = Date.UTC(2026, 8, 24, 23, 0); //  2026-09-25 00:00 Algiers
  const midDay = Date.UTC(2026, 8, 24, 12, 0); //  2026-09-24 13:00 Algiers
  assert.equal(targetDate(at2355), "2026-09-25");
  assert.equal(targetDate(at0000), "2026-09-25");
  assert.equal(targetDate(midDay), "2026-09-24");
  assert.equal(localDate(at2355), "2026-09-24"); // "today" is still the 24th
});

test("contextForecastUrl targets Open-Meteo with the 24-h aggregates", () => {
  const url = contextForecastUrl(34.85, 5.73);
  assert.ok(url.startsWith("https://api.open-meteo.com/v1/forecast?"));
  assert.ok(url.includes("latitude=34.85"));
  assert.ok(url.includes("longitude=5.73"));
  assert.ok(url.includes("precipitation_probability"));
  assert.ok(url.includes("temperature_2m_min"));
});

test("weather24hFromOpenMeteo aggregates temp max/min, rain %, humidity and wind", () => {
  const date = "2026-09-25";
  const w = weather24hFromOpenMeteo(openMeteoPayload(date), date);
  assert.ok(w);
  assert.equal(w!.date, date);
  assert.equal(w!.tempMaxC, 33.2); // daily max wins
  assert.equal(w!.tempMinC, 18.4);
  assert.equal(w!.rainProbabilityPct, 69);
  assert.equal(w!.humidityPct, 62); // round of mean 61.5
  assert.equal(w!.windKph, 28);
  assert.equal(w!.live, true);
});

test("weather24hFromOpenMeteo rejects unusable payloads (no invented numbers)", () => {
  assert.equal(weather24hFromOpenMeteo(null, "2026-09-25"), null);
  assert.equal(weather24hFromOpenMeteo({}, "2026-09-25"), null);
  assert.equal(
    weather24hFromOpenMeteo({ hourly: { time: ["2026-09-25T00:00"], temperature_2m: [1] } }, "2026-09-25"),
    null,
  );
});

test("collectDailyContext wraps the fetch and degrades to reference values", async () => {
  const date = "2026-09-25";
  const live = await collectDailyContext(
    { wilayaCode: "07", crop: "wheat", soil: "clayey", areaHa: 2, date },
    {
      fetchImpl: async () => ({ ok: true, json: async () => openMeteoPayload(date) }),
      nowMs: Date.UTC(2026, 8, 24, 22, 55),
    },
  );
  assert.equal(live.weather.live, true);
  assert.equal(live.weather.humidityPct, 62);

  const offline = await collectDailyContext(
    { wilayaCode: "07", crop: "wheat", soil: "clayey", areaHa: 2, date },
    { fetchImpl: throwingFetch, nowMs: Date.UTC(2026, 8, 24, 22, 55) },
  );
  assert.equal(offline.weather.live, false);
  assert.equal(offline.date, date);
});

test("buildDailyContext quotes the hero card's exact chain (m³, window, stage, soil)", () => {
  const date = "2026-09-25";
  const ctx = buildDailyContext({
    wilayaCode: "07",
    crop: "wheat",
    soil: "clayey",
    areaHa: 2,
    system: "drip",
    date,
    weather24h: DRY_DAY,
    nowMs: Date.UTC(2026, 8, 24, 22, 55),
  });

  // Same computeIrrigation chain as the hero card (reference climate here).
  const irrigation = computeIrrigation({
    wilayaCode: "07",
    crop: "wheat",
    areaHa: 2,
    soil: "clayey",
    system: "drip",
    weather: weatherFor("07"),
  });
  assert.equal(ctx.netIrrigationM3, irrigation.dailyM3);
  assert.equal(ctx.litresPerHaDay, irrigation.litresPerHaDay);
  assert.equal(ctx.wateringWindow.from, OPTIMAL_WINDOW.from);
  assert.equal(ctx.wateringWindow.to, OPTIMAL_WINDOW.to);
  assert.deepEqual(ctx.wateringWindow, { from: "05:30", to: "08:30" });
  assert.equal(ctx.crop.ar, "القمح الصلب");
  assert.equal(ctx.growthStage.ar, growthStageFor("wheat", 8).ar); // September
  assert.equal(ctx.soil.ar, "طينية ثقيلة");
  assert.equal(ctx.wilaya.nameAr, "بسكرة");
  assert.equal(ctx.activeRule, "calm"); // dry + mild + calm wind

  const hot = buildDailyContext({
    wilayaCode: "07",
    crop: "wheat",
    date,
    weather24h: { ...DRY_DAY, tempMaxC: 34 },
  });
  assert.equal(hot.activeRule, "heat");
});

test("weather24hFromSnapshot is a deterministic reference fallback", () => {
  const snap = weatherFor("16");
  const w = weather24hFromSnapshot(snap, "2026-09-25");
  assert.equal(w.live, false);
  assert.equal(w.date, "2026-09-25");
  assert.ok(w.tempMaxC > w.tempMinC);
  assert.equal(w.humidityPct, snap.humidity);
});

/* ------------------------------------------------------------------ */
/*  Rule-based fallback generator                                     */
/* ------------------------------------------------------------------ */

test("rule generator always yields 3–5 valid, bilingual, spec-shaped tasks", () => {
  const ctx = buildDailyContext({
    wilayaCode: "07",
    crop: "wheat",
    soil: "clayey",
    areaHa: 2,
    date: "2026-09-25",
    weather24h: DRY_DAY,
  });
  const tasks = generateRuleTasks(ctx);
  assert.ok(tasks.length >= 3 && tasks.length <= 5, `got ${tasks.length}`);
  tasks.forEach((task, i) => {
    assert.equal(task.id, `t${i + 1}`);
    assert.ok(task.title.length > 0 && task.subtitle.length > 0);
    assert.ok(task.titleFr && task.subtitleFr);
    assert.ok(["irrigation", "protection", "fertilization"].includes(task.category));
    assert.ok(["high", "normal"].includes(task.priority));
  });
  // The irrigation task is first and quotes the card's exact window + m³ —
  // the spec sample phrasing.
  assert.equal(tasks[0].category, "irrigation");
  const expected = `ضخ ${ctx.netIrrigationM3.toFixed(1)}م³ خلال النافذة 05:30 - 08:30`;
  assert.equal(tasks[0].subtitle, expected);
  assert.equal(tasks[0].title, "تشغيل نظام السقي بالتنقيط");
});

test("humidity-driven fungal watch matches the spec sample for durum wheat", () => {
  const date = "2026-09-25";
  const weather24h = weather24hFromOpenMeteo(openMeteoPayload(date), date)!;
  assert.equal(weather24h.humidityPct, 62);
  const ctx = buildDailyContext({
    wilayaCode: "07",
    crop: "wheat",
    soil: "clayey",
    areaHa: 2,
    date,
    weather24h,
  });
  const tasks = generateRuleTasks(ctx);
  const fungal = tasks.find((t) => t.title.includes("الفطريات"));
  assert.ok(fungal, "expected a fungal-watch task");
  assert.equal(fungal!.title, "تفقد الفطريات بالجهة الشمالية");
  assert.equal(fungal!.subtitle, "ارتفاع الرطوبة (62%) يزيد مخاطر الصدأ الصفرائي");
  assert.equal(fungal!.category, "protection");
});

test("heavy rain probability turns the irrigation task into a postponement", () => {
  const ctx = buildDailyContext({
    wilayaCode: "16",
    crop: "tomato",
    areaHa: 1,
    date: "2026-09-25",
    weather24h: { ...DRY_DAY, rainProbabilityPct: 85 },
  });
  const tasks = generateRuleTasks(ctx);
  assert.ok(tasks[0].title.includes("تأجيل"));
  assert.ok(tasks[0].subtitle.includes("85%"));
});

/* ------------------------------------------------------------------ */
/*  AI output parsing + normalization                                */
/* ------------------------------------------------------------------ */

test("extractTasksJson tolerates fences, prose and {tasks:[…]} wrappers", () => {
  const sample = `[{"id":"t1","title":"تشغيل نظام السقي بالتنقيط","subtitle":"ضخ 76.0م³ خلال النافذة 05:30 - 08:30","category":"irrigation","priority":"high"}]`;
  assert.equal((extractTasksJson("```json\n" + sample + "\n```") as unknown[]).length, 1);
  assert.equal((extractTasksJson("أفضل خطة:\n" + sample + "\nشكراً") as unknown[]).length, 1);
  assert.equal((extractTasksJson('{"tasks": ' + sample + "}") as unknown[]).length, 1);
  assert.equal(extractTasksJson("لا يوجد شيء"), null);
  assert.equal(extractTasksJson(""), null);
});

test("normalizePriority maps the AI's medium/normal onto High / Normal", () => {
  assert.equal(normalizePriority("high"), "high");
  assert.equal(normalizePriority("عالية"), "high");
  assert.equal(normalizePriority("medium"), "normal");
  assert.equal(normalizePriority("normal"), "normal");
  assert.equal(normalizePriority("low"), "normal");
  assert.equal(normalizePriority(undefined), "normal");
});

test("normalizeTasks re-indexes ids, maps categories and rejects thin output", () => {
  const raw = [
    { id: "x", title: "مهمة أولى", subtitle: "تفاصيل", category: "irrigation", priority: "medium" },
    { id: "y", title: "مهمة ثانية", subtitle: "تفاصيل", category: "nutrition", priority: "high" },
    { id: "z", title: "مهمة ثالثة", subtitle: "تفاصيل", category: "غير معروفة", priority: "low", titleFr: "Trois" },
    { id: "w", title: "مهمة رابعة", subtitle: "تفاصيل", category: "maintenance", priority: "normal" },
    { id: "v", title: "مهمة خامسة", subtitle: "تفاصيل", category: "protection", priority: "normal" },
    { id: "u", title: "مهمة سادسة", subtitle: "تفاصيل", category: "protection", priority: "normal" },
  ];
  const tasks = normalizeTasks(raw)!;
  assert.equal(tasks.length, 5); // capped
  assert.deepEqual(tasks.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5"]);
  assert.equal(tasks[0].priority, "normal"); // medium → normal
  assert.equal(tasks[0].category, "irrigation");
  assert.equal(tasks[1].category, "fertilization"); // nutrition mapped
  assert.equal(tasks[2].category, "fertilization"); // unknown mapped
  assert.equal(tasks[2].titleFr, "Trois");
  assert.equal(tasks[1].priority, "high");

  assert.equal(normalizeTasks([{ title: "واحدة فقط" }, { title: "اثنتان" }]), null); // <3
  assert.equal(normalizeTasks("نص عشوائي"), null);
  assert.equal(normalizeTasks([{ subtitle: "بلا عنوان" }]), null);
});

test("buildTaskPrompt carries the full snapshot payload (weather, ET₀, m³, window)", () => {
  const ctx = buildDailyContext({
    wilayaCode: "07",
    crop: "wheat",
    soil: "clayey",
    areaHa: 2,
    date: "2026-09-25",
    weather24h: DRY_DAY,
  });
  const prompt = buildTaskPrompt(ctx);
  assert.ok(prompt.includes("2026-09-25"));
  assert.ok(prompt.includes("netIrrigationNeedM3"));
  assert.ok(prompt.includes("optimalWateringWindow"));
  assert.ok(prompt.includes("growthStage"));
  assert.ok(prompt.includes("بسكرة") && prompt.includes("القمح الصلب"));
});

/* ------------------------------------------------------------------ */
/*  AI provider chain (mocked fetch)                                  */
/* ------------------------------------------------------------------ */

const SPEC_SAMPLE_TASKS = [
  {
    id: "t1",
    title: "تشغيل نظام السقي بالتنقيط",
    subtitle: "ضخ 76.0م³ خلال النافذة 05:30 - 08:30",
    category: "irrigation",
    priority: "high",
    titleFr: "Lancer l'irrigation goutte à goutte",
    subtitleFr: "Purger 76,0 m³ pendant la fenêtre 05:30 – 08:30",
  },
  {
    id: "t2",
    title: "تفقد الفطريات بالجهة الشمالية",
    subtitle: "ارتفاع الرطوبة (69%) يزيد مخاطر الصدأ الصفرائي",
    category: "protection",
    priority: "medium",
    titleFr: "Inspecter les foyers fongiques (versant nord)",
    subtitleFr: "Humidité élevée (69 %) : risque accru de rouille jaune",
  },
  {
    id: "t3",
    title: "جرعة آزوتية مساندة",
    subtitle: "دفعة خفيفة لمرحلة التشجير",
    category: "fertilization",
    priority: "normal",
  },
];

test("generateAiTasks parses the spec's Gemini JSON sample end-to-end", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const fetchImpl: FetchLike = async (url) => {
    assert.ok(String(url).includes("generativelanguage.googleapis.com"));
    assert.ok(String(url).includes("key=test-key"));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(SPEC_SAMPLE_TASKS) }] } }],
      }),
    };
  };
  const ctx = buildDailyContext({
    wilayaCode: "07",
    crop: "wheat",
    soil: "clayey",
    areaHa: 2,
    date: "2026-09-25",
    weather24h: DRY_DAY,
  });
  const result = await generateAiTasks(ctx, fetchImpl);
  assert.ok(result);
  assert.equal(result!.provider, "gemini");
  assert.equal(result!.tasks.length, 3);
  assert.equal(result!.tasks[0].title, "تشغيل نظام السقي بالتنقيط");
  assert.equal(result!.tasks[0].subtitle, "ضخ 76.0م³ خلال النافذة 05:30 - 08:30");
  assert.equal(result!.tasks[1].priority, "normal"); // "medium" normalized
  assert.equal(result!.tasks[1].category, "protection");
});

test("generateAiTasks falls back to OpenAI when Gemini is down, and to null when both fail", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "openai-key";
  let calls = 0;
  const fetchImpl: FetchLike = async (url) => {
    calls += 1;
    if (String(url).includes("generativelanguage")) return { ok: false, status: 503, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ tasks: SPEC_SAMPLE_TASKS }) } }],
      }),
    };
  };
  const ctx = buildDailyContext({ wilayaCode: "07", crop: "wheat", date: "2026-09-25" });
  const result = await generateAiTasks(ctx, fetchImpl);
  assert.ok(result);
  assert.equal(result!.provider, "openai");
  assert.ok(calls >= 2); // gemini tried first, then openai

  // Every provider answers unusable text → null (caller must use the rules).
  const badFetch: FetchLike = async () => ({
    ok: true,
    json: async () => ({ candidates: [{ content: { parts: [{ text: "عذراً، لا أستطيع" }] } }] }),
  });
  delete process.env.OPENAI_API_KEY;
  const failed = await generateAiTasks(ctx, badFetch);
  assert.equal(failed, null);
});

/* ------------------------------------------------------------------ */
/*  LocalStorage stores (indexed by YYYY-MM-DD)                       */
/* ------------------------------------------------------------------ */

test("task sets and checked state persist per date and survive a re-read", () => {
  const storage = memoryStorage();
  const date = "2026-09-25";
  const contextKey = contextKeyFor({ wilayaCode: "07", crop: "wheat", soil: "clayey", areaHa: 2 });
  const tasks = generateRuleTasks(
    buildDailyContext({
      wilayaCode: "07",
      crop: "wheat",
      soil: "clayey",
      areaHa: 2,
      date,
      weather24h: DRY_DAY,
    }),
  );
  const set: DailyTaskSet = {
    date,
    contextKey,
    tasks,
    source: "rules",
    generatedAt: new Date().toISOString(),
    publishedAt: "00:00",
  };
  storeWrite(set, storage);
  const readBack = storeRead(date, contextKey, storage);
  assert.ok(readBack);
  assert.equal(readBack!.tasks.length, tasks.length);
  assert.equal(readBack!.date, date);

  // Checked state (refresh-proof): toggle t1 on → persisted; toggle off → {}.
  const done1 = storeToggle(date, contextKey, "t1", storage);
  assert.deepEqual(done1, { t1: true });
  assert.deepEqual(storeReadDone(date, contextKey, storage), { t1: true });
  const done2 = storeToggle(date, contextKey, "t1", storage);
  assert.deepEqual(done2, {});

  // Day rollover housekeeping: entries of other dates are pruned.
  storeWriteDone("2026-09-20", "old-key", { t1: true }, storage);
  storePrune(date, storage);
  assert.equal(storeRead("2026-09-20", "old-key", storage), null);
  assert.deepEqual(storeReadDone("2026-09-20", "old-key", storage), {});
  assert.ok(storeRead(date, contextKey, storage));
});

test("taskText serves the French twin with an Arabic fallback", () => {
  const task: DailyTask = {
    id: "t1",
    title: "تشغيل نظام السقي",
    subtitle: "ضخ 76.0م³",
    category: "irrigation",
    priority: "high",
    titleFr: "Lancer l'irrigation",
    subtitleFr: "Purger 76,0 m³",
  };
  assert.equal(taskText(task, "fr").title, "Lancer l'irrigation");
  assert.equal(taskText({ ...task, titleFr: undefined }, "fr").title, "تشغيل نظام السقي");
  assert.equal(taskText(task, "ar").subtitle, "ضخ 76.0م³");
});

test("context keys never contain RTDB-illegal characters", () => {
  const key = contextKeyFor({ wilayaCode: "07", crop: "wheat", soil: "clayey", areaHa: 2.5 });
  assert.equal(key, "07__wheat__clayey__2_5");
  assert.ok(!/[.#$/[\]]/.test(key));
});

/* ------------------------------------------------------------------ */
/*  Engine orchestration (never-fail)                                 */
/* ------------------------------------------------------------------ */

test("generateDailyTaskSet falls back to the rule engine when every AI stage is down", async () => {
  const { set, context, warnings } = await generateDailyTaskSet({
    wilayaCode: "07",
    crop: "wheat",
    soil: "clayey",
    areaHa: 2,
    date: "2026-09-25",
    fetchImpl: throwingFetch,
  });
  assert.equal(set.source, "rules");
  assert.ok(set.tasks.length >= 3 && set.tasks.length <= 5);
  assert.equal(set.date, "2026-09-25");
  assert.equal(set.publishedAt, "00:00");
  assert.equal(context.date, "2026-09-25");
  assert.ok(warnings.length >= 1);
  assert.ok(set.tasks.every((t) => Boolean(t.title) && Boolean(t.subtitle)));
});

test("generateDailyTaskSet ships AI tasks when the provider answers", async () => {
  process.env.GEMINI_API_KEY = "k";
  const fetchImpl: FetchLike = async (url) => {
    if (String(url).includes("generativelanguage")) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify(SPEC_SAMPLE_TASKS) }] } }],
        }),
      };
    }
    return throwingFetch(url);
  };
  const { set } = await generateDailyTaskSet({
    wilayaCode: "07",
    crop: "wheat",
    soil: "clayey",
    areaHa: 2,
    date: "2026-09-25",
    fetchImpl,
  });
  assert.equal(set.source, "ai");
  assert.equal(set.tasks.length, 3);
});

test("snapshot + generate phases share the stored context (23:55 → 00:00 handoff)", async () => {
  // Fixed clock: 2026-09-24 23:55 Algiers → both phases target 2026-09-25.
  const nowMs = Date.UTC(2026, 8, 24, 22, 55);
  const snap = await runSnapshotPhase(throwingFetch, nowMs);
  assert.equal(snap.phase, "snapshot");
  assert.equal(snap.date, "2026-09-25");
  assert.ok(snap.runs.length >= 1);
  assert.ok(snap.runs.every((r) => r.ok));

  const pinned = pinnedContexts()[0];
  const contextKey = contextKeyFor({
    wilayaCode: pinned.wilayaCode,
    crop: pinned.crop,
    soil: pinned.soil ?? "loamy",
    areaHa: pinned.areaHa ?? 2,
  });
  const stored = await readSnapshot("2026-09-25", contextKey);
  assert.ok(stored, "the 23:55 snapshot must be readable at 00:00");
  assert.equal(stored!.date, "2026-09-25");

  const gen = await runGeneratePhase(throwingFetch, nowMs);
  assert.equal(gen.phase, "generate");
  assert.equal(gen.date, "2026-09-25");
  assert.ok(gen.runs.every((r) => r.ok && (r.taskCount ?? 0) >= 3));
  assert.ok(gen.runs.every((r) => r.source === "rules")); // fetch throws → rules
});

test("publish/read round-trip without RTDB is a safe no-op", async () => {
  const set: DailyTaskSet = {
    date: "2026-09-25",
    contextKey: "07__wheat__clayey__2",
    tasks: generateRuleTasks(
      buildDailyContext({
        wilayaCode: "07",
        crop: "wheat",
        soil: "clayey",
        areaHa: 2,
        date: "2026-09-25",
        weather24h: DRY_DAY,
      }),
    ),
    source: "rules",
    generatedAt: new Date().toISOString(),
    publishedAt: "00:00",
  };
  assert.equal(await publishTaskSet(set, throwingFetch), true);
  assert.equal(await readPublishedTaskSet(set.date, set.contextKey, throwingFetch), null);
});

/* ------------------------------------------------------------------ */
/*  Copy pins (the spec's exact UI strings)                           */
/* ------------------------------------------------------------------ */

test("hero task tray copy matches the required Arabic strings", () => {
  const ar = DASHBOARD.ar.heroTasks;
  // Crisp header row: the sparkle title + the count (the long description was
  // removed with the card-in-card redesign).
  assert.equal(ar.title, "✨ مهام اليوم الذكية");
  assert.equal(ar.progress.replace("{done}", "0").replace("{total}", "5"), "0/5 منجزة");
  assert.equal(ar.updatedAi, "✨ تم تحديث المهام بواسطة الذكاء الاصطناعي - اليوم 00:00");
  assert.equal(ar.categories.irrigation, "💧 سقي");
  assert.equal(ar.categories.protection, "🛡️ وقاية");
  assert.equal(ar.categories.fertilization, "🚜 تسميد/صيانة");
  assert.equal(ar.priorities.high, "عالية");
  assert.equal(ar.priorities.normal, "عادية");
  assert.ok(ar.allDone.includes("اكتملت مهام اليوم 🎉"));
  // The static advice block and the old standalone tasks card copy are gone.
  assert.equal((DASHBOARD.ar as unknown as Record<string, unknown>).advice, undefined);
  assert.equal((DASHBOARD.fr as unknown as Record<string, unknown>).tasks, undefined);
});

test("collapsible tray handle resolves to the spec strings", () => {
  const ar = DASHBOARD.ar.heroTasks;
  const fr = DASHBOARD.fr.heroTasks;
  // Collapsed handle, `{count}` = hidden tasks: «عرض باقي المهام (3+)» + the ⚡
  // and animated ─→ ⌄ chevron the component appends.
  assert.equal(ar.showMore.replace("{count}", "3"), "عرض باقي المهام (3+)");
  // Expanded pill: «طي القائمة» + the same glyph rotated (▴).
  assert.equal(ar.collapse, "طي القائمة");
  assert.equal(fr.showMore.replace("{count}", "3"), "Afficher les autres tâches (3+)");
  assert.equal(fr.collapse, "Replier la liste");
  // Both languages expose the `{count}` slot the component fills in, and the
  // collapsed handle is the longer of the two (it carries the count).
  assert.ok(ar.showMore.includes("{count}") && fr.showMore.includes("{count}"));
  assert.ok(ar.collapse.length > 0 && fr.collapse.length > 0);
  // The redesign dropped the descriptive subtitle key entirely (no dead copy).
  assert.equal((ar as unknown as Record<string, unknown>).subtitle, undefined);
  assert.equal((fr as unknown as Record<string, unknown>).subtitle, undefined);
});

/* ------------------------------------------------------------------ */
/*  Cron auth                                                         */
/* ------------------------------------------------------------------ */

test("cronAuthorized enforces CRON_SECRET when configured", () => {
  assert.equal(cronAuthorized(null, new URLSearchParams()), true); // unset → open
  process.env.CRON_SECRET = "s3cret";
  assert.equal(cronAuthorized(null, new URLSearchParams()), false);
  assert.equal(cronAuthorized("Bearer s3cret", new URLSearchParams()), true);
  assert.equal(cronAuthorized(null, new URLSearchParams("token=s3cret")), true);
  assert.equal(cronAuthorized(null, new URLSearchParams("secret=wrong")), false);
});
