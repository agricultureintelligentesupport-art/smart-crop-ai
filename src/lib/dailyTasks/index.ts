/**
 * Daily AI task engine — public surface.
 *
 *   context.ts   the 23:55 context snapshot (weather + ET₀ + crop/stage/soil)
 *   ai.ts        the 00:00 AI generation (OpenAI → Gemini), JSON-normalized
 *   rules.ts     the never-fail local rule-based generator
 *   engine.ts    orchestration + RTDB publish (cron handlers)
 *   store.ts     LocalStorage cache + checked-state (per date)
 *   useDailyTasks  the hero checklist hook
 */

export * from "./types";
export * from "./growth";
export * from "./context";
export * from "./rules";
export * from "./ai";
export * from "./engine";
export * from "./store";
export { useDailyTasks, type DailyTasksInput, type DailyTasksView } from "./useDailyTasks";
