/**
 * The Gemini model chain, and the health check that keeps it honest.
 *
 * Kept in its own module — free of Next.js imports — so the route and the
 * `tools/check-gemini-models.mjs` CLI share ONE definition. A model id that
 * only exists in a comment is exactly the failure this file exists to prevent:
 * Google rotates its catalog on a fast cadence and a stale id 404s silently
 * until someone reads a production log.
 *
 * Server-safe and dependency-free (Node's global `fetch` is the only I/O).
 */

/* ------------------------------------------------------------------ */
/*  The chain                                                          */
/* ------------------------------------------------------------------ */

/**
 * Gemini model chain entry. `thinking` carries the per-generation
 * `thinkingConfig` — OPTIONAL, because each generation 400s on the wrong
 * shape: the Gemini 3.x line takes `thinkingLevel` (`"low"` = answer-first),
 * Gemini 2.5 took a numeric `thinkingBudget` (`0`), and the long-retired 1.5/2.0
 * ids predate thinking entirely and reject the parameter. `undefined` means
 * "send no `thinkingConfig` at all".
 */
export interface GeminiModel {
  id: string;
  thinking?: { thinkingLevel: "low" } | { thinkingBudget: number };
}

/**
 * The PRIMARY id, used for BOTH Gemini roles (Step 1 image analysis and
 * Step 3 text formatting).
 *
 * `gemini-3.8-flash` — released 2026-09-02, current stable Flash, no shutdown
 * date announced (https://ai.google.dev/gemini-api/docs/deprecations).
 */
export const GEMINI_MODEL_DEFAULT: GeminiModel = {
  id: "gemini-3.8-flash",
  thinking: { thinkingLevel: "low" },
};

/**
 * Built-in fallback ids, walked within the remaining step budget when the
 * primary 404s / is retired.
 *
 * The ordering is deliberate and NOT simply "newest first". Google's 3.6 / 3.7 /
 * 3.8 Flash ids are *short-term availability* models — rolling point releases
 * that Google replaces as newer ones ship, which is precisely how a chain of
 * them dies all at once. So the fallbacks lead with the LONG-LIVED ids:
 *
 *   • `gemini-3.5-flash`      (2026-05-19, supported no earlier than 2027-05-19)
 *   • `gemini-3.5-flash-lite` (2026-07-21, supported no earlier than 2027-07-21)
 *
 * If the rolling 3.8 id is retired tomorrow, the request still lands on a
 * model with ~9 months of guaranteed support instead of 404-ing three times
 * and degrading to MobileNetV2.
 *
 * Retired on purpose (do not re-add without checking the deprecations page):
 *   • `gemini-2.5-flash`   — refused for new API keys ("no longer available
 *                             to new users"), retiring 2026-10-20
 *   • `gemini-2.0-flash*`  — SHUT DOWN 2026-06-01
 *   • `gemini-3.6`         — never existed; the real id was `gemini-3.6-flash`
 */
export const GEMINI_FALLBACK_MODELS: readonly GeminiModel[] = [
  { id: "gemini-3.5-flash", thinking: { thinkingLevel: "low" } },
  { id: "gemini-3.5-flash-lite", thinking: { thinkingLevel: "low" } },
];

/**
 * Resolve the ordered Gemini chain: the `override` (normally
 * `process.env.GEMINI_MODEL`, whitespace-trimmed) or
 * {@link GEMINI_MODEL_DEFAULT} first, then the built-in fallbacks —
 * deduplicated, so pinning an id that is also a fallback never doubles it.
 *
 * `dead` optionally drops ids a previous health check proved unavailable, but
 * NEVER returns an empty chain: if every id is "dead" we keep the originals,
 * because a stale negative cache entry must not disable the stage outright
 * (the model may simply not be listed yet, e.g. a brand-new release).
 */
export function resolveGeminiModels(
  override?: string,
  dead: ReadonlySet<string> = new Set(),
): GeminiModel[] {
  const pinned = override?.trim();
  const primary: GeminiModel = pinned ? { id: pinned } : GEMINI_MODEL_DEFAULT;
  const chain = [
    primary,
    ...GEMINI_FALLBACK_MODELS.filter((model) => model.id !== primary.id),
  ];

  const alive = chain.filter((model) => !dead.has(model.id));
  return alive.length > 0 ? alive : chain;
}

/* ------------------------------------------------------------------ */
/*  Health check — validate the chain against ListModels               */
/* ------------------------------------------------------------------ */

const LIST_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** ListModels is a cheap metadata call; it must never eat a request budget. */
const LIST_MODELS_TIMEOUT_MS = 6_000;

/** Model ids as returned by `GET /v1beta/models`. */
export interface GeminiListedModel {
  /** Resource name, e.g. `models/gemini-3.8-flash`. */
  name: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

/** One entry of the configured chain, annotated with what ListModels said. */
export interface GeminiChainCheck {
  id: string;
  /** `true`/`false` when known; `null` when ListModels could not be reached. */
  available: boolean | null;
  /** True for the id the chain actually starts with. */
  primary: boolean;
}

export interface GeminiHealthReport {
  /** True only when EVERY configured id is confirmed available. */
  ok: boolean;
  chain: GeminiChainCheck[];
  /** Ids that support `generateContent`, newest-first, for diagnostics. */
  available: string[];
  /**
   * The newest available general-purpose Flash id, suggested when the
   * configured chain is broken. `null` when the chain is fine or nothing
   * suitable was found.
   */
  suggestion: string | null;
  /** Set when ListModels itself failed (network, bad key, no route). */
  error?: string;
}

/** Extract the bare id from a `models/…` resource name. */
function bareModelId(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

/**
 * Parse a `version`-style id into comparable numbers, ignoring the family
 * suffix. `gemini-3.8-flash` → `[3, 8]`, `gemini-2.0-flash` → `[2, 0]`.
 */
function versionParts(id: string): number[] {
  const match = /^gemini-(\d+)(?:\.(\d+))?/.exec(id);
  if (!match) return [];
  return [Number(match[1]), Number(match[2] ?? 0)];
}

/** Compare two ids by version, newest first. */
function byVersionDesc(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * True for ids that suit this app's job: a general-purpose, non-preview,
 * non-specialised Flash model. Excludes `-lite` (a last-resort tier we keep
 * in the chain but never recommend as *the* fix), and the image / TTS / live
 * families, which are not text-and-vision generation models.
 */
function isGeneralPurposeFlash(id: string): boolean {
  return (
    /^gemini-\d+(\.\d+)?-flash$/.test(id) &&
    !id.includes("-lite") &&
    !id.includes("-image") &&
    !id.includes("-tts") &&
    !id.includes("-live") &&
    !id.includes("-preview")
  );
}

/**
 * Fetch every model this key can see that supports `generateContent`.
 *
 * Throws on any transport/HTTP failure so the caller can record it as
 * `error` and carry on — a health check must never break a request.
 */
async function listGenerateContentModels(apiKey: string): Promise<string[]> {
  const response = await fetch(`${LIST_MODELS_URL}?pageSize=1000&key=${apiKey}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `ListModels HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { models?: GeminiListedModel[] }
    | null;

  const models = payload?.models;
  if (!Array.isArray(models)) {
    throw new Error("ListModels returned an unexpected payload shape");
  }

  return models
    .filter(
      (model) =>
        model?.supportedGenerationMethods?.includes("generateContent") === true,
    )
    .map((model) => bareModelId(model.name))
    .filter(Boolean)
    .sort(byVersionDesc);
}

/**
 * Validate a configured chain against the live catalog.
 *
 * Uses only the FIRST configured key: a model-visibility problem is almost
 * always global, and burning the whole rotation pool on a diagnostic would be
 * worse than the diagnostic itself.
 */
export async function checkGeminiModelHealth(options: {
  apiKey: string;
  chain: readonly GeminiModel[];
  /** Injectable for tests. */
  fetchModels?: () => Promise<string[]>;
}): Promise<GeminiHealthReport> {
  const { apiKey, chain } = options;

  let available: string[] | null = null;
  let error: string | undefined;
  try {
    available = options.fetchModels
      ? await options.fetchModels()
      : await listGenerateContentModels(apiKey);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (available === null) {
    return {
      ok: false,
      chain: chain.map((model, index) => ({
        id: model.id,
        available: null,
        primary: index === 0,
      })),
      available: [],
      suggestion: null,
      error,
    };
  }

  const listed = new Set(available);
  const checks: GeminiChainCheck[] = chain.map((model, index) => ({
    id: model.id,
    available: listed.has(model.id),
    primary: index === 0,
  }));

  const missing = checks.filter((check) => check.available === false);
  const suggestion = missing.length
    ? available.find(isGeneralPurposeFlash) ?? null
    : null;

  return {
    ok: missing.length === 0,
    chain: checks,
    available,
    suggestion,
    error: undefined,
  };
}

/** One-line, greppable rendering of a health report — the startup log. */
export function formatGeminiHealthReport(
  report: GeminiHealthReport,
  chain: readonly GeminiModel[],
  /**
   * How the reader should diagnose a failed check. Defaults to the CLI, which
   * is the right advice in a server log; the CLI itself passes its own, since
   * telling someone running it to run it would be circular.
   */
  diagnose = "run `npm run check:models` to diagnose",
): string[] {
  const chainLabel = chain.map((model) => model.id).join(" → ");

  if (report.error) {
    return [
      `[Gemini Health] ⚠ could not verify the model chain (${report.error}).`,
      `[Gemini Health]   configured: ${chainLabel}`,
      `[Gemini Health]   ${diagnose}.`,
    ];
  }

  const live = report.chain.filter((check) => check.available === true);
  const missing = report.chain.filter((check) => check.available === false);

  if (missing.length === 0) {
    return [
      `[Gemini Health] ✅ chain ${chainLabel} — ${live.length}/${report.chain.length} configured model ids are live.`,
    ];
  }

  const lines = [
    `[Gemini Health] ❌ ${missing.length} of ${report.chain.length} configured model ids are NOT available: ${missing
      .map((check) => check.id)
      .join(", ")}.`,
    `[Gemini Health]   configured: ${chainLabel}`,
  ];
  if (report.suggestion) {
    lines.push(
      `[Gemini Health]   set GEMINI_MODEL=${report.suggestion} (or update GEMINI_FALLBACK_MODELS in src/lib/assistant/gemini-models.ts).`,
    );
  }
  if (live.length === 0) {
    lines.push(
      "[Gemini Health]   NO configured id is live: every Gemini call will 404 and Step 1 will degrade to MobileNetV2 on every photo.",
    );
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  The runtime monitor                                                */
/* ------------------------------------------------------------------ */

/** How long a verified chain is trusted before re-checking (6 hours). */
export const GEMINI_HEALTH_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Single-flight, TTL-bounded wrapper around {@link checkGeminiModelHealth} for
 * the request path.
 *
 * It exists so a Google deprecation surfaces as ONE loud log line — and so the
 * dead ids stop costing a round-trip per request — instead of a 404 buried in
 * the per-request warnings. Deliberately non-throwing: a diagnostic must never
 * be able to fail a request.
 *
 * `now` and `fetchModels` are injectable so the caching behaviour is testable
 * without waiting six hours.
 */
export class GeminiModelHealthMonitor {
  /** Ids a past check proved unavailable, dropped from the request chain. */
  private unavailable = new Set<string>();
  /** The in-flight (or most recent) check — single-flight guard. */
  private inFlight: Promise<GeminiHealthReport | null> | null = null;
  private checkedAt = Number.NEGATIVE_INFINITY;
  private readonly ttlMs: number;
  private readonly now: () => number;

  // NOTE: written as explicit fields, not TypeScript "parameter properties",
  // because this module is imported by both the Next build and a plain-Node CLI
  // and Node's type-stripping loader rejects parameter properties.
  constructor(ttlMs: number = GEMINI_HEALTH_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Ids to exclude from the request chain (may be empty). */
  get unavailableModels(): ReadonlySet<string> {
    return this.unavailable;
  }

  /**
   * Run the check if the cached verdict is stale. Concurrent callers share one
   * in-flight check; within the TTL it returns the cached verdict immediately.
   * Never rejects.
   */
  async ensure(
    chain: readonly GeminiModel[],
    options: { apiKey: string; fetchModels?: () => Promise<string[]> },
  ): Promise<GeminiHealthReport | null> {
    if (this.inFlight && this.now() - this.checkedAt < this.ttlMs) {
      return this.inFlight;
    }

    this.checkedAt = this.now();
    this.inFlight = checkGeminiModelHealth({ chain, ...options })
      .then((report) => {
        const dead = report.chain
          .filter((check) => check.available === false)
          .map((check) => check.id);
        // A check that could not reach ListModels must not poison the chain.
        this.unavailable = new Set(dead);
        return report;
      })
      .catch((error: unknown) => {
        // Defensive: `checkGeminiModelHealth` is already total, but a defect
        // here must never escape into the request path.
        this.unavailable = new Set();
        throw error instanceof Error ? error : new Error(String(error));
      })
      // Swallow: a broken diagnostic degrades to "unverified", never to a 500.
      .catch(() => null);

    return this.inFlight;
  }

  /**
   * Treat the chain as freshly verified, with nothing marked dead.
   *
   * For callers that already know the verdict (a boot check that ran before
   * traffic arrived) and for tests, where re-issuing a ListModels call on every
   * case would obscure the call counts under test.
   */
  markVerified(): void {
    this.inFlight = Promise.resolve(null);
    this.checkedAt = this.now();
    this.unavailable = new Set();
  }

  /** Forget the cached verdict. Used by tests and by a config reload. */
  reset(): void {
    this.inFlight = null;
    this.checkedAt = Number.NEGATIVE_INFINITY;
    this.unavailable = new Set();
  }
}
