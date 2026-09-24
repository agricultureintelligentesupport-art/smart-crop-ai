"use client";

/**
 * `useDailyTasks` — the hero checklist's data layer.
 *
 * Resolution order for today's set (`YYYY-MM-DD`, Africa/Algiers):
 *
 *   LocalStorage cache (today)  → shown immediately
 *   `/api/daily-tasks` (POST)   → AI generation on the server (rule engine
 *                                fallback there), then cached locally
 *   offline / route down        → local rule-based generator (client-side),
 *                                so the checklist ALWAYS has 3–5 valid tasks
 *
 * Checked state lives in `store.ts` (per date + context) — refresh-proof,
 * resets with the day. SSR-safe like `useLiveWeather`: the server render uses
 * the deterministic rule-generated set (no fetch, no keys in the bundle) and
 * hydration swaps in the cached/remote set through the store subscription.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { buildDailyContext, type DailyContext } from "./context";
import { generateRuleTasks } from "./rules";
import {
  announceDoneChange,
  readDoneState,
  readTaskSet,
  subscribeToTaskStore,
  toggleTaskDone,
  writeTaskSet,
} from "./store";
import {
  contextKeyFor,
  taskText,
  type DailyTask,
  type DailyTaskSet,
  type DailyTaskSource,
} from "./types";
import type { IrrigationSystem, WeatherSnapshot } from "../agronomy";
import type { CropKey, Lang, SoilKey } from "../wilayas";

export interface DailyTasksInput {
  wilayaCode: string;
  crop: CropKey;
  soil: SoilKey;
  areaHa: number;
  system?: IrrigationSystem;
  lang: Lang;
  /** Live/reference snapshot shared by the dashboard — feeds the context. */
  weather?: WeatherSnapshot;
}

export interface DailyTasksView {
  /** Today's date key (`YYYY-MM-DD`). */
  date: string;
  /** Tasks ready for display (title/subtitle already in the active language). */
  tasks: Array<DailyTask & { title: string; subtitle: string }>;
  done: Record<string, boolean>;
  toggle: (taskId: string) => void;
  doneCount: number;
  total: number;
  allDone: boolean;
  /** Where the set came from — `loading` until the first resolution settles. */
  source: DailyTaskSource;
  /** True once a set is on screen (cached, fetched or fallback). */
  ready: boolean;
}

/** POST `/api/daily-tasks` — resolves to a task set or null (never throws). */
async function requestServerSet(input: DailyContext): Promise<DailyTaskSet | null> {
  try {
    const res = await fetch("/api/daily-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wilayaCode: input.wilaya.code,
        crop: input.crop.key,
        soil: input.soil.key,
        areaHa: input.areaHa,
        system: input.system,
        date: input.date,
      }),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { tasks?: DailyTask[]; date?: string; source?: DailyTaskSource };
    if (!payload || !Array.isArray(payload.tasks) || payload.tasks.length === 0) return null;
    return {
      date: payload.date ?? input.date,
      contextKey: contextKeyFor({
        wilayaCode: input.wilaya.code,
        crop: input.crop.key,
        soil: input.soil.key,
        areaHa: input.areaHa,
      }),
      tasks: payload.tasks,
      source: payload.source === "ai" ? "ai" : "rules",
      generatedAt: new Date().toISOString(),
      publishedAt: "00:00",
    };
  } catch {
    return null;
  }
}

export function useDailyTasks(input: DailyTasksInput): DailyTasksView {
  const { wilayaCode, crop, soil, areaHa, lang, weather } = input;
  const system: IrrigationSystem = input.system ?? "drip";

  // The deterministic context (pure) — identical on server and client.
  const context = useMemo<DailyContext>(
    () =>
      buildDailyContext({
        wilayaCode,
        crop,
        soil,
        areaHa,
        system,
        ...(weather ? { snapshot: weather } : {}),
      }),
    [wilayaCode, crop, soil, areaHa, system, weather],
  );
  const date = context.date;
  const contextKey = contextKeyFor({ wilayaCode: context.wilaya.code, crop, soil, areaHa });

  const subscribe = useCallback((onChange: () => void) => subscribeToTaskStore(onChange), []);
  // SSR + hydration render the local rule set; the store subscription swaps in
  // the cached/remote AI set without any setState-in-effect flicker.
  const cached = useSyncExternalStore(
    subscribe,
    () => readTaskSet(date, contextKey),
    () => null,
  );
  const done = useSyncExternalStore(
    subscribe,
    () => readDoneState(date, contextKey),
    () => ({} as Record<string, boolean>),
  );

  // Local fallback set — the "always have valid tasks" guarantee.
  const fallbackSet = useMemo<DailyTaskSet>(() => {
    const rules = generateRuleTasks(context);
    return {
      date,
      contextKey,
      tasks: rules,
      source: "rules",
      generatedAt: context.createdAt,
      publishedAt: "00:00",
    };
  }, [context, date, contextKey]);

  // Resolve today's set once per date+context: cache → server → local rules.
  // A ref dedupes the resolution (no setState-in-effect); results land in the
  // external store and reach the component through its subscription.
  const requestedRef = useRef<string | null>(null);
  useEffect(() => {
    const stamp = `${date}|${contextKey}`;
    if (requestedRef.current === stamp) return;
    requestedRef.current = stamp;
    if (readTaskSet(date, contextKey)) return;
    void (async () => {
      const remote = await requestServerSet(context);
      // Another resolution may have landed while we awaited — never overwrite
      // a fresher cached set.
      if (!readTaskSet(date, contextKey)) {
        writeTaskSet(remote ?? fallbackSet);
      }
    })();
  }, [date, contextKey, context, fallbackSet]);

  const set = cached ?? fallbackSet;

  const toggle = useCallback(
    (taskId: string) => {
      toggleTaskDone(date, contextKey, taskId);
      announceDoneChange();
    },
    [date, contextKey],
  );

  const tasks = useMemo(
    () =>
      set.tasks.map((task) => {
        const text = taskText(task, lang);
        return { ...task, title: text.title, subtitle: text.subtitle };
      }),
    [set.tasks, lang],
  );

  const doneCount = tasks.filter((task) => done[task.id]).length;

  return {
    date,
    tasks,
    done,
    toggle,
    doneCount,
    total: tasks.length,
    allDone: tasks.length > 0 && doneCount === tasks.length,
    source: set.source,
    ready: true,
  };
}
