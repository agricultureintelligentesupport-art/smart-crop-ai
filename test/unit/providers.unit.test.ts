/**
 * Unit tests for `src/lib/assistant/providers.ts` — the hardened credential,
 * timeout and redaction plumbing shared by `/api/assistant` and both
 * `/api/health/*` probes.
 *
 * What is guarded here, in one place:
 *   • the Hugging Face token is read from EXACTLY `HUGGINGFACE_API_KEY`,
 *     trimmed, with no alias and no hardcoded fallback;
 *   • the Gemini rotation order is `GEMINI_API_KEY_4` first, then the base
 *     variable and the numbered variants in numeric order;
 *   • the in-memory rotation state (10-minute quota parks, 60-minute invalid
 *     keys, the 10-minute HF 402 credit circuit) behaves as specified;
 *   • every message that can reach a log or a response body is redacted, and
 *     the 8 s per-attempt / 60 s global timeouts are enforced with real
 *     AbortController timers.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import {
  DeadlineExceededError,
  ENABLE_HUGGINGFACE,
  isHuggingFaceEnabled,
  shuffleGeminiKeyPool,
  GEMINI_CATALOG_TTL_MS,
  GEMINI_INVALID_TTL_MS,
  GEMINI_KEY_NAME_PATTERN,
  GEMINI_LEGACY_POOL_NAME,
  GEMINI_PRIORITY_KEY_NAME,
  GEMINI_QUOTA_TTL_MS,
  GLOBAL_DEADLINE_MS,
  HF_CREDITS_SKIP_MS,
  HF_TOKEN_ENV_NAME,
  HfCreditCircuit,
  PER_ATTEMPT_TIMEOUT_MS,
  REQUIRED_ENV_VARS,
  RequestDeadline,
  GeminiKeyState,
  fetchWithAttemptTimeout,
  isPriorityGeminiKeyMissing,
  redactSecrets,
  resolveGeminiKeyPool,
  resolveHuggingFaceToken,
  safeSecretEquals,
  shortMessage,
} from "../../src/lib/assistant/providers";

/* ------------------------------------------------------------------ */
/*  Environment scrubbing                                              */
/* ------------------------------------------------------------------ */

const SCRUBBED = /^(GEMINI_API_KEY|GEMINI_API_KEYS|GEMINI_MODEL|HUGGINGFACE_API_KEY|HF_TOKEN|HEALTH_SECRET)/;
const original: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (SCRUBBED.test(name)) original[name] = value;
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (SCRUBBED.test(name)) delete process.env[name];
  }
});

afterEach(() => {
  mock.restoreAll();
  for (const name of Object.keys(process.env)) {
    if (SCRUBBED.test(name)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(original)) {
    if (value !== undefined) process.env[name] = value;
  }
});

/* ------------------------------------------------------------------ */
/*  Hugging Face token                                                 */
/* ------------------------------------------------------------------ */

test("the Hugging Face token is read from exactly one variable name", () => {
  assert.equal(HF_TOKEN_ENV_NAME, "HUGGINGFACE_API_KEY");
  process.env.HUGGINGFACE_API_KEY = "  hf_example_token  ";
  assert.equal(resolveHuggingFaceToken(), "hf_example_token");
  // The conventional Hugging Face SDK name is NOT consulted any more.
  delete process.env.HUGGINGFACE_API_KEY;
  process.env.HF_TOKEN = "hf_alias_token";
  assert.equal(resolveHuggingFaceToken(), null);
});

test("blank and whitespace-only tokens resolve to null (never a falsy string)", () => {
  for (const value of ["", "   ", "\n\t "]) {
    process.env.HUGGINGFACE_API_KEY = value;
    assert.equal(resolveHuggingFaceToken(), null);
  }
});

test("newlines pasted with the secret are trimmed away", () => {
  process.env.HUGGINGFACE_API_KEY = "hf_token_with_newline\n";
  assert.equal(resolveHuggingFaceToken(), "hf_token_with_newline");
});

/* ------------------------------------------------------------------ */
/*  Gemini key pool                                                    */
/* ------------------------------------------------------------------ */

test("the documented variable shapes are the only ones collected", () => {
  assert.match("GEMINI_API_KEY", GEMINI_KEY_NAME_PATTERN);
  assert.match("GEMINI_API_KEY_2", GEMINI_KEY_NAME_PATTERN);
  assert.equal(GEMINI_KEY_NAME_PATTERN.test("GEMINI_API_KEYS"), false);
  assert.equal(GEMINI_KEY_NAME_PATTERN.test("MY_GEMINI_API_KEY"), false);
  assert.equal(GEMINI_KEY_NAME_PATTERN.test("GEMINI_API_KEY_X"), false);
});

test("GEMINI_API_KEY_4 leads the rotation, then the base variable and the numbered variants", () => {
  process.env.GEMINI_API_KEY = "base-key";
  process.env.GEMINI_API_KEY_2 = "second-key";
  process.env.GEMINI_API_KEY_3 = "third-key";
  process.env.GEMINI_API_KEY_4 = "priority-key";
  process.env.GEMINI_API_KEY_5 = "fifth-key";

  assert.deepEqual(resolveGeminiKeyPool(), [
    { name: "GEMINI_API_KEY_4", key: "priority-key" },
    { name: "GEMINI_API_KEY", key: "base-key" },
    { name: "GEMINI_API_KEY_2", key: "second-key" },
    { name: "GEMINI_API_KEY_3", key: "third-key" },
    { name: "GEMINI_API_KEY_5", key: "fifth-key" },
  ]);
  assert.equal(isPriorityGeminiKeyMissing(), false);
});

test("a missing GEMINI_API_KEY_4 is reported as missing and the rest still rotates", () => {
  process.env.GEMINI_API_KEY = "base-key";
  process.env.GEMINI_API_KEY_2 = "second-key";
  assert.equal(isPriorityGeminiKeyMissing(), true);
  assert.deepEqual(
    resolveGeminiKeyPool().map((entry) => entry.name),
    ["GEMINI_API_KEY", "GEMINI_API_KEY_2"],
  );
});

test("comma pools, whitespace and duplicates are normalised first-wins", () => {
  process.env.GEMINI_API_KEY = " alpha , , beta ";
  process.env.GEMINI_API_KEY_2 = " beta , gamma ";
  process.env.GEMINI_API_KEYS = " alpha , delta ";
  assert.deepEqual(resolveGeminiKeyPool(), [
    { name: "GEMINI_API_KEY#1", key: "alpha" },
    { name: "GEMINI_API_KEY#2", key: "beta" },
    { name: "GEMINI_API_KEY_2#2", key: "gamma" },
    { name: `${GEMINI_LEGACY_POOL_NAME}#2`, key: "delta" },
  ]);
});

test("blank values never enter the pool", () => {
  process.env.GEMINI_API_KEY = "   ";
  process.env.GEMINI_API_KEY_2 = "";
  assert.deepEqual(resolveGeminiKeyPool(), []);
});

/* ------------------------------------------------------------------ */
/*  Rotation state                                                     */
/* ------------------------------------------------------------------ */

test("quota exhaustion is tracked per (key NAME, model) and expires after 10 minutes", () => {
  let now = 1_000;
  const state = new GeminiKeyState(() => now);
  state.markQuotaExhausted("GEMINI_API_KEY_4", "gemini-3.8-flash");
  assert.equal(state.isQuotaExhausted("GEMINI_API_KEY_4", "gemini-3.8-flash"), true);
  // Another model on the same key is still eligible — quotas are per-model.
  assert.equal(state.isQuotaExhausted("GEMINI_API_KEY_4", "gemini-3.5-flash"), false);
  // Another key is untouched.
  assert.equal(state.isQuotaExhausted("GEMINI_API_KEY", "gemini-3.8-flash"), false);
  now += GEMINI_QUOTA_TTL_MS + 1;
  assert.equal(state.isQuotaExhausted("GEMINI_API_KEY_4", "gemini-3.8-flash"), false);
});

test("a key marked invalid is skipped for 60 minutes, then reconsidered", () => {
  let now = 5_000;
  const state = new GeminiKeyState(() => now);
  state.markInvalid("GEMINI_API_KEY_2");
  assert.equal(state.isInvalid("GEMINI_API_KEY_2"), true);
  assert.equal(state.isInvalid("GEMINI_API_KEY_3"), false);
  now += GEMINI_INVALID_TTL_MS - 1;
  assert.equal(state.isInvalid("GEMINI_API_KEY_2"), true);
  now += 2;
  assert.equal(state.isInvalid("GEMINI_API_KEY_2"), false);
});

test("state reset clears both maps (test isolation, config reload)", () => {
  const state = new GeminiKeyState();
  state.markInvalid("GEMINI_API_KEY");
  state.markQuotaExhausted("GEMINI_API_KEY", "gemini-3.8-flash");
  state.reset();
  assert.equal(state.isInvalid("GEMINI_API_KEY"), false);
  assert.equal(state.isQuotaExhausted("GEMINI_API_KEY", "gemini-3.8-flash"), false);
});

test("the HF credit circuit parks the whole chain for 10 minutes after a 402", () => {
  let now = 0;
  const circuit = new HfCreditCircuit(() => now);
  assert.equal(circuit.isOpen, false);
  circuit.trip();
  assert.equal(circuit.isOpen, true);
  assert.equal(circuit.remainingMs, HF_CREDITS_SKIP_MS);
  now += HF_CREDITS_SKIP_MS + 1;
  assert.equal(circuit.isOpen, false);
  circuit.trip();
  circuit.reset();
  assert.equal(circuit.isOpen, false);
});

/* ------------------------------------------------------------------ */
/*  Redaction                                                          */
/* ------------------------------------------------------------------ */

test("every credential shape is redacted before a message can be logged", () => {
  const hf = "hf_abcdefghijklmnopqrstuvwxyz012345";
  const google = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWX1234567";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature";
  const message = [
    `Authorization: Bearer ${jwt}`,
    `failed at https://example.test/v1?key=${google}&x=1`,
    `body: {"error":"bad token ${hf}"}`,
  ].join(" | ");

  const safe = redactSecrets(message);
  assert.doesNotMatch(safe, /hf_[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(safe, /AIza[0-9A-Za-z_-]{8,}/);
  assert.doesNotMatch(safe, /eyJhbGciOiJIUzI1NiJ9/);
  assert.match(safe, /\[redacted-hf-token\]/);
  assert.match(safe, /key=\[redacted\]/);
  assert.match(safe, /Bearer \[redacted\]/);
});

test("shortMessage collapses whitespace, redacts and caps the length", () => {
  const long = `line one\n\n   line two ${"x".repeat(500)}`;
  const safe = shortMessage(long, 60);
  assert.ok(safe.length <= 61, `expected ≤ 61 chars, got ${safe.length}`);
  assert.match(safe, /line one line two/);
  assert.match(safe, /…$/);
  assert.ok(shortMessage("  clean   text  ") === "clean text");
});

/* ------------------------------------------------------------------ */
/*  Timeouts                                                           */
/* ------------------------------------------------------------------ */

test("the shared windows are the agreed 8 s attempt and 60 s deadline", () => {
  assert.equal(PER_ATTEMPT_TIMEOUT_MS, 8_000);
  assert.equal(GLOBAL_DEADLINE_MS, 60_000);
  // The deadline is the platform ceiling: keep `maxDuration` at or above it so
  // the route's own 503 wins the race instead of a bare platform timeout.
  assert.ok(GLOBAL_DEADLINE_MS <= 60_000);
  assert.ok(GEMINI_CATALOG_TTL_MS === 60 * 60 * 1000);
});

test("the request deadline arms one AbortController and disposes cleanly", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const deadline = new RequestDeadline(1_000);
    assert.equal(deadline.signal.aborted, false);
    assert.equal(deadline.expired, false);
    mock.timers.tick(1_001);
    assert.equal(deadline.signal.aborted, true);
    assert.equal(deadline.expired, true);
    deadline.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("an attempt is cancelled by its OWN 8 s window, not by the 60 s deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const deadline = new RequestDeadline();
    const fetchMock = mock.method(globalThis, "fetch", (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () =>
          reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
        );
      }),
    );
    const pending = fetchWithAttemptTimeout("https://example.test/x", {}, deadline);
    const rejection = assert.rejects(pending, (error: unknown) => {
      // The attempt window fired: this is NOT the global deadline.
      assert.equal(error instanceof DeadlineExceededError, false);
      return true;
    });
    mock.timers.tick(PER_ATTEMPT_TIMEOUT_MS + 1);
    await rejection;
    assert.equal(deadline.expired, false, "the global deadline must still be armed");
    assert.equal(fetchMock.mock.callCount(), 1);
    deadline.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("an attempt aborted by the global deadline surfaces DeadlineExceededError", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const deadline = new RequestDeadline();
    mock.method(globalThis, "fetch", (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () =>
          reject(new Error("aborted by deadline")),
        );
      }),
    );
    const pending = fetchWithAttemptTimeout("https://example.test/x", {}, deadline);
    const rejection = assert.rejects(pending, DeadlineExceededError);
    mock.timers.tick(GLOBAL_DEADLINE_MS + 1);
    await rejection;
    deadline.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("no request is issued once the deadline has already expired", async () => {
  const deadline = new RequestDeadline(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(deadline.expired, true);
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({}));
  await assert.rejects(
    fetchWithAttemptTimeout("https://example.test/x", {}, deadline),
    DeadlineExceededError,
  );
  assert.equal(fetchMock.mock.callCount(), 0);
  deadline.dispose();
});

/* ------------------------------------------------------------------ */
/*  Health endpoints                                                   */
/* ------------------------------------------------------------------ */

test("the required server variables include HEALTH_SECRET and both providers", () => {
  assert.ok(REQUIRED_ENV_VARS.includes("HEALTH_SECRET"));
  assert.ok(REQUIRED_ENV_VARS.includes("HUGGINGFACE_API_KEY"));
  assert.ok(REQUIRED_ENV_VARS.includes("GEMINI_API_KEY"));
  // Hugging Face is soft-blocked by default, so no ROTATION LEADER is required:
  // the pool is a random draw over whatever `GEMINI_API_KEY*` variables exist.
  assert.equal(ENABLE_HUGGINGFACE, false);
  assert.equal(isHuggingFaceEnabled({}), false);
  assert.equal(isHuggingFaceEnabled({ ENABLE_HUGGINGFACE: "1" }), true);
  assert.equal(isHuggingFaceEnabled({ ENABLE_HUGGINGFACE: "TRUE" }), true);
  assert.equal(isHuggingFaceEnabled({ ENABLE_HUGGINGFACE: "false" }), false);
  assert.ok(GEMINI_PRIORITY_KEY_NAME === "GEMINI_API_KEY_4");
});

test("the Gemini pool is drawn in a random order: a permutation, never a repeat", () => {
  const pool = [
    { name: "GEMINI_API_KEY", key: "a" },
    { name: "GEMINI_API_KEY_2", key: "b" },
    { name: "GEMINI_API_KEY_4", key: "c" },
  ];

  // Identity draw: the configured inventory order, byte for byte.
  assert.deepEqual(
    shuffleGeminiKeyPool(pool, () => 1 - Number.EPSILON).map((entry) => entry.key),
    ["a", "b", "c"],
  );
  // Another draw is a genuine (deterministic) permutation…
  const other = shuffleGeminiKeyPool(pool, () => 0).map((entry) => entry.key);
  assert.notDeepEqual(other, ["a", "b", "c"]);
  assert.deepEqual([...other].sort(), ["a", "b", "c"]);
  // …and the input array is never mutated.
  assert.deepEqual(pool.map((entry) => entry.key), ["a", "b", "c"]);

  // Every draw of the REAL generator is a permutation: no key can be lost or
  // repeated inside one request cycle, whatever the generator returns.
  for (let round = 0; round < 200; round += 1) {
    const drawn = shuffleGeminiKeyPool(pool).map((entry) => entry.key);
    assert.deepEqual([...drawn].sort(), ["a", "b", "c"]);
  }
  // A one-key pool and an empty pool are returned unchanged.
  assert.deepEqual(shuffleGeminiKeyPool([pool[0]]).map((e) => e.key), ["a"]);
  assert.deepEqual(shuffleGeminiKeyPool([]), []);
});

test("the health secret is compared in constant time and fails closed on mismatch", () => {
  assert.equal(safeSecretEquals("s3cret", "s3cret"), true);
  assert.equal(safeSecretEquals("s3crey", "s3cret"), false);
  assert.equal(safeSecretEquals("", "s3cret"), false);
  assert.equal(safeSecretEquals(null, "s3cret"), false);
  // Length differences must be rejected (and must not throw).
  assert.equal(safeSecretEquals("s3cret-longer", "s3cret"), false);
  assert.equal(safeSecretEquals("s3cre", "s3cret"), false);
});
