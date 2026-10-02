import sharp from "sharp";
// Read-only model definition: this route has its OWN client/deadline/retry policy.
import { GEMINI_MODEL_DEFAULT } from "@/lib/assistant/gemini-models";
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

export const runtime = "nodejs";
export const maxDuration = 30;

const PROVIDER_TIMEOUT_MS = 25_000;
const RETRY_BACKOFF_MS = 350;
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

/** Read existing credentials, independently; never mutate the chat key pool or env. */
function apiKeys(): string[] {
  const keys = Object.entries(process.env)
    .filter(([name]) => name.startsWith("GEMINI_API_KEY"))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, value]) => (value ?? "").split(","))
    .map((key) => key.trim()).filter(Boolean);
  return [...new Set(keys)];
}

function backoff(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new LeafDiagnosisError("provider-busy")); return; }
    const abort = () => {
      clearTimeout(timer);
      reject(new LeafDiagnosisError("provider-busy"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, RETRY_BACKOFF_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
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

  const keys = apiKeys();
  if (!keys.length) return failure("provider-busy", 503);
  const pinned = process.env.GEMINI_MODEL?.trim();
  const model = pinned ? { id: pinned, thinking: undefined } : GEMINI_MODEL_DEFAULT;
  if (!model.id) return failure("provider-busy", 503);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) controller.abort();

  try {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: LEAF_DIAGNOSIS_PROMPT },
        { inlineData: { mimeType: image.type, data: bytes.toString("base64") } },
      ] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: LEAF_RESPONSE_SCHEMA,
        ...(model.thinking ? { thinkingConfig: model.thinking } : {}),
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": keys[attempt % keys.length] },
          body,
          signal: controller.signal,
          cache: "no-store",
        },
      );
      if (response.status === 429 || response.status === 503) {
        await response.body?.cancel();
        if (attempt === 0) { await backoff(controller.signal); continue; }
        return failure("provider-busy", 503);
      }
      if (!response.ok) {
        await response.body?.cancel();
        return failure("provider-busy", 503);
      }
      let data: unknown;
      try { data = await response.json(); } catch { throw new LeafDiagnosisError("malformed"); }
      const result = parseLeafDiagnosis(providerText(data));
      return Response.json(result, {
        headers: { ...NO_STORE, ...(!result.isPlant ? { "X-Leaf-Diagnose-Reason": "not-a-plant" } : {}) },
      });
    }
    return failure("provider-busy", 503);
  } catch (error) {
    const reason = controller.signal.aborted ? "provider-busy" :
      error instanceof LeafDiagnosisError ? error.reason : "network";
    return failure(reason, reason === "provider-busy" ? 504 : 502);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", cancel);
  }
}
