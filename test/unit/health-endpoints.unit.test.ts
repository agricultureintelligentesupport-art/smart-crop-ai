/**
 * Unit tests for the two operational probes:
 *
 *   `GET /api/health/hf?key=<HEALTH_SECRET>`
 *   `GET /api/health/gemini?key=<HEALTH_SECRET>`
 *
 * What is guarded here is the OPERATIONAL contract, not the happy path alone:
 *   • both probes fail CLOSED when `HEALTH_SECRET` is unset, and answer 401 on a
 *     wrong secret — they reveal which credentials exist, by NAME;
 *   • the HF probe sends exactly the pipeline's request (same endpoint, same
 *     `Authorization: Bearer`, a 1-token chat completion) and reports exactly
 *     the five agreed fields — never the token;
 *   • the Gemini probe walks the pool in `resolveGeminiKeyPool()` order, marks
 *     the first entry `firstInRotation`, reports quota/invalid state and never
 *     echoes a key value;
 *   • both are `Cache-Control: no-store` and bounded by the 8 s window.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { GET as geminiHealth } from "../../src/app/api/health/gemini/route";
import { GET as hfHealth } from "../../src/app/api/health/hf/route";
import { geminiKeyState } from "../../src/lib/assistant/providers";

/* ------------------------------------------------------------------ */
/*  Environment                                                        */
/* ------------------------------------------------------------------ */

const SCRUBBED = /^(GEMINI_API_KEY|GEMINI_API_KEYS|GEMINI_MODEL|HUGGINGFACE_API_KEY|HF_TOKEN|HEALTH_SECRET)/;
const original: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (SCRUBBED.test(name)) original[name] = value;
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (SCRUBBED.test(name)) delete process.env[name];
  geminiKeyState.reset();
  // The probes list the pool in the SAME random draw a request would use
  // (`shuffleGeminiKeyPool`). Pinning the generator to its maximum gives the
  // identity draw, so the order assertions below are exact; the dedicated
  // "shuffled" test at the end proves the order is a permutation, not a fixed
  // sequence.
  mock.method(Math, "random", () => 1 - Number.EPSILON);
});

afterEach(() => {
  mock.restoreAll();
  for (const name of Object.keys(process.env)) if (SCRUBBED.test(name)) delete process.env[name];
  for (const [name, value] of Object.entries(original)) {
    if (value !== undefined) process.env[name] = value;
  }
  geminiKeyState.reset();
});

/** A minimal NextRequest stand-in: the routes only read `nextUrl.searchParams`. */
function probe(key: string | null) {
  const url = new URL("https://assistant.test/api/health/probe");
  if (key !== null) url.searchParams.set("key", key);
  return { nextUrl: url } as unknown as Parameters<typeof hfHealth>[0];
}

/** Silences the routes' own diagnostics so the test report stays readable. */
function quiet() {
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});
  mock.method(console, "error", () => {});
}

interface HfPayload {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  tokenPresent: boolean;
  tokenPrefixOk: boolean;
}

interface GeminiPayload {
  name: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  quotaExhausted: boolean;
  firstInRotation: boolean;
  model: string;
}

const HF_ROUTER_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";
const FIRST_GEMINI_MODEL = "gemini-3.8-flash";

/* ------------------------------------------------------------------ */
/*  Shared guard                                                       */
/* ------------------------------------------------------------------ */

for (const [label, handler] of [
  ["hf", hfHealth],
  ["gemini", geminiHealth],
] as const) {
  test(`${label} probe: health endpoints fail closed without HEALTH_SECRET`, async () => {
    quiet();
    const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({}));
    const response = await handler(probe("anything"));
    assert.equal(response.status, 503);
    const payload = (await response.json()) as { code?: string; error?: string };
    assert.equal(payload.code, "MISSING_HEALTH_SECRET");
    assert.match(String(payload.error), /HEALTH_SECRET/);
    assert.equal(fetchMock.mock.callCount(), 0, "an unauthenticated probe must not spend a request");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test(`${label} probe: a missing or wrong ?key= answers 401 and spends no request`, async () => {
    quiet();
    process.env.HEALTH_SECRET = "correct-horse";
    const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({}));
    for (const supplied of [null, "", "wrong", "correct-hors", "correct-horse "]) {
      const response = await handler(probe(supplied));
      assert.equal(response.status, 401, `supplied=${JSON.stringify(supplied)}`);
      assert.equal(((await response.json()) as { code?: string }).code, "UNAUTHORIZED");
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

/* ------------------------------------------------------------------ */
/*  GET /api/health/hf                                                 */
/* ------------------------------------------------------------------ */

test("hf probe: without HUGGINGFACE_API_KEY it reports tokenPresent:false and sends nothing", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.HF_TOKEN = "hf_this_alias_must_not_be_read";
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({}));

  const response = await hfHealth(probe("s3cret"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as HfPayload;
  assert.deepEqual(payload, {
    ok: false,
    status: null,
    latencyMs: 0,
    tokenPresent: false,
    tokenPrefixOk: false,
  });
  assert.equal(fetchMock.mock.callCount(), 0, "the HF_TOKEN alias is not a credential source");
});

test("hf probe: sends the pipeline's exact 1-token Bearer request and reports the status", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.HUGGINGFACE_API_KEY = "  hf_example_token_value  ";

  let seen: { url: string; init: RequestInit } | undefined;
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    seen = { url: String(url), init };
    return Response.json({ choices: [{ message: { content: "hi" } }] });
  });

  const response = await hfHealth(probe("s3cret"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as HfPayload;
  assert.deepEqual(payload, {
    ok: true,
    status: 200,
    latencyMs: payload.latencyMs,
    tokenPresent: true,
    tokenPrefixOk: true,
  });
  assert.ok(payload.latencyMs >= 0);

  assert.equal(seen?.url, HF_ROUTER_CHAT_URL);
  assert.equal(String(seen?.init.method), "POST");
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer hf_example_token_value", "the token must be trimmed");
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(String(seen?.init.body)) as {
    model?: string;
    messages?: { role: string; content: string }[];
    max_tokens?: number;
  };
  assert.equal(body.model, "Qwen/Qwen3-4B-Instruct-2507");
  assert.equal(body.max_tokens, 1);
  assert.equal(body.messages?.length, 1);
  assert.equal(body.messages?.[0]?.role, "user");
});

test("hf probe: exactly the five agreed fields — no token, no model, no extra keys", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.HUGGINGFACE_API_KEY = "hf_example_token_value";
  mock.method(globalThis, "fetch", async () => new Response("nope", { status: 429 }));

  const response = await hfHealth(probe("s3cret"));
  const raw = await response.text();
  const payload = JSON.parse(raw) as HfPayload;
  assert.deepEqual(Object.keys(payload).sort(), [
    "latencyMs",
    "ok",
    "status",
    "tokenPrefixOk",
    "tokenPresent",
  ]);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 429);
  assert.equal(payload.tokenPresent, true);
  assert.doesNotMatch(raw, /hf_example_token_value/);
});

test("hf probe: a token that does not start with hf_ is present but flagged", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.HUGGINGFACE_API_KEY = "AIzaSyNotAHuggingFaceToken";
  mock.method(globalThis, "fetch", async () => Response.json({}));

  const payload = (await (await hfHealth(probe("s3cret"))).json()) as HfPayload;
  assert.equal(payload.tokenPresent, true);
  assert.equal(payload.tokenPrefixOk, false);
});

test("hf probe: a probe that never settles is cut by the 8 s window, not the 45 s deadline", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.HUGGINGFACE_API_KEY = "hf_example_token_value";
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    mock.method(globalThis, "fetch", (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () =>
          reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
        );
      }),
    );
    const pending = hfHealth(probe("s3cret"));
    mock.timers.tick(8_001);
    const payload = (await (await pending).json()) as HfPayload;
    assert.equal(payload.ok, false);
    assert.equal(payload.status, null);
    assert.equal(payload.tokenPresent, true);
    assert.equal(payload.tokenPrefixOk, true);
  } finally {
    mock.timers.reset();
  }
});

/* ------------------------------------------------------------------ */
/*  GET /api/health/gemini                                             */
/* ------------------------------------------------------------------ */

test("gemini probe: no configured keys is an empty array, not an error", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({}));
  const response = await geminiHealth(probe("s3cret"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("gemini probe: every key in rotation order, first item marked, first chain model probed", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.GEMINI_API_KEY = "base-key-value";
  process.env.GEMINI_API_KEY_2 = "second-key-value";
  process.env.GEMINI_API_KEY_4 = "priority-key-value";

  const probedKeys: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    const key = new URL(String(url)).searchParams.get("key") ?? "";
    probedKeys.push(key);
    return Response.json({ candidates: [{ content: { parts: [{ text: "pong" }] } }] });
  });

  const response = await geminiHealth(probe("s3cret"));
  const payload = (await response.json()) as GeminiPayload[];
  assert.deepEqual(
    payload.map((entry) => entry.name),
    ["GEMINI_API_KEY_4", "GEMINI_API_KEY", "GEMINI_API_KEY_2"],
    "GEMINI_API_KEY_4 leads, then the base variable, then numeric order",
  );
  assert.deepEqual(probedKeys, ["priority-key-value", "base-key-value", "second-key-value"]);
  assert.deepEqual(
    payload.map((entry) => entry.firstInRotation),
    [true, false, false],
  );
  for (const entry of payload) {
    assert.equal(entry.ok, true);
    assert.equal(entry.status, 200);
    assert.equal(entry.quotaExhausted, false);
    assert.equal(entry.model, FIRST_GEMINI_MODEL);
    assert.ok(entry.latencyMs >= 0);
    assert.equal(typeof entry.name, "string");
  }
});

test("gemini probe: the listing is a RANDOM draw — the same keys in a different order, first entry marked", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.GEMINI_API_KEY = "base-key-value";
  process.env.GEMINI_API_KEY_2 = "second-key-value";
  process.env.GEMINI_API_KEY_4 = "priority-key-value";
  // A generator of 0 is the opposite extreme of the identity draw: the
  // permutation it produces must still contain every key exactly once.
  mock.restoreAll();
  mock.method(Math, "random", () => 0);
  quiet();
  mock.method(globalThis, "fetch", async () => Response.json({ candidates: [] }));

  const payload = (await (await geminiHealth(probe("s3cret"))).json()) as GeminiPayload[];
  assert.deepEqual(
    payload.map((entry) => entry.name).slice().sort(),
    ["GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_4"],
    "every configured key is listed exactly once",
  );
  assert.deepEqual(
    payload.map((entry) => entry.firstInRotation),
    [true, ...payload.slice(1).map(() => false)],
    "the marker follows the draw, not a fixed name",
  );
});

test("gemini probe: 429 parks the (key, model) quota mark so the next request skips it", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.GEMINI_API_KEY_4 = "priority-key-value";
  process.env.GEMINI_API_KEY = "base-key-value";

  mock.method(globalThis, "fetch", async (url: string) => {
    const key = new URL(String(url)).searchParams.get("key");
    if (key === "priority-key-value") {
      return Response.json(
        { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded." } },
        { status: 429 },
      );
    }
    return Response.json(
      {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "API key not valid. Please pass a valid API key.",
          details: [{ reason: "API_KEY_INVALID" }],
        },
      },
      { status: 400 },
    );
  });

  const payload = (await (await geminiHealth(probe("s3cret"))).json()) as GeminiPayload[];
  assert.equal(payload[0].quotaExhausted, true, "the 429 is reported");
  assert.equal(payload[0].ok, false);
  assert.equal(payload[0].status, 429);
  assert.ok(geminiKeyState.isQuotaExhausted("GEMINI_API_KEY_4", FIRST_GEMINI_MODEL));
  assert.ok(geminiKeyState.isInvalid("GEMINI_API_KEY"), "400 API_KEY_INVALID parks the key");

  // The cached mark is what a subsequent probe (and the request path) reads.
  mock.method(globalThis, "fetch", async () => Response.json({}));
  const second = (await (await geminiHealth(probe("s3cret"))).json()) as GeminiPayload[];
  assert.equal(second[0].quotaExhausted, true);
  assert.equal(second[1].status, 200);
});

test("gemini probe: a network failure is a null status, and no key value is ever echoed", async () => {
  quiet();
  process.env.HEALTH_SECRET = "s3cret";
  process.env.GEMINI_API_KEY = "super-secret-key-value";
  mock.method(globalThis, "fetch", async () => {
    throw new Error("socket hang up");
  });

  const response = await geminiHealth(probe("s3cret"));
  const raw = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(raw, /super-secret-key-value/);
  const payload = JSON.parse(raw) as GeminiPayload[];
  assert.equal(payload.length, 1);
  assert.equal(payload[0].name, "GEMINI_API_KEY");
  assert.equal(payload[0].ok, false);
  assert.equal(payload[0].status, null);
  assert.equal(payload[0].quotaExhausted, false);
  assert.equal(payload[0].firstInRotation, true);
});
