/**
 * `GET /api/health/hf?key=<HEALTH_SECRET>` — "can this deployment talk to
 * Hugging Face right now?"
 *
 * WHY THIS EXISTS
 * ---------------
 * Step 1's MobileNetV2 fallback and Step 2 (the text model) authenticate to
 * the Hugging Face router with ONE secret: `process.env.HUGGINGFACE_API_KEY`.
 * When that secret is missing, mistyped, or belongs to an account with no
 * credits left, the assistant degrades silently (it still answers, from Gemini
 * or the built-in formatter), and the only clue is a warning buried in
 * `warnings[]`. This probe turns that into a single answerable question.
 *
 * NOTE: the assistant ships with Hugging Face SOFT-BLOCKED
 * (`ENABLE_HUGGINGFACE = false`), so this probe answers "is the token usable?"
 * for the day the flag is flipped back on. It is unaffected by the flag — the
 * probe deliberately reports the credential, not the routing decision.
 *
 * THE PROBE
 * ---------
 * A 1-token chat-completion against the SAME router endpoint, model and auth
 * header the pipeline uses (`/v1/chat/completions`, the first id of the model
 * chain, `Authorization: Bearer <token>`). It is deliberately the smallest
 * possible request: it validates DNS/TLS, the endpoint, the token's shape and
 * the account's ability to serve a completion, and costs (almost) no quota.
 *
 * RESPONSE — exactly the five agreed fields, and NO secret material:
 *
 *   200 { ok, status, latencyMs, tokenPresent, tokenPrefixOk }
 *
 *   • `ok`            — the router answered 2xx.
 *   • `status`        — upstream HTTP status (`null` when no request was sent
 *                       or the request could not reach a status).
 *   • `latencyMs`     — wall-clock round-trip of the probe.
 *   • `tokenPresent`  — `HUGGINGFACE_API_KEY` resolved to a non-blank trimmed
 *                       value. The value itself is never returned, logged or
 *                       echoed.
 *   • `tokenPrefixOk` — the token starts with `hf_` (Hugging Face user access
 *                       tokens do; a pasted API URL or a Firebase-style key
 *                       does not — the classic copy/paste mistake this field
 *                       exists to catch).
 *
 * Bounded by the same 8 s per-attempt window as the pipeline, and always
 * `Cache-Control: no-store` — a health answer is never cached.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  PER_ATTEMPT_TIMEOUT_MS,
  RequestDeadline,
  fetchWithAttemptTimeout,
  resolveHuggingFaceToken,
  shortMessage,
} from "@/lib/assistant/providers";
import { authorizeHealthProbe } from "@/lib/assistant/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Mirrors `HF_ROUTER_CHAT_URL` in the assistant route. */
const HF_ROUTER_CHAT_URL = "https://router.huggingface.co/v1/chat/completions";

/** Mirrors `HF_LLM_MODELS[0]` — the model Step 2 (the primary) leads with. */
const HF_LLM_MODEL = "Qwen/Qwen3-4B-Instruct-2507";

interface HfHealthPayload {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  tokenPresent: boolean;
  tokenPrefixOk: boolean;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = authorizeHealthProbe(request);
  if (denied) return denied;

  const token = resolveHuggingFaceToken();
  const tokenPresent = token !== null;
  const tokenPrefixOk = token !== null && token.startsWith("hf_");

  const noStore = { "Cache-Control": "no-store" } as const;

  if (token === null) {
    console.warn("[Health: HF] HUGGINGFACE_API_KEY is not configured — no probe was sent.");
    return NextResponse.json(
      {
        ok: false,
        status: null,
        latencyMs: 0,
        tokenPresent: false,
        tokenPrefixOk: false,
      } satisfies HfHealthPayload,
      { headers: noStore },
    );
  }

  const startedAt = Date.now();
  const deadline = new RequestDeadline(PER_ATTEMPT_TIMEOUT_MS);
  let status: number | null = null;
  let ok = false;
  let failure: string | null = null;

  try {
    const response = await fetchWithAttemptTimeout(
      HF_ROUTER_CHAT_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: HF_LLM_MODEL,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0,
          stream: false,
        }),
      },
      deadline,
      PER_ATTEMPT_TIMEOUT_MS,
    );
    status = response.status;
    ok = response.ok;
    // Drain the body so the socket is released; never surfaced, never logged.
    await response.text().catch(() => "");
  } catch (error) {
    failure = shortMessage(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    deadline.dispose();
  }

  const latencyMs = Date.now() - startedAt;
  // NAMES and booleans only — a status, a duration and a shape check.
  console.log(
    `[Health: HF] model=${HF_LLM_MODEL} status=${status ?? "none"} ok=${ok} latencyMs=${latencyMs} tokenPresent=${tokenPresent} tokenPrefixOk=${tokenPrefixOk}` +
      (failure ? ` error=${failure}` : ""),
  );

  return NextResponse.json(
    { ok, status, latencyMs, tokenPresent, tokenPrefixOk } satisfies HfHealthPayload,
    { headers: noStore },
  );
}
