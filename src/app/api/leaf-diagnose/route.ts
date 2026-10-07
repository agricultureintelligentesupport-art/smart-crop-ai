import sharp from "sharp";
import {
  LEAF_DIAGNOSIS_PROMPT,
  LEAF_MAX_BYTES,
  LEAF_MAX_SIDE,
  LEAF_RESPONSE_SCHEMA,
  LeafDiagnosisError,
  parseLeafDiagnosis,
  validateLeafImage,
  type LeafFailure,
} from "@/lib/leaf-diagnose";
// This route's OWN Gemini policy (key rotation, model fallback, time budget).
// It only reads the chat's key pool / model chain; nothing shared is modified.
import {
  LEAF_GEMINI_BUDGET_MS,
  generateLeafGemini,
  resolveLeafGeminiRotation,
  resolveLeafGeminiModels,
} from "@/lib/leaf-diagnose-gemini";

export const runtime = "nodejs";
// This route only: key rotation + model fallback may spend up to
// LEAF_GEMINI_BUDGET_MS (50 s) upstream, so it needs headroom above 30 s.
export const maxDuration = 60;

const MAX_MULTIPART_BYTES = LEAF_MAX_BYTES + 64 * 1024;
const NO_STORE = { "Cache-Control": "no-store, private" };

function failure(reason: LeafFailure, status: number) {
  return Response.json({ error: reason }, { status, headers: NO_STORE });
}

/** Bound even chunked requests BEFORE formData() allocates the complete upload. */
async function readImage(request: Request): Promise<File> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !request.body) {
    throw new LeafDiagnosisError("invalid-input");
  }
  const length = request.headers.get("content-length");
  if (length !== null) {
    const bytes = Number(length);
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new LeafDiagnosisError("invalid-input");
    if (bytes > MAX_MULTIPART_BYTES) throw new LeafDiagnosisError("too-large");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MULTIPART_BYTES) {
        await reader.cancel();
        throw new LeafDiagnosisError("too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let form: FormData;
  try { form = await new Response(body, { headers: { "Content-Type": contentType } }).formData(); }
  catch { throw new LeafDiagnosisError("invalid-input"); }
  const images = form.getAll("image");
  if (images.length !== 1 || !(images[0] instanceof File) ||
      [...form.keys()].some((key) => key !== "image")) throw new LeafDiagnosisError("invalid-input");
  return images[0];
}

function providerText(value: unknown): string {
  if (typeof value !== "object" || value === null) throw new LeafDiagnosisError("malformed");
  const envelope = value as { candidates?: { finishReason?: string; content?: { parts?: { text?: unknown; thought?: boolean }[] } }[] };
  const candidate = envelope.candidates?.[0];
  if (!candidate || (candidate.finishReason && candidate.finishReason !== "STOP") ||
      !Array.isArray(candidate.content?.parts)) throw new LeafDiagnosisError("malformed");
  const text = candidate.content.parts
    .filter((part) => part && !part.thought && typeof part.text === "string")
    .map((part) => part.text).join("");
  if (!text) throw new LeafDiagnosisError("malformed");
  return text;
}

/** Multipart field `image`; images exist only in request memory, never storage or logs. */
export async function POST(request: Request): Promise<Response> {
  // The Gemini time budget counts from here, so a slow upload spends it too and
  // the whole request stays inside `maxDuration`.
  const startedAt = Date.now();
  let image: File;
  let bytes: Buffer;
  try {
    image = await readImage(request);
    const metadataError = validateLeafImage(image);
    if (metadataError) throw new LeafDiagnosisError(metadataError);
    bytes = Buffer.from(await image.arrayBuffer());
    const signatureError = validateLeafImage(image, bytes);
    if (signatureError) throw new LeafDiagnosisError(signatureError);
    const decoder = sharp(bytes, { failOn: "error", limitInputPixels: LEAF_MAX_SIDE ** 2 });
    const metadata = await decoder.metadata();
    const format = image.type === "image/jpeg" ? "jpeg" : image.type === "image/png" ? "png" : "webp";
    if (metadata.format !== format || !metadata.width || !metadata.height ||
        metadata.width > LEAF_MAX_SIDE || metadata.height > LEAF_MAX_SIDE ||
        (metadata.pages ?? 1) > 1) throw new LeafDiagnosisError("invalid-input");
    // A valid header is insufficient: truncated/corrupt files must fully decode.
    await decoder.stats();
  } catch (error) {
    const reason = error instanceof LeafDiagnosisError ? error.reason : "invalid-input";
    return failure(reason, reason === "too-large" ? 413 : 400);
  }

  // Same key pool and model chain the chat reads (read-only); see the helper.
  // This request's rotation order: the configured pool, randomly drawn (no
  // key repeats inside this cycle) — see `resolveLeafGeminiRotation`.
  const keys = resolveLeafGeminiRotation();
  const models = resolveLeafGeminiModels();
  if (!keys.length || !models.length) return failure("provider-busy", 503);

  try {
    const mimeType = image.type;
    const data = bytes.toString("base64");
    const outcome = await generateLeafGemini({
      keys,
      models,
      signal: request.signal,
      budgetMs: LEAF_GEMINI_BUDGET_MS - (Date.now() - startedAt),
      buildBody: (model) => JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: LEAF_DIAGNOSIS_PROMPT },
          { inlineData: { mimeType, data } },
        ] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          responseSchema: LEAF_RESPONSE_SCHEMA,
          ...(model.thinking ? { thinkingConfig: model.thinking } : {}),
        },
      }),
    });
    if (!outcome.ok) return failure(outcome.reason, outcome.status);
    const result = parseLeafDiagnosis(providerText(outcome.data));
    return Response.json(result, {
      headers: { ...NO_STORE, ...(!result.isPlant ? { "X-Leaf-Diagnose-Reason": "not-a-plant" } : {}) },
    });
  } catch (error) {
    const reason = error instanceof LeafDiagnosisError ? error.reason : "network";
    return failure(reason, reason === "provider-busy" ? 504 : 502);
  }
}
