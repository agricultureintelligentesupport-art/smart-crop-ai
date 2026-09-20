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
  const upstream = mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(new URL(url).searchParams.get("key"), "test-gemini");
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

test("vision-only advice remains available when Gemini fails", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) =>
    url.includes("huggingface.co")
      ? Response.json([{ label: "Tomato___healthy", score: 0.95 }])
      : new Response(null, { status: 503 }),
  );
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, "vision-only");
});

for (const failure of ["http", "network", "empty"] as const) {
  test(`upstream ${failure} failure is not misreported as missing keys`, async () => {
    configureKeys();
    mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "empty") return Response.json({ candidates: [] });
      return new Response(null, { status: 503 });
    });
    const response = await POST(request());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "AI service temporarily unavailable", code: "UPSTREAM_ERROR",
    });
  });
}
