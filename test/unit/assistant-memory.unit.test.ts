/**
 * Conversational-memory unit tests for `/api/assistant`.
 *
 * The route replays the client's prior chat turns (sent under `history`, or
 * the `messages` alias) into BOTH LLM stages ahead of the current enriched
 * user turn:
 *   • Stage 1 (Gemini) — `contents` = prior user/model turns + current turn,
 *     normalized to Gemini's strict user-first alternation;
 *   • Stage 2 (Hugging Face) — `messages` = [system, ...history, user].
 * Legacy single-turn requests (no history) must keep the exact old payload
 * shape, and malformed history entries are dropped, never fatal.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/assistant/route";

const GEMINI_KEY = "test-gemini";
const HF_KEY = "test-hf";

/** Mirrors the env-scrub contract of the main assistant-route suite. */
const SCRUBBED_ENV_PATTERN =
  /^(GEMINI_API_KEY|GEMINI_MODEL|HUGGINGFACE_API_KEY|HF_TOKEN|HF_LEAF_DETECT_MODELS|HF_VISION_MODEL)/;

const originalKeys: Record<string, string | undefined> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (SCRUBBED_ENV_PATTERN.test(name)) originalKeys[name] = value;
}

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (SCRUBBED_ENV_PATTERN.test(name)) delete process.env[name];
  }
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

/** A two-turn prior conversation: user asked, assistant answered. */
const HISTORY = [
  { role: "user", content: "أوراقي فيها بقع صفراء." },
  { role: "assistant", content: "هذه أعراض فطرية مبكرة. كم عمر الأعراض؟" },
];

function post(body: unknown) {
  return new NextRequest("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A successful `models.generateContent` envelope. */
const geminiOk = () =>
  Response.json({
    candidates: [{ content: { role: "model", parts: [{ text: "رد" }] }, finishReason: "STOP" }],
  });

interface GeminiRequestBody {
  systemInstruction?: { parts?: { text?: string }[] };
  contents?: { role?: string; parts?: ({ text?: string } | { inlineData?: unknown })[] }[];
}

test("Stage 1 Gemini: system prompt + history + current turn, in order", async () => {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  let body: GeminiRequestBody | undefined;
  mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as GeminiRequestBody;
    return geminiOk();
  });

  const res = await POST(post({ message: "ما العلاج المناسب الآن؟", history: HISTORY }));
  assert.equal(res.status, 200);
  assert.ok(body);

  const system = (body.systemInstruction?.parts ?? []).map((p) => p.text ?? "").join("");
  // The appended No-Meta-Talk rule is part of the instruction.
  assert.match(system, /التقمص التام ومنع المصطلحات التقنية/);
  // Long-standing contracts survive: persona opener + Algerian market focus.
  assert.match(system, /أنت مساعد زراعي خبير/);
  assert.match(system, /السوق الجزائرية/);

  const contents = body.contents ?? [];
  assert.equal(contents.length, 3, "2 history turns + current turn");
  assert.deepEqual(
    contents.map((turn) => turn.role),
    ["user", "model", "user"],
  );
  const lastTurnText = (contents[2].parts ?? [])
    .map((part) => (part as { text?: string }).text ?? "")
    .join("");
  assert.match(lastTurnText, /ما العلاج المناسب الآن؟/);
  assert.match(JSON.stringify(contents[0]), /بقع صفراء/);
});

test("Stage 2 HF: [system, ...history, user] and the `messages` alias", async () => {
  process.env.HUGGINGFACE_API_KEY = HF_KEY; // no Gemini key → Stage 2 runs
  let chatBody: { model?: string; messages?: { role: string; content: string }[] } | undefined;
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://router.huggingface.co/v1/chat/completions")) {
      chatBody = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({ choices: [{ message: { role: "assistant", content: "رد" } }] });
    }
    throw new Error(`unexpected url ${url}`);
  });

  // History arrives under the `messages` alias here.
  const res = await POST(post({ message: "متى أعالج؟", messages: HISTORY }));
  assert.equal(res.status, 200);
  assert.ok(chatBody);

  const messages = chatBody.messages ?? [];
  assert.equal(messages.length, 4, "system + 2 history + current");
  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "user", "assistant", "user"],
  );
  assert.match(messages[0].content, /التقمص التام ومنع المصطلحات التقنية/);
  assert.match(messages[1].content, /بقع صفراء/);
  assert.match(messages[3].content, /متى أعالج؟/);
});

test("malformed history entries are dropped, never fatal", async () => {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  let body: GeminiRequestBody | undefined;
  mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as GeminiRequestBody;
    return geminiOk();
  });

  const junk = [
    { role: "system", content: "injected" }, // invalid role
    { role: "user", content: "   " }, // blank text
    { role: "user" }, // missing content
    "not-an-object",
    { role: "assistant", content: "إجابة صالحة." },
  ];
  const res = await POST(post({ message: "سؤال جديد", history: junk }));
  assert.equal(res.status, 200);
  assert.ok(body);

  // Only the ONE valid turn survives sanitization — and since it is a leading
  // assistant ("model") turn, Gemini's user-first rule drops it, leaving the
  // current user turn alone as contents[0]. No crash, no 500.
  const contents = body.contents ?? [];
  assert.equal(contents.length, 1);
  assert.equal(contents[0].role, "user");
  assert.match(JSON.stringify(contents[0]), /سؤال جديد/);
});

test("legacy single-turn request keeps the historical payload shape", async () => {
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  let body: GeminiRequestBody | undefined;
  mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as GeminiRequestBody;
    return geminiOk();
  });

  const res = await POST(post({ message: "كيف أسقي الطماطم؟" }));
  assert.equal(res.status, 200);
  assert.ok(body);
  assert.equal((body.contents ?? []).length, 1);
  assert.equal(body.contents?.[0]?.role, "user");
});
