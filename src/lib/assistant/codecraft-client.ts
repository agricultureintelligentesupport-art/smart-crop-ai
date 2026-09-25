/**
 * CodeCraft vision — CLIENT-SIDE pre-check (best-effort, browser-only).
 *
 * The browser twin of the server-only CodeCraft engine in
 * {@link ./codecraft-vision}. Before the assistant UI triggers the main
 * `/api/assistant` request, it may call CodeCraft DIRECTLY from the browser —
 * OpenAI-compatible chat completions at
 * `https://codecraftapi.com/v1/chat/completions` — asking for the SAME
 * structured verdict the server engine asks for, in order to hand a fast
 * plant-disease diagnosis to the standard request flow.
 *
 * THE STRICT FAILSAFE RULE — the server pipeline is PRIMARY:
 *   • The client call is a BEST-EFFORT pre-check only. The ENTIRE
 *     server-side pipeline (Step 0 detection & cropping → Step 1 dual-engine
 *     vision, CodeCraft → MobileNetV2 → LLM Stages 1–3) runs UNTOUCHED
 *     afterwards, and the diagnosis the server produces always wins in the
 *     response. A client verdict merely rides along in the request payload
 *     (`clientDiagnosis`) — the current route does not consume it; the field
 *     is carried forward-compatible.
 *   • Every failure mode is SILENT: unset/placeholder key, CORS block,
 *     network error, the 8 s deadline, HTTP 401/402/403/429/5xx, an empty or
 *     non-JSON answer, "this is not a plant" — {@link
 *     analyzeImageClientSideCodeCraft} resolves to `null` and the UI
 *     proceeds with the standard `/api/assistant` POST as if the pre-check
 *     never happened. No throw, no toast, no broken state.
 *
 * CREDENTIAL — `NEXT_PUBLIC_CODECRAFT_API_KEY`:
 *   A SEPARATE, optional credential from the server-only `CODECRAFT_API_KEY`
 *   (which stays untouched and is still the secret powering the Step 1
 *   engine inside `/api/assistant`). Next.js inlines `NEXT_PUBLIC_*` values
 *   into the browser bundle at BUILD time; an unset OR placeholder value
 *   disables the pre-check instantly — no request, no latency, behaviour
 *   byte-identical to the client before this module existed.
 *
 * REUSE, NOT DUPLICATION: the request uses the SAME pure helpers the server
 * engine exports (`normalizeImageInput`, {@link VISION_SYSTEM_PROMPT} +
 * `buildVisionPrompt`, `extractJsonObject`, `toAssistantDiagnosis`). None of
 * them touches `process.env` or the network, so importing them into the
 * client bundle is side-effect free — and a client verdict is guaranteed to
 * speak the exact `AssistantDiagnosis` contract the pipeline consumes.
 */

import {
  CODECRAFT_BASE_URL_DEFAULT,
  PLACEHOLDER_KEY_PATTERN,
  VISION_SYSTEM_PROMPT,
  buildVisionPrompt,
  extractJsonObject,
  normalizeImageInput,
  toAssistantDiagnosis,
  type CodeCraftVerdict,
} from "@/lib/assistant/codecraft-vision";
import type {
  AssistantContext,
  AssistantDiagnosis,
} from "@/lib/assistant/types";

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

/**
 * Hard client-side deadline for the WHOLE round-trip (headers AND body).
 * The pre-check must FAIL FAST: 8 s keeps the send flow snappy, and a
 * hanging network can never hold the standard `/api/assistant` POST hostage
 * — the deadline fires, the fetch aborts, `null` resolves, the pipeline runs.
 */
export const CLIENT_CODECRAFT_TIMEOUT_MS = 8_000;

/**
 * Single vision model for the client round-trip — the same primary id the
 * server engine starts from. Deliberately NO model chain-walk here: the
 * browser attempt is one shot; any failure walks to the server pipeline,
 * which owns the full `gpt-4o → gpt-4o-mini` fallback and its fail-safe.
 */
const CLIENT_CODECRAFT_MODEL = "gpt-4o";

/** Structured extraction, not creative writing: mirror the server engine. */
const CLIENT_CODECRAFT_TEMPERATURE = 0.2;

/** Generous enough for the structured JSON verdict (mirrors the server). */
const CLIENT_CODECRAFT_MAX_TOKENS = 900;

/* ------------------------------------------------------------------ */
/*  Environment resolution (browser bundle, build-time inlined)        */
/* ------------------------------------------------------------------ */

/**
 * The client-side CodeCraft credential, or `null` when it is missing, blank
 * or still the documented placeholder — the pre-check is then disabled
 * instantly (no request, no wait, no throw).
 *
 * Static `process.env` access on purpose: Next.js only inlines `NEXT_PUBLIC_*`
 * values for STATIC property reads (the same convention as
 * `src/lib/firebase-env.ts`). Under `npm run test:unit` the plain Node
 * environment is read instead.
 */
export function resolveClientCodeCraftApiKey(): string | null {
  const key = process.env.NEXT_PUBLIC_CODECRAFT_API_KEY?.trim();
  if (!key) return null;
  if (PLACEHOLDER_KEY_PATTERN.test(key)) return null;
  return key;
}

/* ------------------------------------------------------------------ */
/*  Response parsing (defensive — the payload is untrusted)            */
/* ------------------------------------------------------------------ */

/** `choices[0].message.content` as plain text — string and part-array shapes. */
function extractClientMessageText(payload: unknown): string {
  const choices = (payload as { choices?: unknown[] } | null)?.choices;
  const first = choices?.[0] as
    | { message?: { content?: unknown } }
    | null
    | undefined;
  const content = first?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("")
      .trim();
  }
  return "";
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** Everything the client-side pre-check may be told about the photo. */
export interface ClientSideCodeCraftOptions {
  /** Output language of the verdict (drives `crop_ar`/`disease_ar` + severity). */
  lang?: "ar" | "fr";
  /** Agronomic profile that sharpens the verdict (the route's `context` shape). */
  profile?: AssistantContext | null;
  /**
   * Hard deadline for the whole round-trip in ms — default
   * {@link CLIENT_CODECRAFT_TIMEOUT_MS} (8 s). Unit tests pass a small value.
   */
  timeoutMs?: number;
  /**
   * Endpoint override (unit tests / self-hosted proxies) — defaults to
   * `https://codecraftapi.com/v1`.
   */
  baseUrl?: string | null;
}

/**
 * Analyse a leaf photo DIRECTLY from the browser with the CodeCraft vision
 * API — the best-effort pre-check that runs BEFORE the standard
 * `/api/assistant` POST.
 *
 * POSTs the photo (raw base64 or a full `data:<mime>;base64,…` URL) as an
 * `image_url` data-URL part to `https://codecraftapi.com/v1/chat/completions`
 * (Bearer `NEXT_PUBLIC_CODECRAFT_API_KEY`, model `gpt-4o`, one round-trip)
 * asking for the SAME structured JSON verdict the server engine asks for,
 * and normalises it into the shared {@link AssistantDiagnosis} contract with
 * the very same helper the server uses.
 *
 * FAILURE CONTRACT — this function NEVER throws and NEVER hangs:
 *   • no/placeholder `NEXT_PUBLIC_CODECRAFT_API_KEY` → `null` instantly;
 *   • CORS block / network error / the 8 s deadline → `null` (silent);
 *   • HTTP 401/402/403/429/5xx, empty or non-JSON answer → `null`;
 *   • "this is not a plant" or a verdict with no usable diagnosis → `null`.
 * In every one of those cases the caller simply proceeds with the standard
 * `/api/assistant` request — the untouched server-side pipeline is the
 * PRIMARY failsafe and re-does its own vision + LLM stages.
 *
 * @param base64Image raw base64 photo (or a full `data:<mime>;base64,…` URL)
 * @param mimeType    e.g. "image/jpeg" — defaults to `image/jpeg`
 * @param options     language / profile / deadline / endpoint overrides
 * @returns the normalised diagnosis, or `null` when no verdict could be
 *   produced — the caller treats both as "run the standard pipeline".
 */
export async function analyzeImageClientSideCodeCraft(
  base64Image: string,
  mimeType?: string | null,
  options: ClientSideCodeCraftOptions = {},
): Promise<AssistantDiagnosis | null> {
  const apiKey = resolveClientCodeCraftApiKey();
  if (!apiKey) return null; // pre-check disabled — standard pipeline only

  const timeoutMs = options.timeoutMs ?? CLIENT_CODECRAFT_TIMEOUT_MS;
  const lang = options.lang ?? "ar";
  const baseUrl = (options.baseUrl?.trim() || CODECRAFT_BASE_URL_DEFAULT).replace(/\/+$/, "");

  try {
    // Throws for an undecodable payload / bad mime type → caught below → null.
    const image = normalizeImageInput(base64Image, mimeType ?? "image/jpeg");

    const controller = new AbortController();
    // ONE deadline for headers AND body: a connection that answers headers
    // and then stalls can never hold the send flow longer than the budget.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: CLIENT_CODECRAFT_MODEL,
          messages: [
            { role: "system", content: VISION_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: buildVisionPrompt(options.profile ?? null) },
                {
                  type: "image_url",
                  image_url: { url: `data:${image.mimeType};base64,${image.data}` },
                },
              ],
            },
          ],
          temperature: CLIENT_CODECRAFT_TEMPERATURE,
          max_tokens: CLIENT_CODECRAFT_MAX_TOKENS,
          stream: false,
        }),
        signal: controller.signal,
      });

      // Account-level / quota / upstream failures — silent: another model id
      // cannot fix them and the server pipeline is the failsafe anyway.
      if (!response.ok) return null;

      const payload = (await response.json().catch(() => null)) as unknown;
      const text = extractClientMessageText(payload);
      if (!text) return null;

      const verdict = extractJsonObject(text);
      if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) return null;

      // Returns null for "not a plant" / no usable diagnosis — the SAME
      // semantics the server engine applies: nothing to attach, the standard
      // pipeline runs on.
      return toAssistantDiagnosis(verdict as CodeCraftVerdict, CLIENT_CODECRAFT_MODEL, lang);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // CORS block, DNS/network failure, the deadline firing, an unexpected
    // response shape, an invalid image payload — ALL silent by contract:
    // the caller proceeds with the standard /api/assistant POST as usual.
    return null;
  }
}
