/**
 * Shared provider plumbing for `/api/assistant` and both `/api/health/*`
 * endpoints: credentials, rotation state, timeouts and secret redaction.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * The hardened pipeline has four behaviours that must be identical in the chat
 * route and in the two health probes, because a drift between them is exactly
 * how "the health check says OK but the assistant degrades" incidents happen:
 *
 *   • CREDENTIAL RESOLUTION — the Gemini key pool is collected from
 *     `GEMINI_API_KEY` and its numbered variants (`GEMINI_API_KEY_N`), then
 *     SHUFFLED per request (see {@link shuffleGeminiKeyPool}): a random draw
 *     without replacement, so no key is tried twice in one request cycle and
 *     no request always starts on the same credential. When the user picked a
 *     model explicitly, {@link prioritizeGeminiKeyPool} moves the priority key
 *     to the head of that draw first. The Hugging Face token
 *     is read from ONE variable name, `HUGGINGFACE_API_KEY` (trimmed), with no
 *     alias and no hardcoded fallback.
 *   • FEATURE FLAG — {@link ENABLE_HUGGINGFACE} (shipped `false`) bypasses
 *     every Hugging Face stage: the pipeline is Gemini-only. The Hugging Face
 *     code is untouched and comes back by flipping the flag.
 *   • IN-MEMORY STATE — per (key NAME, model) quota exhaustion (10 min),
 *     per key invalidity (60 min) and the Hugging Face 402 credit circuit
 *     (10 min). Names, never values, are the map keys.
 *   • TIMEOUTS — one 8 s per-attempt window and ONE 60 s `AbortController`
 *     deadline for the whole request.
 *   • REDACTION — every message that can reach a log line or the client is
 *     passed through {@link redactSecrets}, so a credential can never leak
 *     through an upstream error body, a URL echoed by `fetch` or a warning.
 *
 * Nothing here imports Next.js or reads a secret at module scope: the module is
 * safe to load in tests, in the CLI tools and in either route bundle.
 */

/* ------------------------------------------------------------------ */
/*  Tunables                                                          */
/* ------------------------------------------------------------------ */

/**
 * Per-attempt budget for a single upstream round-trip (Gemini generateContent,
 * HF chat-completions, HF classification, ListModels). An
 * attempt that blows it is a "network / timeout" failure — Gemini retries the
 * SAME key once, Hugging Face falls through to the next provider.
 */
export const PER_ATTEMPT_TIMEOUT_MS = 8_000;

/**
 * Hard ceiling for the WHOLE request: 60 s, armed as ONE `AbortController` at
 * the top of the handler. When it fires, the route stops calling upstreams and
 * answers HTTP 503 (`code: "DEADLINE_EXCEEDED"`) with the Arabic "service is
 * busy" message — never a hang, never a 500.
 *
 * OPERATIONAL NOTE: 60 s is exactly Vercel's default function ceiling, so the
 * deployment must allow a little more head-room for the 503 to be produced
 * (`maxDuration = 65` on Pro/Enterprise; the Hobby plan is capped at 60 s and
 * will kill the invocation at the same instant the timer fires). The route
 * itself is already correct: the deadline is armed first, every attempt is
 * bounded by {@link PER_ATTEMPT_TIMEOUT_MS}, and the timer is always disposed.
 */
export const GLOBAL_DEADLINE_MS = 60_000;

/**
 * A stage needs at least this much budget left to be worth starting (one
 * connect + first byte, realistically); below it we stop and let the deadline
 * branch answer 503 instead of leaving a request hanging at its edge.
 */
export const MIN_STAGE_BUDGET_MS = 1_200;

/** Hugging Face HTTP 402 (out of credits) parks the whole HF chain for 10 min. */
export const HF_CREDITS_SKIP_MS = 10 * 60 * 1000;

/** A (key, model) pair that hit a daily/quota 429 rests for 10 minutes. */
export const GEMINI_QUOTA_TTL_MS = 10 * 60 * 1000;

/** A key Google rejected as invalid (`API_KEY_INVALID` / 403) rests for 60 min. */
export const GEMINI_INVALID_TTL_MS = 60 * 60 * 1000;

/** A per-key ListModels catalog is trusted for 1 hour. */
export const GEMINI_CATALOG_TTL_MS = 60 * 60 * 1000;

/**
 * FEATURE FLAG — Hugging Face inference (the MobileNetV2 vision fallback and
 * the text model; the leaf-cropping detector of the old Step 0 is gone).
 *
 * `false` = the assistant is Gemini-only: every Hugging Face stage is skipped
 * BEFORE a token is read or a request is built (no latency, no warnings, no
 * quota spent), and Gemini handles both the image analysis and the text. The
 * Hugging Face implementation is deliberately NOT deleted — flipping this
 * constant to `true` restores the exact previous pipeline.
 *
 * `HUGGINGFACE_API_KEY` becomes optional while the flag is off (it is not even
 * resolved, so an unset variable can no longer degrade a request), and the
 * route's `MISSING_KEYS` guard now requires a Gemini key.
 */
export const ENABLE_HUGGINGFACE = false;

/**
 * `ENABLE_HUGGINGFACE`, overridable per deployment/process with the
 * `ENABLE_HUGGINGFACE` environment variable (`true`/`1` to force on,
 * `false`/`0` to force off). The constant is the shipped default; the override
 * exists so the preserved Hugging Face paths stay testable and so an operator
 * can re-enable the stage without a code change.
 */
export function isHuggingFaceEnabled(env: EnvLike = process.env): boolean {
  const override = env.ENABLE_HUGGINGFACE?.trim().toLowerCase();
  if (override === "true" || override === "1") return true;
  if (override === "false" || override === "0") return false;
  return ENABLE_HUGGINGFACE;
}

/**
 * Server-only variables this pipeline expects in production. NAMES ONLY — the
 * list is documentation/validation, never a place to read a value from.
 * `GEMINI_API_KEY` (plus the numbered variants) is what every stage needs,
 * `HUGGINGFACE_API_KEY` is the Hugging Face credential — REQUIRED only while
 * {@link ENABLE_HUGGINGFACE} is on, since the flag makes the pipeline
 * Gemini-only — and `HEALTH_SECRET` protects the two health endpoints.
 */
export const REQUIRED_ENV_VARS = [
  "GEMINI_API_KEY",
  "HUGGINGFACE_API_KEY",
  "HEALTH_SECRET",
] as const;

/* ------------------------------------------------------------------ */
/*  Secret redaction                                                   */
/* ------------------------------------------------------------------ */

/**
 * Anything shaped like a credential, replaced before a string can reach a log
 * line, a warning or a response body. Deliberately generous: a false positive
 * costs a few characters in a diagnostic message, a false negative ships a
 * live key to a log aggregator.
 *
 *   • `hf_…`      — Hugging Face user access tokens
 *   • `AIza…`     — Google API keys
 *   • `key=` / `?key=` / `api_key=` / `access_token=` query values
 *   • `Bearer <token>` header values
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/\bhf_[A-Za-z0-9_-]{8,}/g, "[redacted-hf-token]")
    .replace(/\bAIza[0-9A-Za-z_-]{8,}/g, "[redacted-google-key]")
    .replace(/\b([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"'`]+/gi, "$1[redacted]")
    .replace(/\b(Bearer|Token)\s+[A-Za-z0-9._-]{8,}/gi, "$1 [redacted]");
}

/**
 * A log/response-safe one-liner: redacted and length-capped. Task rule — on an
 * upstream failure we log only the status and a SHORT message, never a full
 * error envelope (which is both a credential-leak and a log-noise risk).
 */
export function shortMessage(input: string, max = 200): string {
  const collapsed = redactSecrets(input).replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/* ------------------------------------------------------------------ */
/*  Deadlines                                                          */
/* ------------------------------------------------------------------ */

/** Raised when the single 60 s request deadline fires. Maps to HTTP 503. */
export class DeadlineExceededError extends Error {
  constructor(message = `global request deadline of ${GLOBAL_DEADLINE_MS} ms exceeded`) {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

/** True for a fetch aborted by an attempt timer (or the platform). */
export function isAbortOrTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /aborted|timeout/i.test(error.message)
  );
}

/**
 * ONE `AbortController` per request, armed with the 60 s global deadline.
 *
 * Every upstream round-trip races its own {@link PER_ATTEMPT_TIMEOUT_MS} timer
 * against this signal, so the two guarantees hold independently: a single slow
 * provider cannot eat the budget of the next fallback, and the sum of all
 * attempts can never outlive the deadline. `dispose()` must run in a
 * `finally`, or the pending timer would keep the serverless invocation alive.
 */
export class RequestDeadline {
  // NOTE: explicit fields, not TypeScript "parameter properties" — this module
  // is imported by the plain-Node unit tests and CLI tools, and Node's
  // type-stripping loader rejects parameter properties outright.
  readonly budgetMs: number;
  readonly startedAt: number;
  readonly expiresAt: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly now: () => number;

  constructor(budgetMs: number = GLOBAL_DEADLINE_MS, now: () => number = Date.now) {
    this.budgetMs = budgetMs;
    this.now = now;
    this.startedAt = this.now();
    this.expiresAt = this.startedAt + budgetMs;
    this.timer = setTimeout(() => {
      this.controller.abort(new DeadlineExceededError(`deadline of ${budgetMs} ms exceeded`));
    }, budgetMs);
  }

  /** The signal every attempt fetch in this request must observe. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Milliseconds left before the 60 s ceiling (may be ≤ 0 once exceeded). */
  get remainingMs(): number {
    return this.expiresAt - this.now();
  }

  /** True once the global deadline has passed or aborted. */
  get expired(): boolean {
    return this.now() >= this.expiresAt || this.controller.signal.aborted;
  }

  /** Cancel the deadline timer; safe to call more than once. */
  dispose(): void {
    clearTimeout(this.timer);
  }
}

/**
 * `fetch` bounded by BOTH windows: this attempt's {@link PER_ATTEMPT_TIMEOUT_MS}
 * and the request's shared 60 s deadline.
 *
 * A deadline abort is re-thrown as {@link DeadlineExceededError} so callers can
 * tell "this provider is slow" (retry the next key/provider) from "we are out
 * of time" (stop and answer 503). Both timers are cleared on every path; the
 * explicit timer (rather than `AbortSignal.timeout`) keeps the callback visible
 * to fake-timer tests and to the abort reason.
 */
export async function fetchWithAttemptTimeout(
  url: string,
  init: RequestInit,
  deadline: RequestDeadline,
  attemptMs: number = PER_ATTEMPT_TIMEOUT_MS,
): Promise<Response> {
  if (deadline.expired) throw new DeadlineExceededError();

  const controller = new AbortController();
  const abortOnDeadline = () => controller.abort(new DeadlineExceededError());
  deadline.signal.addEventListener("abort", abortOnDeadline, { once: true });
  const attemptTimer = setTimeout(
    () => controller.abort(new Error(`attempt timeout after ${attemptMs} ms`)),
    attemptMs,
  );

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (deadline.expired) throw new DeadlineExceededError();
    throw error;
  } finally {
    clearTimeout(attemptTimer);
    deadline.signal.removeEventListener("abort", abortOnDeadline);
  }
}

/**
 * A read-only environment map: `process.env`, or a frozen test double. Every
 * resolver below takes one so a unit test can prove resolution never reads
 * anything but the documented names — and never writes to the environment.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/* ------------------------------------------------------------------ */
/*  Hugging Face — ONE variable name, trimmed, no fallback             */
/* ------------------------------------------------------------------ */

/**
 * The ONLY environment variable consulted for the Hugging Face token. The
 * `HF_TOKEN` alias of earlier revisions is deliberately gone: it made "why did
 * the deployment authenticate with the wrong account?" impossible to answer
 * from the name alone, and a stale shell token could silently shadow the
 * configured secret.
 */
export const HF_TOKEN_ENV_NAME = "HUGGINGFACE_API_KEY";

/**
 * The trimmed `process.env.HUGGINGFACE_API_KEY`, or `null` when it is unset,
 * blank or whitespace-only. Note `.trim()`: a secret pasted into a Vercel
 * dashboard with a trailing newline authenticates again instead of failing
 * with an opaque 401.
 */
export function resolveHuggingFaceToken(env: EnvLike = process.env): string | null {
  const raw = env[HF_TOKEN_ENV_NAME];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? value : null;
}

/**
 * Circuit breaker for Hugging Face's HTTP 402 ("Payment Required" — the free
 * tier's monthly credits are gone). Once tripped, the whole HF chain is
 * skipped in memory for {@link HF_CREDITS_SKIP_MS}, so a request does not burn
 * budget re-discovering the same account-level fact; the request falls straight
 * through to Gemini.
 */
export class HfCreditCircuit {
  private openUntil = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  trip(durationMs: number = HF_CREDITS_SKIP_MS): void {
    this.openUntil = this.now() + durationMs;
  }

  get isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  get remainingMs(): number {
    return Math.max(0, this.openUntil - this.now());
  }

  reset(): void {
    this.openUntil = 0;
  }
}

/** Process-wide HF credit circuit shared by the assistant route and probes. */
export const hfCreditCircuit = new HfCreditCircuit();

/* ------------------------------------------------------------------ */
/*  Gemini — key pool resolution and in-memory rotation state          */
/* ------------------------------------------------------------------ */

/**
 * The ONLY Gemini variable shapes that participate in rotation:
 * `GEMINI_API_KEY` and its numbered variants (`GEMINI_API_KEY_2`, `_3`, …).
 * Anything else — including the legacy comma-separated `GEMINI_API_KEYS` pool,
 * which does not match this pattern — is not part of the numbered order.
 */
export const GEMINI_KEY_NAME_PATTERN = /^GEMINI_API_KEY(_\d+)?$/;

/**
 * The variable usually holding a key from a DIFFERENT Google project (hence a
 * separate daily quota). It keeps the head of the stable inventory order that
 * the log line and the health probe print — the live request order is a random
 * draw (see {@link shuffleGeminiKeyPool}) — and when it is absent the pipeline
 * logs its NAME as missing and continues with the remaining keys.
 */
export const GEMINI_PRIORITY_KEY_NAME = "GEMINI_API_KEY_4";

/**
 * LEGACY, still honoured: the comma-separated `GEMINI_API_KEYS` pool that
 * pre-dates the numbered variables. Its entries are appended AFTER every
 * numbered key so the documented rotation order is unaffected, and the pool is
 * announced once (by name) so it can be migrated away.
 */
export const GEMINI_LEGACY_POOL_NAME = "GEMINI_API_KEYS";

/** One credential in rotation order. `name` is log-safe; `key` never is. */
export interface GeminiKeyEntry {
  /**
   * Environment-variable NAME (plus `#n` when one variable held a comma pool),
   * e.g. `GEMINI_API_KEY_4`, `GEMINI_API_KEY#2`. The ONLY identifier allowed
   * in logs, warnings and health responses.
   */
  name: string;
  /** The secret value. Never logged, never returned, never serialized. */
  key: string;
}

/** Inventory rank: `_4` first, then the base variable, then `_1`, `_2`, … */
function geminiKeyRank(name: string): number {
  if (name === GEMINI_PRIORITY_KEY_NAME) return 0;
  if (name === "GEMINI_API_KEY") return 1;
  const suffix = name.slice("GEMINI_API_KEY_".length);
  const parsed = Number(suffix);
  return Number.isInteger(parsed) ? parsed + 1 : Number.MAX_SAFE_INTEGER;
}

/**
 * Resolve the CONFIGURED key inventory — the set a request draws from:
 *
 *   1. `GEMINI_API_KEY_4`,
 *   2. `GEMINI_API_KEY` and the remaining `GEMINI_API_KEY_N` in numeric order,
 *   3. the legacy `GEMINI_API_KEYS` pool last.
 *
 * Values are trimmed, comma-separated pools are flattened (`#1`, `#2`, … in the
 * entry name) and duplicates are dropped first-wins, so the same credential is
 * never billed twice in one request. Blank entries are ignored.
 *
 * The order returned here is the STABLE inventory/dev order (used by the
 * `/api/health/gemini` probe, the CLI and the log line). It is NOT the order a
 * request uses: {@link shuffleGeminiKeyPool} draws a random permutation per
 * request cycle.
 */
export function resolveGeminiKeyPool(env: EnvLike = process.env): GeminiKeyEntry[] {
  const ranked: { name: string; rank: number; raw: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!GEMINI_KEY_NAME_PATTERN.test(name) || typeof value !== "string") continue;
    ranked.push({ name, rank: geminiKeyRank(name), raw: value });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  const legacyRaw = typeof env[GEMINI_LEGACY_POOL_NAME] === "string" ? env[GEMINI_LEGACY_POOL_NAME] : "";

  const entries: GeminiKeyEntry[] = [];
  const seen = new Set<string>();

  const absorb = (varName: string, raw: string) => {
    const values = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    values.forEach((value, index) => {
      if (seen.has(value)) return;
      seen.add(value);
      entries.push({ name: values.length > 1 ? `${varName}#${index + 1}` : varName, key: value });
    });
  };

  for (const item of ranked) absorb(item.name, item.raw);
  if (legacyRaw.trim()) absorb(GEMINI_LEGACY_POOL_NAME, legacyRaw);

  return entries;
}

/**
 * Draw this request's rotation order: a Fisher–Yates shuffle of the configured
 * pool — a random permutation WITHOUT replacement, so
 *
 *   • every configured key stays in the draw (no key is dropped),
 *   • no key is tried twice in the same request cycle, and
 *   • consecutive requests no longer start on the same credential (the fixed
 *     `GEMINI_API_KEY_4` → base → `_N` order is gone from the request path),
 *
 * which spreads the load across projects instead of concentrating every
 * request on one key's daily quota.
 *
 * `random` is injectable for tests and for a deterministic replay: a generator
 * returning values ≥ `1 - Number.EPSILON` yields the configured order.
 */
export function shuffleGeminiKeyPool(
  pool: readonly GeminiKeyEntry[],
  random: () => number = Math.random,
): GeminiKeyEntry[] {
  const drawn = [...pool];
  for (let i = drawn.length - 1; i > 0; i -= 1) {
    // `Math.min` guards a stubbed/rogue generator returning exactly 1.
    const j = Math.min(Math.floor(random() * (i + 1)), i);
    [drawn[i], drawn[j]] = [drawn[j], drawn[i]];
  }
  return drawn;
}

/**
 * Move one credential to the FRONT of a drawn pool — the "optimized for
 * `GEMINI_API_KEY_4`" step of a manually selected model.
 *
 * An explicit model choice spends the freshest, most predictable credential
 * first (a different Google project usually means its own daily quota), while
 * the rest of the pool keeps its random order: the priority key is tried once
 * per cycle at most, and only one key is pinned — no key is lost, none repeats.
 *
 * Returns a NEW array (the caller's draw is never mutated). When the named key
 * is not configured, or is already at the head, the ORDER is returned
 * unchanged — a missing `GEMINI_API_KEY_4` costs nothing.
 */
export function prioritizeGeminiKeyPool(
  pool: readonly GeminiKeyEntry[],
  name: string = GEMINI_PRIORITY_KEY_NAME,
): GeminiKeyEntry[] {
  const index = pool.findIndex((entry) => entry.name === name);
  if (index <= 0) return [...pool];
  return [pool[index], ...pool.filter((_, position) => position !== index)];
}

/** True when the preferred first key is absent, blank or whitespace-only. */
export function isPriorityGeminiKeyMissing(env: EnvLike = process.env): boolean {
  const raw = env[GEMINI_PRIORITY_KEY_NAME];
  return typeof raw !== "string" || raw.trim().length === 0;
}

/**
 * In-memory rotation state — what the pipeline learned about credentials during
 * THIS process's lifetime. Keyed by variable NAME (so the state itself never
 * becomes a second copy of the secrets) plus an optional model id:
 *
 *   • `quota`    — (key name, model) hit a 429 `RESOURCE_EXHAUSTED` / daily
 *                  quota → parked for 10 min. Another MODEL on the same key is
 *                  still tried: quotas can be per-model.
 *   • `invalid`  — key rejected as `API_KEY_INVALID` (400) or 403 → parked for
 *                  60 min; it is skipped entirely instead of costing a
 *                  round-trip per request.
 *
 * Everything expires, and `reset()` clears it for tests.
 */
export class GeminiKeyState {
  private readonly quota = new Map<string, number>();
  private readonly invalid = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private static quotaId(name: string, modelId: string): string {
    return `${name}|${modelId}`;
  }

  markQuotaExhausted(name: string, modelId: string, ttlMs: number = GEMINI_QUOTA_TTL_MS): void {
    this.quota.set(GeminiKeyState.quotaId(name, modelId), this.now() + ttlMs);
  }

  isQuotaExhausted(name: string, modelId: string): boolean {
    const until = this.quota.get(GeminiKeyState.quotaId(name, modelId));
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.quota.delete(GeminiKeyState.quotaId(name, modelId));
      return false;
    }
    return true;
  }

  markInvalid(name: string, ttlMs: number = GEMINI_INVALID_TTL_MS): void {
    this.invalid.set(name, this.now() + ttlMs);
  }

  isInvalid(name: string): boolean {
    const until = this.invalid.get(name);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.invalid.delete(name);
      return false;
    }
    return true;
  }

  /** Snapshot for diagnostics: model ids currently parked for one key name. */
  quotaExhaustedModels(name: string): string[] {
    const models: string[] = [];
    for (const id of this.quota.keys()) {
      const [keyName, modelId] = id.split("|");
      if (keyName === name && this.isQuotaExhausted(keyName, modelId)) models.push(modelId);
    }
    return models;
  }

  reset(): void {
    this.quota.clear();
    this.invalid.clear();
  }
}

/** Process-wide rotation state shared by the assistant route and the probes. */
export const geminiKeyState = new GeminiKeyState();

/* ------------------------------------------------------------------ */
/*  Health endpoints                                                   */
/* ------------------------------------------------------------------ */

/** The variable that protects `GET /api/health/*` (`?key=<HEALTH_SECRET>`). */
export const HEALTH_SECRET_ENV_NAME = "HEALTH_SECRET";

/**
 * Constant-time comparison for the health endpoints' shared secret. Length is
 * compared first (a leak-free proxy that avoids `timingSafeEqual`'s throw on
 * mismatched buffer sizes), then the bytes — so a probe cannot be used as an
 * oracle to recover the secret character by character.
 */
export function safeSecretEquals(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
