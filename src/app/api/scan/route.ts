/**
 * `/api/scan` — the quick-scan endpoint behind the Home "صحة النبات" card.
 *
 * It serves the SCRIPTED demo diagnosis (Black Spot on a rose leaf, 95 %)
 * after a 5 s simulated vision round-trip, so a demo recording always shows
 * the same curated card. Like the chat mock, this route follows the shared
 * `DEMO_MOCK` flag (see `@/lib/assistant/demo-mock`):
 *
 *   DEMO_MOCK unset / 1   → 200 `{ status: "success", data: { … } }` after 5 s
 *   DEMO_MOCK=0           → 404 `{ status: "error", error: "scan-demo-disabled" }`
 *                           instantly (no delay, no payload)
 *
 * The card always calls this route FIRST and falls back to the real
 * `/api/leaf-diagnose` pipeline whenever this one does not answer with the
 * envelope — which is exactly what happens in production, where the flag is
 * off. Nothing about the real diagnosis path changes: this route NEVER calls a
 * provider, so it cannot burn a quota, hit a rate limit or wait on a cold
 * model. Responses are `no-store` so a preview/proxy can never cache the
 * scripted card.
 */

import { isDemoMockEnabled } from "@/lib/assistant/demo-mock";
import { LEAF_MAX_BYTES, validateLeafImage } from "@/lib/leaf-diagnose";
import { DEMO_SCAN_DELAY_MS, DEMO_SCAN_PAYLOAD } from "@/lib/leaf-scan-demo";

export const runtime = "nodejs";
// The scripted answer only sleeps 5 s; force-dynamic keeps it out of any cache.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" };
const MAX_MULTIPART_BYTES = LEAF_MAX_BYTES + 64 * 1024;

function failure(error: string, status: number) {
  return Response.json({ status: "error", error }, { status, headers: NO_STORE });
}

/**
 * Read and lightly validate the uploaded photo — the SAME acceptance rules as
 * `/api/leaf-diagnose` (size, MIME type and magic bytes), minus the full
 * `sharp` decode: the scripted answer does not analyse pixels, so a corrupt
 * file only has to be rejected on its header here.
 *
 * Accepts both shapes the endpoint is called with:
 *   • `multipart/form-data` with an `image` file (what the Home card sends);
 *   • JSON `{ image: { data, mimeType } }` (handy for a quick curl/manual test).
 */
async function readDemoImage(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (/^multipart\/form-data\s*;/i.test(contentType)) {
    const length = request.headers.get("content-length");
    if (length !== null) {
      const bytes = Number(length);
      if (!Number.isSafeInteger(bytes) || bytes < 1) return "invalid-input";
      if (bytes > MAX_MULTIPART_BYTES) return "too-large";
    }
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) return "invalid-input";
    const metadataError = validateLeafImage(file);
    if (metadataError) return metadataError;
    const bytes = Buffer.from(await file.arrayBuffer());
    return validateLeafImage(file, bytes);
  }

  if (/^application\/json\s*$/i.test(contentType.trim())) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return "invalid-input";
    }
    const image = (body as { image?: { data?: unknown; mimeType?: unknown } } | null)?.image;
    if (!image || typeof image.data !== "string" || typeof image.mimeType !== "string") {
      return "invalid-input";
    }
    const size = Math.floor((image.data.length * 3) / 4); // base64 → bytes
    if (size < 1) return "invalid-input";
    if (size > LEAF_MAX_BYTES) return "too-large";
    return validateLeafImage({ type: image.mimeType, size });
  }

  return "invalid-input";
}

export async function POST(request: Request): Promise<Response> {
  const imageError = await readDemoImage(request).catch(() => "invalid-input" as const);
  if (imageError) return failure(imageError, imageError === "too-large" ? 413 : 400);

  // The demo gate comes AFTER input validation (the endpoint stays honest
  // about bad uploads) and BEFORE any provider lookup — deliberately: the
  // scripted answer must work on a server with zero API keys.
  if (!isDemoMockEnabled()) {
    console.log("[Scan Demo] disabled (DEMO_MOCK=0) — card will use /api/leaf-diagnose.");
    return failure("scan-demo-disabled", 404);
  }

  // Simulated vision round-trip so the card's scanning animation plays out.
  await new Promise((resolve) => setTimeout(resolve, DEMO_SCAN_DELAY_MS));

  console.log(
    `[Scan Demo] scripted quick-scan served — ${DEMO_SCAN_PAYLOAD.data.diseaseName}; no provider was called.`,
  );
  return Response.json(DEMO_SCAN_PAYLOAD, { headers: NO_STORE });
}
