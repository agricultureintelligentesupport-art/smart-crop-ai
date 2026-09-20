import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server";
import { dynamic, POST } from "../../src/app/api/assistant/route";

const originalKeys = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
};

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.HUGGINGFACE_API_KEY;
  // No test may accidentally call a paid provider.
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(originalKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(withImage = false) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "How should I irrigate tomatoes?",
      ...(withImage ? { image: { data: "aW1hZ2U=", mimeType: "image/jpeg" } } : {}),
    }),
  });
}

function configureKeys() {
  process.env.GEMINI_API_KEY = " test-gemini ";
  process.env.HUGGINGFACE_API_KEY = " test-hf ";
}

const geminiReply = () => Response.json({
  candidates: [{ content: { parts: [{ text: "Water in the morning." }] } }],
});

/** Mirrors Google's response for a retired / unavailable model id on v1beta. */
const geminiModelNotFound = (model: string) =>
  Response.json(
    {
      error: {
        code: 404,
        message: `models/${model} is not found for API version v1beta, or is a valid model.`,
        status: "NOT_FOUND",
      },
    },
    { status: 404 },
  );

const requestedModel = (url: string) => /\/models\/([^:]+):generateContent/.exec(url)?.[1];

test("assistant route explicitly uses dynamic rendering", () => {
  assert.equal(dynamic, "force-dynamic");
});

for (const [name, gemini, hf] of [
  ["both absent", undefined, undefined],
  ["Gemini absent", undefined, "test-hf"],
  ["Hugging Face absent", "test-gemini", undefined],
  ["Gemini blank", "  ", "test-hf"],
  ["Hugging Face blank", "test-gemini", "\t"],
] as const) {
  test(`missing keys: ${name} returns 500 without calling providers`, async () => {
    if (gemini !== undefined) process.env.GEMINI_API_KEY = gemini;
    if (hf !== undefined) process.env.HUGGINGFACE_API_KEY = hf;
    const upstream = mock.method(globalThis, "fetch");
    for (const withImage of [false, true]) {
      const response = await POST(request(withImage));
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "API keys missing on server",
        code: "MISSING_KEYS",
      });
    }
    assert.equal(upstream.mock.callCount(), 0);
  });
}

test("keys are read per request, not when the route module loads", async () => {
  assert.equal((await POST(request())).status, 500);
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.match(String(url), /\/models\/gemini-2\.0-flash:generateContent/);
    assert.doesNotMatch(String(url), /models\/models\//);
    assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test-gemini");
    return geminiReply();
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "Water in the morning.", diagnosis: null, source: "gemini",
  });
  assert.equal(upstream.mock.callCount(), 1);
  delete process.env.GEMINI_API_KEY;
  assert.equal((await POST(request())).status, 500);
  assert.equal(upstream.mock.callCount(), 1);
});

/* Model selection: gemini-2.0-flash is primary, the 1.5 ids are availability
   fallbacks (Google 404s the retired bare `gemini-1.5-flash` on v1beta). */

const FALLBACK_ORDER = ["gemini-2.0-flash", "gemini-1.5-flash-latest", "gemini-1.5-pro"] as const;

test("404 model-not-found on the primary model falls back to the next id", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    if (urls.length === 1) return geminiModelNotFound("gemini-2.0-flash");
    return geminiReply();
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "Water in the morning.", diagnosis: null, source: "gemini",
  });
  assert.deepEqual(urls.map(requestedModel), ["gemini-2.0-flash", "gemini-1.5-flash-latest"]);
  assert.doesNotMatch(urls.join(" "), /models\/models\//);
});

test("all models unavailable returns Gemini Error listing every id tried", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return geminiModelNotFound(String(requestedModel(String(url))));
  });
  const response = await POST(request());
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /^Gemini Error:/);
  assert.deepEqual(urls.map(requestedModel), [...FALLBACK_ORDER]);
  for (const model of FALLBACK_ORDER) {
    assert.match(body.error, new RegExp(model.replace(/[.-]/g, "\\$&")));
  }
  assert.doesNotMatch(urls.join(" "), /models\/models\//);
});

test("a model that returns no text falls through to the next id", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return urls.length < FALLBACK_ORDER.length ? Response.json({ candidates: [] }) : geminiReply();
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "Water in the morning.", diagnosis: null, source: "gemini",
  });
  assert.deepEqual(urls.map(requestedModel), [...FALLBACK_ORDER]);
});

test("transient upstream failures do not trigger model fallback", async () => {
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 503 }),
  );
  const response = await POST(request());
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /^Gemini Error:/);
  assert.match(body.error, /HTTP 503/);
  // One attempt only: a 503 is not a model problem, so don't burn the request
  // budget re-trying the same failure on every id.
  assert.equal(upstream.mock.callCount(), 1);
});

test("image requests use server keys and return hybrid results without secrets", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("huggingface.co")) {
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-hf");
      return Response.json([{ label: "Tomato___healthy", score: 0.95 }]);
    }
    return geminiReply();
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis.healthy, true);
  assert.doesNotMatch(JSON.stringify(payload), /test-gemini|test-hf/);
});

test("strict pipeline: Gemini failure with image returns Gemini Error 500 (no vision-only fallback)", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) =>
    url.includes("huggingface.co")
      ? Response.json([{ label: "Tomato___healthy", score: 0.95 }])
      : new Response(null, { status: 503 }),
  );
  const response = await POST(request(true));
  assert.equal(response.status, 500);
  const body = await response.json() as { error: string };
  assert.match(body.error, /^Gemini Error:/);
});

for (const failure of ["http", "network", "empty"] as const) {
  test(`strict pipeline: upstream ${failure} failure is reported as Gemini Error 500 (not MISSING_KEYS)`, async () => {
    configureKeys();
    mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "empty") return Response.json({ candidates: [] });
      return new Response(null, { status: 503 });
    });
    const response = await POST(request());
    assert.equal(response.status, 500);
    const body = await response.json() as { error: string };
    assert.match(body.error, /^Gemini Error:/);
    assert.notEqual(body.error, "API keys missing on server");
  });
}

test("strict pipeline: HF failure returns HF Error 500 with stage identifier", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("huggingface.co")) return new Response(null, { status: 503 });
    return geminiReply();
  });
  const response = await POST(request(true));
  assert.equal(response.status, 500);
  const body = await response.json() as { error: string };
  assert.match(body.error, /^HF Error:/);
});

test("strict pipeline: HF 503 model-loading returns clear HF Error message", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("huggingface.co")) {
      return Response.json({ error: "Model linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification is currently loading", estimated_time: 23.4 }, { status: 503 });
    }
    return geminiReply();
  });
  const response = await POST(request(true));
  assert.equal(response.status, 500);
  const body = await response.json() as { error: string };
  assert.match(body.error, /^HF Error:/);
  assert.match(body.error, /loading/i);
});

test("strict pipeline: HF parses returned array to extract primary class and confidence", async () => {
  configureKeys();
  let geminiRequestBody = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.includes("huggingface.co")) {
      // Unsorted array — route must sort and pick Tomato___Early_blight 95% as top
      return Response.json([
        { label: "Tomato___Late_blight", score: 0.03 },
        { label: "Tomato___Early_blight", score: 0.95 },
        { label: "Tomato___healthy", score: 0.02 },
      ]);
    }
    // Step 2 runs on the primary model id, without a doubled `models/` prefix.
    assert.match(url, /\/models\/gemini-2\.0-flash:generateContent/);
    assert.doesNotMatch(url, /models\/models\//);
    geminiRequestBody = String(init.body ?? "");
    return geminiReply();
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.diagnosis.label, "Tomato___Early_blight");
  assert.equal(Math.round(payload.diagnosis.confidence * 100), 95);
  assert.equal(payload.source, "hybrid");
  // The Step 1 verdict (label + confidence) is passed straight into the prompt.
  assert.match(geminiRequestBody, /Tomato___Early_blight/);
  assert.match(geminiRequestBody, /95%/);
});
