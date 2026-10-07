/**
 * Resilient Gemini transport for `POST /api/leaf-diagnose` — and ONLY that route.
 *
 * The Home-card route used to make at most two calls to ONE model (one retry
 * after 350 ms), so a short 503/429 burst surfaced as "provider busy" while the
 * PhytoScan chat, which rotates through every configured key, kept answering.
 * This module gives the leaf route the same resilience without sharing — or
 * touching — any chat code:
 *
 *  • Credentials: the SAME pool the chat reads. Every env var whose name starts
 *    with `GEMINI_API_KEY` (`GEMINI_API_KEY`, the comma-separated
 *    `GEMINI_API_KEYS`, numbered `GEMINI_API_KEY_N`) is combined, trimmed,
 *    de-duplicated and ordered exactly like the chat orders it. The chat keeps
 *    that logic in a private function, so it is COPIED here (read-only) rather
 *    than exported from a shared file.
 *  • Models: the SAME chain the chat walks — `resolveGeminiModels(GEMINI_MODEL)`
 *    from the shared module, imported read-only. Nothing there is edited, no
 *    shared object is mutated, and no env var is written, renamed or added.
 *
 * Policy for one request (models in chain order; keys in pool order):
 *
 *   2xx                           → done.
 *   429 / 500 / 503 (and their siblings 408 / 502 / 504), a network error or a
 *   per-call timeout              → wait ~1 s, rotate to the next key. Once every
 *                                   key has failed on a model (a lone key still
 *                                   gets two tries) fall to the next model, with
 *                                   no extra wait.
 *   401 / 402 / 403, or a 400 that
 *   Google tags API_KEY_INVALID   → a DEAD key (revoked, deleted, unpaid): skip to
 *                                   the next key at once — no pause, like the chat
 *                                   — and never use it again for this request,
 *                                   whichever model comes next.
 *   404 (this model id is gone)   → skip to the NEXT MODEL at once: no pause, no
 *                                   other key and no second try on this model —
 *                                   a key cannot fix a missing model. The next
 *                                   model starts again from the first usable key.
 *   any 400 that is not a dead
 *   key — and any other non-2xx
 *   status                        → stop at once, no rotation, no fallback:
 *                                   another key cannot fix a bad request. (Same
 *                                   `provider-busy` answer the route always gave.)
 *
 * Everything — sleeps and in-flight calls included — shares ONE wall-clock
 * budget ({@link LEAF_GEMINI_BUDGET_MS}), and a client disconnect stops it too.
 * `provider-busy` therefore only comes back once the budget is spent or no
 * key × model attempt is left (a dead key is never retried, a 404 model is
 * never revisited), or immediately for a terminal 400.
 *
 * Logging: exactly one line per attempt, built only from ordinals, the model id
 * and a status token — never a key, an image, an upstream body or an error
 * message (those can echo request details). The one thing read from an upstream
 * error body is Google's machine-readable `API_KEY_INVALID` reason on a 400, to
 * classify a dead key — it is matched in memory and never stored or emitted.
 */
import { resolveGeminiModels, type GeminiModel } from "@/lib/assistant/gemini-models";
import { resolveGeminiKeyPool } from "@/lib/assistant/providers";
import type { LeafFailure } from "@/lib/leaf-diagnose";

/**
 * Wall-clock budget for the whole request. Leaves 10 s of the route's 60 s
 * `maxDuration` for the upload, validation, platform overhead and the response.
 */
export const LEAF_GEMINI_BUDGET_MS = 50_000;
/** Pause before rotating to the next key after a transient failure. */
export const LEAF_GEMINI_ROTATION_DELAY_MS = 1_000;
/**
 * One stalled call must not eat the whole budget: it is cut here and treated as
 * a transient failure, so the next key / model still gets its turn.
 */
export const LEAF_GEMINI_ATTEMPT_TIMEOUT_MS = 20_000;
/** A lone key is retried once per model (the route's historical "retry once"). */
export const LEAF_GEMINI_MIN_ATTEMPTS_PER_MODEL = 2;

const GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const LOG_TAG = "[leaf-diagnose]";
/** Statuses worth another key after a pause; every other non-2xx status is terminal. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
/** The key (or its billing/project) is unusable: skip it, no pause. */
const DEAD_KEY_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);
/** Google reports an invalid/deleted key as HTTP 400 with this machine-readable reason. */
const INVALID_KEY_REASON = /"reason"\s*:\s*"API_KEY_INVALID"/;
/** The reason sits in the first few hundred bytes; never read more than this. */
const ERROR_BODY_PEEK_LIMIT = 16 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The chat's Gemini key pool, resolved read-only from the environment — the
 * SAME `resolveGeminiKeyPool()` the assistant route rotates, so the two
 * pipelines can never disagree about which credential to spend first:
 * `GEMINI_API_KEY_4` FIRST (a different Google project usually means its own
 * quota), then `GEMINI_API_KEY`, then the numbered variants in numeric order,
 * then the legacy comma-separated `GEMINI_API_KEYS` pool. Blank entries are
 * dropped, duplicates removed and each value trimmed.
 */
export function resolveLeafGeminiKeys(env: Env = process.env): string[] {
  return resolveGeminiKeyPool(env).map((entry) => entry.key);
}

/**
 * The chat's Gemini model chain: the `GEMINI_MODEL` pin (or the shared default)
 * first, then the shared fallbacks — gemini-3.8-flash → gemini-3.5-flash →
 * gemini-3.5-flash-lite unless the shared config says otherwise.
 */
export function resolveLeafGeminiModels(env: Env = process.env): GeminiModel[] {
  return resolveGeminiModels(env.GEMINI_MODEL);
}

export interface LeafGeminiOptions {
  /** Credentials in rotation order — see {@link resolveLeafGeminiKeys}. */
  keys: readonly string[];
  /** Model chain in fallback order — see {@link resolveLeafGeminiModels}. */
  models: readonly GeminiModel[];
  /** Serialised `generateContent` payload for one model (built once per model). */
  buildBody: (model: GeminiModel) => string;
  /** The client's request signal: aborting it stops every further attempt. */
  signal?: AbortSignal;
  /** Remaining wall-clock budget for this call. Default {@link LEAF_GEMINI_BUDGET_MS}. */
  budgetMs?: number;
  /** Pause before rotating keys. Default {@link LEAF_GEMINI_ROTATION_DELAY_MS}. */
  rotationDelayMs?: number;
  /** Cap for one call. Default {@link LEAF_GEMINI_ATTEMPT_TIMEOUT_MS}. */
  attemptTimeoutMs?: number;
}

export type LeafGeminiResult =
  | { ok: true; data: unknown; model: string; attempts: number }
  /** `reason` / `status` are what the route answers with — they never carry upstream text. */
  | { ok: false; reason: LeafFailure; status: number; attempts: number };

interface Attempt {
  /** Log token: the HTTP status, or `network` / `timeout` / `aborted`. */
  status: string;
  next: "done" | "rotate" | "skip" | "model" | "stop" | "malformed" | "expired";
  /** True when the provider answered (or stalled) rather than being unreachable. */
  reachable?: boolean;
  data?: unknown;
}

/** Resolves `true` after `ms`, or `false` the moment `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The first `limit` characters of a body. The stream is always cancelled afterwards. */
async function peekText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/** One `generateContent` round-trip, fully bounded by `run` and its own cap. */
async function callGemini(
  model: GeminiModel,
  key: string,
  body: string,
  run: AbortSignal,
  clientLeft: () => boolean,
  timeoutMs: number,
): Promise<Attempt> {
  const call = new AbortController();
  const relay = () => call.abort();
  let timedOut = false;
  if (run.aborted) call.abort();
  else run.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    call.abort();
  }, timeoutMs);

  /** What an aborted call means: budget / client gone, or just this call's cap. */
  const interrupted = (): Attempt | null =>
    run.aborted
      ? { status: clientLeft() ? "aborted" : "timeout", next: "expired" }
      : timedOut
        ? { status: "timeout", next: "rotate", reachable: true }
        : null;

  try {
    let response: Response;
    try {
      response = await fetch(`${GENERATE_URL}/${encodeURIComponent(model.id)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
        signal: call.signal,
        cache: "no-store",
      });
    } catch {
      // Deliberately not logged or returned: the error text can echo request details.
      return interrupted() ?? { status: "network", next: "rotate", reachable: false };
    }

    const status = String(response.status);
    if (response.ok) {
      try {
        return { status, next: "done", data: await response.json() };
      } catch {
        return interrupted() ?? { status, next: "malformed" };
      }
    }
    // Upstream error text is never logged or returned. The only thing taken from
    // it is Google's "invalid key" reason on a 400 (matched in memory, then dropped).
    if (response.status === 400) {
      let invalidKey: boolean;
      try {
        invalidKey = INVALID_KEY_REASON.test(await peekText(response, ERROR_BODY_PEEK_LIMIT));
      } catch {
        return interrupted() ?? { status, next: "stop" };
      }
      return invalidKey ? { status, next: "skip", reachable: true } : { status, next: "stop" };
    }
    await response.body?.cancel().catch(() => undefined);
    // 404: this model id is gone. No other key can fix that — move on to the next model.
    if (response.status === 404) return { status, next: "model", reachable: true };
    if (DEAD_KEY_STATUSES.has(response.status)) return { status, next: "skip", reachable: true };
    return TRANSIENT_STATUSES.has(response.status)
      ? { status, next: "rotate", reachable: true }
      : { status, next: "stop" };
  } finally {
    clearTimeout(timer);
    run.removeEventListener("abort", relay);
  }
}

/**
 * Run the leaf-diagnosis request through the key pool and model chain under the
 * shared budget. Never throws for provider trouble: every outcome is a
 * {@link LeafGeminiResult}.
 */
export async function generateLeafGemini(options: LeafGeminiOptions): Promise<LeafGeminiResult> {
  const { keys, models } = options;
  const budgetMs = options.budgetMs ?? LEAF_GEMINI_BUDGET_MS;
  const delayMs = options.rotationDelayMs ?? LEAF_GEMINI_ROTATION_DELAY_MS;
  const timeoutMs = options.attemptTimeoutMs ?? LEAF_GEMINI_ATTEMPT_TIMEOUT_MS;

  let attempts = 0;
  const busy = (status: number): LeafGeminiResult => ({
    ok: false,
    reason: "provider-busy",
    status,
    attempts,
  });
  if (!keys.length || !models.length) return busy(503);

  // One controller for the whole request: the budget deadline and a client
  // disconnect both abort it, which cancels the in-flight call and any pause.
  const run = new AbortController();
  let clientGone = false;
  const onClientAbort = () => {
    clientGone = true;
    run.abort();
  };
  const deadline = setTimeout(() => run.abort(), Math.max(0, budgetMs));
  // No budget left (or a nonsensical one): start nothing, fail closed.
  if (!(budgetMs > 0)) run.abort();
  if (options.signal?.aborted) onClientAbort();
  else options.signal?.addEventListener("abort", onClientAbort, { once: true });

  try {
    // Keys the provider rejected as unusable during THIS request (never retried).
    const dead = new Set<number>();
    let reachable = false;
    for (const model of models) {
      // Still-usable keys in pool order, each tried once; a lone key gets two tries.
      const live = keys.flatMap((_, index) => (dead.has(index) ? [] : [index]));
      const tries = live.length ? Math.max(live.length, LEAF_GEMINI_MIN_ATTEMPTS_PER_MODEL) : 0;
      if (!tries) continue;
      const order = Array.from({ length: tries }, (_, slot) => live[slot % live.length]);
      const body = options.buildBody(model);
      // Kept on one line and one token so the attempt log stays greppable.
      const modelLabel = model.id.replace(/\s+/g, "_");
      let modelGone = false;
      for (let slot = 0; slot < order.length && !modelGone; slot += 1) {
        const keyIndex = order[slot];
        if (dead.has(keyIndex)) continue; // a lone key's second try, after it was rejected
        if (run.signal.aborted) return busy(504);
        attempts += 1;
        const startedAt = Date.now();
        const attempt = await callGemini(
          model, keys[keyIndex], body, run.signal, () => clientGone, timeoutMs,
        );
        console.log(
          `${LOG_TAG} attempt=${attempts} key=${keyIndex + 1}/${keys.length} ` +
            `model=${modelLabel} status=${attempt.status} ms=${Date.now() - startedAt}`,
        );

        switch (attempt.next) {
          case "done":
            return { ok: true, data: attempt.data, model: model.id, attempts };
          case "expired":
            return busy(504);
          case "stop":
            return busy(503);
          case "malformed":
            return { ok: false, reason: "malformed", status: 502, attempts };
          case "skip":
            // Dead key: on to the next one right away, and never back to this one.
            dead.add(keyIndex);
            reachable = true;
            continue;
          case "model":
            // Missing model: leave it for good — no more keys, no second try, no pause.
            modelGone = true;
            reachable = true;
            continue;
          case "rotate":
            break;
        }
        reachable ||= attempt.reachable === true;
        // Rotate to the next key after ~1 s; after the model's last key, fall
        // straight through to the next model.
        if (slot < order.length - 1 && !(await pause(delayMs, run.signal))) return busy(504);
      }
    }
    // Every key × model failed. A provider that never answered at all is a
    // network problem; anything else is the provider being busy.
    return reachable ? busy(503) : { ok: false, reason: "network", status: 502, attempts };
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", onClientAbort);
  }
}
