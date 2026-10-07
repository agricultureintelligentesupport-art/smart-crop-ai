#!/usr/bin/env node
/**
 * `npm run check:models` — validate the configured Gemini model chain against
 * Google's live `GET /v1beta/models` catalog.
 *
 * WHY THIS EXISTS
 * Google rotates its model catalog fast and a retired id fails with a 404 that
 * is easy to miss in a busy log — the pipeline then silently degrades every
 * photo to the MobileNetV2 fallback while "the app still works". This script
 * turns that invisible failure into a non-zero exit code you can gate CI on.
 *
 * It imports the SAME chain definition the route uses
 * (`src/lib/assistant/gemini-models.ts`), so the check can never drift from
 * what actually runs in production.
 *
 * USAGE
 *   npm run check:models                 # validate the default chain
 *   GEMINI_MODEL=gemini-3.7-flash npm run check:models   # validate an override
 *   npm run check:models -- --json       # machine-readable, for CI
 *
 * EXIT CODES
 *   0  every configured model id is live
 *   1  at least one configured id is missing (or ListModels failed)
 */

import {
  GEMINI_FALLBACK_MODELS,
  GEMINI_MODEL_DEFAULT,
  checkGeminiModelHealth,
  formatGeminiHealthReport,
  resolveGeminiModels,
} from "../src/lib/assistant/gemini-models.ts";
import { resolveGeminiKeyPool } from "../src/lib/assistant/providers.ts";

/**
 * Collect the Gemini key pool the same way the route does — from the ONE
 * shared resolver, so the CLI probes the key the pipeline would actually use
 * first (`GEMINI_API_KEY_4` when it is configured).
 */
function resolveGeminiApiKeys() {
  return resolveGeminiKeyPool().map((entry) => entry.key);
}

const asJson = process.argv.includes("--json");
const keys = resolveGeminiApiKeys();
const chain = resolveGeminiModels(process.env.GEMINI_MODEL);

if (keys.length === 0) {
  const message =
    "No GEMINI_API_KEY* is configured, so the model catalog cannot be queried.";
  if (asJson) {
    console.log(JSON.stringify({ ok: false, error: message, chain }, null, 2));
  } else {
    console.error(`✖ ${message}`);
    console.error("  Set GEMINI_API_KEY_4 / GEMINI_API_KEY (or the numbered variants) and retry.");
  }
  process.exit(1);
}

const report = await checkGeminiModelHealth({ apiKey: keys[0], chain });

if (asJson) {
  console.log(JSON.stringify({ ...report, chain: chain.map((m) => m.id) }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

console.log(
  `Configured chain: ${chain.map((model) => model.id).join(" → ")}\n` +
    `Default primary : ${GEMINI_MODEL_DEFAULT.id} ` +
    `(override: ${process.env.GEMINI_MODEL?.trim() || "none"})\n` +
    `Built-in fallbacks: ${GEMINI_FALLBACK_MODELS.map((m) => m.id).join(", ")}\n`,
);

for (const line of formatGeminiHealthReport(report, chain, "check the key, quota and network reachability of generativelanguage.googleapis.com")) {
  console.log(line.replace(/^\[Gemini Health\]\s*/, ""));
}

if (!asJson && report.available.length > 0) {
  const flash = report.available.filter((id) => id.startsWith("gemini-")).slice(0, 12);
  console.log(`\nNewest generateContent-capable models visible to this key:\n  ${flash.join("\n  ")}`);
  console.log(
    "\nReference: https://ai.google.dev/gemini-api/docs/deprecations",
  );
}

process.exit(report.ok ? 0 : 1);
