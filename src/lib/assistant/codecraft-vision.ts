/**
 * CodeCraft vision engine — plant-disease analysis through the
 * OpenAI-compatible CodeCraft API (`https://codecraftapi.com/v1`).
 *
 * This module is ONE dedicated vision engine for Step 1 of `/api/assistant`.
 * It is deliberately narrow in scope:
 *
 *   • INPUT  — the leaf photo (base64) + optional agronomic profile context.
 *   • OUTPUT — an {@link AssistantDiagnosis}: the EXACT same contract the
 *     Hugging Face MobileNetV2 PlantVillage classifier already returns, so
 *     everything downstream (the Gemini/HF user turn, the diagnosis card in
 *     the UI, the direct-formatting safety net) keeps working untouched.
 *     CodeCraft's extra findings (severity, immediate treatment, prevention,
 *     symptoms) ride along as OPTIONAL fields on that same object.
 *   • VOICE  — the module asks for STRUCTURED DATA ONLY. It never writes the
 *     farmer-facing report: the existing agent pipeline (same system prompt,
 *     same conversation rules, same tone) turns these findings into the final
 *     reply, exactly as it already does for MobileNetV2.
 *
 * Failure contract (the "dual-engine" safety net): every failure mode —
 * missing/placeholder key, invalid key, HTTP 401/402/403/429 (payment or
 * quota), 404/unknown model, 5xx, timeout, network error, empty or
 * non-JSON answer, "this is not a plant" — throws
 * {@link CodeCraftVisionError}. The caller is expected to catch it and fall
 * back to the pre-existing Hugging Face MobileNetV2 + Gemini vision path
 * without the user ever noticing (no thrown error, no 500, no broken UI).
 *
 * Server-only: the CodeCraft key is read from `process.env` (never a
 * `NEXT_PUBLIC_` variable, never inlined into the browser bundle) and is
 * never echoed in a log line or a response body.
 */

import { parsePlantLabel } from "@/lib/assistant/plantvillage";
import type {
  AssistantContext,
  AssistantDiagnosis,
  DiagnosisCandidate,
} from "@/lib/assistant/types";

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

/** Default CodeCraft endpoint (OpenAI-compatible). Override with `CODECRAFT_BASE_URL`. */
export const CODECRAFT_BASE_URL_DEFAULT = "https://codecraftapi.com/v1";

/**
 * Vision model chain, tried in order: `gpt-4o` is the primary vision model,
 * `gpt-4o-mini` the cheaper/faster safety net inside the CodeCraft engine
 * (a 404 or an unknown-model 400 on the primary walks to it). Override the
 * whole chain with `CODECRAFT_VISION_MODEL` (comma-separated ids).
 */
export const CODECRAFT_VISION_MODELS = ["gemini-3.6-flash", "gpt-4o-mini"] as const;

/**
 * Per-model deadline. Vision round-trips on a full-resolution leaf photo are
 * slower than text; 20 s still leaves the rest of the assistant pipeline
 * (LLM stage + direct formatter) inside the route's 60 s `maxDuration`.
 */
const CODECRAFT_TIMEOUT_MS = 20_000;

/** Generous enough for the structured JSON verdict, capped for latency. */
const CODECRAFT_MAX_TOKENS = 900;

/** Structured extraction, not creative writing: keep sampling tight. */
const CODECRAFT_TEMPERATURE = 0.2;

/** Cap on how many treatment / prevention / symptom bullets are forwarded. */
const MAX_BULLETS = 5;

/** Cap on a single bullet's length (chars) before it is trimmed. */
const MAX_BULLET_CHARS = 300;

/** Cap on the number of alternative diagnoses forwarded (top-1 excluded). */
const MAX_ALTERNATIVES = 2;

/**
 * Confidence used when CodeCraft does not report one. Deliberately a neutral
 * "medium" value: never overstated, and never low enough to trip the
 * "please send a clearer photo" branch (<45 %).
 */
const FALLBACK_CONFIDENCE = 0.7;

/**
 * Placeholder values ship in `.env.local` and `.env.example`. Treating them
 * as "not configured" keeps the engine off until a real key is pasted —
 * instead of burning a 20 s round-trip on a doomed request every time.
 */
const PLACEHOLDER_KEY_PATTERN =
  /^(your[_-]?key[_-]?here|changeme|change[_-]?me|replace[_-]?me|xxx+|<[^>]*>|\{\{.*\}\})$/i;

/**
 * Message fragments meaning "this model id is the problem, not the account" —
 * the only failures that walk the model chain. Everything else (invalid key,
 * 402 payment required, 429 quota, malformed request) fails fast so the
 * caller can fall back without wasting the request budget.
 */
const MODEL_AVAILABILITY_PATTERNS: readonly RegExp[] = [
  /\bmodel not found\b/i,
  /\bunknown model\b/i,
  /\bno such model\b/i,
  /\bnot supported\b/i,
  /\bmodel_not_supported\b/i,
  /\bdoes not exist\b/i,
  /\binvalid model\b/i,
  /\bmodel .{0,30}(retired|deprecated|unavailable)\b/i,
];

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */

/** Every CodeCraft vision failure — the caller degrades to the other engine. */
export class CodeCraftVisionError extends Error {
  /** Upstream HTTP status when the failure came back as a response. */
  readonly status: number | undefined;
  /** Machine error code (`invalid_api_key`, `insufficient_quota`, …) when present. */
  readonly code: string | undefined;
  /** The CodeCraft model id the failure belongs to. */
  readonly model: string | undefined;
  /** True when another model id could plausibly fix this failure. */
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      model?: string;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "CodeCraftVisionError";
    this.status = options.status;
    this.code = options.code;
    this.model = options.model;
    this.retryable = options.retryable ?? false;
  }
}

/* ------------------------------------------------------------------ */
/*  Environment resolution (server-side only, no NEXT_PUBLIC_ prefix)  */
/* ------------------------------------------------------------------ */

/** Trimmed env value, or `null` when unset/blank. */
function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/**
 * The configured CodeCraft credential, or `null` when it is missing — or
 * still the documented placeholder, so an unconfigured deployment skips the
 * engine instantly (no request, no 20 s wait) and keeps the previous
 * pipeline end to end.
 */
export function resolveCodeCraftApiKey(): string | null {
  const key = readEnv("CODECRAFT_API_KEY");
  if (!key) return null;
  if (PLACEHOLDER_KEY_PATTERN.test(key)) {
    console.warn(
      "[CodeCraft: Vision Skipped] CODECRAFT_API_KEY is still a placeholder value — engine disabled, falling back to the Hugging Face vision pipeline.",
    );
    return null;
  }
  return key;
}

/**
 * Extracts the first valid `http`/`https` URL from a (possibly messy)
 * configured value. The match anchors on `http(s)://` and runs until the
 * first whitespace, closing parenthesis `)`, closing bracket `]` or the
 * angle `>` of an autolink — so Markdown link syntax (`[text](url)`,
 * `[url]`, `(url)`, `<url>`) never contributes to the result. A copied
 * HTML-escaped `&gt;` tail is dropped separately below.
 */
const BASE_URL_PATTERN = /https?:\/\/[^\s\)\]>]+/;

/** Strips a copied HTML `&gt;` entity (and anything after it) from the end. */
const HTML_ENTITY_TAIL_PATTERN = /&gt;.*$/;

/** Strips a run of trailing slashes (`/+$`). */
const TRAILING_SLASHES_PATTERN = /\/+$/;

/**
 * Sanitise a configured CodeCraft base URL:
 *
 *  1. the raw value (already trimmed by {@link readEnv}) is trimmed again;
 *  2. a valid `http`/`https` URL is extracted — Markdown brackets `[]`,
 *     parentheses `()` and autolink/`&gt;` wrappers never end up in the
 *     result;
 *  3. any trailing slashes (`/+$`) are removed;
 *  4. the plain literal {@link CODECRAFT_BASE_URL_DEFAULT}
 *     (`https://codecraftapi.com/v1` — no markdown brackets or parentheses)
 *     is used as the fallback when the value holds no valid URL.
 *
 * A pasted `/chat/completions` suffix is also stripped so the endpoint is
 * never doubled.
 */
export function sanitizeBaseUrl(raw: string): string {
  const match = BASE_URL_PATTERN.exec((raw ?? "").trim());
  if (!match) return CODECRAFT_BASE_URL_DEFAULT;
  const cleaned = match[0]
    .replace(HTML_ENTITY_TAIL_PATTERN, "")
    .replace(TRAILING_SLASHES_PATTERN, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(TRAILING_SLASHES_PATTERN, "");
  return cleaned ? cleaned : CODECRAFT_BASE_URL_DEFAULT;
}

/** Base URL actually used: `CODECRAFT_BASE_URL` or the plain default. */
export function resolveCodeCraftBaseUrl(): string {
  const raw = readEnv("CODECRAFT_BASE_URL");
  if (!raw) return CODECRAFT_BASE_URL_DEFAULT;
  return sanitizeBaseUrl(raw);
}

/** `https://codecraftapi.com/v1` → `https://codecraftapi.com/v1/chat/completions`. */
export function codeCraftChatCompletionsUrl(baseUrl: string = resolveCodeCraftBaseUrl()): string {
  return `${baseUrl}/chat/completions`;
}

/**
 * Ordered vision model chain for this request: the
 * `CODECRAFT_VISION_MODEL` override (comma-separated, trimmed, deduplicated)
 * or the built-in `gpt-4o` → `gpt-4o-mini` default. Read per request so a
 * deployment can switch models without a restart.
 */
export function resolveCodeCraftVisionModels(): string[] {
  const raw = readEnv("CODECRAFT_VISION_MODEL") ?? readEnv("CODECRAFT_MODEL");
  if (!raw) return [...CODECRAFT_VISION_MODELS];
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
  return ids.length > 0 ? ids : [...CODECRAFT_VISION_MODELS];
}

/* ------------------------------------------------------------------ */
/*  Prompting — structured extraction only, never the final reply      */
/* ------------------------------------------------------------------ */

/**
 * CodeCraft is asked for DATA, not prose: the assistant's persona, tone and
 * formatting live in the shared system prompt of `/api/assistant`
 * (unchanged) and are applied by the LLM stage that writes the reply.
 */
const VISION_SYSTEM_PROMPT = `You are a plant pathology vision module. You inspect a single photo of a crop leaf or plant and return STRUCTURED DIAGNOSTIC DATA as one JSON object. You never write reports, greetings, or prose outside the JSON.`;

/** Output language for the Arabic-first assistant (French on request). */
function outputLanguage(profile?: AssistantContext | null): "ar" | "fr" {
  return profile?.lang === "fr" ? "fr" : "ar";
}

/**
 * Builds the text part that accompanies the image: the requested JSON schema,
 * the farming context (crop, wilaya, role) and the output language.
 */
function buildVisionPrompt(profile?: AssistantContext | null): string {
  const lang = outputLanguage(profile);
  const langName = lang === "fr" ? "French" : "Modern Standard Arabic (فصحى مبسطة)";
  const contextParts: string[] = [];
  if (profile?.crop) contextParts.push(`declared crop: ${profile.crop}`);
  if (profile?.wilayaName || profile?.wilayaCode) {
    contextParts.push(
      `region (Algerian wilaya): ${profile.wilayaName ?? profile.wilayaCode}`,
    );
  }
  if (profile?.role) contextParts.push(`user role: ${profile.role}`);
  if (typeof profile?.landSizeHa === "number") {
    contextParts.push(`farm size: ${profile.landSizeHa} ha`);
  }

  return [
    "Inspect the attached photo and return ONE JSON object and nothing else — no markdown fences, no commentary, no analysis outside the JSON.",
    "",
    "Schema:",
    "{",
    '  "is_plant": boolean,',
    '  "crop": string,               // English crop name, e.g. "Tomato"; "unknown" when unclear',
    '  "crop_ar": string,            // crop name in the output language',
    '  "disease": string,            // English disease/deficiency name, or "healthy"',
    '  "disease_ar": string,         // disease name in the output language',
    '  "healthy": boolean,',
    '  "severity": "none" | "low" | "medium" | "high" | "critical",',
    '  "severity_percent": number,   // 0-100 share of the plant/leaf already affected',
    '  "confidence": number,         // 0-100 confidence in the diagnosis',
    '  "symptoms": string[],         // <=4 short observed symptoms',
    '  "immediate_treatment": string[], // <=4 immediate actions, in priority order',
    '  "prevention": string[],       // <=3 prevention measures',
    '  "alternatives": [{"disease": string, "confidence": number}], // <=2 other plausible diagnoses',
    '  "notes": string               // one short agronomic remark, optional',
    "}",
    "",
    "Rules:",
    `- Write "symptoms", "immediate_treatment", "prevention", "notes", "crop_ar" and "disease_ar" in ${langName}.`,
    '- Keep "crop" and "disease" in English (snake-free, e.g. "Early blight", "Tomato").',
    '- "immediate_treatment" must be actionable for an Algerian farm: name product families actually sold there (copper fungicides, mancozeb, micronised sulphur, …) with indicative doses and the pre-harvest interval when relevant.',
    '- If the photo is not a plant / leaf / crop, return exactly {"is_plant": false}.',
    '- If the plant looks healthy, set "healthy": true, "disease": "healthy" and "severity": "none".',
    "- Base every field on what the photo actually shows; never invent a disease the image does not support.",
    contextParts.length > 0 ? `Farmer context: ${contextParts.join(" · ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/*  Image input normalisation                                          */
/* ------------------------------------------------------------------ */

const BASE64_PATTERN = /^[A-Za-z0-9+/\s]+={0,2}$/;

interface NormalizedImage {
  data: string;
  mimeType: string;
}

/**
 * Accepts raw base64 (the app's transport format) and tolerates a full
 * `data:<mime>;base64,...` URL, deriving the mime type from the prefix when
 * it is present. Throws {@link CodeCraftVisionError} for anything that is not
 * decodable, so the caller falls back instead of sending a broken payload.
 */
export function normalizeImageInput(
  imageBase64: string,
  mimeType?: string | null,
): NormalizedImage {
  const raw = (imageBase64 ?? "").trim();
  if (!raw) {
    throw new CodeCraftVisionError("empty image payload (no base64 data)");
  }

  const prefixed = /^data:([^;,]+)?;base64,([\s\S]*)$/i.exec(raw);
  const data = prefixed ? (prefixed[2] ?? "") : raw;
  const prefixMime = prefixed?.[1]?.trim().toLowerCase();

  const resolvedMime = (prefixMime || mimeType || "").trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(resolvedMime)) {
    throw new CodeCraftVisionError(
      `unsupported image mime type (${mimeType ?? prefixMime ?? "none"})`,
    );
  }

  const compact = data.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    throw new CodeCraftVisionError("image payload is not valid base64");
  }

  return { data: compact, mimeType: resolvedMime };
}

/* ------------------------------------------------------------------ */
/*  Response parsing                                                   */
/* ------------------------------------------------------------------ */

interface ChatCompletionPayload {
  choices?: {
    message?: {
      content?: string | { type?: string; text?: string }[] | null;
      refusal?: string | null;
    };
    finish_reason?: string | null;
  }[];
  error?: string | { message?: string; code?: string; type?: string } | null;
}

/** `message.content` as plain text — handles both string and part-array shapes. */
function extractMessageText(payload: ChatCompletionPayload | null): string {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("")
      .trim();
  }
  return "";
}

/**
 * Extract the first balanced JSON object from a model answer: tolerant of
 * ```json fences, a short preamble and trailing prose, because a strict
 * `response_format` is not guaranteed on every OpenAI-compatible gateway.
 */
export function extractJsonObject(text: string): unknown | null {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const candidates = cleaned.startsWith("{") ? [cleaned] : [cleaned, text];
  for (const candidate of candidates) {
    const parsed = tryParseBalancedObject(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Slice the first `{…}` with balanced braces/strings, then `JSON.parse` it. */
function tryParseBalancedObject(source: string): unknown | null {
  const start = source.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const slice = source.slice(start, index + 1);
        try {
          return JSON.parse(slice) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Structured verdict → AssistantDiagnosis                            */
/* ------------------------------------------------------------------ */

/** The (loose) shape CodeCraft is asked to answer with. */
interface CodeCraftVerdict {
  is_plant?: unknown;
  crop?: unknown;
  crop_ar?: unknown;
  disease?: unknown;
  disease_ar?: unknown;
  healthy?: unknown;
  severity?: unknown;
  severity_percent?: unknown;
  confidence?: unknown;
  symptoms?: unknown;
  immediate_treatment?: unknown;
  treatment?: unknown;
  prevention?: unknown;
  notes?: unknown;
  alternatives?: unknown;
}

type SeverityLevel = "none" | "low" | "medium" | "high" | "critical";

/** Severity vocabulary → share of the plant affected + the Arabic wording. */
const SEVERITY_SCALE: Record<SeverityLevel, { percent: number; ar: string; fr: string }> = {
  none: { percent: 0, ar: "منعدمة", fr: "nulle" },
  low: { percent: 25, ar: "خفيفة", fr: "faible" },
  medium: { percent: 50, ar: "متوسطة", fr: "moyenne" },
  high: { percent: 75, ar: "شديدة", fr: "élevée" },
  critical: { percent: 95, ar: "حرجة", fr: "critique" },
};

/** Accepts "high", "HIGH", "شديد", "critical"… → a known severity level. */
function parseSeverity(raw: unknown): SeverityLevel | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  for (const level of Object.keys(SEVERITY_SCALE) as SeverityLevel[]) {
    if (value === level || value.startsWith(level)) return level;
  }
  if (/شديد|حرج|خطير|متقدم/.test(raw)) return "high";
  if (/متوسط/.test(raw)) return "medium";
  if (/خفيف|طفيف/.test(raw)) return "low";
  if (/سليم|منعدم|لا توجد/.test(raw)) return "none";
  return null;
}

/** Numbers arriving as `85`, `"85"`, `"85%"` or `0.85` → a 0–100 percentage. */
function toPercent(raw: unknown): number | null {
  let value: number;
  if (typeof raw === "number") value = raw;
  else if (typeof raw === "string") {
    const cleaned = raw.replace(/[%\s]/g, "").replace(",", ".");
    if (!cleaned) return null;
    value = Number(cleaned);
  } else return null;
  if (!Number.isFinite(value)) return null;
  // A 0–1 ratio is normalised to a percentage; anything else is already one.
  const percent = value > 0 && value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, percent));
}

/** Trimmed non-empty string, or `null`. */
function toText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

/** String arrays → trimmed, de-duplicated, capped bullet lists. */
function toBullets(...sources: unknown[]): string[] | null {
  const collected: string[] = [];
  for (const source of sources) {
    if (typeof source === "string") {
      const value = source.trim();
      if (value) collected.push(value);
      continue;
    }
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const value = toText(item);
      if (value) collected.push(value);
    }
  }
  if (collected.length === 0) return null;
  const unique = [...new Set(collected.map((line) => line.replace(/\s+/g, " ").trim()))];
  return unique.slice(0, MAX_BULLETS).map((line) => line.slice(0, MAX_BULLET_CHARS));
}

/**
 * `("Tomato", "Early blight")` → the PlantVillage-style label
 * `Tomato___Early_blight`, so the EXISTING localiser
 * ({@link parsePlantLabel}) — and therefore the UI card, the LLM reference
 * block and the direct-diagnosis formatter — works unchanged.
 */
export function toPlantVillageLabel(crop: string | null, disease: string): string {
  const slugify = (value: string) =>
    value
      .trim()
      .replace(/[\s\-/]+/g, "_")
      .replace(/[^\p{L}\p{N}_()]/gu, "")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  const diseaseSlug = slugify(disease) || "unknown";
  const cropSlug = crop ? slugify(crop) : "";
  return cropSlug ? `${cropSlug}___${diseaseSlug}` : diseaseSlug;
}

interface Localized {
  labelAr: string;
  cropAr: string | null;
  diseaseAr: string | null;
}

/**
 * Arabic wording for the verdict: the existing PlantVillage localiser first
 * (so CodeCraft and MobileNetV2 read identically in the UI), and CodeCraft's
 * own Arabic names as a fallback for diseases the localiser doesn't know.
 */
function localizeVerdict(
  label: string,
  healthy: boolean,
  parsed: ReturnType<typeof parsePlantLabel>,
  cropArRaw: string | null,
  diseaseArRaw: string | null,
): Localized {
  if (healthy) {
    return {
      labelAr: parsed.healthy ? parsed.labelAr : (cropArRaw ? `${cropArRaw} — نبتة سليمة ✅` : "نبتة سليمة ✅"),
      cropAr: parsed.cropAr ?? cropArRaw,
      diseaseAr: null,
    };
  }
  if (parsed.diseaseAr) {
    return {
      labelAr: parsed.labelAr,
      cropAr: parsed.cropAr ?? cropArRaw,
      diseaseAr: parsed.diseaseAr,
    };
  }
  const cropAr = parsed.cropAr ?? cropArRaw;
  const diseaseAr = diseaseArRaw ?? parsed.diseaseAr;
  const labelAr = cropAr && diseaseAr ? `${cropAr} — ${diseaseAr}` : (diseaseAr ?? parsed.labelAr);
  return { labelAr, cropAr, diseaseAr };
}

/** Alternative diagnoses → the same `{ label, score }` candidate contract. */
function toCandidates(
  top: DiagnosisCandidate,
  crop: string | null,
  raw: unknown,
): DiagnosisCandidate[] {
  const candidates: DiagnosisCandidate[] = [top];
  if (!Array.isArray(raw)) return candidates;
  for (const item of raw.slice(0, MAX_ALTERNATIVES)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const disease =
      toText(record.disease) ?? toText(record.name) ?? toText(record.label);
    if (!disease) continue;
    const score = toPercent(record.confidence ?? record.score);
    if (score === null) continue;
    const label = toPlantVillageLabel(crop, disease);
    if (label === top.label) continue;
    candidates.push({ label, score: score / 100 });
  }
  return candidates;
}

/**
 * Turn CodeCraft's JSON verdict into the shared {@link AssistantDiagnosis}
 * contract. Returns `null` when the verdict is unusable (not a plant, no
 * disease named) so the caller can fall back to the other engine.
 */
export function toAssistantDiagnosis(
  verdict: CodeCraftVerdict,
  model: string,
  language: "ar" | "fr" = "ar",
): AssistantDiagnosis | null {
  // "This photo is not a plant" is a legitimate answer, not a failure of the
  // engine: return null so the caller falls back to the other vision engine.
  if (verdict.is_plant === false) return null;
  if (typeof verdict.is_plant === "string" && /^\s*(false|no)\s*$/i.test(verdict.is_plant)) {
    return null;
  }

  const crop = toText(verdict.crop);
  const cropArRaw = toText(verdict.crop_ar);
  const diseaseRaw = toText(verdict.disease);
  const diseaseArRaw = toText(verdict.disease_ar);
  const healthy =
    verdict.healthy === true ||
    (typeof verdict.healthy === "string" && /^true$/i.test(verdict.healthy.trim())) ||
    (diseaseRaw !== null && /^healthy$/i.test(diseaseRaw));

  const disease = healthy ? "healthy" : diseaseRaw;
  if (!disease && verdict.is_plant !== true) return null;
  if (!disease) return null;

  const label = toPlantVillageLabel(crop && !/^unknown$/i.test(crop) ? crop : null, disease);
  const parsed = parsePlantLabel(label);
  const localized = localizeVerdict(label, healthy, parsed, cropArRaw, diseaseArRaw);

  const severityRaw = toText(verdict.severity);
  // A healthy plant has no severity, whatever the model reported.
  const severityLevel = healthy ? "none" : parseSeverity(severityRaw);
  const severityPercentRaw = healthy ? null : toPercent(verdict.severity_percent);
  const severityPercent =
    severityPercentRaw ?? (severityLevel ? SEVERITY_SCALE[severityLevel].percent : null);
  const severityLabel = severityLevel
    ? language === "fr"
      ? SEVERITY_SCALE[severityLevel].fr
      : SEVERITY_SCALE[severityLevel].ar
    : severityRaw;

  const confidencePercent = toPercent(verdict.confidence);
  const confidence =
    confidencePercent === null ? FALLBACK_CONFIDENCE : confidencePercent / 100;

  const candidates = toCandidates(
    { label, score: confidence },
    crop && !/^unknown$/i.test(crop) ? crop : null,
    verdict.alternatives,
  );

  return {
    label,
    labelAr: localized.labelAr,
    cropAr: localized.cropAr,
    diseaseAr: localized.diseaseAr,
    healthy,
    confidence,
    // `codecraft/gpt-4o` — the UI prints the last path segment ("gpt-4o"),
    // and the model id stays visible for operators.
    model: `codecraft/${model}`,
    candidates,
    engine: "codecraft",
    severity: severityLabel,
    severityPercent,
    symptoms: toBullets(verdict.symptoms),
    treatment: toBullets(verdict.immediate_treatment, verdict.treatment),
    prevention: toBullets(verdict.prevention),
    notes: toText(verdict.notes)?.slice(0, MAX_BULLET_CHARS) ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP layer                                                         */
/* ------------------------------------------------------------------ */

/** `AbortSignal.timeout`, merged with an optional caller signal when given. */
function requestSignal(caller?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(CODECRAFT_TIMEOUT_MS);
  if (!caller) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([caller, timeout]) : timeout;
}

/** Human-readable detail for a non-2xx CodeCraft response. */
function describeHttpError(status: number, bodyText: string): { detail: string; code?: string } {
  const fallback = `HTTP ${status}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ""}`;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: string | { message?: string; code?: string; type?: string };
    };
    const envelope = parsed?.error;
    if (typeof envelope === "string" && envelope) {
      return { detail: `HTTP ${status} — ${envelope}` };
    }
    if (envelope && typeof envelope === "object") {
      const message = typeof envelope.message === "string" ? envelope.message.trim() : "";
      const code = typeof envelope.code === "string" ? envelope.code.trim() : "";
      if (message || code) {
        return {
          detail: `HTTP ${status} — ${[code && `[${code}]`, message].filter(Boolean).join(" ")}`,
          code: code || undefined,
        };
      }
    }
  } catch {
    // keep the raw detail
  }
  return { detail: fallback };
}

/** Maps an upstream failure onto a retry-or-fail-fast decision. */
function toVisionError(
  status: number,
  bodyText: string,
  model: string,
): CodeCraftVisionError {
  const { detail, code } = describeHttpError(status, bodyText);
  // Account-level failures: another model id cannot fix them — fail fast so
  // the caller falls back to the Hugging Face engine immediately.
  if (status === 401 || status === 402 || status === 403 || status === 429) {
    return new CodeCraftVisionError(detail, { status, code, model, retryable: false });
  }
  // Unknown / retired / unsupported model id → the next id may serve it.
  if (status === 404 || MODEL_AVAILABILITY_PATTERNS.some((pattern) => pattern.test(detail))) {
    return new CodeCraftVisionError(detail, { status, code, model, retryable: true });
  }
  // Transient upstream failures → worth one more attempt on the next id.
  if (status >= 500) {
    return new CodeCraftVisionError(detail, { status, code, model, retryable: true });
  }
  // Any other 4xx (malformed request, unsupported parameter…) → fail fast.
  return new CodeCraftVisionError(detail, { status, code, model, retryable: false });
}

interface VisionRequestArgs {
  model: string;
  apiKey: string;
  baseUrl: string;
  image: NormalizedImage;
  context: CodeCraftVisionContext;
}

/** One chat-completions round-trip against a single CodeCraft vision model. */
async function requestVisionDiagnosis(args: VisionRequestArgs): Promise<AssistantDiagnosis> {
  const { model, apiKey, baseUrl, image, context } = args;

  let response: Response;
  try {
    response = await fetch(codeCraftChatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: buildVisionPrompt(context.profile) },
              {
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${image.data}` },
              },
            ],
          },
        ],
        temperature: CODECRAFT_TEMPERATURE,
        max_tokens: CODECRAFT_MAX_TOKENS,
        stream: false,
      }),
      signal: requestSignal(context.signal),
    });
  } catch (error) {
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const timedOut = /timeout|abort/i.test(detail);
    throw new CodeCraftVisionError(
      timedOut ? `timeout after ${CODECRAFT_TIMEOUT_MS} ms` : detail,
      { model, retryable: true },
    );
  }

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      bodyText = response.statusText;
    }
    throw toVisionError(response.status, bodyText, model);
  }

  const payload = (await response.json().catch(() => null)) as ChatCompletionPayload | null;
  const text = extractMessageText(payload);
  if (!text) {
    throw new CodeCraftVisionError("empty response (no message content)", {
      model,
      retryable: true,
    });
  }

  const verdict = extractJsonObject(text);
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
    throw new CodeCraftVisionError(
      `response is not a JSON diagnostic object — ${text.slice(0, 160)}`,
      { model, retryable: true },
    );
  }

  const diagnosis = toAssistantDiagnosis(
    verdict as CodeCraftVerdict,
    model,
    outputLanguage(context.profile),
  );
  if (!diagnosis) {
    throw new CodeCraftVisionError(
      "no usable diagnosis in the response (image is not a plant, or no disease named)",
      { model, retryable: false },
    );
  }
  return diagnosis;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** Everything {@link analyzePlantImageWithCodeCraft} may be told about a photo. */
export interface CodeCraftVisionContext {
  /** e.g. "image/jpeg" — defaults to `image/jpeg` when unknown. */
  mimeType?: string | null;
  /** Optional agronomic profile (wilaya, crop, role) that sharpens the verdict. */
  profile?: AssistantContext | null;
  /** Caller-side cancellation, merged with the engine's own deadline. */
  signal?: AbortSignal | null;
  /** Endpoint override (tests / self-hosted proxies) — defaults to `CODECRAFT_BASE_URL`. */
  baseUrl?: string | null;
}

/**
 * Analyse a plant photo with the CodeCraft vision engine.
 *
 * PRIMARY vision engine of Step 1 in `/api/assistant`: it sends the image to
 * `${CODECRAFT_BASE_URL}/chat/completions` (OpenAI chat-completions format,
 * model `gpt-4o`, falling back to `gpt-4o-mini` inside the engine) and asks
 * for structured agricultural diagnostic data — disease name, severity and
 * immediate treatment among them — which is normalised into the exact
 * {@link AssistantDiagnosis} contract the rest of the pipeline already
 * consumes.
 *
 * Throws {@link CodeCraftVisionError} on EVERY failure mode (missing or
 * placeholder key, invalid/unpaid key, HTTP 402/429, timeout, non-JSON
 * answer, "not a plant"), so the caller can silently fail over to the
 * pre-existing Hugging Face / Gemini vision path. Use
 * {@link tryAnalyzePlantImageWithCodeCraft} for a variant that never throws.
 */
export async function analyzePlantImageWithCodeCraft(
  imageBase64: string,
  context: CodeCraftVisionContext = {},
): Promise<AssistantDiagnosis> {
  const apiKey = resolveCodeCraftApiKey();
  if (!apiKey) {
    throw new CodeCraftVisionError(
      "CODECRAFT_API_KEY is not configured (or still the placeholder value) — engine disabled",
    );
  }

  const image = normalizeImageInput(imageBase64, context.mimeType ?? "image/jpeg");
  const baseUrl = context.baseUrl?.trim() ? sanitizeBaseUrl(context.baseUrl) : resolveCodeCraftBaseUrl();
  const models = resolveCodeCraftVisionModels();
  const failures: string[] = [];

  for (const [index, model] of models.entries()) {
    try {
      const diagnosis = await requestVisionDiagnosis({
        model,
        apiKey,
        baseUrl,
        image,
        context,
      });
      console.log(
        `[Step 1: CodeCraft Success] model=${model} label=${diagnosis.label} confidence=${Math.round(
          diagnosis.confidence * 100,
        )}% severity=${diagnosis.severity ?? "n/a"} candidates=${diagnosis.candidates.length}`,
      );
      return diagnosis;
    } catch (error) {
      if (!(error instanceof CodeCraftVisionError)) throw error;
      failures.push(`${model}: ${error.message}`);

      const next = models[index + 1];
      if (error.retryable && next) {
        console.warn(
          `[Step 1: CodeCraft Fallback] ${model} → ${error.message} — retrying with ${next}`,
        );
        continue;
      }
      // Account-level / definitive failures surface immediately, so the caller
      // can fail over without delay. When the WHOLE chain was walked, the
      // error keeps the last status/code but reports every failure, so an
      // operator can tell "one bad id" from "the API is down".
      if (failures.length > 1) {
        throw new CodeCraftVisionError(
          `no CodeCraft vision model could answer (tried ${models.join(", ")}) — ${failures.join(" | ")}`,
          {
            status: error.status,
            code: error.code,
            model,
            retryable: error.retryable,
          },
        );
      }
      throw error;
    }
  }

  throw new CodeCraftVisionError(
    `no CodeCraft vision model could answer (tried ${models.join(", ")}) — ${failures.join(" | ")}`,
  );
}

/** Outcome of {@link tryAnalyzePlantImageWithCodeCraft} — never throws. */
export interface CodeCraftVisionOutcome {
  /** The diagnosis, or `null` when the engine could not produce one. */
  diagnosis: AssistantDiagnosis | null;
  /** Why the engine failed, or `null` on success. */
  error: CodeCraftVisionError | null;
}

/**
 * Non-throwing wrapper around {@link analyzePlantImageWithCodeCraft}: the
 * dual-engine safety net. Any failure — including an unexpected programming
 * error — is captured and returned, so a broken CodeCraft call can never
 * break the request: the caller simply falls back to the existing vision
 * pipeline.
 */
export async function tryAnalyzePlantImageWithCodeCraft(
  imageBase64: string,
  context: CodeCraftVisionContext = {},
): Promise<CodeCraftVisionOutcome> {
  try {
    const diagnosis = await analyzePlantImageWithCodeCraft(imageBase64, context);
    return { diagnosis, error: null };
  } catch (error) {
    const failure =
      error instanceof CodeCraftVisionError
        ? error
        : new CodeCraftVisionError(
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          );
    return { diagnosis: null, error: failure };
  }
}
