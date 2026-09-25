import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  CODECRAFT_BASE_URL_DEFAULT,
  CodeCraftVisionError,
  analyzePlantImageWithCodeCraft,
  codeCraftChatCompletionsUrl,
  extractJsonObject,
  normalizeImageInput,
  resolveCodeCraftApiKey,
  resolveCodeCraftBaseUrl,
  resolveCodeCraftVisionModels,
  sanitizeBaseUrl,
  toAssistantDiagnosis,
  toPlantVillageLabel,
  tryAnalyzePlantImageWithCodeCraft,
  type CodeCraftVisionContext,
} from "@/lib/assistant/codecraft-vision";

/**
 * Unit tests for the dedicated CodeCraft vision service — the PRIMARY engine
 * of Step 1 in `/api/assistant`. The suite locks three contracts:
 *   1. the OpenAI-compatible request shape (endpoint, Bearer auth, model id,
 *      the photo as an `image_url` data URL);
 *   2. the structured verdict → `AssistantDiagnosis` mapping (the SAME
 *      contract MobileNetV2 returns, so the agent pipeline is unaffected);
 *   3. the failure contract — every failure mode throws
 *      `CodeCraftVisionError` (and `tryAnalyze…` never throws), which is what
 *      lets the route fail over silently to the existing engine.
 */

const CODECRAFT_KEY = "test-codecraft";
const CODECRAFT_URL = `${CODECRAFT_BASE_URL_DEFAULT}/chat/completions`;

/** Every env var the module (or a developer's shell) may set. */
const SCRUBBED_ENV_PATTERN = /^CODECRAFT_(API_KEY|BASE_URL|VISION_MODEL|MODEL)$/;

const originalEnv: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (SCRUBBED_ENV_PATTERN.test(name)) originalEnv[name] = value;
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (SCRUBBED_ENV_PATTERN.test(name)) delete process.env[name];
  }
  // No test may accidentally reach the real CodeCraft API.
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected upstream request");
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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
  };
}

/** Install a fetch mock that records the CodeCraft request and answers once. */
function mockCodeCraft(
  answer: () => Response,
  options: { capture?: RequestCapture[]; urls?: string[] } = {},
): void {
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
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

const context = (overrides: CodeCraftVisionContext = {}): CodeCraftVisionContext => ({
  mimeType: "image/jpeg",
  ...overrides,
});

/* ------------------------------------------------------------------ */
/*  Environment resolution                                             */
/* ------------------------------------------------------------------ */

test("no key configured → the engine is disabled (null, no request, no throw)", async () => {
  assert.equal(resolveCodeCraftApiKey(), null);
  await assert.rejects(
    () => analyzePlantImageWithCodeCraft(LEAF_B64, context()),
    (error: unknown) =>
      error instanceof CodeCraftVisionError && /not configured/i.test(error.message),
  );
});

test("the documented placeholder key is treated as 'not configured'", () => {
  process.env.CODECRAFT_API_KEY = "your_key_here";
  assert.equal(resolveCodeCraftApiKey(), null);
});

test("keys are trimmed; blanks and whitespace-only values stay disabled", () => {
  process.env.CODECRAFT_API_KEY = "  sk-live  ";
  assert.equal(resolveCodeCraftApiKey(), "sk-live");
  process.env.CODECRAFT_API_KEY = "   ";
  assert.equal(resolveCodeCraftApiKey(), null);
});

test("base URL: documented default, override, and normalisation", () => {
  assert.equal(resolveCodeCraftBaseUrl(), "https://codecraftapi.com/v1");
  assert.equal(codeCraftChatCompletionsUrl(), CODECRAFT_URL);

  process.env.CODECRAFT_BASE_URL = " https://proxy.internal/v1/ ";
  assert.equal(resolveCodeCraftBaseUrl(), "https://proxy.internal/v1");
  assert.equal(codeCraftChatCompletionsUrl(), "https://proxy.internal/v1/chat/completions");

  // A pasted `/chat/completions` suffix must never double the path.
  process.env.CODECRAFT_BASE_URL = "https://proxy.internal/v1/chat/completions";
  assert.equal(resolveCodeCraftBaseUrl(), "https://proxy.internal/v1");

  // Blank override → documented default.
  process.env.CODECRAFT_BASE_URL = "   ";
  assert.equal(resolveCodeCraftBaseUrl(), CODECRAFT_BASE_URL_DEFAULT);
});

test("sanitizeBaseUrl strips Markdown syntax, brackets, parentheses, trailing slashes and &gt;", () => {
  const clean = "https://codecraftapi.com/v1";

  // Markdown link syntax: only the inner URL survives.
  assert.equal(sanitizeBaseUrl(`[CodeCraft](${clean})`), clean);
  assert.equal(sanitizeBaseUrl(`[${clean}](${clean})`), clean);
  // Square brackets and parentheses around a bare URL.
  assert.equal(sanitizeBaseUrl(`[${clean}]`), clean);
  assert.equal(sanitizeBaseUrl(`(${clean})`), clean);
  // The rendered `&gt;` tail of a &gt;-escaped copy/paste is dropped.
  assert.equal(sanitizeBaseUrl(`${clean}&gt;`), clean);
  assert.equal(sanitizeBaseUrl(`${clean}&gt; extra text`), clean);

  // Trailing slashes are removed.
  assert.equal(sanitizeBaseUrl(`${clean}/`), clean);
  assert.equal(sanitizeBaseUrl(`${clean}///`), clean);
  // A pasted `/chat/completions` suffix (with trailing slashes) never doubles.
  assert.equal(sanitizeBaseUrl(`${clean}/chat/completions/`), clean);

  // No valid http(s) URL → the plain default, never markdown.
  assert.equal(sanitizeBaseUrl(""), CODECRAFT_BASE_URL_DEFAULT);
  assert.equal(sanitizeBaseUrl("   "), CODECRAFT_BASE_URL_DEFAULT);
  assert.equal(sanitizeBaseUrl("[CodeCraft API]"), CODECRAFT_BASE_URL_DEFAULT);
  assert.equal(sanitizeBaseUrl("(no url here)"), CODECRAFT_BASE_URL_DEFAULT);
});

test("model chain: default gpt-4o → gpt-4o-mini, overridable and deduplicated", () => {
  assert.deepEqual(resolveCodeCraftVisionModels(), ["gpt-4o", "gpt-4o-mini"]);
  process.env.CODECRAFT_VISION_MODEL = " gpt-4o-mini , custom/vision , gpt-4o-mini ";
  assert.deepEqual(resolveCodeCraftVisionModels(), ["gpt-4o-mini", "custom/vision"]);
  process.env.CODECRAFT_VISION_MODEL = "  ";
  assert.deepEqual(resolveCodeCraftVisionModels(), ["gpt-4o", "gpt-4o-mini"]);
});

/* ------------------------------------------------------------------ */
/*  Request shape (OpenAI chat-completions format)                     */
/* ------------------------------------------------------------------ */

test("sends an OpenAI-compatible vision request: bearer auth, gpt-4o, data-URL image", async () => {
  process.env.CODECRAFT_API_KEY = ` ${CODECRAFT_KEY} `;
  const capture: RequestCapture[] = [];
  mockCodeCraft(() => chatCompletion(verdictJson()), { capture });

  const diagnosis = await analyzePlantImageWithCodeCraft(LEAF_B64, context());

  assert.equal(capture.length, 1);
  assert.equal(capture[0]?.url, CODECRAFT_URL);
  assert.equal(capture[0]?.auth, `Bearer ${CODECRAFT_KEY}`);
  assert.equal(capture[0]?.body.model, "gpt-4o");

  const messages = capture[0]?.body.messages ?? [];
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "system");
  const userContent = messages[1]?.content;
  assert.ok(Array.isArray(userContent), "the user turn must be a multimodal part array");
  const parts = Array.isArray(userContent) ? userContent : [];
  assert.ok(
    parts.some((part) => part.type === "text"),
    "the text instruction must accompany the photo",
  );
  const imagePart = parts.find((part) => part.type === "image_url");
  assert.equal(imagePart?.image_url?.url, `data:image/jpeg;base64,${LEAF_B64}`);

  assert.equal(diagnosis.engine, "codecraft");
  assert.equal(diagnosis.label, "Tomato___Early_blight");
});

test("the farming profile context is forwarded to sharpen the verdict", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  const capture: RequestCapture[] = [];
  mockCodeCraft(() => chatCompletion(verdictJson()), { capture });

  await analyzePlantImageWithCodeCraft(
    LEAF_B64,
    context({ profile: { wilayaName: "بسكرة", crop: "طماطم", role: "farmer", lang: "fr" } }),
  );

  const body = JSON.stringify(capture[0]?.body ?? {});
  assert.match(body, /بسكرة/);
  assert.match(body, /طماطم/);
  // `lang: "fr"` switches the requested output language of the plan.
  assert.match(body, /French/);
});

/* ------------------------------------------------------------------ */
/*  Structured verdict → AssistantDiagnosis                            */
/* ------------------------------------------------------------------ */

test("maps the verdict onto the shared diagnosis contract (label, Arabic, severity, treatment)", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mockCodeCraft(() => chatCompletion(verdictJson()));

  const diagnosis = await analyzePlantImageWithCodeCraft(LEAF_B64, context());

  // Same shape MobileNetV2 produces — the UI card and the LLM reference block
  // read it without knowing which engine answered.
  assert.equal(diagnosis.label, "Tomato___Early_blight");
  assert.equal(diagnosis.labelAr, "الطماطم — اللفحة المبكرة");
  assert.equal(diagnosis.cropAr, "الطماطم");
  assert.equal(diagnosis.diseaseAr, "اللفحة المبكرة");
  assert.equal(diagnosis.healthy, false);
  assert.equal(Math.round(diagnosis.confidence * 100), 92);
  assert.equal(diagnosis.model, "codecraft/gpt-4o");
  assert.equal(diagnosis.engine, "codecraft");
  // CodeCraft's extra structured findings ride along.
  assert.equal(diagnosis.severity, "متوسطة");
  assert.equal(diagnosis.severityPercent, 45);
  assert.deepEqual(diagnosis.symptoms, ["بقع بنية دائرية"]);
  assert.deepEqual(diagnosis.treatment, ["رشّ مانكوزيب", "إزالة الأوراق المصابة"]);
  assert.deepEqual(diagnosis.prevention, ["تناوب زراعي"]);
  assert.equal(diagnosis.notes, "مرحلة مبكرة");
  // Top-1 + the alternative, in the same { label, score } candidate contract.
  assert.deepEqual(diagnosis.candidates, [
    { label: "Tomato___Early_blight", score: 0.92 },
    { label: "Tomato___Late_blight", score: 0.06 },
  ]);
});

test("a healthy verdict becomes the shared healthy diagnosis", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mockCodeCraft(() =>
    chatCompletion(
      verdictJson({ healthy: true, disease: "healthy", severity: "none", confidence: 97 }),
    ),
  );

  const diagnosis = await analyzePlantImageWithCodeCraft(LEAF_B64, context());
  assert.equal(diagnosis.healthy, true);
  assert.equal(diagnosis.label, "Tomato___healthy");
  assert.match(diagnosis.labelAr, /سليمة/);
  assert.equal(diagnosis.severity, "منعدمة");
  assert.equal(diagnosis.severityPercent, 0);
});

test("a missing confidence falls back to a neutral medium value (never overstated)", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mockCodeCraft(() => chatCompletion(verdictJson({ confidence: null })));

  const diagnosis = await analyzePlantImageWithCodeCraft(LEAF_B64, context());
  assert.equal(diagnosis.confidence, 0.7);
});

test("confidence accepts 0–1 ratios, 0–100 integers and '85%' strings", () => {
  const build = (confidence: unknown) =>
    toAssistantDiagnosis({ is_plant: true, crop: "Tomato", disease: "Early blight", confidence }, "gpt-4o");
  assert.equal(build(0.92)?.confidence, 0.92);
  assert.equal(build(92)?.confidence, 0.92);
  assert.equal(build("85%")?.confidence, 0.85);
  assert.equal(build("nonsense")?.confidence, 0.7);
});

test("an unknown disease keeps CodeCraft's own Arabic wording", () => {
  const diagnosis = toAssistantDiagnosis(
    { is_plant: true, crop: "Date palm", disease: "Brittle leaf disease", disease_ar: "مرض الورقة الهشة", crop_ar: "النخيل" },
    "gpt-4o",
  );
  assert.equal(diagnosis?.label, "Date_palm___Brittle_leaf_disease");
  assert.equal(diagnosis?.labelAr, "النخيل — مرض الورقة الهشة");
});

test("JSON fences, a preamble and trailing prose are tolerated", () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('Here you go: {"a": {"b": "c}"}} — done.'), {
    a: { b: "c}" },
  });
  assert.equal(extractJsonObject("no json at all"), null);
});

test("toPlantVillageLabel builds classifier-shaped labels", () => {
  assert.equal(toPlantVillageLabel("Tomato", "Early blight"), "Tomato___Early_blight");
  assert.equal(toPlantVillageLabel("Corn (maize)", "Common rust"), "Corn_(maize)___Common_rust");
  assert.equal(toPlantVillageLabel(null, "Leaf spot"), "Leaf_spot");
  assert.equal(toPlantVillageLabel("Tomato", "healthy"), "Tomato___healthy");
});

/* ------------------------------------------------------------------ */
/*  Failure contract — throw typed errors, never break the caller      */
/* ------------------------------------------------------------------ */

test("account failures (401/402/403/429) fail fast without walking the model chain", async () => {
  for (const status of [401, 402, 403, 429]) {
    process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
    const urls: string[] = [];
    mockCodeCraft(
      () =>
        Response.json(
          { error: { message: "Insufficient credits", code: "insufficient_quota" } },
          { status },
        ),
      { urls },
    );

    await assert.rejects(
      () => analyzePlantImageWithCodeCraft(LEAF_B64, context()),
      (error: unknown) =>
        error instanceof CodeCraftVisionError &&
        error.status === status &&
        error.code === "insufficient_quota" &&
        error.retryable === false,
      `HTTP ${status} must fail fast`,
    );
    // Only ONE round-trip: another model id cannot fix a billing problem.
    assert.equal(urls.length, 1, `HTTP ${status} must not retry another model`);
  }
});

test("a 404 unknown model walks the chain to gpt-4o-mini", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  const models: string[] = [];
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as { model?: string };
    models.push(body.model ?? "");
    if (models.length === 1) {
      return Response.json({ error: "Model gpt-4o not found" }, { status: 404 });
    }
    return chatCompletion(verdictJson());
  });

  const diagnosis = await analyzePlantImageWithCodeCraft(LEAF_B64, context());
  assert.deepEqual(models, ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(diagnosis.model, "codecraft/gpt-4o-mini");
});

test("a 5xx upstream error walks the chain, then throws when every id fails", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  const urls: string[] = [];
  mockCodeCraft(() => Response.json({ error: "upstream boom" }, { status: 500 }), { urls });

  await assert.rejects(
    () => analyzePlantImageWithCodeCraft(LEAF_B64, context()),
    (error: unknown) =>
      error instanceof CodeCraftVisionError && /no CodeCraft vision model could answer/.test(error.message),
  );
  assert.equal(urls.length, 2, "both ids are attempted before giving up");
});

test("a network/timeout failure is captured as a retryable error", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mock.method(globalThis, "fetch", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    throw timeout;
  });

  await assert.rejects(
    () => analyzePlantImageWithCodeCraft(LEAF_B64, context()),
    (error: unknown) =>
      error instanceof CodeCraftVisionError &&
      /timeout after 20000 ms/.test(error.message) &&
      error.retryable === true,
    // The whole chain is attempted (2 ids) before the error surfaces.
  );
});

test("an empty or non-JSON answer is a failure, not a diagnosis", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mockCodeCraft(() => chatCompletion(""));
  await assert.rejects(
    () => analyzePlantImageWithCodeCraft(LEAF_B64, context()),
    (error: unknown) => error instanceof CodeCraftVisionError && /empty response/.test(error.message),
  );

  mockCodeCraft(() => chatCompletion("تعذّر تحليل الصورة"));
  await assert.rejects(
    () => analyzePlantImageWithCodeCraft(LEAF_B64, context()),
    (error: unknown) =>
      error instanceof CodeCraftVisionError && /not a JSON diagnostic object/.test(error.message),
  );
});

test('"not a plant" is a definitive failure so the caller falls back', async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  const urls: string[] = [];
  mockCodeCraft(() => chatCompletion(JSON.stringify({ is_plant: false })), { urls });

  await assert.rejects(
    () => analyzePlantImageWithCodeCraft(LEAF_B64, context()),
    (error: unknown) =>
      error instanceof CodeCraftVisionError &&
      /not a plant|no disease/.test(error.message) &&
      error.retryable === false,
  );
  assert.equal(urls.length, 1, "a definitive answer must not retry another model");
});

test("an invalid image payload is rejected before any request is sent", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  const urls: string[] = [];
  mockCodeCraft(() => chatCompletion(verdictJson()), { urls });

  await assert.rejects(
    () => analyzePlantImageWithCodeCraft("not-base64!!", context({ mimeType: "image/jpeg" })),
    (error: unknown) => error instanceof CodeCraftVisionError && /not valid base64/.test(error.message),
  );
  await assert.rejects(
    () => analyzePlantImageWithCodeCraft(LEAF_B64, context({ mimeType: "text/plain" })),
    (error: unknown) => error instanceof CodeCraftVisionError && /mime type/.test(error.message),
  );
  assert.equal(urls.length, 0);
});

test("a data-URL input is accepted and its mime type is honoured", () => {
  const normalized = normalizeImageInput(`data:image/png;base64,${LEAF_B64}`);
  assert.equal(normalized.mimeType, "image/png");
  assert.equal(normalized.data, LEAF_B64);
});

/* ------------------------------------------------------------------ */
/*  Non-throwing wrapper — the dual-engine safety net                  */
/* ------------------------------------------------------------------ */

test("tryAnalyzePlantImageWithCodeCraft never throws: failures come back as an error object", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mockCodeCraft(() => Response.json({ error: "nope" }, { status: 402 }));

  const outcome = await tryAnalyzePlantImageWithCodeCraft(LEAF_B64, context());
  assert.equal(outcome.diagnosis, null);
  assert.ok(outcome.error instanceof CodeCraftVisionError);
  assert.equal(outcome.error?.status, 402);
});

test("tryAnalyzePlantImageWithCodeCraft captures even an unexpected programming error", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mock.method(globalThis, "fetch", async () => {
    throw new Error("boom");
  });

  const outcome = await tryAnalyzePlantImageWithCodeCraft(LEAF_B64, context());
  assert.equal(outcome.diagnosis, null);
  assert.ok(outcome.error instanceof CodeCraftVisionError);
  assert.match(outcome.error?.message ?? "", /boom/);
});

test("tryAnalyzePlantImageWithCodeCraft returns the diagnosis on success", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mockCodeCraft(() => chatCompletion(verdictJson()));

  const outcome = await tryAnalyzePlantImageWithCodeCraft(LEAF_B64, context());
  assert.equal(outcome.error, null);
  assert.equal(outcome.diagnosis?.label, "Tomato___Early_blight");
});

test("the API key never appears in a thrown error message", async () => {
  process.env.CODECRAFT_API_KEY = CODECRAFT_KEY;
  mockCodeCraft(() => Response.json({ error: { message: "invalid api key" } }, { status: 401 }));

  const outcome = await tryAnalyzePlantImageWithCodeCraft(LEAF_B64, context());
  assert.doesNotMatch(outcome.error?.message ?? "", new RegExp(CODECRAFT_KEY));
});
