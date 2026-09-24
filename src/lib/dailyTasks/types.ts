/**
 * Daily AI task engine — shared types.
 *
 * The contract every layer speaks: the rule-based fallback generator, the
 * LLM normalizer, the scheduled (23:55 → 00:00) workflow, the persistence
 * stores and the hero-card checklist. Task copy is bilingual: `title` /
 * `subtitle` are the primary Arabic strings (the app's default language) and
 * `titleFr` / `subtitleFr` carry the French twin so the language switch keeps
 * working — the JSON the AI returns matches this exact shape.
 */

/** Task buckets shown as category badges on the checklist. */
export type TaskCategory = "irrigation" | "protection" | "fertilization";

/** Only two priorities exist in the UI: High / Normal. */
export type TaskPriority = "high" | "normal";

/** How the day's task set was produced. */
export type DailyTaskSource = "ai" | "rules";

export interface DailyTask {
  /** Stable id inside one set — re-indexed to `t1`, `t2`, … on normalization. */
  id: string;
  /** Arabic title — professional, agricultural, concise. */
  title: string;
  /** Arabic detail line with the concrete numbers (m³, window, %, °C…). */
  subtitle: string;
  category: TaskCategory;
  priority: TaskPriority;
  /** French twins (optional — the UI falls back to the Arabic strings). */
  titleFr?: string;
  subtitleFr?: string;
}

/**
 * One published day of tasks, always indexed by `date` (`YYYY-MM-DD`,
 * Africa/Algiers) in both LocalStorage and RTDB.
 */
export interface DailyTaskSet {
  date: string;
  /** `wilaya|crop|soil|area` — the parcel context these tasks were built for. */
  contextKey: string;
  tasks: DailyTask[];
  source: DailyTaskSource;
  /** ISO timestamp of the generation run (the 00:00 publish, or an on-demand run). */
  generatedAt: string;
  /** The daily publish slot the UI footer quotes: "اليوم 00:00". */
  publishedAt: string;
}

/** Canonical storage key part: RTDB rejects `# $ / [ ] .` in keys. */
export function contextKeyFor(parts: {
  wilayaCode: string;
  crop: string;
  soil: string;
  areaHa: number;
}): string {
  const area = String(Math.round(parts.areaHa * 100) / 100).replace(".", "_");
  return [parts.wilayaCode || "na", parts.crop, parts.soil, area].join("__");
}

/** The display copy of a task in the requested language. */
export function taskText(task: DailyTask, lang: "ar" | "fr"): { title: string; subtitle: string } {
  if (lang === "fr") {
    return { title: task.titleFr || task.title, subtitle: task.subtitleFr || task.subtitle };
  }
  return { title: task.title, subtitle: task.subtitle };
}
