/**
 * `GET /api/health/gemini?key=<HEALTH_SECRET>` — "which Gemini keys work right
 * now, and in which order will the assistant try them?"
 *
 * WHY THIS EXISTS
 * ---------------
 * Step 1 (image analysis) and Step 3 (text fallback) rotate through a pool of
 * Gemini credentials, and the pool is heterogeneous by design: each variable
 * may belong to a different Google project with its own daily quota. When a key
 * is revoked, or a project's quota is gone, the assistant keeps answering from
 * the NEXT key — so a broken credential is invisible from the outside. This
 * probe reports the actual rotation order and the actual reachability of every
 * key, by NAME.
 *
 * THE PROBE
 * ---------
 * One 1-token `generateContent` per configured key, in rotation order, against
 * the FIRST model of the chain (the id the request path starts with). Rotation
 * order comes from `resolveGeminiKeyPool()` and is the SAME order the pipeline
 * uses: `GEMINI_API_KEY_4` FIRST, then `GEMINI_API_KEY` and the remaining
 * `GEMINI_API_KEY_N` in numeric order, then the legacy `GEMINI_API_KEYS` pool.
 *
 * RESPONSE
 * --------
 * An array in rotation order, one entry per key, NAMES ONLY — never a value:
 *
 *   [
 *     {
 *       name: "GEMINI_API_KEY_4",   // variable name (+ "#n" for a comma pool)
 *       ok: true,                    // 2xx from generateContent
 *       status: 200,                 // upstream HTTP status (null if no status)
 *       latencyMs: 412,              // round-trip of this probe
 *       quotaExhausted: false,       // cached 429 mark, or this probe's 429
 *       firstInRotation: true,       // ← the key the pipeline starts with
 *       model: "gemini-3.8-flash"    // the chain's first id, probed here
 *     },
 *     …
 *   ]
 *
 * The first item is marked `firstInRotation: true` (and is the only one that
 * can be), so "which key does the assistant use first?" needs no guessing.
 *
 * A 429 marks the (key, first-model) pair in the shared 10-minute quota cache
 * and a 400 `API_KEY_INVALID` / 403 marks the key as invalid for 60 minutes —
 * exactly what a real request would do — so a probe that finds a dead key also
 * spares the next user request from discovering it the hard way.
 *
 * Each probe is bounded by the shared 8 s per-attempt window; the response is
 * `Cache-Control: no-store` and is only reachable with `?key=<HEALTH_SECRET>`.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveGeminiModels } from "@/lib/assistant/gemini-models";
import {
  GEMINI_INVALID_TTL_MS,
  PER_ATTEMPT_TIMEOUT_MS,
  RequestDeadline,
  fetchWithAttemptTimeout,
  geminiKeyState,
  redactSecrets,
  resolveGeminiKeyPool,
} from "@/lib/assistant/providers";
import { authorizeHealthProbe } from "@/lib/assistant/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface GeminiKeyHealth {
  /** Environment-variable NAME only (never the credential value). */
  name: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  quotaExhausted: boolean;
  /** True for the key the pipeline tries FIRST. */
  firstInRotation: boolean;
  /** The chain's first model id — the one probed with a 1-token request. */
  model: string;
}

/** Google's "this key is not usable" signatures (mirrors the route's list). */
const INVALID_KEY_PATTERNS: readonly RegExp[] = [
  /API[_ ]?KEY[_ ]?INVALID/i,
  /API key not valid/i,
  /invalid API key/i,
  /PERMISSION_DENIED/i,
  /API (?:has not been used|is not enabled)/i,
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = authorizeHealthProbe(request);
  if (denied) return denied;

  const keyPool = resolveGeminiKeyPool();
  const model = resolveGeminiModels(process.env.GEMINI_MODEL)[0].id;

  const results: GeminiKeyHealth[] = [];

  for (const [index, entry] of keyPool.entries()) {
    const startedAt = Date.now();
    let status: number | null = null;
    let ok = false;
    let quotaExhausted = geminiKeyState.isQuotaExhausted(entry.name, model);
    let bodyText = "";

    const deadline = new RequestDeadline(PER_ATTEMPT_TIMEOUT_MS);
    try {
      const response = await fetchWithAttemptTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${entry.key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
            generationConfig: { maxOutputTokens: 1, temperature: 0 },
          }),
        },
        deadline,
        PER_ATTEMPT_TIMEOUT_MS,
      );
      status = response.status;
      ok = response.ok;
      // Only an error body is worth keeping (for the redacted log line).
      bodyText = response.ok ? "" : await response.text().catch(() => "");
      // A dead key discovered by the probe is parked exactly as a request
      // would park it — the next real request does not re-pay the round-trip.
      if (status === 429) {
        geminiKeyState.markQuotaExhausted(entry.name, model);
        quotaExhausted = true;
      } else if (status === 403 || (status === 400 && INVALID_KEY_PATTERNS.some((p) => p.test(bodyText)))) {
        geminiKeyState.markInvalid(entry.name, GEMINI_INVALID_TTL_MS);
      }
    } catch {
      // Network error / 8 s timeout: no HTTP status to report.
      status = null;
      ok = false;
    } finally {
      deadline.dispose();
    }

    const latencyMs = Date.now() - startedAt;
    // NAMES and status codes only — an upstream error body can echo a request
    // URL, so it is redacted and shortened before it can reach a log line.
    console.log(
      `[Health: Gemini] ${entry.name} / ${model} status=${status ?? "none"} ok=${ok} ` +
        `latencyMs=${latencyMs} quotaExhausted=${quotaExhausted} firstInRotation=${index === 0}` +
        (bodyText ? ` detail=${redactSecrets(bodyText).replace(/\s+/g, " ").slice(0, 120)}` : ""),
    );

    results.push({
      name: entry.name,
      ok,
      status,
      latencyMs,
      quotaExhausted,
      firstInRotation: index === 0,
      model,
    });
  }

  return NextResponse.json(results, { headers: { "Cache-Control": "no-store" } });
}
