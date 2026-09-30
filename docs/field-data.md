# Real field data — Sentinel-2 NDVI over a drawn boundary

## What this is

The dashboard's field heatmap used to spread one modelled number around a
4×4 grid with a seeded ±12 % wobble. That was never a measurement. This
replaces it with two real upstreams and one hard rule:

> If a number was not measured, it is not shown.

The heatmap UI is untouched — same three Arabic tabs (`الإجهاد الحراري` /
`الاحتياج المائي` / `مؤشر النتج`), same 4×4 cells, same colour ramp, same
16 tappable zones. Only the data behind it changed.

| Upstream | Gives | Key required? |
| --- | --- | --- |
| [NASA POWER](https://power.larc.nasa.gov/) | Daily meteorology for the parcel centroid: Tmax, Tmin, RH, wind, solar radiation, rain — and the FAO-56 ET₀ computed from them | **No.** Public, no registration, no quota. |
| [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/) — Sentinel Hub Process API (`sh.dataspace.copernicus.eu`) | Sentinel-2 L2A NDVI, SCL cloud-masked, clipped to the polygon: one Process request kept as a **per-pixel raster at 10 m** (`observation.raster`: values + `dataMask` + bbox + width/height), with acquisition date and cloud cover. The heatmap's grid cells are derived from that same raster. | Yes — a CDSE client id/secret, server-side only. |

## Setup

1. Create a free account at
   <https://identity.dataspace.copernicus.eu/auth/realms/CDSE/account>.
2. Create an OAuth client (a Sentinel Hub dashboard client, id `sh-…`, works)
   and record the client id and secret.
3. Put them in `.env.local` (git-ignored):

   ```
   CDSE_CLIENT_ID=…
   CDSE_CLIENT_SECRET=…
   ```

   `.env.example` documents every variable, including the optional token,
   Process API and openEO overrides.

That is the whole setup. POWER needs nothing — its base URL is a constant
rather than an env var, so a mirror would be a reviewable code change instead
of a silent deployment toggle.

**Without credentials the app still works.** The map draws, plots save, the
heatmap renders — it just reports that no data is available yet, in the
farmer's language, and shows no numbers for the affected layers.

## How a boundary becomes numbers

1. The farmer draws a polygon on Esri World Imagery (`src/components/map/`),
   measured on a spherical earth (`src/lib/geo/polygon.ts`) and stored in
   Firestore with a localStorage copy so the map works offline.
2. The grid is cut from the parcel's bounding box and clipped to the polygon
   (`gridCells`). The plot's area is always recomputed server-side from its
   geometry; the client's `areaHa` is only compared and logged.
3. `src/app/api/field-data/route.ts` fetches POWER and Sentinel-2 **concurrently**
   (`src/lib/field-data/observation.ts`) and returns either an observation or a
   typed reason — never a fabricated number. The satellite step
   (`src/lib/satellite/sentinelhub.ts`) is: CDSE token → Catalog API (passes in
   the last 30 days, date + `eo:cloud_cover`) → Process API (S2 L2A, bbox +
   polygon, ~10 m, SCL mask + `dataMask` evalscript, FLOAT32 GeoTIFF). The
   answer is kept as **pixels**: `observation.raster` carries every measured
   NDVI value with its `dataMask` flag, the bbox and the raster size, so the
   plot-details view paints the layer in the parcel's real shape (10 m per
   pixel, values rounded to 3 decimals; a boundary so large it would exceed the
   transport budget is sampled a little coarser and says so via
   `raster.resolutionM`). The heatmap's `cells` are derived from that same
   raster, so both views read the identical measurement.
   **NASA POWER is independent**: when the satellite step fails the POWER day
   is still returned as `climate` on the failure response (and the plot view
   shows it).
   `CDSE_USE_GRID=1` keeps only the legacy rows/cols cell means (no
   per-pixel layer); `CDSE_USE_OPENEO=1` switches the satellite step back to
   the legacy openEO graph (`src/lib/satellite/openeo.ts`). Both are off by
   default — the raster is the primary path.

### Local validation and the grid

Before any request, `validateAnalysisInput` (`src/lib/field-data/grid.ts`)
derives `rows × cols` **on the server** from the plot's real geometry area
(cells ≈ 0.03–0.1 ha, each side clamped to 2..8; `rows`/`cols` sent by the
client are ignored) and cuts the cells. It logs
`[field-data] plot=… step=validate ok=… detail=… areaHa=… rows=… cols=… ring=… cells=…`.
A failure answers `reason: "invalid-input"` with the exact condition in
`technical`; `"malformed"` is reserved for an unparsable answer from the
provider. The observation carries `rows`/`cols` and is row-major with
unmeasurable cells present as `ndvi: null`, so the heatmap paints the grid the
satellite read.

### Diagnosing a failure

Every upstream call is logged as one line (host only, never a path or secret):

```
[field-data] step=cdse-token host=identity.dataspace.copernicus.eu status=200 ok=true ms=310
[field-data] step=sh-catalog host=sh.dataspace.copernicus.eu status=200 ok=true message="4 pass(es) in 2026-08-31..2026-09-30" ms=420
[field-data] step=sh-process host=sh.dataspace.copernicus.eu status=403 ok=false code=ACCESS_DENIED message="…" ms=180
```

Steps: `nasa-power`, `cdse-token`, `sh-catalog`, `sh-process`
(`openeo-result` / `openeo-poll` on the legacy path). The same records come back
as `diagnostics` in the JSON, with a short `technical` string that the error
card prints under the localised message.
4. `src/lib/field-data/useFieldData.ts` holds the result, and
   `FieldHeatmapCard` renders it or explains its absence.

### The plot-details layer (why the NDVI is no squares)

The plot view's «تحليل القطعة» button runs the same observation through a
second `useFieldData` instance targeted at the open plot — the module-level
cache and one in-flight promise per plot make a duplicate request impossible.
`src/lib/plot/ndvi-layers.ts` then turns `observation.raster` into the layer:

- **Clipping** — only pixels whose centre is inside the drawn boundary AND
  whose `dataMask` is 1 are ever painted, counted or probed
  (`measuredPixelMask`); everything else is fully transparent, so the
  satellite imagery underneath shows through and no masked pixel is ever
  filled with an estimate.
- **Smoothing** — `composeNdviLayer` upscales the raster with bilinear
  interpolation over *premultiplied* colours, display-only: it can soften an
  edge towards transparency, never pull a colour into a cloud hole. The layer
  is drawn on a canvas, clipped by the real polygon (`clipPath`), and
  positioned exactly over the plot's satellite image.
- **Colour** — the ramp spans the field's own real min/max (with a 0.02 floor
  so uniform noise is not stretched into drama); the legend quotes those real
  values, the scene date, the scene cloud cover and the caption
  «دقة القياس 10 م، والعرض منعَّم» (using the raster's true `resolutionM`).
- **Probe** — tapping the figure reports the nearest *measured* pixel and its
  coordinates, never an interpolated display colour; stats (mean/min/max) come
  from measured pixels only.

## The ET₀ decision (read this before "fixing" it)

NASA POWER serves meteorology but **not** ET₀ — the `ET0` parameter is
rejected, and it is the only accepted parameter whose value we compute
ourselves.

FAO-56 Penman–Monteith needs a real daily temperature range. MERRA-2 collapses
it: live Algiers readings span **1.58–1.85 °C**, which is physically absurd and
produces an ET₀ near zero. Using it as-is would be a confidently wrong number —
worse than showing nothing.

So the extremes come from POWER's own 2001–2020 climatology (Algiers September:
**33.25 / 19.34 °C**, a 13.91 °C range) and are reconstructed around the
observed daily mean. The result is ≈ **4.7 mm/day**, and `rangeSource` records
which path was taken:

- `"daily"` — the day's own extremes had a usable range;
- `"climatology"` — reconstructed from monthly climatology (the normal case);
- `"none"` — neither was usable, and no defensible ET₀ exists, so the
  temperature- and radiation-driven layers report themselves unavailable
  rather than showing a guess.

Hargreaves is kept only as a cross-check, never as the primary.

## Per-cell variation comes only from NDVI

`ndvi-driven`, as agreed: NASA POWER is a **single scalar for the whole
field**, so it cannot produce a spatial pattern. Every cell-to-cell difference
the heatmap shows is a real Sentinel-2 NDVI difference.

Two terms are kept separate, and the distinction matters:

- **`contrast`** — the cell's position *within the parcel's own* NDVI range.
  This is what makes one zone read drier than its neighbour.
- **`vigour`** — absolute canopy condition from the parcel's **mean measured**
  NDVI, mapped onto 0.20 (sparse/bare) … 0.65 (dense canopy).

Normalising only against the parcel's min/max made a uniformly weak field
(NDVI 0.2) render identically to a uniformly healthy one (NDVI 0.9). Thermal
stress and transpiration now use both terms, so absolute weakness and relative
variation are never conflated. The moisture layer stays relative on purpose:
its absolute level is already carried by the decision card's per-hectare figure,
and inventing one in the grid would mean showing a number nobody measured.

## Caching

`fieldDataCache/{sha256(uid + ring rounded to 5 decimals)}`, keyed by the
Africa/Algiers date. Opening the dashboard repeatedly costs **no** satellite or
weather calls. A failed refresh may serve a stale reading (flagged as such in
the UI); otherwise it returns typed no-data.

The cache isolates capabilities per uid — it is **not** an authorization
mechanism. A client-supplied `uid` needs a real auth check before production
use.

## Failure is a first-class state

Every failure has a reason, and the reason is translated. The card never falls
back to an estimate once a plot exists:

`notConfigured` · `auth` · `network` · `timeout` · `http` · `quota` ·
`noScenes` (no cloud-free pass in three weeks) · `malformed` · `tooSmall`

Network failures are distinguished from authentication failures on purpose: a
farmer with no signal should not be told to go and check their API keys.

A boundary that crosses itself is refused before it is stored. Leaflet.draw's
own wording for this is English and offers no way out, so the app checks the
ring itself (`isSimpleRing`), shows the reason in Arabic, and leaves the draw
tool usable.

## Verified, and not verified

**Verified:** geometry (16 tests, ≤0.52 % area error vs WGS84), POWER ET₀
against live data (20 tests), openEO graph and response parsing (15), Sentinel Hub
Process API request/GeoTIFF/diagnostics (18), layer
mapping (16), boundary validation, and the draw → finish → measured area →
save → "no data" flow in a real browser. 396 unit tests, 0 lint errors, clean
production build.

**Not verified:** a live end-to-end run against Copernicus. This sandbox has no
CDSE credentials, so no claim is made that a real Sentinel-2 request has
completed; the GeoTIFF reader is tested on synthetic files in the layouts
Sentinel Hub produces (strips/tiles, Deflate, float predictor). The 8 pre-existing `auth-flow` / `onboarding` e2e failures reproduce
identically on the base commit and are unrelated.

## Follow-ups (map-UX branch)

- **Plot persistence encoding.** Firestore rejects nested arrays, so the
  account-plot documents store `ring` as a flat `ringFlat: number[]`
  (`[lon, lat, lon, lat, …]`). The conversion happens only at the storage
  boundary (`src/lib/field-data/plots.ts`); `Plot`, the API contract and the
  satellite pipeline are unchanged. Legacy documents with pair arrays still
  decode.
- **Bounded I/O.** The route's Firestore round-trip is capped at 2 s per leg
  (4 s total, within `REMOTE_CEILING_MS = 4000`), and the client gives the
  observation fetch 45 s before aborting with `reason: "timeout"` — the saved
  polygon is never lost.
- **Assistant isolation** is enforced by `test/unit/map-assistant-isolation.unit.test.ts`
  and `e2e/assistant-regression.spec.ts` (no stubs on `/api/assistant`).
