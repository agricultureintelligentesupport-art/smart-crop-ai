import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  CLIENT_CODECRAFT_TIMEOUT_MS,
  analyzeImageClientSideCodeCraft,
  resolveClientCodeCraftApiKey,
} from "@/lib/assistant/codecraft-client";

/**
 * Unit tests for the CLIENT-SIDE CodeCraft pre-check (browser direct fetch)
 * that runs BEFORE the standard `/api/assistant` POST. The suite locks:
 *
 *   1. the request shape — a direct POST to
 *      `https://codecraftapi.com/v1/chat/completions` with Bearer
 *      `NEXT_PUBLIC_CODECRAFT_API_KEY`, model `gpt-4o`, the photo as an
 *      `image_url` data URL and the SAME structured prompt the server
 *      engine sends (no duplication, no drift);
 *   2. the success contract — the shared `AssistantDiagnosis` mapping the
 *      pipeline already consumes (label, Arabic, severity, treatment…);
 *   3. the SILENT failure contract — the function NEVER throws and NEVER
 *      hangs: no key, placeholder key, CORS/network error, the deadline,
 *      HTTP 401/402/403/429/5xx, empty/non-JSON answers and "not a plant"
 *      all resolve to `null` so the caller proceeds with the untouched
 *      server pipeline as the primary fail-safe.
 */

const CLIENT_KEY = "test-client-codecraft";
const CODECRAFT_URL = "https://codecraftapi.com/v1/chat/completions";

/** The one env var the client helper may read — restored afterwards. */
const originalClientKey = process.env.NEXT_PUBLIC_CODECRAFT_API_KEY;

let fetchCalls = 0;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_CODECRAFT_API_KEY;
  fetchCalls = 0;
  // No test may accidentally reach the real CodeCraft API.
  mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("Unexpected upstream request");
  });
});

afterEach(() => {
  mock.restoreAll();
  if (originalClientKey === undefined) delete process.env.NEXT_PUBLIC_CODECRAFT_API_KEY;
  else process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = originalClientKey;
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** A 1×1 JPEG — the smallest real leaf photo. */
const LEAF_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA/9k=";

interface RequestCapture {
  url: string;
  auth: string | null;
  body: {
    model?: string;
    messages?: {
      role: string;
      content: string | { type?: string; text?: string; image_url?: { url?: string } }[];
    }[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  };
}

/** Install a fetch mock that records the CodeCraft request and answers once. */
function mockCodeCraft(
  answer: () => Response,
  options: { capture?: RequestCapture[]; urls?: string[] } = {},
): void {
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    fetchCalls += 1;
    options.urls?.push(String(url));
    options.capture?.push({
      url: String(url),
      auth: new Headers(init.headers).get("Authorization"),
      body: JSON.parse(String(init.body ?? "{}")) as RequestCapture["body"],
    });
    return answer();
  });
}

/** A successful CodeCraft chat completion carrying `content` verbatim. */
function chatCompletion(content: string): Response {
  return Response.json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

const verdictJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    is_plant: true,
    crop: "Tomato",
    crop_ar: "الطماطم",
    disease: "Early blight",
    disease_ar: "اللفحة المبكرة",
    healthy: false,
    severity: "medium",
    severity_percent: 45,
    confidence: 92,
    symptoms: ["بقع بنية دائرية"],
    immediate_treatment: ["رشّ مانكوزيب", "إزالة الأوراق المصابة"],
    prevention: ["تناوب زراعي"],
    alternatives: [{ disease: "Late blight", confidence: 6 }],
    notes: "مرحلة مبكرة",
    ...overrides,
  });

/* ------------------------------------------------------------------ */
/*  Environment resolution (NEXT_PUBLIC_ client key)                   */
/* ------------------------------------------------------------------ */

test("the documented 8 s client deadline is the default budget", () => {
  assert.equal(CLIENT_CODECRAFT_TIMEOUT_MS, 8_000);
});

test("no client key configured → the pre-check is disabled (null, no request, no throw)", async () => {
  assert.equal(resolveClientCodeCraftApiKey(), null);
  const result = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");
  assert.equal(result, null);
  assert.equal(fetchCalls, 0);
});

test("the documented placeholder client key is treated as 'not configured'", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = "your_key_here";
  assert.equal(resolveClientCodeCraftApiKey(), null);
  const result = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");
  assert.equal(result, null);
  assert.equal(fetchCalls, 0);
});

test("client keys are trimmed; blanks and whitespace-only values stay disabled", () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = "  sk-live  ";
  assert.equal(resolveClientCodeCraftApiKey(), "sk-live");
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = "   ";
  assert.equal(resolveClientCodeCraftApiKey(), null);
});

/* ------------------------------------------------------------------ */
/*  Request shape (direct browser POST, OpenAI chat-completions)       */
/* ------------------------------------------------------------------ */

test("sends a direct OpenAI-compatible vision request to codecraftapi.com", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = ` ${CLIENT_KEY} `;
  const capture: RequestCapture[] = [];
  mockCodeCraft(() => chatCompletion(verdictJson()), { capture });

  const diagnosis = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");

  assert.equal(fetchCalls, 1, "the client pre-check is exactly ONE round-trip");
  assert.equal(capture[0]?.url, CODECRAFT_URL);
  assert.equal(capture[0]?.auth, `Bearer ${CLIENT_KEY}`);
  assert.equal(capture[0]?.body.model, "gpt-4o");
  assert.equal(capture[0]?.body.stream, false);

  const messages = capture[0]?.body.messages ?? [];
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  // The EXACT system instruction the server engine uses (single source).
  assert.match(String(messages[0]?.content), /plant pathology vision module/i);

  const userContent = messages[1]?.content;
  assert.ok(Array.isArray(userContent), "the user turn must be a multimodal part array");
  const parts = Array.isArray(userContent) ? userContent : [];
  assert.ok(parts.some((part) => part.type === "text"), "the text instruction must accompany the photo");
  const imagePart = parts.find((part) => part.type === "image_url");
  assert.equal(imagePart?.image_url?.url, `data:image/jpeg;base64,${LEAF_B64}`);

  // The credential travels in the header ONLY — never in the URL.
  assert.doesNotMatch(capture[0]?.url ?? "", new RegExp(CLIENT_KEY));

  assert.ok(diagnosis, "a valid verdict must normalise to a diagnosis");
  assert.equal(diagnosis?.engine, "codecraft");
  assert.equal(diagnosis?.model, "codecraft/gpt-4o");
  assert.equal(diagnosis?.label, "Tomato___Early_blight");
});

test("the farming profile context is forwarded to sharpen the verdict", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  const capture: RequestCapture[] = [];
  mockCodeCraft(() => chatCompletion(verdictJson()), { capture });

  await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg", {
    lang: "fr",
    profile: { wilayaName: "بسكرة", crop: "طماطم", role: "farmer", lang: "fr" },
  });

  const body = JSON.stringify(capture[0]?.body ?? {});
  assert.match(body, /بسكرة/);
  assert.match(body, /طماطم/);
  // `lang: "fr"` switches the requested output language of the plan.
  assert.match(body, /French/);
});

/* ------------------------------------------------------------------ */
/*  Success contract — the shared AssistantDiagnosis mapping           */
/* ------------------------------------------------------------------ */

test("maps the verdict onto the shared diagnosis contract (label, Arabic, severity, treatment)", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  mockCodeCraft(() => chatCompletion(verdictJson()));

  const diagnosis = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");

  // Same shape the server pipeline consumes — the UI card and the LLM
  // reference block read it without knowing which side answered.
  assert.equal(diagnosis?.label, "Tomato___Early_blight");
  assert.equal(diagnosis?.labelAr, "الطماطم — اللفحة المبكرة");
  assert.equal(diagnosis?.cropAr, "الطماطم");
  assert.equal(diagnosis?.diseaseAr, "اللفحة المبكرة");
  assert.equal(diagnosis?.healthy, false);
  assert.equal(Math.round((diagnosis?.confidence ?? 0) * 100), 92);
  assert.equal(diagnosis?.engine, "codecraft");
  assert.equal(diagnosis?.severity, "متوسطة");
  assert.equal(diagnosis?.severityPercent, 45);
  assert.deepEqual(diagnosis?.symptoms, ["بقع بنية دائرية"]);
  assert.deepEqual(diagnosis?.treatment, ["رشّ مانكوزيب", "إزالة الأوراق المصابة"]);
  assert.deepEqual(diagnosis?.prevention, ["تناوب زراعي"]);
  assert.equal(diagnosis?.notes, "مرحلة مبكرة");
});

test("a healthy verdict becomes the shared healthy diagnosis", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  mockCodeCraft(() =>
    chatCompletion(verdictJson({ healthy: true, disease: "healthy", severity: "none", confidence: 97 })),
  );

  const diagnosis = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");
  assert.equal(diagnosis?.healthy, true);
  assert.equal(diagnosis?.label, "Tomato___healthy");
  assert.match(diagnosis?.labelAr ?? "", /سليمة/);
});

test("a data-URL input is accepted and its mime type is honoured", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  const capture: RequestCapture[] = [];
  mockCodeCraft(() => chatCompletion(verdictJson()), { capture });

  const diagnosis = await analyzeImageClientSideCodeCraft(`data:image/png;base64,${LEAF_B64}`);
  assert.ok(diagnosis);
  const imagePart = (capture[0]?.body.messages?.[1]?.content as { type?: string; image_url?: { url?: string } }[]).find(
    (part) => part.type === "image_url",
  );
  assert.equal(imagePart?.image_url?.url, `data:image/png;base64,${LEAF_B64}`);
});

test("a baseUrl override points the direct fetch elsewhere (tests / proxies)", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  const urls: string[] = [];
  mockCodeCraft(() => chatCompletion(verdictJson()), { urls });

  const diagnosis = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg", {
    baseUrl: "https://proxy.internal/v1",
  });
  assert.ok(diagnosis);
  assert.equal(urls[0], "https://proxy.internal/v1/chat/completions");
});

/* ------------------------------------------------------------------ */
/*  Silent failure contract — null, never a throw, never a hang        */
/* ------------------------------------------------------------------ */

test("an invalid image payload is rejected before any request is sent (null, no throw)", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  assert.equal(await analyzeImageClientSideCodeCraft("not-base64!!", "image/jpeg"), null);
  assert.equal(await analyzeImageClientSideCodeCraft(LEAF_B64, "text/plain"), null);
  assert.equal(fetchCalls, 0);
});

test("account failures (401/402/403/429) and 5xx resolve to null — silent", async () => {
  for (const status of [401, 402, 403, 429, 500]) {
    process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
    mockCodeCraft(() =>
      Response.json({ error: { message: "Insufficient credits", code: "insufficient_quota" } }, { status }),
    );

    const result = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");
    assert.equal(result, null, `HTTP ${status} must resolve to null, never throw`);
  }
});

test("a network error (CORS block) resolves to null — the caller proceeds to /api/assistant", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    // A CORS rejection surfaces in the browser as a network failure with no
    // status — the exact shape the pre-check must swallow silently.
    const error = new TypeError("Failed to fetch");
    throw error;
  });

  const result = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");
  assert.equal(result, null);
  assert.equal(fetchCalls, 1, "one attempt, then silent fallback");
});

test("an empty or non-JSON answer resolves to null (not a diagnosis)", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  mockCodeCraft(() => chatCompletion(""));
  assert.equal(await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg"), null);

  mockCodeCraft(() => chatCompletion("تعذّر تحليل الصورة"));
  assert.equal(await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg"), null);
});

test('"not a plant" is a definitive answer with nothing to attach → null', async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  const urls: string[] = [];
  mockCodeCraft(() => chatCompletion(JSON.stringify({ is_plant: false })), { urls });

  const result = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");
  assert.equal(result, null);
  assert.equal(urls.length, 1, "a definitive answer must not retry another model");
});

test("a stalled response is aborted at the deadline and resolves to null (fail fast)", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });

  const startedAt = Date.now();
  const result = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg", { timeoutMs: 75 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result, null);
  assert.ok(elapsed < 5_000, `the deadline must fire fast (took ${elapsed} ms)`);
});

test("the deadline covers a hung BODY too (headers answered, body never arrives)", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
    const signal = init?.signal;
    // 200 headers + a body stream that never closes: response.json() would
    // wait forever without the shared deadline.
    const neverClosing = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          try {
            controller.error(new Error("aborted"));
          } catch {
            // already closed
          }
        });
      },
    });
    return Promise.resolve(
      new Response(neverClosing, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  const startedAt = Date.now();
  const result = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg", { timeoutMs: 75 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result, null);
  assert.ok(elapsed < 5_000, `the body read must be bounded by the deadline (took ${elapsed} ms)`);
});

test("an unexpected response shape (no choices at all) resolves to null — no throw", async () => {
  process.env.NEXT_PUBLIC_CODECRAFT_API_KEY = CLIENT_KEY;
  mockCodeCraft(() => Response.json({ id: "cmpl-x", object: "chat.completion" }));

  const result = await analyzeImageClientSideCodeCraft(LEAF_B64, "image/jpeg");
  assert.equal(result, null);
});
