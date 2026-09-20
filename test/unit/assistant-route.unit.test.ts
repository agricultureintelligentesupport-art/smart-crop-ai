import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
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
  "Qwen/Qwen2.5-Coder-7B-Instruct",
  "HuggingFaceH4/zephyr-7b-beta",
  "TiagoPires/Xenova-Qwen1.5-0.5B-Chat",
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

/**
 * Mirrors HF's 403 for gated families (meta-llama/*, google/gemma-*) whose
 * license the token owner never accepted on huggingface.co. Must walk the
 * model chain like any other availability error.
 */
const llmGated = () =>
  Response.json(
    {
      error:
        "You cannot access this model unless the model owner gives you access. You can do so by accepting the terms.",
    },
    { status: 403 },
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

/** Shape of the zero-failure `source: "direct"` fallback response. */
interface DirectPayload {
  reply: string;
  diagnosis: unknown;
  source: string;
  warnings: string[];
}

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
  test(`missing keys: HF ${name} returns 503 MISSING_KEYS without calling providers`, async () => {
    if (hf !== undefined) process.env.HUGGINGFACE_API_KEY = hf;
    // Even a valid-looking legacy Gemini key must not unlock the route.
    process.env.GEMINI_API_KEY = "test-gemini";
    const upstream = mock.method(globalThis, "fetch");
    for (const withImage of [false, true]) {
      const response = await POST(request(withImage));
      // Misconfiguration is the ONLY non-200/4xx outcome — 503, never 500.
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "API keys missing on server",
        code: "MISSING_KEYS",
      });
    }
    assert.equal(upstream.mock.callCount(), 0);
  });
}

test("keys are read per request, not when the route module loads", async () => {
  assert.equal((await POST(request())).status, 503);
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
  assert.equal((await POST(request())).status, 503);
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

test("every serverless model unsupported by provider degrades to 200 basic-mode with the whole chain in warnings", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return llmProviderUnsupported();
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
  const warning = payload.warnings.join(" | ");
  assert.match(warning, /Model not supported by provider hf-inference/);
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
  for (const model of LLM_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
  }
});

test("an unrelated 400 (bad request) fails fast without walking the model chain", async () => {
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Invalid payload: messages field is required." }, { status: 400 }),
  );
  const response = await POST(request());
  // Fail-proof: even a fail-fast upstream error answers 200 in basic mode.
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.warnings.join(" | "), /HTTP 400/);
  // A malformed-request 400 is not a model problem — no extra round-trips.
  assert.equal(upstream.mock.callCount(), 1);
});

test("all LLM models unavailable degrades to 200 basic-mode listing every id tried in warnings", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return llmModelNotFound(String(requestedChatModel(String(url))));
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis, null);
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
  const warning = payload.warnings.join(" | ");
  for (const model of LLM_FALLBACK_ORDER) {
    assert.match(warning, new RegExp(model.replace(/[./-]/g, "\\$&")));
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
  // Fail-proof: transient 503s degrade to the basic-mode reply, not an HTTP 500.
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.warnings.join(" | "), /HTTP 503/);
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

/* ------------------------------------------------------------------ */
/*  Zero-failure strategy — Step 2.5 direct formatting                  */
/* ------------------------------------------------------------------ */

test("zero-failure: Step 2 outage after a successful Step 1 returns 200 with source=direct", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) =>
    isChatUrl(String(url))
      ? new Response(null, { status: 503 })
      : Response.json([
          { label: "Tomato___Late_blight", score: 0.03 },
          { label: "Tomato___Early_blight", score: 0.95 },
          { label: "Tomato___healthy", score: 0.02 },
        ]),
  );
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis.label, "Tomato___Early_blight");
  // Clean concise Arabic Markdown card built from the Step 1 label + confidence.
  assert.match(payload.reply, /## 🔬 التشخيص/);
  assert.match(payload.reply, /Tomato___Early_blight/);
  assert.match(payload.reply, /95%/);
  assert.match(payload.reply, /الطماطم/);
  assert.match(payload.reply, /## 💊 خطة العلاج/);
  assert.match(payload.reply, /## 🛡️ الوقاية مستقبلاً/);
  // The failure is reported as a non-fatal warning, not a 500.
  assert.ok(Array.isArray(payload.warnings) && payload.warnings.length >= 1);
  assert.match(payload.warnings.join(" | "), /LLM unavailable/i);
  assert.doesNotMatch(JSON.stringify(payload), /test-hf|legacy-gemini-key-must-be-ignored/);
});

test("zero-failure: gated-model 403s walk the whole chain, then answer with direct formatting", async () => {
  configureKeys();
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) {
      urls.push(String(url));
      return llmGated();
    }
    return Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]);
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "direct");
  assert.deepEqual(urls.map(requestedChatModel), [...LLM_FALLBACK_ORDER]);
});

test("zero-failure: healthy diagnosis gets a direct reassurance card with prevention tips", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) =>
    isChatUrl(String(url))
      ? llmProviderUnsupported()
      : Response.json([{ label: "Tomato___healthy", score: 0.97 }]),
  );
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "direct");
  assert.equal(payload.diagnosis.healthy, true);
  assert.match(payload.reply, /سليمة/);
  assert.match(payload.reply, /97%/);
  assert.match(payload.reply, /## 🛡️ وقاية/);
  assert.doesNotMatch(payload.reply, /## 💊 خطة العلاج/);
});

test("zero-failure: low-confidence diagnosis asks for a clearer photo in the direct card", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) =>
    isChatUrl(String(url))
      ? new Response(null, { status: 503 })
      : Response.json([{ label: "Tomato___Late_blight", score: 0.3 }]),
  );
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /صورة أوضح/);
});

test("zero-failure: an unrelated 400 on every LLM still ends in direct formatting when Step 1 succeeded", async () => {
  configureKeys();
  const upstream = mock.method(globalThis, "fetch", async (url: string) =>
    isChatUrl(String(url))
      ? Response.json({ error: "Invalid payload." }, { status: 400 })
      : Response.json([{ label: "Tomato___Early_blight", score: 0.95 }]),
  );
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, "direct");
  // A bad-request 400 fails fast (1 chat attempt only) — then Step 2.5 takes over.
  assert.equal(
    upstream.mock.calls.filter((c) => isChatUrl(String(c.arguments[0]))).length,
    1,
  );
});

for (const failure of ["http", "network", "empty"] as const) {
  test(`zero-failure: text-only upstream ${failure} failure answers 200 basic-mode (not MISSING_KEYS, not 500)`, async () => {
    configureKeys();
    mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "empty") return Response.json({ choices: [] });
      return new Response(null, { status: 503 });
    });
    const response = await POST(request());
    assert.equal(response.status, 200);
    const payload = (await response.json()) as DirectPayload;
    assert.equal(payload.source, "direct");
    assert.equal(payload.diagnosis, null);
    // Non-greeting question → polite basic-mode explanation, not a config error.
    assert.match(payload.reply, /الوضع الأساسي/);
    assert.notEqual(payload.reply, "API keys missing on server");
    assert.match(payload.warnings.join(" | "), /Step 2 LLM unavailable/);
  });
}

/* ------------------------------------------------------------------ */
/*  Zero-failure strategy — text-only basic-mode replies                */
/* ------------------------------------------------------------------ */

function textRequest(message: string) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

for (const greeting of ["هلا", "مرحبا", "السلام عليكم", "أهلا وسهلا", "السلامُ عليكم ورحمةُ الله"] as const) {
  test(`zero-failure: text-only LLM outage greets back a simple greeting (${greeting}) with 200 direct`, async () => {
    configureKeys();
    mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
    const response = await POST(textRequest(greeting));
    assert.equal(response.status, 200);
    const payload = (await response.json()) as DirectPayload;
    assert.equal(payload.source, "direct");
    assert.equal(payload.diagnosis, null);
    // Greets the user back warmly…
    assert.match(payload.reply, /وعليكم السلام|أهلاً وسهلاً/);
    // …and asks how it can help with the farm/crops.
    assert.match(payload.reply, /نساعدك/);
    assert.match(payload.reply, /ضيعتك|محصولك/);
    assert.match(payload.warnings.join(" | "), /Step 2 LLM unavailable/);
  });
}

test("zero-failure: text-only LLM outage answers a farm question with the polite basic-mode fallback", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async () => llmGated());
  const response = await POST(textRequest("كيف أسقي الطماطم في بسكرة؟"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "direct");
  // Explains the basic mode and invites symptoms or a leaf photo.
  assert.match(payload.reply, /الوضع الأساسي/);
  assert.match(payload.reply, /أعراض/);
  assert.match(payload.reply, /صورة/);
  // The fallback must not look like a greeting reply.
  assert.doesNotMatch(payload.reply, /وعليكم السلام/);
});

test("zero-failure: a long message is never mistaken for a greeting", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const response = await POST(
    textRequest("السلام عليكم، عندي بقع صفراء على أوراق الطماطم منذ أسبوع وبدأت تنتشر للبيت البلاستيكي المجاور فماذا أفعل"),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.reply, /الوضع الأساسي/);
});

test("final safety net: an unexpected internal exception still answers 200 direct (never 500)", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async () => chatReply());
  // Simulate a bug deep inside the success path: the first response
  // serialization explodes; the route's outer try/catch must absorb it.
  let jsonCalls = 0;
  const original = NextResponse.json.bind(NextResponse);
  mock.method(NextResponse, "json", ((...args: Parameters<typeof NextResponse.json>) => {
    jsonCalls += 1;
    if (jsonCalls === 1) throw new Error("simulated serialization bug");
    return original(...args);
  }) as typeof NextResponse.json);
  const response = await POST(request());
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "direct");
  assert.match(payload.warnings.join(" | "), /simulated serialization bug/);
  assert.equal(jsonCalls, 2);
});

/* ------------------------------------------------------------------ */
/*  Zero-failure strategy — graceful vision degradation                 */
/* ------------------------------------------------------------------ */

test("zero-failure: HF vision failure degrades to the LLM with a Step 1 warning (never 500)", async () => {
  configureKeys();
  let chatCalls = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) {
      chatCalls += 1;
      return chatReply("Water in the morning.");
    }
    // Step 1 fails on every vision model → Step 2 must still answer the text.
    return new Response(null, { status: 503 });
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "llm");
  assert.equal(payload.diagnosis, null);
  assert.match(payload.warnings.join(" | "), /Step 1 vision unavailable/);
  assert.ok(chatCalls >= 1);
});

test("zero-failure: HF 503 model-loading with the LLM down too answers 200 asking to retry the photo", async () => {
  configureKeys();
  mock.method(globalThis, "fetch", async (url: string) => {
    if (isChatUrl(String(url))) return new Response(null, { status: 503 });
    return Response.json({ error: "Model linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification is currently loading", estimated_time: 23.4 }, { status: 503 });
  });
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as DirectPayload;
  assert.equal(payload.source, "direct");
  // The reply tells the user the photo couldn't be analysed and to retry.
  assert.match(payload.reply, /تعذّر تحليل صورة الورقة/);
  assert.match(payload.reply, /أعد المحاولة/);
  const warning = payload.warnings.join(" | ");
  assert.match(warning, /Step 1 vision unavailable/);
  assert.match(warning, /loading/i);
  assert.match(warning, /Step 2 LLM unavailable/);
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
