/**
 * Unit tests for `src/lib/assistant/model-choice.ts` — the catalog shared by the
 * chat's model picker and `/api/assistant`.
 *
 * The contract that matters: a choice the client sends always resolves to the
 * Gemini id the picker promised, and ANYTHING else (absent, blank, a stale
 * stored id, a hostile string) resolves to `null` so the request runs on the
 * default chain instead of failing or pinning junk.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PHYTO_MODEL_ID,
  PHYTO_MODEL_CHOICES,
  PHYTO_MODEL_IDS,
  PHYTO_MODEL_STORAGE_KEY,
  phytoModelFor,
  phytoModelLabel,
  resolveRequestedModel,
} from "../../src/lib/assistant/model-choice";

test("the catalog maps the three friendly names to their Gemini ids, in order", () => {
  assert.deepEqual(
    PHYTO_MODEL_CHOICES.map((choice) => [choice.id, choice.label, choice.model]),
    [
      ["phyto-3.8", "phyto 3.8", "gemini-3.8-flash"],
      ["phyto-3.5", "phyto 3.5", "gemini-3.5-flash"],
      ["phyto-2.5", "phyto 2.5", "gemini-2.5-flash"],
    ],
  );
  assert.equal(DEFAULT_PHYTO_MODEL_ID, "phyto-3.8");
  assert.deepEqual(PHYTO_MODEL_IDS, ["phyto-3.8", "phyto-3.5", "phyto-2.5"]);
  assert.equal(PHYTO_MODEL_STORAGE_KEY, "phytoscan.model");
  // Every choice carries a note the UI can localise, and the default is the
  // first (and only) "balanced" one.
  for (const choice of PHYTO_MODEL_CHOICES) {
    assert.ok(["balanced", "fast", "economy"].includes(choice.note));
  }
  assert.equal(PHYTO_MODEL_CHOICES[0].note, "balanced");
});

test("a choice is accepted as its id, its friendly name or the raw Gemini id", () => {
  for (const raw of [
    "phyto-3.5",
    "phyto 3.5",
    "  phyto 3.5  ",
    "PHYTO_3.5",
    "gemini-3.5-flash",
    "GEMINI-3.5-FLASH",
  ]) {
    assert.equal(
      resolveRequestedModel(raw)?.model,
      "gemini-3.5-flash",
      `failed to resolve ${JSON.stringify(raw)}`,
    );
  }
  assert.equal(resolveRequestedModel("phyto-2.5")?.model, "gemini-2.5-flash");
  assert.equal(resolveRequestedModel("phyto-3.8")?.model, "gemini-3.8-flash");
});

test("anything unknown resolves to null — the request keeps the default chain", () => {
  for (const raw of [
    undefined,
    null,
    0,
    {},
    [],
    "",
    "   ",
    "phyto 4.0",
    "gemini-3.8-flash-preview",
    "gemini-4.0-flash",
    "../../etc/passwd",
    "phyto 3.5; DROP TABLE keys",
  ]) {
    assert.equal(resolveRequestedModel(raw), null, `unexpectedly resolved ${JSON.stringify(raw)}`);
  }
  // A model id that exists in Gemini but is NOT offered by the picker stays out
  // of reach: the selector may only pin what the UI actually shows.
  assert.equal(resolveRequestedModel("gemini-3.5-flash-lite"), null);
  assert.equal(resolveRequestedModel("gemini-flash-latest"), null);
});

test("phytoModelFor validates stored preferences and never throws", () => {
  assert.equal(phytoModelFor("phyto-2.5")?.model, "gemini-2.5-flash");
  assert.equal(phytoModelFor(" phyto 3.8 ")?.id, "phyto-3.8");
  assert.equal(phytoModelFor(null), null);
  assert.equal(phytoModelFor(undefined), null);
  assert.equal(phytoModelFor(""), null);
  assert.equal(phytoModelFor("phyto-9.9"), null);
});

test("phytoModelLabel names a model for logs, and passes unknown ids through", () => {
  assert.equal(phytoModelLabel("gemini-3.8-flash"), "phyto 3.8");
  assert.equal(phytoModelLabel("gemini-3.5-flash"), "phyto 3.5");
  assert.equal(phytoModelLabel("gemini-2.5-flash"), "phyto 2.5");
  // A `GEMINI_MODEL` override outside the picker still logs something useful.
  assert.equal(phytoModelLabel("gemini-3.7-flash"), "gemini-3.7-flash");
});
