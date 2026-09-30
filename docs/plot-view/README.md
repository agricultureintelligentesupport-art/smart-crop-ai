# Stage 1 · Full-screen plot view

## Delivered

- Finishing a valid drawing with **تم** uses the existing `onSave → addPlot → savePlot` flow, then opens an opaque full-screen plot view. Failed validation/save stays on the drawing screen, with the draft and a retry action. Concurrent saves are guarded.
- Back returns to the still-mounted drawing map. Redraw starts its existing drawing handler and replaces the same active plot on the next save. Saved-plot chips also reopen the view. Delete asks for confirmation.
- No live map, controls, blurred map, or dim isolation layer inside the new screen. This base checkout did not contain `plotIsolate`.
- North-up SVG polygon, uniformly fitted using Web Mercator coordinates. Its proportions match the drawing map; its canvas-composited texture is clipped to the exact boundary. Small plots are enlarged instead of becoming tiny map features.
- Esri coverage metadata skips unavailable levels. Each tile starts at the resolution needed for the 1024px texture (up to z23) and walks to its genuine parent independently. `blankTile=false`, HTTP/decode checks, dimensions and conservative pixel validation reject gray/text/transparent placeholders. Parent source crops preserve geographic alignment, rather than repeating or stretching a whole parent tile into each child.
- Six concurrent workers, shared parent requests, 36 target tiles maximum, 100 total requests, 12-second overall budget. Up to eight ancestor levels. The texture publishes only when the complete mosaic succeeds. Otherwise the polygon retains its emerald gradient. Attribution is displayed for imagery.
- Inline name editing uses existing metadata-only `renamePlot`; area (ha and m²), spherical perimeter, WGS84 centroid, unique vertex count and original creation date derive from the saved geometry/record. Measurements are labelled approximate.
- Arabic RTL and French LTR copy. All plot-view buttons are at least 48px. Disabled **تحليل القطعة** explicitly says **قادم في الخطوة التالية**. No analysis action added.
- Fade/scale entry/exit, reduced-motion support, focus containment/restoration, inert background, labelled editing controls and delete confirmation, safe-area padding, independently scrollable information.

## Narrow persistence fix

The existing store saved locally before awaiting Firestore, but its write promise could remain pending indefinitely offline. That blocked the required post-save navigation, rename and deletion. These existing operations now cap the **remote acknowledgement** at four seconds without cancelling the queued SDK write. Local persistence remains the same. Rename prefers the current local record and writes name/timestamp metadata only.

`useFieldData` changes only the `addPlot` return type/value to return the persisted `Plot` alongside `ok`; observation requests, cache invalidation and satellite behaviour are unchanged. Dashboard components/cards, assistant, search, geocoder, satellite API/pipeline, `FieldMapCanvas.tsx`, and `map.css` were **not modified**.

The current `/api/geocode` only implements forward search, not reverse lookup. The optional commune/wilaya label was skipped, as allowed, rather than modifying search or inventing a location.

## Browser evidence · 2026-09-30

Tested the production build in actual Chromium with **390×844 mobile viewport, touch enabled, device scale 2**. Drawing uses real Leaflet pointer events; Done and plot actions use touch taps. Additional screenshots at **320×740** and **1280×900** verify responsive layout. This is browser mobile emulation, not a physical-device test.

- `npm run build`: passed.
- `npx tsc --noEmit`: passed.
- `npm run test:unit`: **420 passed** (including 7 new plot-view geometry/imagery tests).
- `npm run lint`: no errors; one existing unused `onChip` warning in untouched `AssistantView.tsx`.
- Mobile browser suites: **16 passed** across plot view (5), existing field map (4), and existing map search (7).
- Verified: save once, persisted rename with unchanged ID/ring/date, back and saved-plot reopen, redraw replacing the same ID, cancel/confirm deletion, deleted state after reload, 48px controls, hidden background map, focus trap, Escape/back, reduced motion, incomplete drawing not saved.
- Geometry cases: irregular **0.17 ha**, rectangular **0.17 ha** and **40.01 ha** in the browser; narrow/concave boundaries and exact 40 ha in pure geometry tests.
- Imagery cases: failed requests, HTTP-200 gray text placeholders, metadata reporting missing zooms, mixed child/parent coverage, malformed image bodies. Highest accepted zoom and fallback state are asserted, not just screenshot-tested.

### Important evidence limits

Live Esri TLS requests are blocked in this sandbox. Therefore live imagery quality/coverage has **not** been verified here. `fixture` screenshots use intentionally synthetic textured tiles intercepted **only in Playwright** to test compositing, correct parent cropping and SVG clipping. These are **not real satellite photographs**. Production code always requests Esri; no synthetic fixture is shipped to the app.

Firestore and the field observation upstream are also unavailable here. Browser verification establishes local-first persistence, not successful cloud acknowledgement; `/api/field-data` is stubbed for these UI tests. No claim of a completed satellite analysis is made.

## Screenshots

### Actual unavailable-imagery state, irregular 0.17 ha

| Full-screen plot | Scrolled details and persisted edited name |
| --- | --- |
| ![390px plot view, real fallback UI](01-mobile-fallback.png) | ![390px details and actions](02-mobile-details.png) |

### Deterministic imagery fixtures, not satellite photographs

| Small plot, 0.17 ha | Large plot, 40.01 ha |
| --- | --- |
| ![Small plot with synthetic test tiles](03-small-fixture-mobile.png) | ![Large plot with synthetic test tiles](03-large-fixture-mobile.png) |

- [320px small plot](04-small-fixture-320.png)
- [320px large plot](04-large-fixture-320.png)
- [Desktop small plot](05-small-fixture-desktop.png)
- [Desktop large plot](05-large-fixture-desktop.png)

## Files changed

Existing:
- `src/components/map/FieldMapSheet.tsx`: save/transition integration, back/redraw/reopen.
- `src/lib/field-data/useFieldData.ts`: return the saved plot record.
- `src/lib/field-data/plots.ts`: bounded remote acknowledgements and metadata rename.

New:
- `src/components/plot/PlotView.tsx`
- `src/components/plot/plot-view.css`
- `src/lib/plot/geometry.ts`
- `src/lib/plot/imagery.ts`
- `test/unit/plot-view.unit.test.ts`
- `e2e/plot-view.spec.ts`
- `docs/plot-view/README.md` and eight screenshots.

## Reproduce

Run a production server on port 3000, then:

```sh
npm ci
npm run build
npm run start -- --hostname 0.0.0.0
# In another terminal, after installing Playwright Chromium if needed:
npx playwright test e2e/plot-view.spec.ts e2e/field-map.spec.ts e2e/map-search.spec.ts --project='Mobile Chrome' --workers=1
```

The Playwright config also supports `PW_CHROMIUM_PATH` for a preinstalled browser. This sandbox used the installed `@sparticuz/chromium` binary plus its bundled AL2023 libraries (`LD_LIBRARY_PATH=/tmp/al2023/lib:/tmp`); no browser binaries or dependencies were added to Git.
