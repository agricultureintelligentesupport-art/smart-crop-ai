/**
 * Request-scoped Gemini credential pool.
 *
 * Keys are resolved from the server-only environment and sampled randomly
 * without replacement. A single manager should be created per assistant
 * request and shared by every Gemini stage so an image-analysis key cannot be
 * selected again by the text formatter later in that same request.
 */

export type GeminiEnvironment = Readonly<Record<string, string | undefined>>;

export interface GeminiKeyLease {
  /** Server-only credential; never log or return this value. */
  apiKey: string;
  /** One-based selection number for safe, non-secret diagnostics. */
  attempt: number;
  /** Number of distinct configured credentials in this request's pool. */
  poolSize: number;
}

export interface GeminiKeyManager {
  readonly size: number;
  /** Number of distinct keys already selected during this request. */
  readonly attemptedCount: number;
  /** Number of keys that have not yet been selected. */
  readonly remainingCount: number;
  /** Randomly select one untried key, or return null when the pool is empty. */
  next(): GeminiKeyLease | null;
}

/**
 * Resolve all supported Gemini credential variables. Every variable beginning
 * with `GEMINI_API_KEY` participates (`GEMINI_API_KEY`, `GEMINI_API_KEYS`, and
 * numbered variants); comma-separated values are accepted, whitespace is
 * trimmed, duplicates are removed, and numbered names sort numerically.
 */
export function resolveGeminiApiKeys(env: GeminiEnvironment = process.env): string[] {
  const prefix = "GEMINI_API_KEY";
  const configured = Object.entries(env)
    .filter(([name, value]) => name.startsWith(prefix) && typeof value === "string")
    .sort(([first], [second]) => {
      const order = (name: string): [number, string] => {
        if (name === prefix) return [0, name];
        const suffix = name.slice(`${prefix}_`.length);
        return [/^\d+$/.test(suffix) ? Number(suffix) : Number.POSITIVE_INFINITY, name];
      };

      const [firstRank, firstName] = order(first);
      const [secondRank, secondName] = order(second);
      return firstRank - secondRank || firstName.localeCompare(secondName);
    })
    .flatMap(([, value]) => value?.split(",") ?? []);

  return [...new Set(configured.map((key) => key.trim()).filter(Boolean))];
}

/**
 * Create a request-scoped pool that draws each distinct credential at most
 * once. `random` is injectable so the selection contract can be unit-tested;
 * production callers use `Math.random`.
 */
export function createGeminiKeyManager(
  keys: readonly string[],
  random: () => number = Math.random,
): GeminiKeyManager {
  const untried = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  const poolSize = untried.length;
  const attempted = new Set<string>();

  let selectedCount = 0;
  let pendingCount = untried.length;

  return {
    size: poolSize,
    get attemptedCount() {
      return selectedCount;
    },
    get remainingCount() {
      return pendingCount;
    },
    next() {
      while (untried.length > 0) {
        const sample = random();
        const normalizedSample = Number.isFinite(sample)
          ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON)
          : 0;
        const index = Math.floor(normalizedSample * untried.length);
        const [apiKey] = untried.splice(index, 1);
        pendingCount = untried.length;

        // Duplicates are removed on construction, but keep the Set guard here
        // as a final invariant if this implementation is changed later.
        if (attempted.has(apiKey)) continue;
        attempted.add(apiKey);
        selectedCount += 1;
        return { apiKey, attempt: selectedCount, poolSize };
      }
      return null;
    },
  };
}
