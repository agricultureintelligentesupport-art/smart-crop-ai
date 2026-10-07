/**
 * Shared guard for the two operational probes — `GET /api/health/hf` and
 * `GET /api/health/gemini`.
 *
 * Both endpoints spend a real upstream round-trip and reveal which credentials
 * exist (by NAME only — never a value), so both are protected by the same
 * server-side secret: `?key=<HEALTH_SECRET>`.
 *
 *   • `HEALTH_SECRET` unset/blank on the server → HTTP 503 +
 *     `code: "MISSING_HEALTH_SECRET"`. A missing secret must fail CLOSED: an
 *     unprotected probe endpoint is worse than a 503, because it would answer
 *     anyone who knows the URL and (on the Gemini probe) enumerate key names.
 *   • missing/wrong `?key=` → HTTP 401 + `code: "UNAUTHORIZED"`, compared with
 *     {@link safeSecretEquals} so the endpoint cannot be used as a
 *     character-by-character oracle.
 *   • correct secret → `null`, and the route runs its probe.
 *
 * The comparison value is read from `process.env` per request, so a rotated
 * secret is picked up without a redeploy. The secret itself is never logged,
 * echoed or included in a response.
 */

import { NextResponse, type NextRequest } from "next/server";
import { HEALTH_SECRET_ENV_NAME, safeSecretEquals } from "@/lib/assistant/providers";

/**
 * `null` when the probe may run; the ready-made 503/401 response otherwise.
 * Never throws and never logs the supplied value.
 */
export function authorizeHealthProbe(request: NextRequest): NextResponse | null {
  const expected = process.env[HEALTH_SECRET_ENV_NAME]?.trim() ?? "";
  // A rejected probe is still a probe answer: never let a proxy cache either
  // the "not configured" 503 or the 401, or a stale denial could outlive the
  // deployment fix in front of it.
  const noStore = { "Cache-Control": "no-store" } as const;

  if (!expected) {
    console.error(
      `[Health] ${HEALTH_SECRET_ENV_NAME} is not configured — refusing the probe (fail closed). ` +
        `Set it in Vercel (Project → Settings → Environment Variables) to enable /api/health/*.`,
    );
    return NextResponse.json(
      {
        error: `${HEALTH_SECRET_ENV_NAME} is not configured on the server`,
        code: "MISSING_HEALTH_SECRET",
      },
      { status: 503, headers: noStore },
    );
  }

  const provided = request.nextUrl.searchParams.get("key");
  if (!safeSecretEquals(provided, expected)) {
    return NextResponse.json(
      { error: "Unauthorized — pass ?key=<HEALTH_SECRET>", code: "UNAUTHORIZED" },
      { status: 401, headers: noStore },
    );
  }

  return null;
}
