import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGeminiKeyManager,
  resolveGeminiApiKeys,
} from "../../src/lib/assistant/gemini-key-manager";

test("Gemini key resolution trims, sorts numbered variables and removes duplicates", () => {
  assert.deepEqual(
    resolveGeminiApiKeys({
      GEMINI_API_KEYS: " alpha, beta ",
      GEMINI_API_KEY_10: "ten",
      GEMINI_API_KEY_2: " two ",
      GEMINI_API_KEY: "base, alpha",
      GEMINI_API_KEY_3: "three",
      GEMINI_API_KEY_4: "two",
      GEMINI_API_KEY_5: "  ",
      UNRELATED_GEMINI_API_KEY: "ignored",
    }),
    ["base", "alpha", "two", "three", "ten", "beta"],
  );
});

test("Gemini key manager randomly selects without replacement and stops when exhausted", () => {
  const samples = [0.75, 0, 0.5, 0];
  const manager = createGeminiKeyManager(
    ["key-a", "key-b", "key-c", "key-d", "key-a", "  "],
    () => samples.shift() ?? 0,
  );

  assert.equal(manager.size, 4);
  assert.equal(manager.remainingCount, 4);
  const leases = Array.from({ length: 4 }, () => manager.next());

  assert.deepEqual(
    leases.map((lease) => lease && { attempt: lease.attempt, poolSize: lease.poolSize }),
    [
      { attempt: 1, poolSize: 4 },
      { attempt: 2, poolSize: 4 },
      { attempt: 3, poolSize: 4 },
      { attempt: 4, poolSize: 4 },
    ],
  );
  assert.deepEqual(leases.map((lease) => lease?.apiKey), ["key-d", "key-a", "key-c", "key-b"]);
  assert.equal(new Set(leases.map((lease) => lease?.apiKey)).size, 4);
  assert.equal(manager.attemptedCount, 4);
  assert.equal(manager.remainingCount, 0);
  assert.equal(manager.next(), null);
});

test("a request-scoped key manager shares its no-repeat state across Gemini stages", () => {
  const manager = createGeminiKeyManager(["image-key", "text-key"], () => 0);

  const imageStageLease = manager.next();
  const formatterStageLease = manager.next();

  assert.notEqual(imageStageLease?.apiKey, formatterStageLease?.apiKey);
  assert.equal(manager.next(), null);
});
