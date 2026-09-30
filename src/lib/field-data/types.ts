/**
 * Shared shapes for the real field-observation pipeline:
 *   a drawn plot (Firestore) → one cached daily observation → the heatmap.
 *
 * The observation is deliberately self-describing. Every number it carries
 * travels with the source that produced it (`ndvi.sceneDate`, `climate.source`,
 * `climate.et0Method`) so the UI can state exactly how old a number is and
 * where it came from, instead of implying a precision it does not have.
 */

/** A field boundary the farmer drew on the map, in GeoJSON `[lon, lat]` order. */
export interface Plot {
  id: string;
  uid: string;
  name: string;
  /** Unclosed ring, `[lon, lat]`. */
  ring: [number, number][];
  /** Area derived from `ring` with `ringAreaHa` — never user-typed. */
  areaHa: number;
  /** WGS84 centroid of `ring`. */
  centroid: [number, number];
  createdAt: string;
  updatedAt: string;
}

/** Why an observation is missing. Drives the "no data yet" copy. */
export type FieldDataReason =
  | "noPlot"
  | "notConfigured"
  | "auth"
  | "network"
  | "timeout"
  | "http"
  | "quota"
  | "noScenes"
  /** The PROVIDER answered with something unparsable. Never used for local checks. */
  | "malformed"
  /** A local pre-flight check failed before any request was made. */
  | "invalid-input"
  | "tooSmall";

/** Per-cell reading of a real Sentinel-2 scene, aligned with the heatmap grid. */
export interface CellObservation {
  /** Matches the heatmap zone id, `z-<row>-<col>`. */
  id: string;
  row: number;
  col: number;
  /** Mean NDVI, or `null` when the cell was fully masked (cloud/no data). */
  ndvi: number | null;
  /** Area of the clipped cell in hectares. */
  areaHa: number;
  /**
   * Approximate number of 10 m Sentinel-2 pixels averaged in this cell
   * (100 m² = 0.01 ha each). An area-derived estimate, not a count the
   * back-end reported — labelled as such in the UI.
   */
  pixels: number;
}

/**
 * Per-pixel NDVI of the plot, row-major, as the Process API sampled it over the
 * plot's bbox. This is what makes the plot-details layer look like the REAL
 * parcel shape instead of a grid of squares: every 10 m pixel the satellite
 * actually measured is painted where it is, and nothing else is.
 */
export interface NdviRaster {
  /** The bbox the pixel grid covers (the plot's own bbox), WGS84 degrees. */
  bbox: { west: number; south: number; east: number; north: number };
  width: number;
  height: number;
  /**
   * Ground sampling distance in metres. 10 m (one Sentinel-2 pixel) unless the
   * boundary is so large that a 10 m grid would exceed the transport budget —
   * the plot view states the real value, never an assumed 10 m.
   */
  resolutionM: number;
  /**
   * Row-major NDVI, `length = width × height`, rounded to 3 decimals (finer
   * than Sentinel-2's own reflectance quantisation). `null` wherever
   * `dataMask` is 0 — a masked pixel is a missing measurement, never an
   * interpolated or neighbouring value.
   */
  ndvi: (number | null)[];
  /**
   * Row-major 0/1, same length as `ndvi`. 1 = the satellite really measured
   * this pixel (inside the polygon, not cloud/shadow/cirrus/snow, valid
   * reflectances). The client renders 0 as fully transparent.
   */
  dataMask: number[];
}

/** The field-wide NASA POWER day, with its FAO-56 method recorded. */
export interface ClimateObservation {
  /** Always "nasa-power" — the only upstream behind these numbers. */
  source: "nasa-power";
  date: string;
  et0: number;
  et0Method: "penman-monteith" | "hargreaves";
  /** Hargreaves cross-check, shown so the choice of method is auditable. */
  et0Hargreaves: number | null;
  tempC: number | null;
  tempMaxC: number | null;
  tempMinC: number | null;
  humidityPct: number | null;
  windMs: number | null;
  rainMm: number | null;
  soilWetness: number | null;
  radiationMj: number | null;
  elevationM: number | null;
  /** POWER's own grid cell in degrees — the true spatial scale of the above. */
  gridDeg: { lat: number; lon: number } | null;
  /** The parcel centroid POWER was queried for. */
  latitude: number;
  longitude: number;
}

/** The complete, cacheable result for one plot on one day. */
export interface FieldObservation {
  plotId: string;
  /** "YYYY-MM-DD" (Africa/Algiers) — the cache key's date component. */
  date: string;
  /** Sentinel-2 scene the NDVI came from; may predate `date`. */
  sceneDate: string | null;
  /**
   * The grid the server cut the plot into (`cells` is row-major, `rows × cols`,
   * unmeasurable cells are present with `ndvi: null`). Optional: records cached
   * before the server chose the grid lack it.
   */
  rows?: number;
  cols?: number;
  cells: CellObservation[];
  /**
   * The per-pixel NDVI raster, present on records built by the raster path
   * (the default since the plot-details view paints real pixels). Optional and
   * additive: records cached before it existed — and the legacy grid path
   * behind `CDSE_USE_GRID=1` — only carry `cells`. `cells` is ALWAYS present:
   * on the raster path it is derived from the same raster, so the dashboard
   * heatmap keeps reading the exact same measurement it always did.
   */
  raster?: NdviRaster;
  /** `null` when NASA POWER was unreachable — the layers that need it go dark. */
  climate: ClimateObservation | null;
  /**
   * Cloud cover (%) of the Sentinel-2 tile the NDVI came from, as reported by
   * the Copernicus Catalog. Optional and additive: absent on older cached
   * records and on the openEO path, which does not report it.
   */
  cloudCoverPct?: number | null;
  /** True when some cells could not be measured (cloud, or a sliver cell). */
  partial: boolean;
  /** Wall-clock time this record was produced. */
  fetchedAt: string;
}

/** What the API hands to the client. */
export interface FieldDataResponse {
  ok: boolean;
  reason?: FieldDataReason;
  observation: FieldObservation | null;
  /** Set when `ok` is false, or when serving a cached-but-not-today record. */
  message?: string;
  /** True when the record is a cached one for an earlier day. */
  stale?: boolean;
  /**
   * Short technical reason for a failed satellite step, e.g.
   * `sh-process · sh.dataspace.copernicus.eu · HTTP 403 · ACCESS_DENIED`.
   * No secrets. Shown under the localised message in the error card.
   */
  technical?: string;
  /** Every upstream call of this request: host, status, code, message. */
  diagnostics?: import("@/lib/satellite/trace").StepLog[];
  /**
   * The NASA POWER day, returned even when the satellite step failed — the
   * two upstreams are independent, so a cloud/credential problem never throws
   * the weather away.
   */
  climate?: ClimateObservation | null;
}

/** Sentinel-2 L2A pixel area: 10 m × 10 m = 0.01 ha. */
export const SENTINEL_PIXEL_HA = 0.01;
