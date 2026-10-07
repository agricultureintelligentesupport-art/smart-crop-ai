/**
 * Route-level tests for the resilience policy of `POST /api/leaf-diagnose`:
 * key rotation over the env key pool, model fallback over the shared chain, the
 * ~50 s budget inside `maxDuration = 60`, and an unchanged response contract.
 *
 * The helper itself is covered in `leaf-diagnose-gemini.unit.test.ts`; these
 * tests prove the ROUTE is wired to it. Time is mocked (`mock.timers`), so the
 * real 1 s / 20 s / 50 s defaults run without waiting.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import baseTest, { afterEach, beforeEach, type TestContext } from "node:test";
import { inspect } from "node:util";
import sharp from "sharp";
import * as route from "../../src/app/api/leaf-diagnose/route";
import { GEMINI_FALLBACK_MODELS, GEMINI_MODEL_DEFAULT } from "../../src/lib/assistant/gemini-models";
import { LEAF_RESPONSE_SCHEMA, parseLeafDiagnosis } from "../../src/lib/leaf-diagnose";
import { LEAF_GEMINI_BUDGET_MS } from "../../src/lib/leaf-diagnose-gemini";

const { POST } = route;

/** A regression into a hang becomes a failing test, not a stalled run. */
const test = (name: string, run: (t: TestContext) => Promise<void> | void) =>
  baseTest(name, { timeout: 15_000 }, run);

// Test-process-only credentials (restored after every test); no env file or real provider call is touched.
const originalEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("GEMINI_API_KEY") || key === "GEMINI_MODEL"),
);
function clearTestEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GEMINI_API_KEY") || key === "GEMINI_MODEL") delete process.env[key];
  }
}
const POOL = ["route-secret-ALPHA", "route-secret-BRAVO", "route-secret-CHARLIE"] as const;
beforeEach((t) => {
  clearTestEnv();
  process.env.GEMINI_API_KEY = POOL[0];
  process.env.GEMINI_API_KEY_2 = POOL[1];
  process.env.GEMINI_API_KEYS = ` ${POOL[2]} , ${POOL[0]} `; // comma pool + a duplicate of the first key
  // The rotation is a RANDOM draw per request (`shuffleGeminiKeyPool`). This
  // suite asserts the exact rotation sequence, so the generator is pinned to
  // its maximum, which yields the identity draw (the configured inventory
  // order) — the randomization itself is covered in
  // `providers.unit.test.ts` and `assistant-route.unit.test.ts`.
  if ("mock" in t) t.mock.method(Math, "random", () => 1 - Number.EPSILON);
});
afterEach(() => {
  clearTestEnv();
  Object.assign(process.env, originalEnv);
});

const fixture = {
  isPlant: true, plantNameAr: "طماطم", verdict: "diseased", diseaseNameAr: "اللفحة المبكرة",
  confidence: 0.84, findings: [{ labelAr: "بقع بنية", box: [100, 200, 300, 450], severity: "medium" }],
};
const answer = () => Response.json({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(fixture) }] } }],
});
const status = (code: number, body = "PRIVATE upstream text") => new Response(body, { status: code });
const picture = () => sharp({ create: { width: 40, height: 30, channels: 3, background: "#487b45" } }).jpeg().toBuffer();
function upload(bytes: Uint8Array, signal?: AbortSignal) {
  const body = new FormData();
  body.append("image", new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }), "leaf");
  return new Request("http://unit.test/api/leaf-diagnose", { method: "POST", body, signal });
}

interface Call { key: string; model: string; url: string; at: number; config: Record<string, unknown> }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Mocked time plus a virtual clock for timestamping upstream calls. */
function mockClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: 0 };
  const advance = (ms: number) => { t.mock.timers.tick(ms); clock.now += ms; };
  return { clock, advance };
}

/** Script the upstream; `reached(n)` resolves once the n-th upstream call has been made. */
function upstream(
  t: TestContext,
  respond: (call: Call, n: number, init: RequestInit) => Response | Promise<Response>,
  clock?: { now: number },
) {
  const calls: Call[] = [];
  let waiters: { count: number; resolve: () => void }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      key: headers["x-goog-api-key"],
      model: decodeURIComponent(/models\/([^:]+):generateContent$/.exec(String(url))?.[1] ?? "?"),
      url: String(url),
      at: clock?.now ?? 0,
      config: JSON.parse(String(init?.body)).generationConfig,
    });
    waiters = waiters.filter((waiter) => (calls.length >= waiter.count ? (waiter.resolve(), false) : true));
    return respond(calls[calls.length - 1], calls.length, init ?? {});
  });
  // Resolves once the n-th upstream call was made AND everything it triggered has settled
  // (response handled, attempt logged, next pause armed) — only then is it safe to advance mocked time.
  const reached = async (count: number) => {
    if (calls.length < count) await new Promise<void>((resolve) => waiters.push({ count, resolve }));
    await flush();
  };
  return { calls, reached };
}

const stall = (_call: Call, _n: number, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
  });

/** Tick 1 s at a time until the route's promise settles. */
async function finish<T>(advance: (ms: number) => void, pending: Promise<T>, maxSteps = 120): Promise<T> {
  let settled = false;
  const tracked = pending.finally(() => { settled = true; });
  for (let step = 0; step < maxSteps && !settled; step += 1) {
    await flush();
    if (settled) break;
    advance(1_000);
  }
  await flush();
  assert.ok(settled, "route did not settle");
  return tracked;
}

function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
    });
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  maxDuration                                                        */
/* ------------------------------------------------------------------ */

test("maxDuration is 60 for this route — a static literal Next can read — and the budget fits inside it", () => {
  assert.equal(route.maxDuration, 60);
  assert.equal(route.runtime, "nodejs");
  const source = fs.readFileSync(new URL("../../src/app/api/leaf-diagnose/route.ts", import.meta.url), "utf8");
  assert.match(source, /^export const maxDuration = 60;$/m);
  assert.equal(LEAF_GEMINI_BUDGET_MS, 50_000);
  assert.ok(LEAF_GEMINI_BUDGET_MS < route.maxDuration * 1_000, "budget leaves headroom under maxDuration");
});

/* ------------------------------------------------------------------ */
/*  Rotation + fallback through the real env pool and shared chain     */
/* ------------------------------------------------------------------ */

test("route: rotates the env key pool after ~1 s, falls to the next shared-chain model, and the response contract is unchanged", async (t) => {
  const { clock, advance } = mockClock(t);
  const { calls, reached } = upstream(t, (call) => (call.model === GEMINI_MODEL_DEFAULT.id ? status(503) : answer()), clock);
  const pending = POST(upload(await picture()));

  await reached(1);
  advance(999);
  await flush();
  assert.equal(calls.length, 1, "no rotation before ~1 s");
  advance(1);
  await reached(2);
  advance(1_000);
  await reached(4); // third key, then — with no pause — the next model's first key
  const response = await pending;

  const fallback = GEMINI_FALLBACK_MODELS[0];
  assert.deepEqual(
    calls.map((call) => call.key),
    [POOL[0], POOL[1], POOL[2], POOL[0]],
    "identity draw: base, _2, then the comma pool; the duplicate credential is tried once per cycle",
  );
  assert.deepEqual(calls.map((call) => call.model), [GEMINI_MODEL_DEFAULT.id, GEMINI_MODEL_DEFAULT.id, GEMINI_MODEL_DEFAULT.id, fallback.id]);
  assert.deepEqual(calls.map((call) => call.at), [0, 1_000, 2_000, 2_000]);
  assert.deepEqual(calls[0].config.thinkingConfig, GEMINI_MODEL_DEFAULT.thinking);
  assert.deepEqual(calls[3].config.thinkingConfig, fallback.thinking);

  // Unchanged contract: 200, exactly the parsed diagnosis with exactly the schema's keys, no-store.
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, parseLeafDiagnosis(JSON.stringify(fixture)));
  assert.deepEqual(Object.keys(body).sort(), [...LEAF_RESPONSE_SCHEMA.required].sort());
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("x-leaf-diagnose-reason"), null);
});

test("route: a GEMINI_MODEL pin leads the chain (no thinkingConfig) and the shared fallbacks still follow", async (t) => {
  process.env.GEMINI_MODEL = " pinned-model ";
  const { advance } = mockClock(t);
  const { calls, reached } = upstream(t, (call) => (call.model === "pinned-model" ? status(429) : answer()));
  const pending = POST(upload(await picture()));
  await reached(1);
  const response = await finish(advance, pending);

  assert.equal(response.status, 200);
  assert.deepEqual(
    [...new Set(calls.map((call) => call.model))],
    ["pinned-model", GEMINI_FALLBACK_MODELS[0].id],
  );
  assert.equal(calls[0].config.thinkingConfig, undefined);
  assert.equal(calls.filter((call) => call.model === "pinned-model").length, 3, "every pooled key tried on the pinned model first");
});

test("route: when every key × model fails, provider-busy 503 comes back only after all of them were tried", async (t) => {
  delete process.env.GEMINI_API_KEYS; // two keys: ALPHA, BRAVO
  const { advance } = mockClock(t);
  const { calls, reached } = upstream(t, () => status(503));
  const pending = POST(upload(await picture()));
  await reached(1);
  const response = await finish(advance, pending);

  assert.equal(calls.length, 2 * (1 + GEMINI_FALLBACK_MODELS.length), "2 keys × 3 models");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

/* ------------------------------------------------------------------ */
/*  No retry on 400; 404 = the model is gone, so on to the next one    */
/* ------------------------------------------------------------------ */

test("route: a 400 is not retried — one upstream call even with three keys and three models", async (t) => {
  const { advance } = mockClock(t);
  const { calls, reached } = upstream(t, () => status(400, "PRIVATE upstream details"));
  const pending = POST(upload(await picture()));
  await reached(1);
  const response = await finish(advance, pending, 3);

  assert.equal(calls.length, 1);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
});

test("route: a 404 on the head model skips to the next model at once — same first key, no pause, no repeat", async (t) => {
  const { clock } = mockClock(t);
  const fallback = GEMINI_FALLBACK_MODELS[0];
  const { calls, reached } = upstream(
    t,
    (call) => (call.model === GEMINI_MODEL_DEFAULT.id ? status(404, "PRIVATE models/x is not found") : answer()),
    clock,
  );
  const pending = POST(upload(await picture()));
  await reached(2); // no time is advanced: a pause before the 2nd call would leave this pending forever
  const response = await pending;

  assert.deepEqual(
    calls.map((call) => [call.model, call.key, call.at]),
    [[GEMINI_MODEL_DEFAULT.id, POOL[0], 0], [fallback.id, POOL[0], 0]],
    "one try on the missing model (not the other two keys), then the next model from the first key",
  );
  assert.deepEqual(calls[1].config.thinkingConfig, fallback.thinking, "the next model gets its own thinkingConfig");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), parseLeafDiagnosis(JSON.stringify(fixture)));
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("route: a retired GEMINI_MODEL pin (404) is skipped in favour of the shared fallbacks", async (t) => {
  process.env.GEMINI_MODEL = " retired-model ";
  const { clock } = mockClock(t);
  const { calls, reached } = upstream(t, (call) => (call.model === "retired-model" ? status(404) : answer()), clock);
  const pending = POST(upload(await picture()));
  await reached(2);
  const response = await pending;

  assert.deepEqual(calls.map((call) => call.model), ["retired-model", GEMINI_FALLBACK_MODELS[0].id]);
  assert.equal(calls[0].config.thinkingConfig, undefined);
  assert.equal(response.status, 200);
});

test("route: when every model 404s, each is tried exactly once and the answer is provider-busy 503", async (t) => {
  const { clock } = mockClock(t);
  const { calls, reached } = upstream(t, () => status(404, "PRIVATE upstream details"), clock);
  const pending = POST(upload(await picture()));
  await reached(1 + GEMINI_FALLBACK_MODELS.length);
  const response = await pending;

  assert.deepEqual(
    calls.map((call) => [call.model, call.key, call.at]),
    [GEMINI_MODEL_DEFAULT, ...GEMINI_FALLBACK_MODELS].map((model) => [model.id, POOL[0], 0]),
    "one attempt per model, no key rotation, no waiting",
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

/* ------------------------------------------------------------------ */
/*  Dead keys: skipped at once, like the chat                          */
/* ------------------------------------------------------------------ */

test("route: a dead head key (403) is skipped at once and the next pooled key answers", async (t) => {
  const { clock } = mockClock(t);
  const { calls, reached } = upstream(t, (call) => (call.key === POOL[0] ? status(403) : answer()), clock);
  const pending = POST(upload(await picture()));
  await reached(2); // no time is advanced: a pause before the 2nd call would leave this pending forever
  const response = await pending;

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), parseLeafDiagnosis(JSON.stringify(fixture)));
  assert.deepEqual(calls.map((call) => [call.key, call.at]), [[POOL[0], 0], [POOL[1], 0]]);
});

test("route: a 400 that Google tags API_KEY_INVALID is skipped at once; any other 400 stays terminal", async (t) => {
  const { clock } = mockClock(t);
  const invalid = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } });
  const dead = upstream(t, (call) => (call.key === POOL[0] ? status(400, invalid) : answer()), clock);
  const pending = POST(upload(await picture()));
  await dead.reached(2);
  assert.equal((await pending).status, 200);
  assert.deepEqual(dead.calls.map((call) => call.key), [POOL[0], POOL[1]]);

  t.mock.restoreAll();
  const ordinary = upstream(t, () => status(400, JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT" } })), clock);
  const second = POST(upload(await picture()));
  await ordinary.reached(1);
  const response = await second;
  assert.equal(ordinary.calls.length, 1, "an ordinary 400 is never retried");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
});

test("route: when every pooled key is dead, one attempt per key ends it with provider-busy 503", async (t) => {
  const { clock } = mockClock(t);
  const { calls, reached } = upstream(t, () => status(401), clock);
  const pending = POST(upload(await picture()));
  await reached(POOL.length);
  const response = await pending;

  assert.deepEqual(calls.map((call) => call.key), [...POOL], "each key once, no model walk, no waiting");
  assert.deepEqual(calls.map((call) => call.at), [0, 0, 0]);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
});

/* ------------------------------------------------------------------ */
/*  Budget                                                             */
/* ------------------------------------------------------------------ */

test("route: a stalled upstream is cut at ~50 s with provider-busy 504 — never earlier, nothing started after", async (t) => {
  const { clock, advance } = mockClock(t);
  const { calls, reached } = upstream(t, stall, clock);
  const pending = POST(upload(await picture()));
  await reached(1);
  const response = await finish(advance, pending);

  assert.deepEqual(calls.map((call) => [call.key, call.at]), [[POOL[0], 0], [POOL[1], 21_000], [POOL[2], 42_000]]);
  assert.ok(clock.now >= 49_000 && clock.now <= LEAF_GEMINI_BUDGET_MS, `settled at ${clock.now} ms`);
  assert.ok(calls.every((call) => call.at < LEAF_GEMINI_BUDGET_MS));
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
});

test("route: time already spent before the Gemini call (upload, validation) counts against the same ~50 s budget", async (t) => {
  const { clock, advance } = mockClock(t);
  const { calls, reached } = upstream(t, stall, clock);
  // Simulate a slow upload: every Date.now() read after the handler's first one is 10 s later.
  const realNow = Date.now.bind(Date);
  let armed = false;
  let reads = 0;
  t.mock.method(Date, "now", () => realNow() + (armed && reads++ > 0 ? 10_000 : 0));
  const request = upload(await picture());
  armed = true;
  const pending = POST(request); // its very first statement reads the clock (the budget's start)
  await reached(1);
  const response = await finish(advance, pending);

  const remaining = LEAF_GEMINI_BUDGET_MS - 10_000;
  assert.equal(response.status, 504);
  assert.ok(clock.now >= remaining - 1_000 && clock.now <= remaining, `settled at ${clock.now} ms, expected ≈ ${remaining}`);
  // 0 s and 21 s start; the 42 s attempt would be past the shortened 40 s budget.
  assert.deepEqual(calls.map((call) => call.at), [0, 21_000]);
});

test("route: a client disconnect cancels the upstream call and stops all further attempts", async (t) => {
  const { advance } = mockClock(t);
  const { calls, reached } = upstream(t, stall);
  const client = new AbortController();
  const pending = POST(upload(await picture(), client.signal));
  await reached(1);
  client.abort();
  const response = await pending;
  advance(10_000);
  await flush();

  assert.equal(calls.length, 1, "no attempt after the disconnect");
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
});

/* ------------------------------------------------------------------ */
/*  Logging and secrets                                                */
/* ------------------------------------------------------------------ */

test("route: one log line per attempt, and no key, image or upstream text ever leaves in logs or the response", async (t) => {
  const lines = captureConsole(t);
  const bytes = await picture();
  const { advance } = mockClock(t);
  const { calls, reached } = upstream(t, (call, n) => {
    if (n === 1) return status(429, `quota exceeded for ${call.key}`);
    if (n === 2) throw new Error(`socket hang up ${call.key}`);
    return answer();
  });
  const pending = POST(upload(bytes));
  await reached(1);
  const response = await finish(advance, pending);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(lines.length, 3, "exactly one line per attempt");
  const attemptLine = /^\[leaf-diagnose\] attempt=(\d+) key=(\d+)\/3 model=(\S+) status=(\d{3}|network) ms=\d+$/;
  for (const line of lines) assert.match(line, attemptLine);
  assert.deepEqual(lines.map((line) => attemptLine.exec(line)?.[4]), ["429", "network", "200"]);
  assert.deepEqual(lines.map((line) => attemptLine.exec(line)?.[2]), ["1", "2", "3"]);

  const everything = [...lines, body, JSON.stringify([...response.headers])].join("\n");
  for (const secret of [...POOL, bytes.toString("base64"), "quota exceeded", "socket hang up", "PRIVATE"]) {
    assert.ok(!everything.includes(secret), `leaked: ${secret.slice(0, 24)}`);
  }
});
