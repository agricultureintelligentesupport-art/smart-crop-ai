/**
 * `/api/geocode` — place search for the field map, proxied through Nominatim.
 *
 *   GET /api/geocode?q=خنشلة&lang=ar
 *     → 200 `{ results: [{ id, name, secondary, lat, lng }] }`
 *     → 400 for a query shorter than 3 characters or an unknown language
 *     → 502 `{ error: "upstream" }` when Nominatim is unreachable, slow or
 *       rate-limiting (the UI shows a retryable error, never a hang)
 *
 * WHY THE BROWSER DOES NOT CALL NOMINATIM DIRECTLY
 * ------------------------------------------------
 * The replaced `leaflet-control-geocoder` fetched Nominatim from the client,
 * which left two real problems. First, its result mapping crashed on our
 * `addressdetails=0` responses and the control swallowed the rejection — the
 * spinner ran forever with zero feedback. Second, a browser cannot send the
 * identifying `User-Agent` Nominatim's usage policy asks applications to use,
 * cannot cache across sessions, and can only soft-throttle racing requests.
 * A server route fixes all of it at once:
 *
 *   • It signs requests with the app's own User-Agent (the policy's
 *     "Referer or User-Agent" requirement for applications).
 *   • It caches responses for a day — place names do not move — so repeated
 *     searches cost Nominatim nothing.
 *   • It spaces upstream calls at least ~1.1 s apart, inside the policy's
 *     absolute maximum of 1 request/second, even under concurrent users.
 *   • It shape-checks the upstream JSON (`parseNominatimResults`), so a bad
 *     payload degrades to "no results" instead of breaking the UI.
 *
 * `addressdetails=1` is requested deliberately: the UI's secondary line is
 * built from `display_name` only, but keeping details on makes future uses
 * (e.g. resolving the wilaya of a searched place) possible without changing
 * the cache contract. Algeria-only (`countrycodes=dz`) stays: a farmer
 * searching "Biskra" must get Biskra, DZ.
 */

import { NextRequest, NextResponse } from "next/server";
import { normalizeQuery, parseNominatimResults, type GeocodeResponse } from "@/lib/geo/places";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
/** "an absolute maximum of 1 request per second" — keep a safety margin. */
const MIN_UPSTREAM_INTERVAL_MS = 1100;
/** Upstream read budget; past it the search fails visibly and can be retried. */
const UPSTREAM_TIMEOUT_MS = 8000;
/** Place names are stable; the policy explicitly asks clients to cache. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Memory ceiling for the per-instance cache, well past any session's use. */
const CACHE_MAX_ENTRIES = 200;
const MAX_QUERY_LENGTH = 80;
const LANGUAGES = new Set(["ar", "fr"]);

/** Identifies this application to Nominatim, as the usage policy requires. */
const USER_AGENT = "smart-crop-ai/0.1 (field-map place search; https://github.com/agricultureintelligentesupport-art/smart-crop-ai)";

interface CacheEntry {
  results: GeocodeResponse["results"];
  expiresAt: number;
}

/** Per-instance response cache, newest-checked on read, trimmed on insert. */
const cache = new Map<string, CacheEntry>();

function readCache(key: string): GeocodeResponse["results"] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Refresh recency so the oldest entry (not the most recently used) is the
  // one evicted when the ceiling is hit.
  cache.delete(key);
  cache.set(key, hit);
  return hit.results;
}

function writeCache(key: string, results: GeocodeResponse["results"]): void {
  cache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Serialises upstream calls and spaces them ≥ MIN_UPSTREAM_INTERVAL_MS apart,
 * FIFO, across every request handled by this server instance. Failures do not
 * break the chain for later callers.
 */
let upstreamChain: Promise<unknown> = Promise.resolve();
let lastUpstreamStart = 0;

function scheduleUpstream<T>(task: () => Promise<T>): Promise<T> {
  const run = upstreamChain.then(async () => {
    const wait = MIN_UPSTREAM_INTERVAL_MS - (Date.now() - lastUpstreamStart);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastUpstreamStart = Date.now();
    return task();
  });
  upstreamChain = run.catch(() => undefined);
  return run;
}

async function fetchNominatim(q: string, lang: string): Promise<GeocodeResponse["results"]> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "dz");
  url.searchParams.set("accept-language", lang);

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`nominatim ${response.status}`);
  const raw: unknown = await response.json();
  return parseNominatimResults(raw);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = normalizeQuery(request.nextUrl.searchParams.get("q") ?? "");
  const lang = request.nextUrl.searchParams.get("lang") ?? "ar";
  if (q.length < 3 || q.length > MAX_QUERY_LENGTH || !LANGUAGES.has(lang)) {
    return NextResponse.json({ error: "invalid-query" }, { status: 400 });
  }

  const key = `${lang}:${q}`;
  const cached = readCache(key);
  if (cached) {
    return NextResponse.json({ results: cached } satisfies GeocodeResponse, {
      headers: { "Cache-Control": "public, max-age=86400" },
    });
  }

  try {
    const results = await scheduleUpstream(() => fetchNominatim(q, lang));
    writeCache(key, results);
    return NextResponse.json({ results } satisfies GeocodeResponse, {
      headers: { "Cache-Control": "public, max-age=86400" },
    });
  } catch {
    // Timeout, 429, 5xx, TLS failure — one retryable failure shape for the UI.
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
