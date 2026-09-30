/**
 * The analysis grid and the local validation that runs before any request to
 * Copernicus.
 *
 * WHY THE SERVER CHOOSES THE GRID
 * -------------------------------
 * The client used to send `rows`/`cols` derived from the dashboard's calculator
 * area (default 2 ha), not from the drawn plot. A 0.34 ha plot was therefore cut
 * into the grid of a 2 ha field. The grid is now a pure function of the plot's
 * REAL area (from its geometry) and shape, so both sides agree on it by reading
 * `rows`/`cols` off the observation instead of guessing.
 *
 * Target: cells of roughly 0.03–0.1 ha (3–10 Sentinel-2 pixels), aspect follows
 * the plot's bounding box, and each side is clamped to 2..8.
 */

import { bboxOf, gridCells, MIN_CELL_HA, ringAreaHa, type GridCell, type Ring } from "../geo/polygon";

export const MIN_GRID_SIDE = 2;
export const MAX_GRID_SIDE = 8;
/** Preferred cell size; the 0.03–0.1 ha band is centred on this. */
export const TARGET_CELL_HA = 0.06;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** `rows × cols` for a plot of `areaHa` whose bbox is `widthM × heightM` metres. */
export function gridForArea(areaHa: number, widthM: number, heightM: number): { rows: number; cols: number } {
  const cells = clamp(areaHa / TARGET_CELL_HA, MIN_GRID_SIDE * MIN_GRID_SIDE, MAX_GRID_SIDE * MAX_GRID_SIDE);
  const aspect = widthM > 0 && heightM > 0 ? widthM / heightM : 1;
  // A side can never hold more cells than `cells / MIN_GRID_SIDE`, so a tiny,
  // elongated plot is not cut into more cells than its area can feed.
  const colsCap = Math.max(MIN_GRID_SIDE, Math.floor(cells / MIN_GRID_SIDE));
  const cols = clamp(Math.round(Math.sqrt(cells * aspect)), MIN_GRID_SIDE, Math.min(MAX_GRID_SIDE, colsCap));
  const rows = clamp(Math.round(cells / cols), MIN_GRID_SIDE, MAX_GRID_SIDE);
  return { rows, cols };
}

export interface AnalysisValidation {
  ok: boolean;
  /** The exact condition that failed, with the real values. `null` when ok. */
  detail: string | null;
  ringLength: number;
  /** Area from the polygon geometry — never the client's claim. */
  areaHa: number;
  rows: number;
  cols: number;
  cells: GridCell[];
}

/**
 * Checks, in order, everything that can be decided locally. The first failing
 * condition is returned verbatim so the log, the JSON and the card all name the
 * same thing.
 */
export function validateAnalysisInput(
  ring: Ring,
  override?: { rows?: number; cols?: number },
): AnalysisValidation {
  const ringLength = Array.isArray(ring) ? ring.length : 0;
  const base = { ringLength, areaHa: 0, rows: 0, cols: 0, cells: [] as GridCell[] };
  const fail = (detail: string, extra: Partial<AnalysisValidation> = {}): AnalysisValidation => ({
    ...base,
    ...extra,
    ok: false,
    detail,
  });

  if (ringLength < 3) return fail(`ring has ${ringLength} point(s), at least 3 are required`);

  const areaHa = ringAreaHa(ring);
  if (!Number.isFinite(areaHa) || areaHa <= 0) return fail(`areaHa=${areaHa} from geometry is not a positive number`, { areaHa: 0 });

  const bbox = bboxOf(ring);
  if (!bbox) return fail("ring has no usable bounding box", { areaHa });

  const midLat = (bbox.north + bbox.south) / 2;
  const widthM = (bbox.east - bbox.west) * 111_320 * Math.cos((midLat * Math.PI) / 180);
  const heightM = (bbox.north - bbox.south) * 110_574;
  const auto = gridForArea(areaHa, widthM, heightM);
  const rows = clamp(Math.round(override?.rows ?? auto.rows), MIN_GRID_SIDE, MAX_GRID_SIDE);
  const cols = clamp(Math.round(override?.cols ?? auto.cols), MIN_GRID_SIDE, MAX_GRID_SIDE);

  const cells = gridCells(ring, rows, cols);
  if (cells.length === 0) {
    return fail(
      `gridCells produced 0 cells for rows=${rows} cols=${cols} (areaHa=${areaHa.toFixed(3)}, ` +
        `every clipped cell is under ${MIN_CELL_HA} ha or outside the polygon)`,
      { areaHa, rows, cols },
    );
  }
  return { ok: true, detail: null, ringLength, areaHa, rows, cols, cells };
}
