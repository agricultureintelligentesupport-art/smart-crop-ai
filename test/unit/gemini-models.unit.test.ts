/**
 * Unit tests for `src/lib/assistant/gemini-models.ts` — the Gemini model chain
 * and the ListModels health check.
 *
 * The regression this file guards against is concrete and expensive: a hardcoded
 * model id that Google never shipped (`gemini-3.6`) sat in the route until every
 * request 404'd and every photo silently degraded to the MobileNetV2 fallback.
 *
 * The live catalog is verified against
 * https://ai.google.dev/gemini-api/docs/deprecations (last updated 2026-09-24).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GEMINI_FALLBACK_MODELS,
  GEMINI_MODEL_DEFAULT,
  checkGeminiModelHealth,
  formatGeminiHealthReport,
  GeminiModelHealthMonitor,
  resolveGeminiModels,
  type GeminiModel,
} from "../../src/lib/assistant/gemini-models";

/** Ids that must never reappear in the chain, and why. */
const RETIRED_IDS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
] as const;

/* ------------------------------------------------------------------ */
/*  The chain                                                          */
/* ------------------------------------------------------------------ */

test("the default primary is gemini-3.8-flash with answer-first thinking", () => {
  assert.equal(GEMINI_MODEL_DEFAULT.id, "gemini-3.8-flash");
  assert.deepEqual(GEMINI_MODEL_DEFAULT.thinking, { thinkingLevel: "low" });
});

test("every default and fallback id is a real, live model", () => {
  const ids = [GEMINI_MODEL_DEFAULT, ...GEMINI_FALLBACK_MODELS].map((m) => m.id);
  for (const retired of RETIRED_IDS) {
    assert.ok(
      !ids.includes(retired),
      `${retired} is retired/shut down and must not be in the chain`,
    );
  }
  // The exact string that shipped by accident — a real id, wrong name.
  assert.ok(!ids.includes("gemini-3.6"), "the real id is gemini-3.6-flash");
  // Every id must carry an explicit family, not a bare generation number.
  for (const id of ids) {
    assert.match(id, /^gemini-\d+(\.\d+)?-flash(-lite)?$/, `unexpected id shape: ${id}`);
  }
});

test("the chain mixes a rolling id with long-lived ones", () => {
  // 3.6/3.7/3.8 Flash are short-term rolling point releases; a chain built only
  // from them dies all at once on the next rotation. At least one long-lived
  // id (3.5 Flash / Flash-Lite, supported into 2027) must be present.
  const ids = [GEMINI_MODEL_DEFAULT, ...GEMINI_FALLBACK_MODELS].map((m) => m.id);
  const longLived = ids.filter((id) => id.startsWith("gemini-3.5-flash"));
  assert.ok(longLived.length >= 2, `expected long-lived fallbacks, got ${ids.join(", ")}`);
});

test("every chain id takes thinkingLevel, never the legacy numeric budget", () => {
  for (const model of [GEMINI_MODEL_DEFAULT, ...GEMINI_FALLBACK_MODELS]) {
    assert.deepEqual(model.thinking, { thinkingLevel: "low" }, `${model.id}`);
  }
});

test("resolveGeminiModels returns the default chain with no override", () => {
  assert.deepEqual(
    resolveGeminiModels().map((m) => m.id),
    ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"],
  );
});

test("an override replaces the primary and is never duplicated", () => {
  const chain = resolveGeminiModels("  gemini-3.7-flash  ").map((m) => m.id);
  assert.deepEqual(chain, ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]);
  // Pinning a built-in fallback must not repeat it.
  const deduped = resolveGeminiModels("gemini-3.5-flash").map((m) => m.id);
  assert.equal(deduped.filter((id) => id === "gemini-3.5-flash").length, 1);
});

test("a blank override is ignored, not treated as a model id", () => {
  assert.deepEqual(resolveGeminiModels("   ").map((m) => m.id), resolveGeminiModels().map((m) => m.id));
});

test("proved-dead ids are dropped from the chain", () => {
  const chain = resolveGeminiModels(undefined, new Set(["gemini-3.8-flash"])).map((m) => m.id);
  assert.deepEqual(chain, ["gemini-3.5-flash", "gemini-3.5-flash-lite"]);
});

test("the chain never resolves to empty, even if every id is marked dead", () => {
  const allDead = new Set(["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]);
  const chain = resolveGeminiModels(undefined, allDead).map((m) => m.id);
  // A stale negative cache must not disable the stage outright.
  assert.equal(chain.length, 3);
});

/* ------------------------------------------------------------------ */
/*  The health check                                                   */
/* ------------------------------------------------------------------ */

const CHAIN: GeminiModel[] = [
  { id: "gemini-3.8-flash" },
  { id: "gemini-3.5-flash" },
];

const health = (ids: string[]) => (chain = CHAIN) =>
  checkGeminiModelHealth({ apiKey: "k", chain, fetchModels: async () => ids });

test("a fully live chain reports ok", async () => {
  const report = await health(["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"])();
  assert.equal(report.ok, true);
  assert.deepEqual(report.chain.map((c) => c.available), [true, true]);
  assert.equal(report.chain[0].primary, true);
  assert.equal(report.suggestion, null);
});

test("a retired primary is reported and a live replacement is suggested", async () => {
  const report = await health(["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"])();
  assert.equal(report.ok, false);
  assert.equal(report.chain[0].available, false);
  assert.equal(report.chain[0].id, "gemini-3.8-flash");
  // Newest general-purpose Flash wins.
  assert.equal(report.suggestion, "gemini-3.7-flash");
});

test("the suggestion skips -lite, image, tts, live and preview families", async () => {
  const report = await health([
    "gemini-3.8-flash-lite",
    "gemini-3.8-flash-image",
    "gemini-3.8-flash-tts",
    "gemini-3.8-live",
    "gemini-3.8-flash-preview",
    "gemini-3.1-pro-preview",
  ])();
  assert.equal(report.suggestion, null, "nothing suitable should be suggested");
});

test("a fully dead chain is detected and flagged loudly", async () => {
  const report = await health(["gemini-2.0-flash-lite"])();
  assert.equal(report.ok, false);
  assert.deepEqual(report.chain.map((c) => c.available), [false, false]);
  const text = formatGeminiHealthReport(report, CHAIN).join("\n");
  assert.match(text, /❌/);
  assert.match(text, /NO configured id is live/);
  assert.match(text, /degrade to MobileNetV2/);
});

test("a ListModels outage reports unknown availability, not a false failure", async () => {
  const report = await checkGeminiModelHealth({
    apiKey: "k",
    chain: CHAIN,
    fetchModels: async () => {
      throw new Error("fetch failed");
    },
  });
  assert.equal(report.ok, false);
  assert.match(report.error ?? "", /fetch failed/);
  assert.deepEqual(report.chain.map((c) => c.available), [null, null]);
  // A failed check must never claim a model is missing.
  const text = formatGeminiHealthReport(report, CHAIN).join("\n");
  assert.match(text, /could not verify/);
  assert.doesNotMatch(text, /❌/);
});

test("a successful check logs a single reassuring line", () => {
  const lines = formatGeminiHealthReport(
    { ok: true, chain: [{ id: "gemini-3.8-flash", available: true, primary: true }], available: ["gemini-3.8-flash"], suggestion: null },
    [{ id: "gemini-3.8-flash" }],
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /✅/);
  assert.match(lines[0], /1\/1 configured model ids are live/);
});

test("a partial failure names the missing ids and the fix", () => {
  const report: Parameters<typeof formatGeminiHealthReport>[0] = {
    ok: false,
    chain: [
      { id: "gemini-3.8-flash", available: false, primary: true },
      { id: "gemini-3.5-flash", available: true, primary: false },
    ],
    available: ["gemini-3.5-flash", "gemini-3.7-flash"],
    suggestion: "gemini-3.7-flash",
  };
  const text = formatGeminiHealthReport(report, CHAIN).join("\n");
  assert.match(text, /1 of 2 configured model ids are NOT available: gemini-3.8-flash/);
  assert.match(text, /set GEMINI_MODEL=gemini-3\.7-flash/);
  assert.doesNotMatch(text, /NO configured id is live/);
});

/* ------------------------------------------------------------------ */
/*  The runtime monitor: single-flight + TTL + dead-id cache           */
/* ------------------------------------------------------------------ */

test("monitor checks once, then serves the cached verdict within the TTL", async () => {
  let clock = 1_000;
  let calls = 0;
  const monitor = new GeminiModelHealthMonitor(6 * 60 * 60 * 1000, () => clock);
  const fetchModels = async () => {
    calls += 1;
    return ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  };

  await monitor.ensure(CHAIN, { apiKey: "k", fetchModels });
  await monitor.ensure(CHAIN, { apiKey: "k", fetchModels });
  assert.equal(calls, 1, "a second request inside the TTL must not re-query");

  // Past the TTL it re-checks — a recovered model is picked up without a redeploy.
  clock += 6 * 60 * 60 * 1000 + 1;
  await monitor.ensure(CHAIN, { apiKey: "k", fetchModels });
  assert.equal(calls, 2);
});

test("monitor collapses concurrent first calls into one ListModels request", async () => {
  let calls = 0;
  const monitor = new GeminiModelHealthMonitor();
  const fetchModels = async () => {
    calls += 1;
    return ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  };

  const results = await Promise.all(
    Array.from({ length: 4 }, () => monitor.ensure(CHAIN, { apiKey: "k", fetchModels })),
  );
  assert.equal(calls, 1, "single-flight guard");
  for (const result of results) assert.equal(result?.ok, true);
});

test("monitor records dead ids and the chain drops them, but never empties", async () => {
  const monitor = new GeminiModelHealthMonitor();
  // The production incident: the primary is gone, the long-lived fallback lives.
  await monitor.ensure(CHAIN, {
    apiKey: "k",
    fetchModels: async () => ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
  });

  assert.ok(monitor.unavailableModels.has("gemini-3.8-flash"));
  assert.equal(monitor.unavailableModels.has("gemini-3.5-flash"), false);
  const chain = resolveGeminiModels(undefined, monitor.unavailableModels);
  assert.deepEqual(chain.map((model) => model.id), ["gemini-3.5-flash", "gemini-3.5-flash-lite"]);
});

test("a ListModels outage does not poison the chain", async () => {
  const monitor = new GeminiModelHealthMonitor();
  // No fetchModels override => a real fetch, which cannot succeed here.
  // The point: "could not check" must never be recorded as "model is dead",
  // or a transient Google outage would empty the chain for six hours.
  const report = await monitor.ensure(CHAIN, { apiKey: "k" });

  assert.equal(report?.ok, false);
  assert.ok((report?.error ?? "").length > 0, "the reason must be reported, not swallowed");
  for (const check of report?.chain ?? []) {
    assert.equal(check.available, null, "unverified is not the same as unavailable");
  }
  assert.equal(monitor.unavailableModels.size, 0);
  assert.deepEqual(
    resolveGeminiModels(undefined, monitor.unavailableModels).map((model) => model.id),
    [GEMINI_MODEL_DEFAULT.id, ...GEMINI_FALLBACK_MODELS.map((model) => model.id)],
    "the real default chain must come through untouched",
  );
});

test("monitor.reset() forgets the cached verdict so the next call re-checks", async () => {
  let calls = 0;
  const monitor = new GeminiModelHealthMonitor();
  const fetchModels = async () => {
    calls += 1;
    return ["gemini-3.5-flash"];
  };

  await monitor.ensure(CHAIN, { apiKey: "k", fetchModels });
  monitor.reset();
  assert.equal(monitor.unavailableModels.size, 0);
  await monitor.ensure(CHAIN, { apiKey: "k", fetchModels });
  assert.equal(calls, 2);
});
