/**
 * The manual model selector's catalog — ONE definition, shared by the chat
 * client (which renders the picker) and `/api/assistant` (which validates the
 * choice and pins the Gemini chain), so the two can never disagree about what
 * "phyto 3.5" means.
 *
 * HOW A CHOICE TRAVELS
 * --------------------
 *   1. The client sends the stable id (`"phyto-3.5"`) in the request body's
 *      `model` field — never the raw Gemini id, so a future re-mapping (Google
 *      retires an id) is a one-line change here instead of a client release.
 *   2. The route calls {@link resolveRequestedModel}; anything it does not
 *      recognise (absent, blank, a stale cached choice, a hostile value) yields
 *      `null` and the request runs exactly as before — the full fallback chain
 *      with no pin. A bad selector value can never fail or slow a request.
 *   3. A recognised choice becomes the HEAD of the Gemini chain and takes
 *      priority on `GEMINI_API_KEY_4`; the built-in fallbacks stay behind it, so
 *      a retired or unavailable selected model still answers instead of
 *      erroring (the route reports the substitution in `warnings[]`).
 *
 * Dependency-free and safe in both bundles: no React, no Next.js, no `fetch`,
 * no environment access.
 */

/** One selectable model, as shown in the picker. */
export interface PhytoModelChoice {
  /** Stable identifier sent in the request body (`"phyto-3.8"`). */
  id: string;
  /** User-facing name, exactly as the picker shows it (`"phyto 3.8"`). */
  label: string;
  /** The Gemini model id this choice pins as the chain head. */
  model: string;
  /**
   * One-line characterisation for the picker's secondary text. Kept as a KEY
   * (not a translated string) so this module stays language-neutral; the client
   * localises it.
   */
  note: "balanced" | "fast" | "economy";
}

/**
 * The three selectable models, in the order the picker lists them. `phyto 3.8`
 * is the default and the same primary the pipeline uses when no choice is sent.
 *
 * `phyto 2.5` maps to `gemini-2.5-flash`, which Google refuses for NEW API keys
 * and retires on 2026-10-20: it is offered because the specification asks for
 * it, and the per-key `GET /v1beta/models` catalog plus the fallback chain keep
 * the request answering (with a warning naming the substitution) when a key
 * cannot see it.
 */
export const PHYTO_MODEL_CHOICES: readonly PhytoModelChoice[] = [
  { id: "phyto-3.8", label: "phyto 3.8", model: "gemini-3.8-flash", note: "balanced" },
  { id: "phyto-3.5", label: "phyto 3.5", model: "gemini-3.5-flash", note: "fast" },
  { id: "phyto-2.5", label: "phyto 2.5", model: "gemini-2.5-flash", note: "economy" },
];

/** The choice the picker starts on and the pipeline defaults to. */
export const DEFAULT_PHYTO_MODEL_ID = "phyto-3.8";

/** The choice list's ids, for validation without importing the objects. */
export const PHYTO_MODEL_IDS: readonly string[] = PHYTO_MODEL_CHOICES.map((choice) => choice.id);

/**
 * Fold the accepted spellings of a choice into one comparable key: the stable
 * id, the user-facing label (`"phyto 3.8"`), an underscored variant
 * (`"PHYTO_3.8"`) and the raw Gemini id all normalise to a lowercase,
 * dash-separated token.
 */
function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * Resolve whatever the client sent into a catalog entry, or `null` for
 * anything unknown (including `undefined`, blank strings, non-strings and
 * model ids that are not part of the picker).
 *
 * Accepts the stable id (`"phyto-3.5"`), the friendly name (`"phyto 3.5"`) and
 * the raw Gemini id (`"gemini-3.5-flash"`), so an old client, a curl request
 * and the picker all work without version negotiation.
 */
export function resolveRequestedModel(raw: unknown): PhytoModelChoice | null {
  if (typeof raw !== "string") return null;
  const key = normalize(raw);
  if (!key) return null;
  return (
    PHYTO_MODEL_CHOICES.find(
      (choice) => normalize(choice.id) === key || normalize(choice.model) === key,
    ) ?? null
  );
}

/** The catalog entry for a stable id — `null` when the id is not offered. */
export function phytoModelFor(id: string | null | undefined): PhytoModelChoice | null {
  if (!id) return null;
  const key = normalize(id);
  return PHYTO_MODEL_CHOICES.find((choice) => normalize(choice.id) === key) ?? null;
}

/**
 * The friendly name for a Gemini model id, for logs and diagnostics
 * (`"gemini-3.5-flash"` → `"phyto 3.5"`). Ids outside the picker are returned
 * unchanged, so a `GEMINI_MODEL` override still logs something meaningful.
 */
export function phytoModelLabel(model: string): string {
  const key = normalize(model);
  return PHYTO_MODEL_CHOICES.find((choice) => normalize(choice.model) === key)?.label ?? model;
}

/**
 * The persisted client preference's storage key. The value is a catalog id; an
 * unknown/short-lived id is discarded by {@link phytoModelFor} and the default
 * is used, so no migration is ever needed.
 */
export const PHYTO_MODEL_STORAGE_KEY = "phytoscan.model";
