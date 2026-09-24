/**
 * Client-side persistence for the daily AI task checklist.
 *
 * Both stores are indexed by date (`YYYY-MM-DD`, Africa/Algiers) exactly as
 * the workflow spec asks:
 *
 *   `smart-crop.daily-tasks.v1.{date}.{contextKey}`       → the generated set
 *   `smart-crop.daily-tasks.done.v1.{date}.{contextKey}`  → checked state
 *
 * The done-state survives refreshes and resets naturally with the date (a new
 * day = a new key = a fresh checklist). Mirrors `weather/live.ts`: in-memory
 * + localStorage, `useSyncExternalStore`-friendly subscriptions, SSR-safe,
 * never throws. A `Storage` implementation is injectable so the whole layer
 * is unit-testable in plain Node.
 */

import type { DailyTaskSet } from "./types";

const SET_PREFIX = "smart-crop.daily-tasks.v1.";
const DONE_PREFIX = "smart-crop.daily-tasks.done.v1.";
const DONE_EVENT = "smart-crop:daily-tasks-done";

/** Minimal structural storage contract (browser localStorage in production). */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const memSets = new Map<string, DailyTaskSet>();
const memDone = new Map<string, Record<string, boolean>>();
const listeners = new Set<() => void>();

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** Subscribes to cache/done updates (used by useSyncExternalStore). */
export function subscribeToTaskStore(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function setKeyFor(date: string, contextKey: string): string {
  return `${SET_PREFIX}${date}.${contextKey}`;
}

export function doneKeyFor(date: string, contextKey: string): string {
  return `${DONE_PREFIX}${date}.${contextKey}`;
}

/* ------------------------------------------------------------------ */
/*  Generated task sets                                               */
/* ------------------------------------------------------------------ */

export function readTaskSet(
  date: string,
  contextKey: string,
  storage: StorageLike | null = defaultStorage(),
): DailyTaskSet | null {
  const key = setKeyFor(date, contextKey);
  const mem = memSets.get(key);
  if (mem) return mem;
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DailyTaskSet;
    const ok = parsed && typeof parsed.date === "string" && Array.isArray(parsed.tasks) && parsed.tasks.length > 0;
    if (!ok) return null;
    memSets.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function writeTaskSet(set: DailyTaskSet, storage: StorageLike | null = defaultStorage()): void {
  const key = setKeyFor(set.date, set.contextKey);
  memSets.set(key, set);
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify(set));
    } catch {
      /* storage full/blocked — the in-memory entry still serves this session */
    }
  }
  pruneOldDays(set.date, storage);
  notify();
}

/* ------------------------------------------------------------------ */
/*  Checked (completed) state                                         */
/* ------------------------------------------------------------------ */

export function readDoneState(
  date: string,
  contextKey: string,
  storage: StorageLike | null = defaultStorage(),
): Record<string, boolean> {
  const key = doneKeyFor(date, contextKey);
  const mem = memDone.get(key);
  if (mem) return mem;
  let clean: Record<string, boolean> = {};
  if (storage) {
    try {
      const raw = storage.getItem(key);
      const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      for (const [id, value] of Object.entries(parsed ?? {})) {
        if (value === true) clean[id] = true;
      }
    } catch {
      clean = {};
    }
  }
  // ALWAYS cache the parsed map (even empty) — useSyncExternalStore requires a
  // stable snapshot reference between notifications.
  memDone.set(key, clean);
  return clean;
}

export function writeDoneState(
  date: string,
  contextKey: string,
  done: Record<string, boolean>,
  storage: StorageLike | null = defaultStorage(),
): void {
  const key = doneKeyFor(date, contextKey);
  memDone.set(key, done);
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify(done));
    } catch {
      /* ignore */
    }
  }
  notify();
}

/**
 * Marks one task done/undone. Returns the next map (also persisted) so the
 * caller can render without waiting for a re-read.
 */
export function toggleTaskDone(
  date: string,
  contextKey: string,
  taskId: string,
  storage: StorageLike | null = defaultStorage(),
): Record<string, boolean> {
  const current = readDoneState(date, contextKey, storage);
  const next = { ...current };
  if (next[taskId]) delete next[taskId];
  else next[taskId] = true;
  writeDoneState(date, contextKey, next, storage);
  return next;
}

/** Broadcasts a done-state change to other hook instances on the page. */
export function announceDoneChange(): void {
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(DONE_EVENT));
    } catch {
      /* ignore */
    }
  }
  notify();
}

/* ------------------------------------------------------------------ */
/*  Housekeeping                                                      */
/* ------------------------------------------------------------------ */

/** Drops cached sets/done maps from days other than `today` (keys are dated). */
export function pruneOldDays(today: string, storage: StorageLike | null = defaultStorage()): void {
  for (const key of [...memSets.keys()]) {
    if (!key.includes(`.${today}.`)) memSets.delete(key);
  }
  for (const key of [...memDone.keys()]) {
    if (!key.includes(`.${today}.`)) memDone.delete(key);
  }
  if (!storage) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key ? storage.key(i) : null;
      if (
        key &&
        (key.startsWith(SET_PREFIX) || key.startsWith(DONE_PREFIX)) &&
        !key.includes(`.${today}.`)
      ) {
        doomed.push(key);
      }
    }
    doomed.forEach((key) => storage.removeItem(key));
  } catch {
    /* ignore */
  }
}
