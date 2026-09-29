/**
 * Place-search types and pure parsing, shared by the `/api/geocode` proxy
 * (server) and the map search UI (client).
 *
 * WHY A PROXY EXISTS AT ALL
 * -------------------------
 * Nominatim's usage policy asks heavy clients to identify themselves (a real
 * `User-Agent`, which browsers refuse to let scripts set) and to cache
 * aggressively, and it rate-limits to 1 request/second per source. A small
 * server route satisfies all three: it sends the app's own User-Agent, keeps
 * a response cache, and spaces upstream calls. It also returns a shaped,
 * validated result list so the UI never trusts raw upstream JSON.
 *
 * LABELLING
 * ---------
 * Nominatim gives a flat `display_name` ("خنشلة, دائرة خنشلة, خنشلة, الجزائر").
 * Farmers need two lines: the place itself, and where it sits (wilaya /
 * daïra / commune). `splitDisplayName` takes the first segment as the place
 * name, drops the trailing country (it is always Algeria here — the search is
 * `countrycodes=dz`) and de-duplicates consecutive repeats, leaving the
 * administrative path in between.
 */

export interface Place {
  /** Stable identity for list rendering keys. */
  id: string;
  /** The place itself — the bold line ("خنشلة"). */
  name: string;
  /** Administrative context — the lighter line ("دائرة خنشلة، خنشلة"). */
  secondary: string | null;
  lat: number;
  lng: number;
}

export interface GeocodeResponse {
  results: Place[];
}

/** Country label Nominatim appends for `countrycodes=dz`, per `accept-language`. */
const COUNTRY_NAMES = new Set(["الجزائر", "algeria", "algérie"]);

/** Collapse whitespace so "  خنشلة   " and "خنشلة" share one cache entry. */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}

/** Drop a segment that repeats the previous one ("خنشلة, خنشلة" → "خنشلة"). */
function dropConsecutiveDuplicates(parts: string[]): string[] {
  return parts.filter((part, i) => i === 0 || part !== parts[i - 1]);
}

/**
 * Split Nominatim's `display_name` into the two lines the result row shows.
 * Returns `null` for the secondary line when nothing is left after removing
 * the place name and the country — a top-level result like the wilaya of
 * Khenchela is just "خنشلة".
 */
export function splitDisplayName(displayName: string, name: string): string | null {
  const segments = displayName.split(",").map((s) => s.trim()).filter(Boolean);
  const rest = dropConsecutiveDuplicates(
    segments.slice(name && segments[0] === name ? 1 : 0).filter((s) => !COUNTRY_NAMES.has(s.toLowerCase())),
  );
  return rest.length > 0 ? rest.join("، ") : null;
}

/**
 * Shape one raw Nominatim (jsonv2) item. Defensive by design: the UI must
 * never crash on an upstream field going missing — that is exactly the class
 * of bug that made the old geocoder control spin forever.
 */
function parseNominatimItem(raw: unknown, index: number): Place | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const lat = Number(item.lat);
  const lng = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const displayName = typeof item.display_name === "string" ? item.display_name : "";
  if (!displayName) return null;
  const explicitName = typeof item.name === "string" ? item.name.trim() : "";
  const name = explicitName || displayName.split(",")[0].trim() || displayName;
  const placeId =
    typeof item.place_id === "string" || typeof item.place_id === "number" ? String(item.place_id) : String(index);
  return {
    id: `${placeId}-${index}`,
    name,
    secondary: splitDisplayName(displayName, name),
    lat,
    lng,
  };
}

/** Shape an upstream result array, dropping anything unusable. */
export function parseNominatimResults(raw: unknown): Place[] {
  if (!Array.isArray(raw)) return [];
  const places: Place[] = [];
  for (let i = 0; i < raw.length && places.length < 5; i++) {
    const place = parseNominatimItem(raw[i], i);
    if (place) places.push(place);
  }
  return places;
}
