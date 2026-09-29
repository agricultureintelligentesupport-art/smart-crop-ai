# Diagnosis — no analysis after saving a plot (NDVI / soil / weather)

**Status: DIAGNOSIS ONLY. No source file was modified.** (`git status --porcelain` → empty.)

Scope of the question: draw a boundary → save → `POST /api/field-data` →
openEO/POWER → `FieldHeatmapCard`. Where does it stop, and why does the UI show
nothing?

---

## 0. What was actually executed to produce this report

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | 480 packages, exit 0 |
| Unit suite (baseline) | `npm run test:unit` | **413 pass / 0 fail** |
| Lint (baseline) | `npm run lint` | 0 errors, 1 pre-existing warning (`AssistantView.tsx:331 'onChip' unused`) |
| `ringFlat` round trip | `node --import ./test/unit/register.mjs --test test/unit/plots-storage.unit.test.ts` | **4/4 pass** ("the encoding round-trips the Plot shape — including [lon, lat] order") |
| Live route, no CDSE env | `curl -X POST localhost:3000/api/field-data` (1.6 ha ring near Algiers) | `200` `{"ok":false,"reason":"notConfigured","observation":null}` in 1618 ms |
| Real `POST` handler, CDSE env **set** | in-process import of `src/app/api/field-data/route.ts` | `200` `{"ok":false,"reason":"network"}` |
| Real `POST` handler, 0.005 ha ring | same | `200` `{"ok":false,"reason":"tooSmall","message":"the boundary encloses 0.005 ha, under the 0.05 ha minimum"}` |
| Real `POST` handler, ring missing / 2 points | same | `400` `{"ok":false,"reason":"malformed"}` |
| Real `POST` handler, POWER mocked valid, CDSE unset | same | 2 outbound POWER calls issued, then `200` `{"ok":false,"reason":"notConfigured","observation":null}` |
| Dev server boots | `next dev -H 0.0.0.0 -p 3000` | `GET /guest → 200`, `GET /dashboard → 200` |

**Not verified (blocked in this sandbox).** Every host except `registry.npmjs.org`
returns HTTP `000` in <60 ms: `power.larc.nasa.gov`,
`openeo.dataspace.copernicus.eu`, `firestore.googleapis.com`,
`api.open-meteo.com` all unreachable. `npx playwright install chromium` also
fails (`Failed to download Chrome for Testing 153.0.8010.12`), and no jsdom is
installed. Consequences, stated plainly:

- No live end-to-end run against CDSE/POWER is possible here. The two upstreams
  were exercised with a mocked `fetch` through the **real** `POST` handler.
- The **browser half** of the flow (does `useFieldData` really fire the fetch
  after a save?) is verified by code trace only, not by execution.

---

## 1. The traced flow, hop by hop

| # | Hop | File:line | Verdict |
| --- | --- | --- | --- |
| 1 | Draw → finish → `onDraftChange` | `src/components/map/FieldMapCanvas.tsx` → `FieldMapSheet.tsx:238` | OK |
| 2 | `handleSave` → `onSave(name, draft)` | `FieldMapSheet.tsx:200-212` | OK — gated on `validatePlot(draft).ok` |
| 3 | `onSave` is `fieldData.addPlot` | `DashboardView.tsx:366` | OK — wired |
| 4 | `addPlot` → `savePlot` → local + Firestore, then `setChosenId` + `responseCache.delete` + `setNonce(n+1)` | `useFieldData.ts:226-241` | OK |
| 5 | Effect keyed `[activePlot, areaHa, nonce]` → `requestObservation` → `fetch("/api/field-data")` | `useFieldData.ts:190-197`, `:70-125` | OK — the fetch **is** issued after a save |
| 6 | `POST` parse + geometry re-validation | `route.ts:121-152` | OK — verified live (`malformed` / `tooSmall` / `network` all reachable) |
| 7 | `buildObservation` → POWER ‖ openEO | `observation.ts:139-168` | **STOPS HERE** |
| 8 | `isConfigured(config)` → `fetchNdvi` | `observation.ts:161`, `openeo.ts:78` | **false without `CDSE_CLIENT_ID`+`CDSE_CLIENT_SECRET`** → `ndvi` resolves to `null`, no request is ever attempted |
| 9 | `if (!ndvi) return { ...empty, reason: "notConfigured" }` | **`observation.ts:170`** | **← the flow dies here.** The already-fetched POWER `climate` on line 168 is discarded. |
| 10 | Response | `route.ts:202-206` | `200 {"ok":false,"reason":"notConfigured","observation":null}` — measured live |
| 11 | Client maps it | `useFieldData.ts:103` | `observation: null`, `reason: "notConfigured"`, `state: "error"` |
| 12 | `FieldHeatmapCard` | `FieldHeatmapCard.tsx:595-601` | Amber reason line **does** render — but see §4 for why it reads as "nothing" |

### Root cause, ranked

**RC1 (primary, deployment).** `CDSE_CLIENT_ID` and `CDSE_CLIENT_SECRET` are not
set. Both are blank in `.env.example:220-221`, nothing in the repo supplies
them, and `README.md` has no Vercel checklist for them. `isConfigured()`
(`openeo.ts:78`) therefore returns false, `fetchNdvi` is never called, and the
route answers `notConfigured`. **No NDVI heatmap can exist in this state — this
is not a bug, it is the documented no-credentials behaviour**
(`docs/field-data.md`: "Without credentials the app still works… it just reports
that no data is available yet").

**RC2 (primary, code).** The whole observation is gated on NDVI, so the
keyless weather/soil data is thrown away with it. `observation.ts:168` awaits
POWER and openEO in parallel; `observation.ts:170` returns `notConfigured` and
discards the `climate` value that POWER already produced. Proven by execution:
with a mocked-but-valid POWER response and no CDSE creds, the real handler
issued both POWER requests and still answered
`{"ok":false,"reason":"notConfigured","observation":null}`. So even after RC1 is
fixed, a CDSE outage silently removes the weather/climate panel too.

**RC3 (UI).** There is no "analyzing…" state and no retry control.
`useFieldData` computes `state` (`useFieldData.ts:205`) and exposes `refresh`
(`:249`), but **neither is consumed anywhere**: `grep -rn '\.state\b|refresh('
src/components/ src/app/` returns nothing. During the up-to-45 s fetch
(`OBSERVATION_TIMEOUT_MS`, `useFieldData.ts:68`) `reason` is `null`
(`:203`), so `observationReason` is `null` (`DashboardView.tsx:342`) and the
card renders only the "model estimate" banner (`FieldHeatmapCard.tsx:272`).
The one real error message is a 10.5 px amber line at the very bottom of a very
long card (`:595`), below the average row — below the fold on a phone.

**RC4 (observability).** Zero server logging. `grep -n 'console\.|logAuth'
src/app/api/field-data/route.ts src/lib/field-data/observation.ts
src/lib/satellite/openeo.ts src/lib/weather/power.ts` → **0 matches**. Vercel
logs show only Next's own `POST /api/field-data 200 in 1618ms`, which is
indistinguishable between "not configured", "bad credentials", "quota gone" and
"cloud cover". The typed reason exists end-to-end and is then dropped on the
floor at the server boundary.

---

## 2. Is the plot actually saved?

**`ringFlat` encoding: correct and tested.** Firestore rejects nested arrays, so
`toFirestoreDoc` flattens to `[lon, lat, lon, lat, …]` (`plots.ts:168-171`) and
`fromFirestoreDoc` rebuilds pairs (`:174-190`).
`test/unit/plots-storage.unit.test.ts` → 4/4 pass, including
"the encoding round-trips the Plot shape — including [lon, lat] order" and
"the Firestore document carries no nested arrays". This hop is **not** the
problem.

**Firestore rules: cannot be verified from this repository.**
`git ls-files | grep -i 'rules\|firebase\|firestore'` returns only source and
docs files — there is **no `firestore.rules` and no `firebase.json` in the
repo**. The rules live only in the Firebase console for project
`agriculture-intelligente-7873e` (the hard-coded fallback in
`firebase-env.ts:54-62`). Two concrete consequences:

1. **Plot writes** target `users/{uid}/plots/{plotId}` (`plots.ts:292`). Whether
   that is allowed depends on console rules I cannot read.
2. **The server-side daily cache uses the *browser* client SDK
   unauthenticated.** `route.ts` imports `db` from `@/lib/firebase` — the client
   SDK, not the Admin SDK (the route's own header comment admits this: "The app
   does not run the Firebase Admin SDK"). So `fieldDataCache/{sha256}` is read
   and written with **no auth token**. If the console rules require
   `request.auth != null`, every cache access from the server throws
   `permission-denied`, and both are swallowed silently:
   `readCache` `catch { return null }` (`route.ts:97`), `writeCache`
   `catch { /* … */ }` (`route.ts:112`). Symptom: the once-a-day cache never
   works, so **every dashboard load re-runs a CDSE job** and burns the free
   monthly quota until it starts returning `quota`. That must be checked in the
   console; it cannot be checked here.

**A failed remote save still reports success.** `savePlot` catches the Firestore
error, calls `logAuthError` (browser `console.error`, `[auth]` prefix), and then
falls through to `return { ok: true, plot }` (`plots.ts:292-300`). The farmer
sees the plot on screen (localStorage copy) and gets no indication that the
account write was refused. Same pattern in `deletePlot` and `renamePlot`.

**Client → `/api/field-data` after save: wired, verified by trace.**
`addPlot` bumps `nonce` and clears `responseCache` (`useFieldData.ts:235-237`);
the effect depends on `nonce` (`:192`) and calls `requestObservation`
(`:187-190`) → `fetch("/api/field-data")` (`:81`). As stated in §0, no browser
exists in this sandbox, so this hop is a code trace, not an executed test.

**Two smaller defects found on the way** (not the cause of "nothing appears"):

- The client sends `areaHa` but the server never reads it: `RequestBody`
  (`route.ts:117-124`) has no `areaHa` field and `parseBody` (`:126-138`) does
  not look at `body.areaHa`.
- Grid size is computed from the dashboard's nominal `areaHa` (default `2`,
  `DashboardView.tsx:74`), not the drawn plot's measured area:
  `useFieldData.ts:186` passes the hook argument into `heatmapGrid(areaHa)`
  (`heatmap.ts:107-109`, `rows = clamp(round(areaHa*2), 3, 6)`, `cols = 4`).
  `plot.areaHa` is available and unused, so a 20 ha parcel is still cut into a
  4×4 grid.

---

## 3. Environment variables for this flow

Read from `.env.example` and cross-checked against the code
(`openeo.ts:67-72`, `route.ts`, `firebase-env.ts:23-31`, `power.ts:53-54`).

| Variable | Needed for | In `.env.example` | Must be set on Vercel Preview? |
| --- | --- | --- | --- |
| **`CDSE_CLIENT_ID`** | openEO token → Sentinel-2 NDVI | yes, **blank** (`:220`) | **YES — blocking.** Without it the route can only answer `notConfigured` |
| **`CDSE_CLIENT_SECRET`** | same | yes, **blank** (`:221`) | **YES — blocking.** `isConfigured` requires *both* (`openeo.ts:78`) |
| `CDSE_TOKEN_URL` | CDSE OIDC endpoint override | yes (`:223`) | No — defaults to the CDSE realm |
| `CDSE_OPENEO_URL` | openEO endpoint override | yes (`:224`) | No — defaults to `openeo.dataspace.copernicus.eu/openeo/1.2` |
| `CDSE_COLLECTION` | collection id | **NO — undocumented** | No — defaults to `SENTINEL2_L2A` (`openeo.ts:39`) |
| `CDSE_TIMEOUT_MS` | openEO deadline | **NO — undocumented** | No — defaults to `45000` (`openeo.ts:72`) |
| `NEXT_PUBLIC_AUTH_BACKEND` | firebase / demo / auto | yes (`:17`) | Recommended: `firebase` |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firestore plot save | yes (`:19`) | Recommended — falls back to the hard-coded project otherwise |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | same | yes (`:20`) | Recommended |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | same | yes (`:21`) | Recommended |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | same | yes (`:24`) | Recommended (required field, `firebase-env.ts:87`) |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | same | yes (`:22`) | Optional (not required) |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | same | yes (`:23`) | Optional |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | same | yes (`:25`) | Optional |
| — | **NASA POWER** (weather / soil wetness / ET₀) | n/a | **Nothing to set.** Base URL is a constant, `power.ts:53-54`; no key, no quota |

Two notes:

- `CDSE_*` must **never** carry a `NEXT_PUBLIC_` prefix — they are read
  server-side only (`openeo.ts:67-68`), and prefixing them would inline the
  secret into the browser bundle.
- On Vercel, add them to the **Preview** environment explicitly. Project →
  Environment Variables tickboxes are per-environment; a var set only for
  Production is absent from a Preview deployment, which is exactly the
  `notConfigured` signature.
- Also worth checking in Firebase Console → Authentication → Authorized
  domains: the Vercel Preview origin. That is not this flow's failure, but it
  gates the sign-in that produces the `uid` the plots are stored under.

---

## 4. Proposed fix (NOT applied — awaiting your go-ahead)

### 4a. UI: "analyzing…" / "failed: reason" + retry

Everything needed already exists; it is simply unconsumed. Three edits:

1. `DashboardView.tsx:333-345` — pass two more props:
   `observationState={fieldData.activePlot ? fieldData.state : "idle"}` and
   `onRetryObservation={fieldData.refresh}`.
2. `FieldHeatmapCard.tsx` — accept them and render, **at the top of the card
   body (not the bottom)**, one of:
   - `state === "loading"` → spinner + "جارٍ تحليل القطعة… / Analyse de la
     parcelle…" with `role="status" aria-live="polite"`;
   - `state === "error"` → the existing `t.fieldDataReason[reason]` text plus a
     `↻ إعادة المحاولة / Réessayer` button calling `onRetryObservation`
     (≥44 px, focus ring, `aria-label`);
   - `stale === true` → an explicit "reading from {date}, today's unavailable"
     chip, which the response already carries (`route.ts:191-200`) and the
     client already stores (`useFieldData.ts:104`) but never displays.
3. `lib/dashboard/copy.ts` — add the 3 new strings × (ar, fr) alongside the
   existing `fieldDataReason` block (`:509-522` / `:904-917`).

### 4b. Server logs with the reason

One small logger in `route.ts` and one line per exit, each naming the reason:

```
[field-data] uid=… plot=… cells=16 → notConfigured (CDSE_CLIENT_ID/CDSE_CLIENT_SECRET absent)
[field-data] uid=… plot=… cells=16 → auth (CDSE token rejected, HTTP 401)
[field-data] uid=… plot=… cells=16 → noScenes (20-day lookback, N masked cells / N)
[field-data] uid=… plot=… cells=16 → quota (HTTP 429)
[field-data] uid=… plot=… cells=16 → timeout after 45000 ms
[field-data] cache read denied/failed: permission-denied (falling back to a live fetch)
```

`openeo.ts` already distinguishes auth vs network vs timeout (`:125` — 401/403
→ `auth`, anything else → `network`; `:133` — abort → `timeout`) and
maps HTTP status → reason (`reasonForStatus`, `:357-363`); it just never prints
them. The `readCache`/`writeCache` bare `catch {}` blocks (`route.ts:97`, `:112`)
are where the silent-quota-burn symptom of §2 hides and should log too.

### 4c. Decouple POWER from NDVI (fixes RC2)

`observation.ts:170` should not discard a successfully fetched POWER day. Either
return a partial observation carrying `climate` with `ndvi` nulled per cell, or
expose `climate` on the failure result so the weather/climate panel survives a
CDSE outage. This is a behaviour change, so it is listed rather than done.

### 4d. Surface a refused account write

`savePlot` (`plots.ts:292-300`) should propagate the Firestore failure into
`SavePlotResult` (e.g. `savedLocallyOnly: true`) so the map sheet can say "saved
on this device only" instead of implying an account write happened.

---

## 5. One-line answer

The save works and the client does call `POST /api/field-data`; the request dies
at `src/lib/field-data/observation.ts:170` because `CDSE_CLIENT_ID` /
`CDSE_CLIENT_SECRET` are unset, and the same line throws away the NASA POWER day
that was fetched successfully in parallel. The UI then shows almost nothing
because `useFieldData`'s `state` and `refresh` are computed but never consumed,
and the server logs nothing at all.
