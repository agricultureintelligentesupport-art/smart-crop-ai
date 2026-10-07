/**
 * Unit tests for `src/lib/leaf-diagnose-gemini.ts` — the key-rotation / model
 * fallback / time-budget transport used ONLY by `/api/leaf-diagnose`.
 *
 * Everything runs against a scripted `fetch`. Timing-sensitive cases use
 * `mock.timers` with a tiny virtual-time driver, so the real defaults
 * (~1 s rotation pause, 20 s per call, 50 s budget) are verified without
 * waiting in real time.
 */
import assert from "node:assert/strict";
import baseTest, { type TestContext } from "node:test";
import { inspect } from "node:util";
import {
  GEMINI_FALLBACK_MODELS,
  GEMINI_MODEL_DEFAULT,
  type GeminiModel,
} from "../../src/lib/assistant/gemini-models";
import {
  LEAF_GEMINI_ATTEMPT_TIMEOUT_MS,
  LEAF_GEMINI_BUDGET_MS,
  LEAF_GEMINI_ROTATION_DELAY_MS,
  generateLeafGemini,
  resolveLeafGeminiKeys,
  resolveLeafGeminiModels,
  type LeafGeminiOptions,
} from "../../src/lib/leaf-diagnose-gemini";

/**
 * Every test here gets a timeout: if rotation/abort wiring ever regresses into a
 * hang, the run reports a failing test instead of stalling forever.
 */
const test = (name: string, run: (t: TestContext) => Promise<void> | void) =>
  baseTest(name, { timeout: 15_000 }, run);

/* ------------------------------------------------------------------ */
/*  Fixtures and helpers                                               */
/* ------------------------------------------------------------------ */

const KEYS = ["AIza-test-key-ALPHA", "AIza-test-key-BRAVO", "AIza-test-key-CHARLIE"] as const;
const MODELS: readonly GeminiModel[] = [{ id: "model-one" }, { id: "model-two" }, { id: "model-three" }];
const ATTEMPT_LINE =
  /^\[leaf-diagnose\] attempt=(\d+) key=(\d+)\/(\d+) model=(\S+) status=(\d{3}|network|timeout|aborted) ms=(\d+)$/;

interface Call { n: number; model: string; key: string; url: string; at: number }
type Responder = (call: Call, init: RequestInit) => Response | Promise<Response>;

/** Replace global fetch with a script; every call is recorded (never the key in the URL). */
function scriptFetch(t: TestContext, respond: Responder, clock?: { now: number }): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      n: calls.length + 1,
      model: /models\/([^:]+):generateContent$/.exec(String(url))?.[1] ?? "?",
      key: headers["x-goog-api-key"],
      url: String(url),
      at: clock?.now ?? 0,
    };
    calls.push(call);
    return respond(call, init ?? {});
  });
  return calls;
}

const status = (code: number, body = "PRIVATE upstream text") => new Response(body, { status: code });
/** What Google returns for an invalid or deleted key (HTTP 400). */
const invalidKeyBody = (echo = "") => JSON.stringify({
  error: {
    code: 400,
    message: `API key not valid. Please pass a valid API key. ${echo}`.trim(),
    status: "INVALID_ARGUMENT",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "API_KEY_INVALID",
      domain: "googleapis.com",
      metadata: { service: "generativelanguage.googleapis.com" },
    }],
  },
});
const otherBadRequestBody = JSON.stringify({
  error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" },
});
const answer = () => Response.json({ candidates: [{ finishReason: "STOP" }] });
/** A call that never answers; it only ends when its AbortSignal fires. */
const stall: Responder = (_call, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
  });

/** No pause between keys — for tests that are not about timing. */
const fast = (over: Partial<LeafGeminiOptions> = {}): LeafGeminiOptions => ({
  keys: KEYS, models: MODELS, buildBody: () => "{}", rotationDelayMs: 0, ...over,
});
/** Production timing defaults (no overrides). */
const real = (over: Partial<LeafGeminiOptions> = {}): LeafGeminiOptions => ({
  keys: KEYS, models: MODELS, buildBody: () => "{}", ...over,
});

/** Capture every console method; the attempt log must be the only output. */
function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 6 }))).join(" "));
    });
  }
  return lines;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Advance mocked time in 100 ms steps (settling promises in between) until `work` settles. */
async function inMockTime<T>(t: TestContext, work: Promise<T>, clock: { now: number }, limitMs = 120_000): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => { settled = true; });
  await flush();
  while (!settled && clock.now < limitMs) {
    t.mock.timers.tick(100);
    clock.now += 100;
    await flush();
  }
  assert.ok(settled, `still pending after ${limitMs} ms of mocked time`);
  return tracked;
}

/* ------------------------------------------------------------------ */
/*  1 · The SAME key list and model chain as the chat (read-only)      */
/* ------------------------------------------------------------------ */

test("key pool: the chat's rotation order — GEMINI_API_KEY_4 first, then base, numbered ascending, then the comma pool", () => {
  const env = Object.freeze({
    GEMINI_API_KEYS: " pool-1 , pool-2 ,, pool-1 ",
    GEMINI_API_KEY_10: "ten",
    GEMINI_API_KEY_2: "two",
    GEMINI_API_KEY: "base",
    GEMINI_API_KEY_3: "three",
    GEMINI_API_KEY_4: "two", // duplicate credential: kept once, at its first position
    GEMINI_API_KEY_5: "   ", // blank: ignored
    GEMINI_API_KEY_6: undefined, // unset: ignored
    UNRELATED_GEMINI_API_KEY: "ignored",
    GEMINI_MODEL: "ignored-too",
  });
  // GEMINI_API_KEY_4 leads by rule (it usually belongs to a different Google
  // project, hence a separate daily quota), so its value — a duplicate of
  // _2's — is kept once, at ITS first position, and _2 is then skipped.
  // A frozen env also proves resolution never writes to the environment.
  assert.deepEqual(resolveLeafGeminiKeys(env), ["two", "base", "three", "ten", "pool-1", "pool-2"]);
});

test("key pool: nothing configured is an empty pool", () => {
  assert.deepEqual(resolveLeafGeminiKeys({}), []);
  assert.deepEqual(resolveLeafGeminiKeys({ GEMINI_API_KEY: "  ", GEMINI_API_KEYS: " , ," }), []);
});

test("model chain: the shared default and fallbacks, read-only; GEMINI_MODEL pins the head", () => {
  const before = JSON.stringify([GEMINI_MODEL_DEFAULT, GEMINI_FALLBACK_MODELS]);
  const shared = [GEMINI_MODEL_DEFAULT, ...GEMINI_FALLBACK_MODELS];
  assert.deepEqual(resolveLeafGeminiModels({}), shared);
  assert.deepEqual(resolveLeafGeminiModels({ GEMINI_MODEL: "   " }), shared);

  const pinned = resolveLeafGeminiModels({ GEMINI_MODEL: " pinned-model " });
  assert.deepEqual(
    pinned.map((model) => model.id),
    ["pinned-model", ...GEMINI_FALLBACK_MODELS.map((model) => model.id)],
  );
  assert.equal(pinned[0].thinking, undefined, "a pinned id is sent without thinkingConfig");

  // Pinning an id that is already a fallback never doubles it.
  const dup = GEMINI_FALLBACK_MODELS[0].id;
  assert.deepEqual(
    resolveLeafGeminiModels({ GEMINI_MODEL: dup }).map((model) => model.id),
    [dup, ...GEMINI_FALLBACK_MODELS.map((model) => model.id).filter((id) => id !== dup)],
  );
  assert.equal(JSON.stringify([GEMINI_MODEL_DEFAULT, GEMINI_FALLBACK_MODELS]), before, "shared config untouched");
});

test("policy constants: ~50 s budget inside the route's 60 s, ~1 s rotation pause", () => {
  assert.equal(LEAF_GEMINI_BUDGET_MS, 50_000);
  assert.equal(LEAF_GEMINI_ROTATION_DELAY_MS, 1_000);
  assert.ok(LEAF_GEMINI_ATTEMPT_TIMEOUT_MS < LEAF_GEMINI_BUDGET_MS, "one stalled call cannot eat the whole budget");
});

/* ------------------------------------------------------------------ */
/*  2 · Rotation order                                                 */
/* ------------------------------------------------------------------ */

for (const code of [429, 500, 503]) {
  test(`rotation order: ${code} moves to the next key, in pool order, once each`, async (t) => {
    const calls = scriptFetch(t, () => status(code));
    const result = await generateLeafGemini(fast({ models: [MODELS[0]] }));
    assert.deepEqual(calls.map((call) => call.key), [...KEYS]);
    assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 3 });
  });
}

for (const code of [408, 502, 504]) {
  test(`rotation order: ${code} (sibling transient status) rotates too`, async (t) => {
    const calls = scriptFetch(t, (call) => (call.n < 3 ? status(code) : answer()));
    const result = await generateLeafGemini(fast());
    assert.deepEqual(calls.map((call) => call.key), [KEYS[0], KEYS[1], KEYS[2]]);
    assert.equal(result.ok, true);
  });
}

test("rotation order: stops at the first key that answers and returns its payload", async (t) => {
  const calls = scriptFetch(t, (call) => (call.n === 1 ? status(429) : Response.json({ hello: "leaf" })));
  const result = await generateLeafGemini(fast());
  assert.deepEqual(calls.map((call) => call.key), [KEYS[0], KEYS[1]], "third key never touched");
  assert.deepEqual(result, { ok: true, data: { hello: "leaf" }, model: "model-one", attempts: 2 });
});

test("rotation order: the key travels only in the x-goog-api-key header, never the URL", async (t) => {
  const calls = scriptFetch(t, () => status(503));
  await generateLeafGemini(fast({ models: [MODELS[0]] }));
  for (const call of calls) {
    for (const key of KEYS) assert.ok(!call.url.includes(key), "key must not appear in the URL");
    assert.equal(call.url, `https://generativelanguage.googleapis.com/v1beta/models/${call.model}:generateContent`);
  }
});

test("rotation pause: the next key is tried only after ~1 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = scriptFetch(t, (call) => (call.n === 1 ? status(503) : answer()));
  const pending = generateLeafGemini(real());
  await flush();
  assert.equal(calls.length, 1);

  t.mock.timers.tick(LEAF_GEMINI_ROTATION_DELAY_MS - 1);
  await flush();
  assert.equal(calls.length, 1, "still waiting at 999 ms");

  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2, "rotated at 1000 ms");
  assert.deepEqual(calls.map((call) => call.key), [KEYS[0], KEYS[1]]);
  assert.equal((await pending).ok, true);
});

test("rotation: a lone key is retried once per model (the route's historical retry-once)", async (t) => {
  const calls = scriptFetch(t, () => status(503));
  const result = await generateLeafGemini(fast({ keys: [KEYS[0]] }));
  assert.deepEqual(
    calls.map((call) => `${call.model}/${call.key}`),
    MODELS.flatMap((model) => [`${model.id}/${KEYS[0]}`, `${model.id}/${KEYS[0]}`]),
  );
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------------------ */
/*  3 · Fallback to the next model                                     */
/* ------------------------------------------------------------------ */

test("fallback: after every key failed on a model, the next model answers", async (t) => {
  const calls = scriptFetch(t, (call) => (call.model === "model-one" ? status(503) : answer()));
  const result = await generateLeafGemini(fast());
  assert.deepEqual(
    calls.map((call) => `${call.model}/${call.key}`),
    [`model-one/${KEYS[0]}`, `model-one/${KEYS[1]}`, `model-one/${KEYS[2]}`, `model-two/${KEYS[0]}`],
  );
  assert.deepEqual(result, { ok: true, data: { candidates: [{ finishReason: "STOP" }] }, model: "model-two", attempts: 4 });
});

test("fallback: walks the whole chain in order, then reports provider-busy", async (t) => {
  const calls = scriptFetch(t, () => status(503));
  const result = await generateLeafGemini(fast());
  assert.deepEqual(
    calls.map((call) => `${call.model}/${call.key}`),
    MODELS.flatMap((model) => KEYS.map((key) => `${model.id}/${key}`)),
  );
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 9 });
});

test("fallback: switching model needs no pause — only key rotation waits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: 0 };
  const calls = scriptFetch(t, (call) => (call.model === "model-one" ? status(503) : answer()), clock);
  await inMockTime(t, generateLeafGemini(real()), clock);
  assert.deepEqual(
    calls.map((call) => [call.model, call.key, call.at]),
    [
      ["model-one", KEYS[0], 0],
      ["model-one", KEYS[1], 1_000],
      ["model-one", KEYS[2], 2_000],
      ["model-two", KEYS[0], 2_000], // same instant: no pause before a model switch
    ],
  );
});

test("fallback: the requested chain 3.8 → 3.5 → 3.5-lite is what a real request walks", async (t) => {
  const calls = scriptFetch(t, () => status(503));
  await generateLeafGemini(fast({ keys: [KEYS[0], KEYS[1]], models: resolveLeafGeminiModels({}) }));
  assert.deepEqual(
    [...new Set(calls.map((call) => call.model))],
    [GEMINI_MODEL_DEFAULT, ...GEMINI_FALLBACK_MODELS].map((model) => model.id),
  );
});

test("fallback: each model gets its own thinkingConfig through buildBody (built once per model)", async (t) => {
  const built: string[] = [];
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return status(503);
  });
  await generateLeafGemini(fast({
    models: [{ id: "a", thinking: { thinkingLevel: "low" } }, { id: "b" }],
    buildBody: (model) => { built.push(model.id); return JSON.stringify({ for: model.id, thinking: model.thinking ?? null }); },
  }));
  assert.deepEqual(built, ["a", "b"], "one body per model, not per attempt");
  assert.deepEqual(bodies.map((body) => JSON.parse(body).for), ["a", "a", "a", "b", "b", "b"]);
});

/* ------------------------------------------------------------------ */
/*  4 · No retry on 400 (and other terminal statuses)                  */
/* ------------------------------------------------------------------ */

test("no retry on 400: one call — no key rotation, no model fallback, no waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // a pause would never elapse: detect it as "unsettled"
  const calls = scriptFetch(t, () => status(400));
  let settled = false;
  const pending = generateLeafGemini(real()).then((result) => { settled = true; return result; });
  await flush();
  await flush();
  assert.equal(settled, true, "400 must end the request immediately, without a rotation pause");
  assert.equal(calls.length, 1, "exactly one upstream call");
  // The route's historical answer for a non-retryable upstream status.
  assert.deepEqual(await pending, { ok: false, reason: "provider-busy", status: 503, attempts: 1 });
});

for (const code of [405, 413, 422, 501]) {
  test(`no retry on ${code}: every other non-transient, non-dead-key status is terminal as well`, async (t) => {
    const calls = scriptFetch(t, () => status(code));
    const result = await generateLeafGemini(fast());
    assert.equal(calls.length, 1);
    assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 1 });
  });
}

test("no retry on 400 even after earlier transient failures: the first terminal status ends it", async (t) => {
  const codes = [503, 400];
  const calls = scriptFetch(t, (call) => status(codes[call.n - 1] ?? 200));
  const result = await generateLeafGemini(fast());
  assert.equal(calls.length, 2, "503 rotated once, 400 stopped everything");
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 2 });
});

test("a 200 whose body is not JSON is malformed and is not retried", async (t) => {
  const calls = scriptFetch(t, () => new Response("<html>not json</html>", { status: 200 }));
  const result = await generateLeafGemini(fast());
  assert.equal(calls.length, 1);
  assert.deepEqual(result, { ok: false, reason: "malformed", status: 502, attempts: 1 });
});

/* ------------------------------------------------------------------ */
/*  4b · Dead keys: skip to the next key at once (chat parity)         */
/* ------------------------------------------------------------------ */

/** Run to completion on mocked time WITHOUT ticking: only an instant (pause-free) path can finish. */
async function settlesWithoutWaiting<T>(work: Promise<T>): Promise<T | "still waiting"> {
  let outcome: T | "still waiting" = "still waiting";
  void work.then((value) => { outcome = value; });
  await flush();
  await flush();
  return outcome;
}

for (const code of [401, 402, 403]) {
  test(`dead key: ${code} skips to the next key at once — no pause`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] }); // a pause could never elapse: it would show as "still waiting"
    const calls = scriptFetch(t, (call) => (call.n === 1 ? status(code) : answer()));
    const result = await settlesWithoutWaiting(generateLeafGemini(real()));
    assert.notEqual(result, "still waiting", `${code} must rotate without the 1 s pause`);
    assert.deepEqual(calls.map((call) => call.key), [KEYS[0], KEYS[1]]);
    assert.deepEqual(result, { ok: true, data: { candidates: [{ finishReason: "STOP" }] }, model: "model-one", attempts: 2 });
  });
}

test("dead key: a 400 that Google tags API_KEY_INVALID skips to the next key at once — no pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = scriptFetch(t, (call) => (call.n === 1 ? status(400, invalidKeyBody()) : answer()));
  const result = await settlesWithoutWaiting(generateLeafGemini(real()));
  assert.notEqual(result, "still waiting");
  assert.deepEqual(calls.map((call) => call.key), [KEYS[0], KEYS[1]]);
  assert.equal((result as { ok: boolean }).ok, true);
});

test("dead key: every OTHER 400 is still terminal — one call, no rotation (your no-retry-on-400 rule)", async (t) => {
  for (const body of [otherBadRequestBody, "", "PRIVATE upstream text", '{"error":{"status":"FAILED_PRECONDITION"}}']) {
    const calls = scriptFetch(t, () => status(400, body));
    const result = await generateLeafGemini(fast());
    assert.equal(calls.length, 1, `body ${JSON.stringify(body.slice(0, 30))}`);
    assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 1 });
    t.mock.restoreAll();
  }
});

test("dead key: it is never used again in this request — not on the next model either", async (t) => {
  const lines = captureConsole(t);
  const keys = [KEYS[0], KEYS[1]];
  const calls = scriptFetch(t, (call) => {
    if (call.key === keys[0]) return status(403);
    return call.model === "model-one" ? status(503) : answer();
  });
  const result = await generateLeafGemini(fast({ keys }));
  assert.deepEqual(
    calls.map((call) => `${call.model}/${call.key}`),
    [`model-one/${keys[0]}`, `model-one/${keys[1]}`, `model-two/${keys[1]}`],
    "the dead key is skipped for model-two (no wasted attempt)",
  );
  assert.deepEqual(result, { ok: true, data: { candidates: [{ finishReason: "STOP" }] }, model: "model-two", attempts: 3 });
  assert.deepEqual(
    lines.map((line) => /key=(\d\/\d) .* status=(\d+)/.exec(line)?.slice(1).join(" ")),
    ["1/2 403", "2/2 503", "2/2 200"],
    "ordinals stay the keys' positions in the full pool",
  );
});

test("dead key: a lone key that is dead is not retried — one attempt, then provider-busy", async (t) => {
  const calls = scriptFetch(t, () => status(403));
  const result = await generateLeafGemini(fast({ keys: [KEYS[0]] }));
  assert.equal(calls.length, 1);
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 1 });
});

test("dead key: if every key is dead, one attempt per key ends it — no model walk, no pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = scriptFetch(t, () => status(403));
  const result = await settlesWithoutWaiting(generateLeafGemini(real()));
  assert.deepEqual(calls.map((call) => `${call.model}/${call.key}`), KEYS.map((key) => `model-one/${key}`));
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 3 });
});

test("dead key: transient failures still wait ~1 s, a dead key before them does not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: 0 };
  const codes = [403, 503];
  const calls = scriptFetch(t, (call) => (call.n <= 2 ? status(codes[call.n - 1]) : answer()), clock);
  await inMockTime(t, generateLeafGemini(real()), clock);
  assert.deepEqual(
    calls.map((call) => [call.key, call.at]),
    [[KEYS[0], 0], [KEYS[1], 0], [KEYS[2], 1_000]], // dead key: no pause; 503: ~1 s
  );
});

test("dead key: the error body is only peeked — a bounded read, the stream cancelled, never retained", async (t) => {
  // The reason arrives only AFTER the 16 KB window: it must not be found, and the read must stop.
  let pulls = 0;
  let cancelled = false;
  const late = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode(pulls > 40 ? invalidKeyBody() : "x".repeat(8_192)));
      if (pulls > 41) controller.close();
    },
    cancel() { cancelled = true; },
  });
  const calls = scriptFetch(t, () => new Response(late, { status: 400 }));
  const result = await generateLeafGemini(fast());
  assert.equal(calls.length, 1, "no reason inside the window: an ordinary, terminal 400");
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 1 });
  assert.equal(cancelled, true, "stream cancelled after the peek");
  assert.ok(pulls < 10, `read only a bounded prefix, pulled ${pulls} chunks`);
});

test("dead key: the 400 body that identified it — even one echoing a key — never reaches logs or the result", async (t) => {
  const lines = captureConsole(t);
  scriptFetch(t, (call) => (call.n === 1 ? status(400, invalidKeyBody(`key=${KEYS[0]}`)) : status(403, `echo ${call.key}`)));
  const result = await generateLeafGemini(fast());
  const everything = [...lines, JSON.stringify(result)].join("\n");
  for (const secret of [...KEYS, "API key not valid", "API_KEY_INVALID", "echo", "INVALID_ARGUMENT"]) {
    assert.ok(!everything.includes(secret), `leaked: ${secret}`);
  }
  assert.equal(lines.length, 3, "one line per attempt: two dead keys skipped, third rejected too");
  for (const line of lines) assert.match(line, ATTEMPT_LINE);
});

/* ------------------------------------------------------------------ */
/*  4c · 404 (the model is gone): next model, never a retry            */
/* ------------------------------------------------------------------ */

test("404: skips to the next model at once — no other key, no second try on that model, no pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); // a pause could never elapse: it would show as "still waiting"
  const lines = captureConsole(t);
  const calls = scriptFetch(t, (call) =>
    (call.model === "model-one" ? status(404, `models/model-one is not found ${call.key}`) : answer()));
  const result = await settlesWithoutWaiting(generateLeafGemini(real()));

  assert.notEqual(result, "still waiting", "a 404 must move on without the rotation pause");
  assert.deepEqual(
    calls.map((call) => `${call.model}/${call.key}`),
    [`model-one/${KEYS[0]}`, `model-two/${KEYS[0]}`],
    "one try on the missing model — not the other keys, not a repeat — then the next model from the first key",
  );
  assert.deepEqual(result, { ok: true, data: { candidates: [{ finishReason: "STOP" }] }, model: "model-two", attempts: 2 });
  assert.deepEqual(
    lines.map((line) => line.replace(/ ms=\d+$/, "")),
    [
      "[leaf-diagnose] attempt=1 key=1/3 model=model-one status=404",
      "[leaf-diagnose] attempt=2 key=1/3 model=model-two status=200",
    ],
  );
  const everything = [...lines, JSON.stringify(result)].join("\n");
  for (const secret of [...KEYS, "is not found", "models/model-one"]) assert.ok(!everything.includes(secret), `leaked: ${secret}`);
});

test("404: a lone key gets no second try on the missing model", async (t) => {
  const calls = scriptFetch(t, (call) => (call.model === "model-one" ? status(404) : answer()));
  const result = await generateLeafGemini(fast({ keys: [KEYS[0]] }));
  assert.deepEqual(calls.map((call) => `${call.model}/${call.key}`), [`model-one/${KEYS[0]}`, `model-two/${KEYS[0]}`]);
  assert.equal(result.ok, true);
});

test("404: every model gone — each is tried exactly once, then provider-busy 503, with no waiting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = scriptFetch(t, () => status(404));
  const result = await settlesWithoutWaiting(generateLeafGemini(real()));
  assert.deepEqual(
    calls.map((call) => `${call.model}/${call.key}`),
    MODELS.map((model) => `${model.id}/${KEYS[0]}`),
    "one attempt per model, always from the first usable key",
  );
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 3 });
});

test("404 after a transient failure: that one waits ~1 s, the 404 then leaves the model without any wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: 0 };
  const calls = scriptFetch(t, (call) => {
    if (call.model !== "model-one") return answer();
    return call.key === KEYS[0] ? status(503) : status(404);
  }, clock);
  const result = await inMockTime(t, generateLeafGemini(real()), clock);
  assert.deepEqual(
    calls.map((call) => [call.model, call.key, call.at]),
    [
      ["model-one", KEYS[0], 0],
      ["model-one", KEYS[1], 1_000], // after the 503: the usual ~1 s rotation pause
      ["model-two", KEYS[0], 1_000], // 404: straight on, no pause, third key never touched
    ],
  );
  assert.equal(result.ok, true);
});

test("404 does not condemn the key — only a dead-key status does: dead keys stay skipped, healthy ones carry on", async (t) => {
  const keys = [KEYS[0], KEYS[1]];
  const calls = scriptFetch(t, (call) => {
    if (call.key === keys[0]) return status(403); // genuinely dead
    return call.model === "model-one" ? status(404) : answer(); // key 2 is fine; model-one is gone
  });
  const result = await generateLeafGemini(fast({ keys }));
  assert.deepEqual(
    calls.map((call) => `${call.model}/${call.key}`),
    [`model-one/${keys[0]}`, `model-one/${keys[1]}`, `model-two/${keys[1]}`],
  );
  assert.deepEqual(result, { ok: true, data: { candidates: [{ finishReason: "STOP" }] }, model: "model-two", attempts: 3 });
});

test("404: the response body is dropped unread — a body that fails on any read cannot disturb the skip", async (t) => {
  const poisoned = () => new Response(
    new ReadableStream<Uint8Array>({ pull() { throw new Error("a 404 body must never be read"); } }),
    { status: 404 },
  );
  const calls = scriptFetch(t, (call) => (call.model === "model-one" ? poisoned() : answer()));
  const result = await generateLeafGemini(fast());
  assert.deepEqual(calls.map((call) => call.model), ["model-one", "model-two"]);
  assert.equal(result.ok, true);
});

test("404: the missing model's own thinkingConfig is not carried over — the next model builds its own body", async (t) => {
  const bodies: Array<{ model: string; thinking: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    bodies.push({ model: /models\/([^:]+):/.exec(String(url))?.[1] ?? "?", thinking: JSON.parse(String(init?.body)).thinking });
    return bodies.length === 1 ? status(404) : answer();
  });
  await generateLeafGemini(fast({
    models: [{ id: "gone", thinking: { thinkingLevel: "low" } }, { id: "next" }],
    buildBody: (model) => JSON.stringify({ thinking: model.thinking ?? null }),
  }));
  assert.deepEqual(bodies, [{ model: "gone", thinking: { thinkingLevel: "low" } }, { model: "next", thinking: null }]);
});

/* ------------------------------------------------------------------ */
/*  5 · Network errors                                                 */
/* ------------------------------------------------------------------ */

test("network errors rotate like 503; a provider that never answered is reported as `network`", async (t) => {
  const calls = scriptFetch(t, () => { throw new TypeError("fetch failed"); });
  const result = await generateLeafGemini(fast());
  assert.equal(calls.length, 9);
  assert.deepEqual(result, { ok: false, reason: "network", status: 502, attempts: 9 });
});

test("a provider that answered at least once is `provider-busy`, not `network`", async (t) => {
  scriptFetch(t, (call) => { if (call.n % 2) throw new TypeError("fetch failed"); return status(503); });
  const result = await generateLeafGemini(fast());
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 503, attempts: 9 });
});

test("nothing configured: provider-busy without a single upstream call", async (t) => {
  const calls = scriptFetch(t, () => answer());
  assert.deepEqual(await generateLeafGemini(fast({ keys: [] })), { ok: false, reason: "provider-busy", status: 503, attempts: 0 });
  assert.deepEqual(await generateLeafGemini(fast({ models: [] })), { ok: false, reason: "provider-busy", status: 503, attempts: 0 });
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ */
/*  6 · The time budget                                                */
/* ------------------------------------------------------------------ */

test("budget respected: a stalled upstream is cut per call, rotation goes on, and nothing starts after ~50 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: 0 };
  const lines = captureConsole(t);
  const calls = scriptFetch(t, stall, clock);

  const result = await inMockTime(t, generateLeafGemini(real()), clock);

  // 0 s: first call, cut after 20 s → 1 s pause → 21 s: second key, cut at 41 s
  // → 1 s pause → 42 s: third key — the 50 s budget ends it mid-flight.
  assert.deepEqual(calls.map((call) => [call.key, call.at]), [[KEYS[0], 0], [KEYS[1], 21_000], [KEYS[2], 42_000]]);
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 504, attempts: 3 });
  assert.ok(clock.now >= LEAF_GEMINI_BUDGET_MS && clock.now <= LEAF_GEMINI_BUDGET_MS + 100,
    `gave up at ${clock.now} ms of mocked time, expected ≈ ${LEAF_GEMINI_BUDGET_MS}`);
  assert.ok(calls.every((call) => call.at < LEAF_GEMINI_BUDGET_MS), "no attempt starts after the budget");
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => /status=timeout /.test(line)), lines.join("\n"));
});

test("budget respected: provider-busy comes back only once the budget is spent, never earlier", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: 0 };
  scriptFetch(t, stall, clock);
  let settledAt = -1;
  const pending = generateLeafGemini(real()).then((result) => { settledAt = clock.now; return result; });
  await flush();
  while (settledAt < 0 && clock.now < 60_000) {
    t.mock.timers.tick(100);
    clock.now += 100;
    await flush();
    if (clock.now === LEAF_GEMINI_BUDGET_MS - 100) assert.equal(settledAt, -1, "still trying 100 ms before the budget ends");
  }
  assert.equal((await pending).ok, false);
  assert.ok(settledAt >= LEAF_GEMINI_BUDGET_MS, `settled early, at ${settledAt} ms`);
});

test("budget respected: the budget also cuts a rotation pause short", async (t) => {
  const calls = scriptFetch(t, () => status(503));
  const startedAt = performance.now();
  const result = await generateLeafGemini(fast({ budgetMs: 60, rotationDelayMs: 30_000 }));
  assert.ok(performance.now() - startedAt < 5_000, "the 30 s pause was cut by the 60 ms budget");
  assert.deepEqual(result, { ok: false, reason: "provider-busy", status: 504, attempts: 1 });
  assert.equal(calls.length, 1, "no further attempt after the budget");
});

test("budget respected: a spent (or invalid) budget starts nothing", async (t) => {
  const calls = scriptFetch(t, () => answer());
  for (const budgetMs of [0, -5, Number.NaN]) {
    assert.deepEqual(
      await generateLeafGemini(fast({ budgetMs })),
      { ok: false, reason: "provider-busy", status: 504, attempts: 0 },
    );
  }
  assert.equal(calls.length, 0);
});

test("budget respected: a client that already left starts nothing; one that leaves mid-call stops rotation", async (t) => {
  const lines = captureConsole(t);
  const calls = scriptFetch(t, stall);

  const gone = new AbortController();
  gone.abort();
  assert.deepEqual(
    await generateLeafGemini(fast({ signal: gone.signal })),
    { ok: false, reason: "provider-busy", status: 504, attempts: 0 },
  );
  assert.equal(calls.length, 0);

  const client = new AbortController();
  const pending = generateLeafGemini(fast({ signal: client.signal }));
  await flush();
  assert.equal(calls.length, 1);
  client.abort();
  assert.deepEqual(await pending, { ok: false, reason: "provider-busy", status: 504, attempts: 1 });
  assert.equal(calls.length, 1, "no attempt after the disconnect");
  assert.match(lines[0], /^\[leaf-diagnose\] attempt=1 key=1\/3 model=model-one status=aborted ms=\d+$/);
});

/* ------------------------------------------------------------------ */
/*  7 · Logging: one line per attempt, and the key is never logged     */
/* ------------------------------------------------------------------ */

test("log: exactly one `[leaf-diagnose] attempt=N key=i/total model=… status=… ms=…` line per attempt", async (t) => {
  const lines = captureConsole(t);
  const calls = scriptFetch(t, async (call) => {
    if (call.n === 3) await new Promise((resolve) => setTimeout(resolve, 30));
    return call.n === 1 ? status(503) : call.n === 2 ? status(429) : answer();
  });
  const result = await generateLeafGemini(fast({ keys: [KEYS[0], KEYS[1]] }));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(lines.length, 3, "one line per attempt, nothing else");
  assert.deepEqual(
    lines.map((line) => line.replace(/ ms=\d+$/, "")),
    [
      "[leaf-diagnose] attempt=1 key=1/2 model=model-one status=503",
      "[leaf-diagnose] attempt=2 key=2/2 model=model-one status=429",
      "[leaf-diagnose] attempt=3 key=1/2 model=model-two status=200",
    ],
  );
  for (const line of lines) assert.match(line, ATTEMPT_LINE);
  assert.ok(Number(ATTEMPT_LINE.exec(lines[2])?.[6]) >= 20, "ms is the real duration of the attempt");
});

test("log: keys, images and upstream text never reach the logs or the result", async (t) => {
  const lines = captureConsole(t);
  const IMAGE = "BASE64-IMAGE-PAYLOAD-0123456789";
  const calls = scriptFetch(t, (call) => {
    if (call.n === 1) return status(429, `quota exceeded for ${call.key}`);
    if (call.n === 2) throw new Error(`socket hang up (${call.key}) while sending ${IMAGE}`);
    if (call.n === 3) return status(500, `internal error ${IMAGE}`);
    return answer();
  });

  const result = await generateLeafGemini(fast({
    models: [MODELS[0], MODELS[1]],
    buildBody: () => JSON.stringify({ inlineData: { data: IMAGE } }),
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.key), [KEYS[0], KEYS[1], KEYS[2], KEYS[0]], "the keys really were used");

  assert.equal(lines.length, 4);
  const everything = [...lines, JSON.stringify(result)].join("\n");
  for (const secret of [...KEYS, IMAGE, "quota exceeded", "socket hang up", "internal error", "PRIVATE"]) {
    assert.ok(!everything.includes(secret), `leaked: ${secret}`);
  }
  for (const line of lines) assert.match(line, ATTEMPT_LINE);
  assert.deepEqual(lines.map((line) => ATTEMPT_LINE.exec(line)?.[5]), ["429", "network", "500", "200"]);
});

test("log: a failed run reports only ordinals and tokens — no key, no body, no error text", async (t) => {
  const lines = captureConsole(t);
  scriptFetch(t, (call) => {
    if (call.n % 3 === 0) throw new Error(`boom ${call.key}`);
    return status(call.n % 3 === 1 ? 503 : 404, `echo ${call.key}`);
  });
  const result = await generateLeafGemini(fast());
  const everything = [...lines, JSON.stringify(result)].join("\n");
  for (const key of KEYS) assert.ok(!everything.includes(key));
  assert.ok(!/boom|echo/.test(everything));
  for (const line of lines) assert.match(line, ATTEMPT_LINE);
});
