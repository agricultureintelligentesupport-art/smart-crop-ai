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
  // A stray legacy Gemini key must never be read anymore — the HF key is the
  // only secret the route may use.
  process.env.GEMINI_API_KEY = " legacy-gemini-key-must-be-ignored ";
  process.env.HUGGINGFACE_API_KEY = " test-hf ";
}

/* ------------------------------------------------------------------ */
/*  HF Step 2 (LLM chat-completions) mock helpers                       */
/* ------------------------------------------------------------------ */

/** Step 2 model chain, in order — must mirror the route's HF_LLM_MODELS. */
const LLM_FALLBACK_ORDER = [
  "meta-llama/Llama-3.2-3B-Instruct",
  "meta-llama/Llama-3.1-8B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.3",
  "google/gemma-2-9b-it",
] as const;

const chatReply = (content = "اسقِ في الصباح الباكر.") =>
  Response.json({ choices: [{ message: { role: "assistant", content } }] });

/** Mirrors the HF router response for a retired / mistyped model id. */
const llmModelNotFound = (model: string) =>
  Response.json({ error: `Model ${model} not found.` }, { status: 404 });

/**
 * Mirrors the live HF serverless router rejection for an id no longer in its
 * catalog: `400 — Model not supported by provider hf-inference`. Must behave
 * like a model-availability error (fall through to the next id).
 */
const llmProviderUnsupported = () =>
  Response.json(
    { error: "Model not supported by provider hf-inference" },
    { status: 400 },
  );

const isChatUrl = (url: string) => url.includes("/v1/chat/completions");

const requestedChatModel = (url: string) =>
  /\/hf-inference\/models\/(.+?)\/v1\/chat\/completions/.exec(url)?.[1];

interface ChatRequestBody {
  model?: string;
  messages?: { role: string; content: string }[];
  max_tokens?: number;
}

const parseChatBody = (init: RequestInit): ChatRequestBody =>
  JSON.parse(String(init.body ?? "{}")) as ChatRequestBody;

test("assistant route explicitly uses dynamic rendering", () => {
  assert.equal(dynamic, "force-dynamic");
});

/* ------------------------------------------------------------------ */
/*  Key handling — only HUGGINGFACE_API_KEY is required                 */
/* ------------------------------------------------------------------ */

for (const [name, hf] of [
  ["absent", undefined],
  ["blank", "   "],
  ["tab-only", "\t"],
] as const) {
  test(`missing keys: HF ${name} returns 500 without calling providers`, async () => {
    if (hf !== undefined) process.env.HUGGINGFACE_API_KEY = hf;
    // Even a valid-looking legacy Gemini key must not unlock the route.
    process.env.GEMINI_API_KEY = "test-gemini";
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
  process.env.HUGGINGFACE_API_KEY = " test-hf ";
  const upstream = mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    assert.ok(isChatUrl(String(url)));
    assert.equal(requestedChatModel(String(url)), LLM_FALLBACK_ORDER[0]);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-hf");
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "Water in the morning.", diagnosis: null, source: "llm",
  });
  assert.equal(upstream.mock.callCount(), 1);
  delete process.env.HUGGINGFACE_API_KEY;
  assert.equal((await POST(request())).status, 500);
  assert.equal(upstream.mock.callCount(), 1);
});

/* ------------------------------------------------------------------ */
/*  Step 2 request shape — system prompt & concise-Arabic instruction   */
/* ------------------------------------------------------------------ */

test("Step 2 sends the concise professional Arabic system prompt to the HF LLM", async () => {
  configureKeys();
  const captured: { body?: ChatRequestBody } = {};
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.ok(isChatUrl(String(url)));
    captured.body = parseChatBody(init);
    return chatReply();
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const chatBody = captured.body;
  assert.ok(chatBody);
  assert.equal(chatBody.model, LLM_FALLBACK_ORDER[0]);
  const messages = chatBody.messages ?? [];
  assert.ok(messages.length >= 2);
  const [system, user] = messages;
  assert.equal(system.role, "system");
  // The mandated system instruction: expert agricultural assistant, concise,
  // direct, practical Arabic, no introductions and no padding.
  assert.match(system.content, /أنت مساعد زراعي خبير/);
  assert.match(system.content, /دون مقدمات أو إطالة/);
  assert.match(system.content, /باللغة العربية/);
  assert.match(system.content, /عملي/);
  assert.equal(user.role, "user");
  assert.match(user.content, /How should I irrigate tomatoes\?/);
  // Concise output must be enforced with a hard token cap too.
  assert.ok(typeof chatBody.max_tokens === "number" && chatBody.max_tokens <= 1000);
});

/* ------------------------------------------------------------------ */
/*  Step 2 model selection & fallback chain                             */
/* ------------------------------------------------------------------ */

test("404 model-not-found on the primary LLM falls back to the next id", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    if (urls.length === 1) return llmModelNotFound(LLM_FALLBACK_ORDER[0]);
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "Water in the morning.", diagnosis: null, source: "llm",
  });
  assert.deepEqual(urls.map(requestedChatModel), [
    LLM_FALLBACK_ORDER[0],
    LLM_FALLBACK_ORDER[1],
  ]);
});

test("400 Model-not-supported-by-provider on the primary LLM falls back to the next id", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    if (urls.length === 1) return llmProviderUnsupported();
    return chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "Water in the morning.", diagnosis: null, source: "llm",
  });
  assert.deepEqual(urls.map(requestedChatModel), [
    LLM_FALLBACK_ORDER[0],
    LLM_FALLBACK_ORDER[1],
  ]);
});

test("every serverless model unsupported by provider returns LLM Error listing the whole chain", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return llmProviderUnsupported();
  });
  const response = await POST(request());
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /^LLM Error:/);
  assert.match(body.error, /Model not supported by provider hf-inference/);
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
  for (const model of LLM_FALLBACK_ORDER) {
    assert.match(body.error, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

test("an unrelated 400 (bad request) fails fast without walking the model chain", async () => {
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Invalid payload: messages field is required." }, { status: 400 }),
  );
  const response = await POST(request());
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /^LLM Error:/);
  assert.match(body.error, /HTTP 400/);
  // A malformed-request 400 is not a model problem — no extra round-trips.
  assert.equal(upstream.mock.callCount(), 1);
});

test("all LLM models unavailable returns LLM Error listing every id tried", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return llmModelNotFound(String(requestedChatModel(String(url))));
  });
  const response = await POST(request());
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /^LLM Error:/);
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
  for (const model of LLM_FALLBACK_ORDER) {
    assert.match(body.error, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

test("an LLM that returns no text falls through to the next id", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return urls.length < LLM_FALLBACK_ORDER.length
      ? Response.json({ choices: [] })
      : chatReply("Water in the morning.");
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reply: "Water in the morning.", diagnosis: null, source: "llm",
  });
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
});

test("transient upstream failures do not trigger model fallback", async () => {
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async () =>
    new Response(null, { status: 503 }),
  );
  const response = await POST(request());
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /^LLM Error:/);
  assert.match(body.error, /HTTP 503/);
  // One attempt only: a 503 is not a model problem, so don't burn the request
  // budget re-trying the same failure on every id.
  assert.equal(upstream.mock.callCount(), 1);
});

/* ------------------------------------------------------------------ */
/*  Hybrid pipeline (Step 1 vision + Step 2 LLM)                        */
/* ------------------------------------------------------------------ */

test("image requests use server keys and return hybrid results without secrets", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-hf");
    if (!isChatUrl(String(url))) {
      // Step 1 — PlantVillage vision classifier.
      assert.match(String(url), /router\.huggingface\.co\/hf-inference\/models\//);
      return Response.json([{ label: "Tomato___healthy", score: 0.95 }]);
    }
    // Step 2 — HF LLM chat completion.
    return chatReply("النبتة سليمة. قلّم الأوراق السفلية.");
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "hybrid");
  assert.equal(payload.diagnosis.healthy, true);
  assert.doesNotMatch(JSON.stringify(payload), /test-hf|legacy-gemini-key-must-be-ignored/);
});

test("strict pipeline: LLM failure with image returns LLM Error 500 (no vision-only fallback)", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) =>
    isChatUrl(String(url))
      ? new Response(null, { status: 503 })
      : Response.json([{ label: "Tomato___healthy", score: 0.95 }]),
  );
  const response = await POST(request(true));
  assert.equal(response.status, 500);
  const body = await response.json() as { error: string };
  assert.match(body.error, /^LLM Error:/);
});

for (const failure of ["http", "network", "empty"] as const) {
  test(`strict pipeline: upstream ${failure} failure is reported as LLM Error 500 (not MISSING_KEYS)`, async () => {
    configureKeys();
    mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "empty") return Response.json({ choices: [] });
      return new Response(null, { status: 503 });
    });
    const response = await POST(request());
    assert.equal(response.status, 500);
    const body = await response.json() as { error: string };
    assert.match(body.error, /^LLM Error:/);
    assert.notEqual(body.error, "API keys missing on server");
  });
}

test("strict pipeline: HF vision failure returns HF Error 500 with stage identifier", async () => {
  configureKeys();
  let chatCalls = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) {
      chatCalls += 1;
      return chatReply();
    }
    // Step 1 fails on every vision model → Step 2 must never run.
    return new Response(null, { status: 503 });
  });
  const response = await POST(request(true));
  assert.equal(response.status, 500);
  const body = await response.json() as { error: string };
  assert.match(body.error, /^HF Error:/);
  assert.equal(chatCalls, 0);
});

test("strict pipeline: HF 503 model-loading returns clear HF Error message", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) return chatReply();
    return Response.json({ error: "Model linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification is currently loading", estimated_time: 23.4 }, { status: 503 });
  });
  const response = await POST(request(true));
  assert.equal(response.status, 500);
  const body = await response.json() as { error: string };
  assert.match(body.error, /^HF Error:/);
  assert.match(body.error, /loading/i);
});

test("strict pipeline: HF parses returned array to extract primary class and confidence", async () => {
  configureKeys();
  let llmRequestBody = "";
  let llmUrl = "";
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (isChatUrl(String(url))) {
      llmUrl = String(url);
      llmRequestBody = String(init.body ?? "");
      return chatReply();
    }
    // Unsorted array — route must sort and pick Tomato___Early_blight 95% as top
    return Response.json([
      { label: "Tomato___Late_blight", score: 0.03 },
      { label: "Tomato___Early_blight", score: 0.95 },
      { label: "Tomato___healthy", score: 0.02 },
    ]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.diagnosis.label, "Tomato___Early_blight");
  assert.equal(Math.round(payload.diagnosis.confidence * 100), 95);
  assert.equal(payload.source, "hybrid");
  // Step 2 runs on the primary HF LLM via the chat-completions endpoint…
  assert.equal(requestedChatModel(llmUrl), LLM_FALLBACK_ORDER[0]);
  // …and the Step 1 verdict (label + confidence) is passed straight into the prompt.
  assert.match(llmRequestBody, /Tomato___Early_blight/);
  assert.match(llmRequestBody, /95%/);
});
