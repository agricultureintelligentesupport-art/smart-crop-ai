/**
 * Step-by-step diagnostics for the upstream calls behind `/api/field-data`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vercel's request log only shows *that* a call was made, not why it failed.
 * "Copernicus rejected credentials" was being reported for a rejection that
 * happened on a different step than the one the message implied, and nobody
 * could tell which. Every upstream call now records one `StepLog` — the host,
 * the HTTP status and the error code/message the server answered with — and
 * prints it as one greppable line.
 *
 * NO SECRETS
 * ----------
 * Only the URL *host* is logged (never the path or query), the error text is
 * cut to `MAX_DETAIL_CHARS`, and anything that looks like a credential — the
 * configured client id/secret, a Bearer value, a JWT — is replaced before it
 * is stored. The same redacted records are returned to the browser, so a
 * failure can be diagnosed from the UI without opening the Vercel dashboard.
 */

/** The upstream calls of one field-data request, in the order they happen. */
export type TraceStep =
  | "validate"
  | "nasa-power"
  | "cdse-token"
  | "sh-catalog"
  | "sh-process"
  | "openeo-result"
  | "openeo-poll";

export interface StepLog {
  step: TraceStep;
  /** URL host only — never a path, query or credential. */
  host: string;
  /** HTTP status, or `null` when no response arrived (DNS, TLS, timeout). */
  status: number | null;
  ok: boolean;
  /** Machine code from the response body (`invalid_client`, `ACCESS_DENIED`…). */
  code: string | null;
  /** Human message from the response body, ≤ 300 chars, redacted. */
  message: string | null;
  ms: number;
}

export const MAX_DETAIL_CHARS = 300;
/** The UI card gets a much shorter string than the server log. */
const MAX_TECHNICAL_CHARS = 150;

/** The host of a URL, or `"invalid-url"`. Never throws. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** Strips anything credential-shaped and cuts to `max` characters. */
export function redact(text: string, secrets: readonly (string | null | undefined)[] = [], max = MAX_DETAIL_CHARS): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  out = out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .replace(/(client_secret|access_token|refresh_token|password)=([^&\s"]+)/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const pickString = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Pulls `{ code, message }` out of whatever an error body looks like.
 *
 *   Keycloak        { "error": "invalid_client", "error_description": "…" }
 *   Sentinel Hub    { "error": { "status": 403, "reason": "Forbidden", "message": "…", "code": "ACCESS_DENIED" } }
 *   openEO          { "id": "…", "code": "AuthenticationFailed", "message": "…" }
 *   Anything else   the first 300 chars of the raw text.
 */
export function extractErrorDetail(
  rawText: string,
  secrets: readonly (string | null | undefined)[] = [],
): { code: string | null; message: string | null } {
  const text = typeof rawText === "string" ? rawText : "";
  let code: string | null = null;
  let message: string | null = null;
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const nested = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : null;
      code =
        pickString(nested?.code) ??
        pickString(nested?.reason) ??
        pickString(typeof b.error === "string" ? b.error : null) ??
        pickString(b.code) ??
        pickString(b.reason);
      message =
        pickString(nested?.message) ??
        pickString(b.error_description) ??
        pickString(b.message) ??
        pickString(b.detail) ??
        pickString(b.title);
    }
  } catch {
    /* not JSON — fall through to the raw text */
  }
  if (!code && !message && text.trim()) message = text;
  return {
    code: code ? redact(code, secrets, 80) : null,
    message: message ? redact(message, secrets) : null,
  };
}

/** Collects the steps of ONE request and prints each as a single log line. */
export class SatelliteTrace {
  readonly steps: StepLog[] = [];
  private readonly secrets: (string | null | undefined)[];
  private readonly sink: (line: string) => void;
  private readonly requestTag: string;

  constructor(options: { secrets?: (string | null | undefined)[]; tag?: string; sink?: (line: string) => void } = {}) {
    this.secrets = options.secrets ?? [];
    this.requestTag = options.tag ?? "";
    this.sink = options.sink ?? ((line) => console.log(line));
  }

  /** Records one finished call. `body` is the raw response text of a failure. */
  record(entry: { step: TraceStep; url: string; status: number | null; ok: boolean; body?: string; note?: string; startedAt: number }): StepLog {
    const detail = entry.ok
      ? { code: null, message: entry.note ? redact(entry.note, this.secrets) : null }
      : entry.body !== undefined
        ? extractErrorDetail(entry.body, this.secrets)
        : { code: null, message: entry.note ? redact(entry.note, this.secrets) : null };
    const log: StepLog = {
      step: entry.step,
      host: hostOf(entry.url),
      status: entry.status,
      ok: entry.ok,
      code: detail.code,
      message: detail.message,
      ms: Math.max(0, Date.now() - entry.startedAt),
    };
    this.steps.push(log);
    this.sink(
      `[field-data]${this.requestTag ? ` ${this.requestTag}` : ""} step=${log.step} host=${log.host} status=${log.status ?? "none"} ok=${log.ok}` +
        `${log.code ? ` code=${log.code}` : ""}${log.message ? ` message=${JSON.stringify(log.message)}` : ""} ms=${log.ms}`,
    );
    return log;
  }

  /**
   * Records the local validation that precedes every upstream call:
   * `[field-data] plot=… step=validate ok=… detail=… areaHa=… rows=… cols=… ring=… cells=…`.
   */
  validation(entry: { ok: boolean; detail: string | null; areaHa: number; rows: number; cols: number; ringLength: number; cells: number }): StepLog {
    const detail = entry.detail ? redact(entry.detail, this.secrets) : null;
    const log: StepLog = {
      step: "validate",
      host: "local",
      status: null,
      ok: entry.ok,
      code: entry.ok ? null : "invalid-input",
      message: detail,
      ms: 0,
    };
    this.steps.push(log);
    this.sink(
      `[field-data]${this.requestTag ? ` ${this.requestTag}` : ""} step=validate ok=${entry.ok} detail=${JSON.stringify(detail ?? "none")} ` +
        `areaHa=${Number.isFinite(entry.areaHa) ? entry.areaHa.toFixed(3) : entry.areaHa} rows=${entry.rows} cols=${entry.cols} ring=${entry.ringLength} cells=${entry.cells}`,
    );
    return log;
  }

  /** The first satellite step that failed, if any (POWER is reported separately). */
  firstSatelliteFailure(): StepLog | null {
    return this.steps.find((s) => !s.ok && s.step !== "nasa-power") ?? null;
  }

  /** Short technical string for the UI card, or `null` when nothing failed. */
  technical(): string | null {
    const failed = this.firstSatelliteFailure();
    return failed ? describeStep(failed) : null;
  }
}

/** `sh-process · sh.dataspace.copernicus.eu · HTTP 403 · ACCESS_DENIED: message…` */
export function describeStep(step: StepLog): string {
  // A local check has no host or HTTP status: `validate · invalid-input: <detail>`.
  if (step.step === "validate") {
    const text = `validate · ${step.code ?? "failed"}${step.message ? `: ${step.message}` : ""}`;
    return text.length > MAX_TECHNICAL_CHARS ? `${text.slice(0, MAX_TECHNICAL_CHARS - 1)}…` : text;
  }
  const parts = [step.step, step.host, step.status === null ? "no response" : `HTTP ${step.status}`];
  if (step.code) parts.push(step.code);
  let text = parts.join(" · ");
  if (step.message && step.message !== step.code) text += `: ${step.message}`;
  return text.length > MAX_TECHNICAL_CHARS ? `${text.slice(0, MAX_TECHNICAL_CHARS - 1)}…` : text;
}

/**
 * Wraps a `fetch` so every call is recorded as a step — used for NASA POWER,
 * whose module has no logging of its own. The response is passed through
 * untouched; a failure body is read from a clone so the caller still can.
 */
export function withStepLogging<F extends (input: string, init?: never) => Promise<{ ok: boolean; status?: number }>>(
  fetchImpl: F,
  trace: SatelliteTrace,
  step: TraceStep,
): F {
  const wrapped = async (input: string, init?: never) => {
    const startedAt = Date.now();
    try {
      const res = await fetchImpl(input, init);
      let body: string | undefined;
      if (!res.ok) {
        const clone = (res as unknown as { clone?: () => { text(): Promise<string> } }).clone?.();
        try {
          body = clone ? await clone.text() : undefined;
        } catch {
          body = undefined;
        }
      }
      trace.record({ step, url: input, status: typeof res.status === "number" ? res.status : null, ok: res.ok, body, startedAt });
      return res;
    } catch (error) {
      trace.record({
        step,
        url: input,
        status: null,
        ok: false,
        note: error instanceof Error ? `${error.name}: ${error.message}` : "request failed",
        startedAt,
      });
      throw error;
    }
  };
  return wrapped as unknown as F;
}
