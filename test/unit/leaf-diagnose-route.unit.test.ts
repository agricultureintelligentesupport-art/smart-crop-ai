import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import sharp from "sharp";
import { POST } from "../../src/app/api/leaf-diagnose/route";
import { GEMINI_MODEL_DEFAULT } from "../../src/lib/assistant/gemini-models";
import { LEAF_MAX_BYTES, LEAF_RESPONSE_SCHEMA } from "../../src/lib/leaf-diagnose";

// Test-process-only credentials; no env files or real provider calls are changed.
const originalEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GEMINI_API_KEY") || key === "GEMINI_MODEL"));
function clearTestEnv() {
  for (const key of Object.keys(process.env)) if (key.startsWith("GEMINI_API_KEY") || key === "GEMINI_MODEL") delete process.env[key];
}
beforeEach(() => { clearTestEnv(); process.env.GEMINI_API_KEY = "leaf-unit-key"; });
afterEach(() => { clearTestEnv(); Object.assign(process.env, originalEnv); });

const fixture = {
  isPlant: true, plantNameAr: "طماطم", verdict: "diseased", diseaseNameAr: "اللفحة المبكرة",
  confidence: 0.84, findings: [{ labelAr: "بقع بنية", box: [100, 200, 300, 450], severity: "medium" }],
};
const envelope = (value: unknown = fixture) => Response.json({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
});
async function picture(format: "jpeg" | "png" | "webp" = "jpeg", width = 40, height = 30) {
  return sharp({ create: { width, height, channels: 3, background: "#487b45" } }).toFormat(format).toBuffer();
}
function upload(bytes: Uint8Array, type = "image/jpeg", signal?: AbortSignal) {
  const body = new FormData();
  body.append("image", new Blob([Uint8Array.from(bytes)], { type }), "leaf");
  return new Request("http://unit.test/api/leaf-diagnose", { method: "POST", body, signal });
}

for (const format of ["jpeg", "png", "webp"] as const) {
  test(`new leaf route fully validates ${format} and uses the configured image model/schema`, async (t) => {
    const bytes = await picture(format);
    const calls: { url: string; init?: RequestInit }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return envelope({ ...fixture, advice: "must not escape the server" });
    });
    const response = await POST(upload(bytes, `image/${format}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), fixture);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_DEFAULT.id}:generateContent`);
    assert.ok(!calls[0].url.includes("leaf-unit-key"));
    const body = JSON.parse(calls[0].init?.body as string);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.responseSchema, LEAF_RESPONSE_SCHEMA);
    assert.deepEqual(body.generationConfig.thinkingConfig, GEMINI_MODEL_DEFAULT.thinking);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, `image/${format}`);
    assert.equal(body.contents[0].parts[1].inlineData.data, bytes.toString("base64"));
    assert.equal((calls[0].init?.headers as Record<string, string>)["x-goog-api-key"], "leaf-unit-key");
    assert.equal(calls[0].init?.cache, "no-store");
    assert.match(body.contents[0].parts[0].text, /Never invent a disease/);
    assert.match(body.contents[0].parts[0].text, /No treatment/);
  });
}

test("leaf route reads an existing GEMINI_MODEL override as the head of the model chain, without a thinking config", async (t) => {
  process.env.GEMINI_MODEL = " fixture-configured-image-model ";
  let requested = "";
  let config: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    requested = String(url);
    config = JSON.parse(init?.body as string).generationConfig;
    return envelope();
  });
  assert.equal((await POST(upload(await picture()))).status, 200);
  assert.ok(requested.includes("/fixture-configured-image-model:generateContent"));
  assert.equal(config.thinkingConfig, undefined);
});

test("leaf route clamps boxes, drops malformed findings, and returns at most five", async (t) => {
  t.mock.method(globalThis, "fetch", async () => envelope({ ...fixture, findings: [
    { labelAr: "غير صالح", box: [400, 0, 10, 40], severity: "low" },
    ...Array.from({ length: 8 }, () => ({ labelAr: "بقع بنية", box: [-10, 20.1, 1100, 700.8], severity: "high" })),
  ] }));
  const data = await (await POST(upload(await picture()))).json();
  assert.equal(data.findings.length, 5);
  assert.deepEqual(data.findings[0].box, [0, 20, 1000, 701]);
  assert.deepEqual(Object.keys(data), LEAF_RESPONSE_SCHEMA.required);
});

test("leaf route returns a strict not-a-plant object and explicit technical reason", async (t) => {
  t.mock.method(globalThis, "fetch", async () => envelope({ ...fixture, isPlant: false }));
  const response = await POST(upload(await picture()));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-leaf-diagnose-reason"), "not-a-plant");
  assert.deepEqual(await response.json(), {
    isPlant: false, plantNameAr: "", verdict: "uncertain", diseaseNameAr: "", confidence: 0.84, findings: [],
  });
});

test("invalid, spoofed, truncated, uncompressed and empty images never reach Gemini", async (t) => {
  const provider = t.mock.method(globalThis, "fetch", async () => envelope());
  const requests = [
    upload(new Uint8Array(), "image/png"),
    upload(new TextEncoder().encode("<svg/>"), "image/svg+xml"),
    upload(await picture("png"), "image/jpeg"),
    upload(new Uint8Array([255, 216, 255, 224, 0, 20]), "image/jpeg"),
    upload((await picture("png")).subarray(0, 45), "image/png"),
    upload(await picture("jpeg", 1281, 100)),
    new Request("http://unit.test/api/leaf-diagnose", { method: "POST", body: JSON.stringify({ image: "wrong" }), headers: { "Content-Type": "application/json" } }),
  ];
  for (const request of requests) {
    const response = await POST(request);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid-input" });
  }
  assert.equal(provider.mock.callCount(), 0);
});

test("leaf upload rejects extra fields and multiple image parts", async (t) => {
  const provider = t.mock.method(globalThis, "fetch", async () => envelope());
  const bytes = Uint8Array.from(await picture());
  for (const kind of ["extra", "duplicate"]) {
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "image/jpeg" }), "leaf");
    if (kind === "extra") form.append("other", "unwanted");
    else form.append("image", new Blob([bytes], { type: "image/jpeg" }), "another");
    const response = await POST(new Request("http://unit.test/api/leaf-diagnose", { method: "POST", body: form }));
    assert.equal(response.status, 400);
  }
  assert.equal(provider.mock.callCount(), 0);
});

test("leaf route caps file bytes, declared body size and chunked upload size before provider calls", async (t) => {
  const provider = t.mock.method(globalThis, "fetch", async () => envelope());
  const large = new Uint8Array(LEAF_MAX_BYTES + 1);
  const fileResponse = await POST(upload(large));
  assert.equal(fileResponse.status, 413);
  assert.deepEqual(await fileResponse.json(), { error: "too-large" });
  const declared = upload(await picture());
  declared.headers.set("content-length", String(LEAF_MAX_BYTES + 64 * 1024 + 1));
  assert.equal((await POST(declared)).status, 413);
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(LEAF_MAX_BYTES + 64 * 1024 + 1)); },
    cancel() { canceled = true; },
  });
  const chunked = new Request("http://unit.test/api/leaf-diagnose", {
    method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=test" }, body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.equal((await POST(chunked)).status, 413);
  assert.equal(canceled, true);
  assert.equal(provider.mock.callCount(), 0);
});

for (const status of [429, 503]) {
  test(`leaf route retries ${status} once with a short backoff and the same model`, async (t) => {
    const urls: string[] = [];
    const provider = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      urls.push(String(url));
      return urls.length === 1 ? new Response("busy", { status }) : envelope();
    });
    const response = await POST(upload(await picture()));
    assert.equal(response.status, 200);
    assert.equal(provider.mock.callCount(), 2);
    assert.equal(urls[0], urls[1]);
  });
}

test("leaf route tries a lone key twice per model, walks the model chain once, and maps missing credentials to busy", async (t) => {
  const provider = t.mock.method(globalThis, "fetch", async () => new Response("busy", { status: 503 }));
  const response = await POST(upload(await picture()));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
  // 1 key x 2 tries x 3 models in the chain (~1 s real pause between each pair of tries).
  assert.equal(provider.mock.callCount(), 6);
  clearTestEnv();
  assert.equal((await POST(upload(await picture()))).status, 503);
  assert.equal(provider.mock.callCount(), 6);
});

test("leaf route skips a 404 model to the next one without retrying it or leaking upstream text", async (t) => {
  const provider = t.mock.method(globalThis, "fetch", async () => new Response("PRIVATE upstream details", { status: 404 }));
  const response = await POST(upload(await picture()));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
  assert.equal(provider.mock.callCount(), 3);
});

for (const payload of [
  {}, { candidates: [] }, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: JSON.stringify(fixture) }] } }] },
  { candidates: [{ content: { parts: [{ text: "```json\n{}\n```" }] } }] },
  { candidates: [{ content: { parts: [{ text: "{}", thought: true }] } }] },
]) {
  test("leaf route rejects a malformed/blocked/truncated provider response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    const response = await POST(upload(await picture()));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "malformed" });
  });
}

test("leaf route's 50-second budget aborts Gemini and logs only attempt lines, never image or provider errors", async (t) => {
  const bytes = await picture();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const logs = t.mock.method(console, "log", () => {});
  const errors = t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("PRIVATE image details")), { once: true });
    started();
  }));
  const pending = POST(upload(bytes));
  await entered;
  // Attempts, a rotation pause and the budget are chained timers: advance one second at a time.
  let settled = false;
  void pending.then(() => { settled = true; });
  for (let second = 0; second < 60 && !settled; second += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  const response = await pending;
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "provider-busy" });
  // The only output is one `[leaf-diagnose] attempt=...` line per attempt (no key, image or provider text).
  assert.ok(logs.mock.callCount() >= 1);
  for (const call of logs.mock.calls) {
    assert.equal(call.arguments.length, 1);
    assert.match(String(call.arguments[0]), /^\[leaf-diagnose\] attempt=\d+ key=1\/1 model=\S+ status=(?:\d{3}|network|timeout|aborted) ms=\d+$/);
  }
  // Node may emit its own experimental MockTimers warning; no image/error content escapes.
  for (const call of errors.mock.calls) {
    assert.ok(!JSON.stringify(call.arguments).includes("PRIVATE"));
    assert.ok(!JSON.stringify(call.arguments).includes(bytes.toString("base64")));
  }
});

test("leaf route exposes a stable network reason, not an image-bearing exception", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("PRIVATE image details"); });
  const response = await POST(upload(await picture()));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "network" });
});
