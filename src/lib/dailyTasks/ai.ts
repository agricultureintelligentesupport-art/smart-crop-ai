/**
 * AI task generation — the 00:00 stage of the daily workflow.
 *
 * Sends the full `DailyContext` snapshot to an LLM and asks for 3–5 tailored
 * daily farming tasks as a JSON array (`id`, `title`, `subtitle`, `category`,
 * `priority`, `titleFr`, `subtitleFr`). Provider chain mirrors the assistant
 * route's resilience philosophy, minus the vision stages:
 *
 *   Stage 1 — OpenAI-compatible chat endpoint (`OPENAI_API_KEY`,
 *             `OPENAI_MODEL`, default `gpt-4o-mini`) with JSON mode.
 *   Stage 2 — Google Gemini (`GEMINI_MODEL`, default `gemini-3.6`, then
 *             `gemini-2.5-flash` → `gemini-2.0-flash` on a retired-id 404),
 *             keyed with the full `GEMINI_API_KEY*` pool (rotated on quota) —
 *             the SECONDARY FALLBACK: it only runs when the primary OpenAI
 *             stage is unconfigured or could not answer.
 *
 * Every response is parsed defensively (`extractTasksJson` +
 * `normalizeTasks`) — malformed or too-thin output returns `null` and the
 * caller falls back to the rule engine. Nothing here throws.
 */

import type { DailyContext } from "./context";
import type { DailyTask, TaskCategory, TaskPriority } from "./types";

/** Providers that can produce the daily set. */
export type AiProvider = "gemini" | "openai";

export interface AiGeneration {
  tasks: DailyTask[];
  provider: AiProvider;
  model: string;
}

/** Minimal fetch contract (same spirit as weather/live.ts). */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; body?: string; method?: string },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown>; text?(): Promise<string> }>;

export const AI_TIMEOUT_MS = 15_000;

/**
 * Model chain for Gemini — a retired primary 404s onto its successor.
 * Ordered from the newest generation to the oldest.
 */
export function resolveGeminiModels(): string[] {
  const override = (process.env.GEMINI_MODEL ?? "").trim();
  const chain = ["gemini-3.6", "gemini-2.5-flash", "gemini-2.0-flash"];
  return override ? [override, ...chain.filter((m) => m !== override)] : chain;
}

/**
 * Every `GEMINI_API_KEY*` variable participates (`GEMINI_API_KEY`,
 * `GEMINI_API_KEYS` comma pool, `GEMINI_API_KEY_N` variants) — trimmed,
 * deduplicated, rotation-ordered. Read per call so key changes need no
 * restart.
 */
export function resolveGeminiApiKeys(): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const [name, raw] of Object.entries(process.env)) {
    if (!name.startsWith("GEMINI_API_KEY") || typeof raw !== "string") continue;
    for (const part of raw.split(",")) {
      const key = part.trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

export function resolveOpenAi(): { key: string; model: string } | null {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return null;
  return { key, model: (process.env.OPENAI_MODEL ?? "").trim() || "gpt-4o-mini" };
}

/* ------------------------------------------------------------------ */
/*  Prompt                                                            */
/* ------------------------------------------------------------------ */

export const TASK_SYSTEM_PROMPT = [
  "أنت مهندس زراعي خبير تخطّط يوم عمل فلاح جزائري في لوحة «محصولي الذكي».",
  "اكتب 3 إلى 5 مهام ميدانية تنفيذية لليوم المستهدف، مبنية حصراً على سياق الطقس والمحصول والتربة المرسل.",
  "العبارات بالعربية الفصحى الزراعية: مهنية، دقيقة، مختصرة؛ الأرقام في سطر التفاصيل (subtitle) كما وردت في السياق (م³، النوافذ، النسب، الدرجات).",
  "أضف ترجمة فرنسية للمهمة في titleFr وsubtitleFr.",
  "التصنيف category من: irrigation, protection, fertilization.",
  "الأولوية priority من: high, normal.",
  "أعد JSON مصفوفة فقط، بلا شرح ولا تنسيق Markdown، بالشكل:",
  '[{"id":"t1","title":"…","subtitle":"…","category":"irrigation","priority":"high","titleFr":"…","subtitleFr":"…"}]',
].join("\n");

/** The full context payload the LLM reasons over. */
export function buildTaskPrompt(ctx: DailyContext): string {
  return JSON.stringify(
    {
      targetDate: ctx.date,
      wilaya: ctx.wilaya,
      crop: ctx.crop,
      growthStage: ctx.growthStage,
      soil: ctx.soil,
      areaHa: ctx.areaHa,
      irrigationSystem: ctx.system,
      weather24h: ctx.weather,
      et0MmDay: ctx.et0MmDay,
      netIrrigationNeedM3: ctx.netIrrigationM3,
      netWaterNeedMmDay: ctx.netMmDay,
      optimalWateringWindow: ctx.wateringWindow,
      activeWeatherRule: ctx.activeRule,
    },
    null,
    0,
  );
}

/* ------------------------------------------------------------------ */
/*  Parsing + normalization                                           */
/* ------------------------------------------------------------------ */

/**
 * Pulls the JSON array (or `{ "tasks": [...] }` object) out of an LLM reply —
 * tolerates code fences, leading prose and trailing commentary.
 */
export function extractTasksJson(text: string): unknown {
  if (typeof text !== "string" || !text.trim()) return null;
  let cleaned = text.trim();
  // ```json … ``` fences.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fence) cleaned = fence[1].trim();

  // Normalizes a parsed value to the tasks array (or null when unusable).
  const unwrap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray((value as { tasks?: unknown }).tasks)) {
      return (value as { tasks: unknown[] }).tasks;
    }
    return null;
  };

  const tryParse = (s: string): unknown => {
    try {
      return unwrap(JSON.parse(s));
    } catch {
      return null;
    }
  };

  const direct = tryParse(cleaned);
  if (direct !== null) return direct;

  // First bracketed array…last closing bracket (inclusive).
  const a = cleaned.indexOf("[");
  const b = cleaned.lastIndexOf("]");
  if (a >= 0 && b > a) {
    const parsed = tryParse(cleaned.slice(a, b + 1));
    if (parsed !== null) return parsed;
  }
  // Object with a `tasks` field.
  const o = cleaned.indexOf("{");
  const c = cleaned.lastIndexOf("}");
  if (o >= 0 && c > o) {
    const parsed = tryParse(cleaned.slice(o, c + 1));
    if (parsed !== null) return parsed;
  }
  return null;
}

const CATEGORIES: Record<string, TaskCategory> = {
  irrigation: "irrigation",
  سقي: "irrigation",
  protection: "protection",
  وقاية: "protection",
  fertilization: "fertilization",
  fertilisation: "fertilization",
  nutrition: "fertilization",
  maintenance: "fertilization",
  operations: "fertilization",
  "تسميد": "fertilization",
  "صيانة": "fertilization",
};

/** `high` / `عالية` → high; `medium` / `normal` / `عادية` / anything else → normal. */
export function normalizePriority(raw: unknown): TaskPriority {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "high" || v === "عالية" || v === "haute" ? "high" : "normal";
}

function str(raw: unknown, max = 160): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Validates and canonicalizes raw AI output into 3–5 `DailyTask`s with
 * `t1…tN` ids. Returns `null` when the output is unusable (fewer than 3 real
 * tasks or no titles) — the caller then uses the rule engine.
 */
export function normalizeTasks(raw: unknown): DailyTask[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DailyTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const title = str(t.title ?? t.name);
    const subtitle = str(t.subtitle ?? t.detail ?? t.description, 200);
    if (!title) continue;
    const category = CATEGORIES[str(t.category).toLowerCase()] ?? "fertilization";
    out.push({
      id: `t${out.length + 1}`,
      title,
      subtitle,
      category,
      priority: normalizePriority(t.priority),
      ...(str(t.titleFr) ? { titleFr: str(t.titleFr) } : {}),
      ...(str(t.subtitleFr) ? { subtitleFr: str(t.subtitleFr, 200) } : {}),
    });
    if (out.length >= 5) break;
  }
  return out.length >= 3 ? out : null;
}

/* ------------------------------------------------------------------ */
/*  Provider calls                                                    */
/* ------------------------------------------------------------------ */

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gemini `generateContent` payload — JSON response mode, chain-aware: the
 * answer-first thinking configuration is generation-specific (a wrong
 * parameter is a hard 400).
 *   • Gemini 3.x reasons by default and takes `thinkingLevel` (the legacy
 *     numeric `thinkingBudget` is rejected on this generation);
 *   • Gemini 2.5 takes a numeric `thinkingBudget` (`0` = skip the reasoning
 *     pass, answer-first);
 *   • the 1.5/2.0 generations predate thinking entirely and must receive NO
 *     `thinkingConfig` at all.
 */
function geminiBody(model: string, prompt: string): unknown {
  const base: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: TASK_SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.5 },
  };
  if (/^gemini-3/.test(model)) {
    (base.generationConfig as Record<string, unknown>).thinkingConfig = {
      thinkingLevel: "low",
    };
  } else if (model.includes("2.5")) {
    (base.generationConfig as Record<string, unknown>).thinkingConfig = {
      thinkingBudget: 0,
    };
  }
  return base;
}

/**
 * Stage 2 (FALLBACK) — Google Gemini. Walks models × keys; a
 * 404/model-not-found moves to the next model id, quota (429) rotates to the
 * next key. Returns `null` on any failure.
 */
export async function generateWithGemini(
  prompt: string,
  keys: string[],
  fetchImpl: FetchLike,
  timeoutMs = AI_TIMEOUT_MS,
): Promise<AiGeneration | null> {
  if (keys.length === 0) return null;
  for (const model of resolveGeminiModels()) {
    for (const key of keys) {
      const payload = await postJson(
        fetchImpl,
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {},
        geminiBody(model, prompt),
        timeoutMs,
      );
      if (!payload || typeof payload !== "object") continue;
      const p = payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = p.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      const tasks = normalizeTasks(extractTasksJson(text));
      if (tasks) return { tasks, provider: "gemini", model };
      // Unusable JSON but the endpoint answered → try the next model (the
      // prompt/mode support differs per generation).
    }
  }
  return null;
}

/** Stage 1 (PRIMARY) — OpenAI-compatible chat completions with JSON mode. */
export async function generateWithOpenAI(
  prompt: string,
  cfg: { key: string; model: string },
  fetchImpl: FetchLike,
  timeoutMs = AI_TIMEOUT_MS,
): Promise<AiGeneration | null> {
  const payload = await postJson(
    fetchImpl,
    "https://api.openai.com/v1/chat/completions",
    { Authorization: `Bearer ${cfg.key}` },
    {
      model: cfg.model,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: TASK_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    },
    timeoutMs,
  );
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { choices?: Array<{ message?: { content?: string } }> };
  const text = p.choices?.[0]?.message?.content ?? "";
  const tasks = normalizeTasks(extractTasksJson(text));
  return tasks ? { tasks, provider: "openai", model: cfg.model } : null;
}

/**
 * Runs the provider chain for one context — PRIMARY first, Gemini second:
 * OpenAI (when `OPENAI_API_KEY` is configured) is attempted before the
 * Gemini fallback, which only runs when the primary is unconfigured or could
 * not produce a usable task set. `null` = no AI stage produced a usable set →
 * the caller MUST fall back to `generateRuleTasks`. Never throws.
 */
export async function generateAiTasks(
  ctx: DailyContext,
  fetchImpl: FetchLike | undefined,
  timeoutMs = AI_TIMEOUT_MS,
): Promise<AiGeneration | null> {
  if (!fetchImpl) return null;
  const prompt = buildTaskPrompt(ctx);
  try {
    const openai = resolveOpenAi();
    if (openai) {
      const primary = await generateWithOpenAI(prompt, openai, fetchImpl, timeoutMs);
      if (primary) return primary;
    }
    const gemini = await generateWithGemini(prompt, resolveGeminiApiKeys(), fetchImpl, timeoutMs);
    if (gemini) return gemini;
  } catch {
    /* defensive: the chain must never reject */
  }
  return null;
}
