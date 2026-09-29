/**
 * Isolation guard: the field-map feature and the PhytoScan AI assistant must
 * never share code paths.
 *
 * The previous field-map PR broke the chat screen while touching nothing in it
 * — the coupling happened through the runtime environment, not the source.
 * This suite keeps the *source* half of that promise mechanically true: the
 * transitive import graph of either feature may not reach a module owned by
 * the other. Anything genuinely shared (auth, wilayas, the app shell copy) is
 * deliberately outside both sets.
 *
 *   npm run test:unit
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

/** Directories/files owned by the assistant feature. */
const ASSISTANT_OWNED = [
  "app/assistant",
  "app/api/assistant",
  "components/assistant",
  "lib/assistant",
];

/** Directories/files owned by the field-map / field-data feature. */
const MAP_OWNED = [
  "components/map",
  "lib/field-data",
  "lib/geo",
  "lib/satellite",
  "app/api/field-data",
];

const owns = (rel: string, roots: string[]): boolean =>
  roots.some((root) => rel === root || rel.startsWith(`${root}/`) || rel === `${root}.ts`);

/** All `.ts`/`.tsx` files under a directory (relative to `src`). */
function filesUnder(dir: string): string[] {
  const abs = path.join(SRC, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Resolve a `@/`-style specifier to a `src`-relative module path, or null. */
function resolveSpecifier(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  const base = spec.slice(2);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fs.existsSync(path.join(SRC, candidate)) && fs.statSync(path.join(SRC, candidate)).isFile()) {
      return candidate;
    }
  }
  // An unresolvable internal import is a build error elsewhere; ignore it here.
  return null;
}

/** Every module reachable from `roots`, following `@/` imports only. */
function importGraph(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = fs.readFileSync(path.join(SRC, rel), "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^"'`]*from\s*["']([^"'`]+)["']/g)) {
      const target = resolveSpecifier(match[1]);
      if (target && !seen.has(target)) stack.push(target);
    }
    // Side-effect imports (CSS, plugins) carry no module graph of ours.
  }
  return seen;
}

const assistantRoots = ASSISTANT_OWNED.flatMap(filesUnder).filter((f) => fs.existsSync(path.join(SRC, f)));
const mapRoots = MAP_OWNED.flatMap(filesUnder).filter((f) => fs.existsSync(path.join(SRC, f)));

test("both feature trees exist and are non-empty", () => {
  assert.ok(assistantRoots.length > 0, "assistant tree found");
  assert.ok(mapRoots.length > 0, "field-map tree found");
});

test("the assistant's import graph reaches no field-map module", () => {
  const graph = importGraph(assistantRoots);
  const offenders = [...graph].filter((rel) => owns(rel, MAP_OWNED));
  assert.deepEqual(
    offenders,
    [],
    `assistant code must not import field-map code — found: ${offenders.join(", ")}`,
  );
});

test("the field-map import graph reaches no assistant module", () => {
  const graph = importGraph(mapRoots);
  const offenders = [...graph].filter((rel) => owns(rel, ASSISTANT_OWNED));
  assert.deepEqual(
    offenders,
    [],
    `field-map code must not import assistant code — found: ${offenders.join(", ")}`,
  );
});

test("no file is owned by both features", () => {
  const overlap = assistantRoots.filter((rel) => owns(rel, MAP_OWNED) || mapRoots.includes(rel));
  assert.deepEqual(overlap, [], `owned by both: ${overlap.join(", ")}`);
});

test("the assistant route keeps its own error copy module untouched by map strings", () => {
  // The connection-error string lives in assistant copy; map copy lives under
  // lib/dashboard/copy.ts. The two files must remain separate modules.
  assert.ok(fs.existsSync(path.join(SRC, "lib/assistant/copy.ts")));
  assert.ok(fs.existsSync(path.join(SRC, "lib/dashboard/copy.ts")));
  const assistantCopy = fs.readFileSync(path.join(SRC, "lib/assistant/copy.ts"), "utf8");
  assert.ok(
    !assistantCopy.includes("fieldMap") && !assistantCopy.includes("fieldDataReason"),
    "map copy must not leak into the assistant copy module",
  );
});
