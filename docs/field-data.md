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
| [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/) openEO | Sentinel-2 L2A NDVI, cloud-masked, mean per grid cell | Yes — a CDSE client id/secret, server-side only. |

## Setup

1. Create a free account at
   <https://identity.dataspace.copernicus.eu/auth/realms/CDSE/account>.
2. Add a **CDSE Explorer** client (confidential → service credentials) and
   record the client id and secret.
3. Put them in `.env.local` (git-ignored):

   ```
   CDSE_CLIENT_ID=…
   CDSE_CLIENT_SECRET=…
   ```

   `.env.example` documents every variable, including the optional token and
   openEO endpoint overrides.

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
2. The 4×4 grid is cut from the parcel's bounding box
   (`gridCells`), one openEO `aggregate_spatial` call per cell.
3. `src/app/api/field-data/route.ts` fetches POWER and openEO **concurrently**
   (`src/lib/field-data/observation.ts`) and returns either an observation or a
   typed reason — never a fabricated number.
4. `src/lib/field-data/useFieldData.ts` holds the result, and
   `FieldHeatmapCard` renders it or explains its absence.

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
against live data (20 tests), openEO graph and response parsing (15), layer
mapping (16), boundary validation, and the draw → finish → measured area →
save → "no data" flow in a real browser. 396 unit tests, 0 lint errors, clean
production build.

**Not verified:** a live end-to-end run against Copernicus. This sandbox has no
outbound TLS to CDSE, so no claim is made that a real Sentinel-2 job has
completed. The 8 pre-existing `auth-flow` / `onboarding` e2e failures reproduce
identically on the base commit and are unrelated.
