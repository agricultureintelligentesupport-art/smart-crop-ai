/**
 * Plot geometry — the small, dependency-free set of operations the field map
 * needs, kept pure and unit-testable (see `test/unit/geo-polygon.unit.test.ts`).
 *
 * Everything here works on a GeoJSON-style ring: an array of `[lon, lat]`
 * positions in WGS84 decimal degrees, NOT closed (first point is not repeated
 * at the end). Coordinates are always **longitude first**, matching GeoJSON,
 * even though the map UI and this file's own maths read them as `lon, lat`.
 *
 * Areas are computed on a sphere (the standard geodesy-free "spherical excess"
 * shoelace) rather than in degrees, so a parcel's hectare figure is meaningful
 * without pulling in a geodesy library. At the scale of a field (metres to a
 * few kilometres) the error is far below a Sentinel-2 pixel.
 *
 * Deliberately no `@turf/*` dependency: the app already implements its own
 * haversine in `lib/auth/geolocation.ts`, and pulling the full turf bundle into
 * a mobile-first client costs more than the ~40 lines it would save.
 */

/** One WGS84 position, GeoJSON order: `[longitude, latitude]`. */
export type Position = [number, number];

/** An unclosed ring of positions. */
export type Ring = Position[];

/** Axis-aligned bounding box, GeoJSON order. */
export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Mean Earth radius (WGS84 authalic sphere) in metres. */
const EARTH_RADIUS_M = 6378137;
const DEG_TO_RAD = Math.PI / 180;

/** One grid cell of the parcel, expressed as a polygon clipped to the parcel. */
export interface GridCell {
  /** Stable identity `c-<row>-<col>`, matching the heatmap's zone ids. */
  id: string;
  row: number;
  col: number;
  /** The (possibly clipped) cell polygon, in `[lon, lat]` order. */
  ring: Ring;
  /** Area of the clipped cell in hectares — the pixels openEO will average. */
  areaHa: number;
}

export function isFinitePosition(p: unknown): p is Position {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    Math.abs(p[0] as number) <= 180 &&
    Math.abs(p[1] as number) <= 90
  );
}

/**
 * Drops consecutive duplicates and a trailing repeat of the first point, and
 * rejects anything that is not a usable position. Leaflet.draw hands back a
 * closed ring; every helper below wants it unclosed, so normalise at the edge.
 */
export function normalizeRing(raw: unknown): Ring {
  if (!Array.isArray(raw)) return [];
  const out: Ring = [];
  for (const item of raw) {
    if (!isFinitePosition(item)) continue;
    const p: Position = [item[0], item[1]];
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
    else break;
  }
  return out;
}

/** Closes a ring for GeoJSON output (first point repeated at the end). */
export function closeRing(ring: Ring): Ring {
  if (ring.length < 3) return ring;
  return [...ring, [ring[0][0], ring[0][1]]];
}

/**
 * Spherical-excess shoelace. Returns the absolute area in m².
 *
 * The per-edge `2 + sin(lat1) + sin(lat2)` term is the standard
 * approximation of the spherical triangle excess between two meridians; summing
 * it around a ring and taking half the result scaled by R² gives the enclosed
 * surface area without any trigonometry beyond `sin`.
 */
export function ringAreaM2(ring: Ring): number {
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    total += (lon2 - lon1) * DEG_TO_RAD * (2 + Math.sin(lat1 * DEG_TO_RAD) + Math.sin(lat2 * DEG_TO_RAD));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Enclosed area of a ring in hectares. */
export function ringAreaHa(ring: Ring): number {
  return ringAreaM2(ring) / 10_000;
}

/** Bounding box of a ring; `null` when the ring has no usable position. */
export function bboxOf(ring: Ring): Bbox | null {
  if (ring.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

/**
 * Area-weighted centroid, computed by triangulating the ring against its first
 * vertex and weighting each triangle by its own planar area in an
 * equirectangular projection. Exact enough at field scale and, unlike a plain
 * vertex mean, it stays inside a concave parcel.
 */
export function centroidOf(ring: Ring): Position | null {
  if (ring.length === 0) return null;
  if (ring.length < 3) {
    const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    return [lon, lat];
  }
  const refLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = Math.cos(refLat * DEG_TO_RAD);
  const [ox, oy] = ring[0];
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 1; i < ring.length - 1; i += 1) {
    const ax = (ring[i][0] - ox) * kx;
    const ay = ring[i][1] - oy;
    const bx = (ring[i + 1][0] - ox) * kx;
    const by = ring[i + 1][1] - oy;
    const tri = ax * by - bx * ay;
    area += tri;
    cx += (ax + bx) * tri;
    cy += (ay + by) * tri;
  }
  if (Math.abs(area) < 1e-12) {
    const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    return [lon, lat];
  }
  return [ox + cx / (3 * area * kx), oy + cy / (3 * area)];
}

/** Standard even-odd ray cast; points exactly on the edge are not guaranteed. */
export function pointInRing(ring: Ring, point: Position): boolean {
  if (ring.length < 3) return false;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Rectangle as a closed-less ring in `[lon, lat]` order. */
function boxRing(b: Bbox): Ring {
  return [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
  ];
}

/**
 * Sutherland–Hodgman: clips the `subject` polygon to the half-plane left of
 * each directed edge of the `clip` polygon.
 *
 * Exact when the clip polygon is convex. Real parcels are usually convex quads
 * or pentagons, and the *subject* here is always a rectangle (hence convex), so
 * the common case is exact. For a deliberately concave parcel the result can
 * slightly over-cover along the reflex edge; callers therefore discard cells
 * whose area is degenerate, and every published hectare figure comes from
 * `ringAreaHa` on the drawn ring rather than from this routine.
 */
function clipRingToPolygon(subject: Ring, clip: Ring): Ring {
  let output = subject;
  for (let i = 0; i < clip.length; i += 1) {
    if (output.length === 0) return [];
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const input = output;
    output = [];
    const side = (p: Position) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const onBoundary = (p: Position) => Math.abs(side(p)) < 1e-12;
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      const currentIn = side(current) >= -1e-12;
      const previousIn = side(previous) >= -1e-12;
      if (currentIn) {
        if (!previousIn && !onBoundary(previous)) {
          output.push(intersect(previous, current, a, b));
        }
        output.push(current);
      } else if (previousIn) {
        output.push(intersect(previous, current, a, b));
      }
    }
  }
  return output;
}

function intersect(p1: Position, p2: Position, a: Position, b: Position): Position {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = b[0] - a[0];
  const d2y = b[1] - a[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-15) return p1;
  const t = ((a[0] - p1[0]) * d2y - (a[1] - p1[1]) * d2x) / denom;
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

/** Cells below this area hold too few Sentinel-2 pixels to average. */
export const MIN_CELL_HA = 0.02;

/**
 * Shoelace sign in an equirectangular frame: positive when the ring runs
 * counter-clockwise (lon = x, lat = y), negative when clockwise.
 */
export function ringSignedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/**
 * Splits the parcel's bounding box into a `rows × cols` grid and clips every
 * cell to the parcel itself, so the mean openEO returns per cell is computed
 * only over pixels that are actually inside the drawn boundary.
 *
 * Cells that end up thinner than `MIN_CELL_HA` (≈2 Sentinel-2 pixels) are
 * dropped rather than reported: a mean over one or two pixels is noise, and
 * the heatmap shows them as "no data" instead of a misleading figure.
 */
export function gridCells(ring: Ring, rows: number, cols: number): GridCell[] {
  const bbox = bboxOf(ring);
  if (!bbox || rows < 1 || cols < 1) return [];
  /* `clipRingToPolygon` keeps what lies LEFT of each clip edge, which is the
     inside only for a counter-clockwise clip polygon. A boundary drawn
     clockwise (as a map draw tool commonly yields) would otherwise clip every
     cell away and leave zero cells whatever the plot's size. Orientation is
     irrelevant to the farmer, so normalise it here. */
  const clip = ringSignedArea(ring) < 0 ? [...ring].reverse() : ring;
  const dx = (bbox.east - bbox.west) / cols;
  const dy = (bbox.north - bbox.south) / rows;
  const out: GridCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      // Row 0 is the NORTH edge of the parcel, matching the heatmap's
      // top-to-bottom reading order and the SVG rendering.
      const cell: Bbox = {
        west: bbox.west + col * dx,
        east: bbox.west + (col + 1) * dx,
        south: bbox.north - (row + 1) * dy,
        north: bbox.north - row * dy,
      };
      const clipped = clipRingToPolygon(boxRing(cell), clip);
      if (clipped.length < 3) continue;
      const areaHa = ringAreaHa(clipped);
      if (!Number.isFinite(areaHa) || areaHa < MIN_CELL_HA) continue;
      out.push({ id: `c-${row}-${col}`, row, col, ring: clipped, areaHa });
    }
  }
  return out;
}

/** A polygon is usable for a real satellite query only if this passes. */
export interface PolygonValidation {
  ok: boolean;
  /** Machine-readable rejection reason, for copy + telemetry. */
  reason:
    | "tooFewPoints"
    | "selfIntersecting"
    | "degenerate"
    | "tooSmall"
    | "tooLarge"
    | "outOfRange"
    | "ok";
  /** `ok` is false whenever this is set. */
  detail?: string;
}

/** A drawn parcel must be at least this big to carry a real NDVI mean. */
/**
 * Does this edge touch the edge that follows it?
 *
 * Shared endpoints are how a ring is built, so they are not crossings. Collinear
 * overlap along the same line is a real defect: a double-back leaves a zero-area
 * sliver, and the area we report to the farmer would no longer match the shape
 * they drew.
 */
function edgesTouch(a: Position, b: Position, c: Position, d: Position): boolean {
  const side = (p: Position, q: Position, r: Position) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));

  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);

  // A proper crossing: each edge straddles the line of the other.
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;

  // Collinear touch or overlap: the straddling test cannot see these.
  const onSegment = (p: Position, q: Position, r: Position) =>
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1]);
  if (d1 === 0 && onSegment(c, a, d)) return true;
  if (d2 === 0 && onSegment(c, b, d)) return true;
  if (d3 === 0 && onSegment(a, c, b)) return true;
  if (d4 === 0 && onSegment(a, d, b)) return true;
  return false;
}

/**
 * Is this boundary a simple ring — no edge crossing another, and no repeated
 * point? Leaflet.draw reports the failure in English and offers no way out, so
 * the app checks the shape itself before it ever becomes a saved plot, a
 * measured area, or a satellite query.
 */
export function isSimpleRing(ring: Ring): boolean {
  const n = ring.length;
  if (n < 3) return false;

  for (let i = 0; i < n; i++) {
    if (ring[i][0] === ring[(i + 1) % n][0] && ring[i][1] === ring[(i + 1) % n][1]) return false;
  }

  // Two edges may only meet at the vertex they share, so skip the two pairs of
  // edges that are meant to touch: (i, i+1) and (n-1, 0).
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      if (edgesTouch(a, b, c, d)) return false;
    }
  }
  return true;
}

export const MIN_PLOT_HA = 0.05;
/** Guardrail so a stray click cannot trigger a whole-tile query. */
export const MAX_PLOT_HA = 50;

/**
 * The app covers Algeria; a plot outside that envelope is a GPS glitch, not a
 * field, and the agronomic copy on the dashboard is wilaya-scoped anyway.
 */
const ALGERIA_BBOX: Bbox = { west: -9.1, south: 18.9, east: 12.2, north: 37.6 };

export function validatePlot(ring: Ring): PolygonValidation {
  if (ring.length < 3) {
    return { ok: false, reason: "tooFewPoints", detail: "at least 3 points are required" };
  }
  for (const [lon, lat] of ring) {
    if (lon < ALGERIA_BBOX.west || lon > ALGERIA_BBOX.east || lat < ALGERIA_BBOX.south || lat > ALGERIA_BBOX.north) {
      return { ok: false, reason: "outOfRange", detail: "the boundary is outside Algeria" };
    }
  }
  // A repeated point leaves a zero-length edge, so the shape encloses nothing.
  // That is a different complaint from a genuine crossing, and the farmer needs
  // to be told which one happened.
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    if (ring[i][0] === ring[(i + 1) % n][0] && ring[i][1] === ring[(i + 1) % n][1]) {
      return { ok: false, reason: "degenerate", detail: "the boundary encloses no area" };
    }
  }
  if (!isSimpleRing(ring)) {
    return {
      ok: false,
      reason: "selfIntersecting",
      detail: "the boundary crosses itself",
    };
  }
  const areaHa = ringAreaHa(ring);
  if (!Number.isFinite(areaHa) || areaHa <= 0) {
    return { ok: false, reason: "degenerate", detail: "the boundary encloses no area" };
  }
  if (areaHa < MIN_PLOT_HA) {
    return {
      ok: false,
      reason: "tooSmall",
      detail: `the boundary encloses ${areaHa.toFixed(3)} ha, under the ${MIN_PLOT_HA} ha minimum`,
    };
  }
  if (areaHa > MAX_PLOT_HA) {
    return {
      ok: false,
      reason: "tooLarge",
      detail: `the boundary encloses ${areaHa.toFixed(1)} ha, over the ${MAX_PLOT_HA} ha maximum`,
    };
  }
  return { ok: true, reason: "ok" };
}
