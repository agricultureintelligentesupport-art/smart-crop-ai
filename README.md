# محصولي الذكي · Smart Crop AI

Mobile-first, bilingual (Arabic RTL default · French LTR) precision-agriculture
app for Algeria: **Next.js (App Router) + React 19 + Tailwind CSS v4 + Framer
Motion + Lucide React**.

```bash
npm install
npm run dev   # http://localhost:3000
```

## Routes

| Route | What it is |
| --- | --- |
| `/` | 3-slide pre-auth onboarding carousel (swipe, dots, skip) |
| `/auth` | Full authentication workflow, sign-in tab |
| `/login` | Same workflow, sign-in tab (explicit entry point) |
| `/register` | Same workflow, create-account tab |
| `/dashboard` | Member dashboard (app shell: top bar + bottom tab bar) — requires an authenticated session |
| `/guest` | Removed — forwards to `/auth` (guest mode is gone) |

> `#account` opens the dashboard's account sheet directly (the "حسابي" tab
deep-links to it from `/assistant`).

API routes (JSON): `/api/assistant` (the resilient AI diagnosis chain),
`/api/daily-tasks` (daily AI task generation + published-day lookup for the
hero checklist) and the scheduled pair `/api/cron/daily-snapshot` (23:55
context snapshot) → `/api/cron/daily-tasks` (00:00 AI generation + publish) —
see [`docs/daily-tasks.md`](docs/daily-tasks.md).

Every route is interactive end to end. There are no "coming soon" screens:
every CTA leads to a working destination, and every dashboard feature requires
an authenticated account (Google, Algerian phone OTP, or e-mail) — or the
subtle "المتابعة كزائر" / "Continue as Guest" bypass on the auth wizard, which
claims a local guest flag (`smart-crop.guest.v1`) for rapid testing without
touching Firebase. An unauthenticated visitor without the guest flag is always
routed to the auth wizard.

## The auth workflow

```
Step 1 · method     Google · Algerian phone (+213) with SMS OTP · e-mail + password
                    ↳ tab toggle: sign in / create account, show-hide password,
                      live password-strength meter, forgot-password
Step 2 · role       Farmer · Agronomist · Investor (radio cards, perks expand)
Step 3 · wilaya     Searchable list of all 58 wilayas + climate preview
        ↓
   success panel → /dashboard
```

- **State machine**: `src/components/auth/useAuthFlow.ts` owns validation, step
  navigation, OTP countdowns and error mapping. The four Firebase-facing
  handlers are named for what they will do:
  `handleGoogleAuth`, `handleSendOTP`, `handleVerifyOTP`, `handleEmailAuth`.
- **Gateway**: all identity work goes through the `AuthGateway` interface
  (`src/lib/auth/types.ts`), implemented today by an on-device demo gateway
  (`src/lib/auth/gateway.ts`) so every button really works before the backend
  exists. The demo SMS code is `123456` and is shown in the UI while
  `gateway.isDemo` is true.
- **Firebase**: drop-in adapter + step-by-step wiring in
  [`docs/firebase-adapter.md`](docs/firebase-adapter.md).
  `NEXT_PUBLIC_AUTH_BACKEND` is the only behavioural switch: `firebase` (real
  Auth), `auto` (Firebase when the config is complete, demo otherwise) or
  `demo` — the default when the variable is unset.
- **Firebase environment**: every `NEXT_PUBLIC_FIREBASE_*` variable is read
  once, statically, in `src/lib/firebase-env.ts` (the only place `process.env`
  is touched), so Next.js can inline it into both the server and the browser
  bundle. See [`.env.example`](.env.example). Missing variables fall back to
  the documented project **and are reported** — never silently ignored.
- **Auth failure reporting**: `signInWithPopup`, `signInWithRedirect` and
  `getRedirectResult` are wrapped end to end. Any rejection renders the raw
  `error.code` + `error.message` under the Google button, together with a
  localized sentence, an actionable hint and a diagnostics table (backend,
  project, authDomain, origin, authorized-domain check, iframe warning,
  `browserLocalPersistence` state) — plus a "copy details" button.
- **Session persistence**: `setPersistence(auth, browserLocalPersistence)` is
  awaited *before* every popup/redirect (`ensureAuthPersistence()` in
  `src/lib/firebase.ts`), so a redirect return is not lost on the way back.
- **Persistence (device)**: `src/lib/auth/profile.ts` keeps the session
  on-device (`localStorage`, mirroring `users/{uid}`), plus device preferences
  (role + wilaya) that survive signing out, so a returning farmer skips the
  setup steps.

## The dashboard

One component (`DashboardView`), rendered at `/dashboard` for authenticated
members only. The signed-in screens run on a native app shell — translucent
top bar, a single scroll region, a bottom tab bar and bottom sheets — styled
by the shared surfaces in `globals.css` ("App shell") over the
`components/app/` primitives. See
[`docs/redesign/README.md`](docs/redesign/README.md) for the design language
and before/after screenshots.

**Weather data**: the dashboard's temperature/humidity/wind/rain readings are
**live from [Open-Meteo](https://open-meteo.com)** (free, no API key, fetched
client-side per wilaya with a 1-hour per-wilaya cache). If the fetch fails,
the UI falls back to the deterministic, offline wilaya reference baseline in
`src/lib/agronomy.ts` and clearly labels which source is showing — no fake
"live" data, no hydration mismatch (the server always renders reference
values). Soil and crops remain wilaya baselines; the irrigation formulas
(`ET₀ × Kc × soil ÷ efficiency`) are unchanged — only their climate inputs
can now be live.

- **Weather + water need**: live hourly and 7-day views (fallback: reference
  series), ET₀, agronomic advice line.
- **Per-hectare breakdown** (`PerHectareFlowSheet`): the hero card's
  "لكل هكتار" pill opens a step-by-step diagram of the very chain
  `computeIrrigation` runs — climate inputs → ET₀ → Kc × soil factor →
  ÷ system efficiency → L/ha → parcel m³. Each factor is a real button: hovering
  or tapping it highlights the term it acts on and draws an animated connector,
  with its mathematical effect spelled out. The headline litres and m³ are read
  straight off the same `IrrigationResult` the card renders, so the explanation
  can never drift from the number it explains.
- **Field heatmap** (`FieldHeatmapCard`): the parcel split into a 4-column zone
  grid with three switchable layers (thermal stress, water requirement,
  transpiration index), tap/keyboard zone inspection with per-zone verdicts, and
  slow sensor-style shimmer. The moisture layer averages back **exactly** to the
  card's L/ha figure (the zone rounding preserves the total), and the whole
  pattern is a deterministic model estimate built from the day's own inputs —
  labelled as such, never presented as a satellite reading.
- **Irrigation calculator**: crop × area × soil × system → L/ha, m³/day, m³/week
  and water saved versus furrow (FAO-56 style: `ET₀ × Kc × soil ÷ efficiency`).
- **Leaf scan**: file picker / drag & drop / camera capture, local preview,
  progress, diagnosis with confidence, severity and numbered field steps.
- **Vegetation index**: NDVI reading, 8-week sparkline, stress share.
- **Daily AI tasks (hero checklist)**: the hero decision card's lower half is
  the interactive **"✨ مهام اليوم الذكية"** tray — it replaces the old static
  advice lines and the standalone tasks card. The whole hero is ONE container
  with two zones (metrics, then the tray) joined by a single hairline; no nested
  cards, no inner boxes. The tray ships **collapsed** (the first,
  highest-priority task stays on screen; the rest wait behind the integrated
  glass handle `عرض باقي المهام (n+) ⚡`), so the card stays a quick read on
  phones — tapping the handle springs the height open and flips it to
  `طي القائمة`. Each task row is borderless: animated check + strike-through,
  a quiet category tint (💧 سقي / 🛡️ وقاية / 🚜 تسميد/صيانة) and a High/Normal
  priority chip; the header row carries the live counter and a thin progress
  rail, the `🎉` badge celebrates a fully checked day, and the card footer
  carries the AI publish stamp (`✨ تم تحديث المهام بواسطة الذكاء الاصطناعي -
  اليوم 00:00`). Sets are generated daily by the 23:55 → 00:00 scheduled workflow
  (`/api/cron/daily-snapshot` + `/api/cron/daily-tasks`, AI with a never-empty
  rule-based fallback) and cached per `YYYY-MM-DD` in LocalStorage (and RTDB
  when configured); checked state survives collapses and refreshes for the day.
  See [`docs/daily-tasks.md`](docs/daily-tasks.md).

Values are labelled as decision-support estimates, not measurements.

## The leaf diagnosis orchestrator (Gemini analysis → MobileNetV2 fallback → text)

`/api/assistant` runs a photo through a strict, fail-proof priority chain. A
text-only question skips the image stage entirely and goes straight to the
text stages.

> **Current provider setup — Gemini-only.** `ENABLE_HUGGINGFACE = false`
> (`src/lib/assistant/providers.ts`) soft-blocks every Hugging Face stage: no
> token is read, no Hugging Face request is built, and Gemini handles the image
> analysis AND the text. The Hugging Face code is untouched — set
> `ENABLE_HUGGINGFACE=1` (or flip the constant) to restore the two stages marked
> "while enabled" below. The leaf **Detection & Cropping** pre-step is
> **removed**: every model receives the original frame and `preprocessing` is
> always `"skipped"`.

```
photo (base64)
  │
  ├─ (removed) Detection & Cropping — the DETR-ResNet-50 detector + sharp crop
  │    that used to run first is GONE. No detector round-trip, no crop, no
  │    re-encode: the original frame is what every stage sees, and
  │    `preprocessing` still rides along on image responses as `"skipped"`.
  │
  ├─ Step 1 · IMAGE ANALYSIS
  │    PRIMARY   — Google Gemini (gemini-3.8-flash → 3.5-flash →
  │      3.5-flash-lite on a retired-id 404, overridable with GEMINI_MODEL)
  │      inspects the photo and
  │      is pinned by `responseMimeType: "application/json"` + a
  │      `responseSchema` to answer with a structured AnalysisData object:
  │      { plant_type, disease_detected, disease_name, confidence,
  │        affected_parts, severity, symptoms_observed, notes }.
  │    FALLBACK  — MobileNetV2 PlantVillage
  │      (linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification,
  │      overridable with HF_VISION_MODEL) on the free Hugging Face router —
  │      only while ENABLE_HUGGINGFACE is on; with the flag off a failed Gemini
  │      analysis goes straight to Step 4. Its raw { label, score } is mapped
  │      into the SAME AnalysisData shape, so the text stage is
  │      source-agnostic.
  │    BOTH DOWN  — Step 4: no text model is ever called with empty data. The
  │      user gets a pre-written, polite "retry with a clearer photo" reply.
  │
  ├─ Step 2 · TEXT GENERATION (while ENABLE_HUGGINGFACE is on; BYPASSED in the
  │    shipped configuration, where Gemini is the primary text model) — the
  │    Hugging Face Inference Providers
  │    router (open Qwen chain led by Qwen/Qwen3-4B-Instruct-2507, Bearer
  │    HUGGINGFACE_API_KEY — ONE variable name, no HF_TOKEN alias) narrates
  │    the AnalysisData into a clear,
  │    user-facing explanation with a practical recommendation. Fails on a
  │    transport error/timeout, an empty or nonsensical reply, or a reply that
  │    does not correspond to the AnalysisData.
  │
  └─ Step 3 · TEXT GENERATION (Google Gemini — the PRIMARY text model) —
       reached after Step 2 failed, which with Hugging Face soft-blocked is
       every request. Same 5-id model chain. The key pool is drawn in a RANDOM
       order per request (`shuffleGeminiKeyPool`: a permutation without
       replacement — no key repeats inside one cycle, and consecutive requests
       do not all start on the same credential). Per model, every key is
       tried in that drawn order; a 429 parks that (key, model) pair for 10
       minutes, a 400 API_KEY_INVALID / 403 parks the key for 60 minutes, and a
       503/network error retries the same key once before rotating. One 8 s
       AbortController per attempt inside ONE 60 s
       deadline for the whole request; exceeding it answers HTTP 503
       { code: "DEADLINE_EXCEEDED" } with the Arabic
       "الخدمة مشغولة حالياً، حاول بعد قليل". It gets
       the AnalysisData and NO image, so it formats the data and never
       re-analyses the photo — including the edge case where the analysis came
       from MobileNetV2. If the text model is down, the built-in formatter
       answers 200 from the analysis (direct diagnosis card) or with a
       greeting-aware basic-mode reply for a text-only question.
```

### The Gemini model chain

Every Gemini model id in the repo comes from a single definition:
`src/lib/assistant/gemini-models.ts`. The route, the daily-task generator and
the `check:models` CLI all import it, so a fix applied in one place cannot be
missed in another.

| Role | Model id | Why |
| --- | --- | --- |
| Primary | `gemini-3.8-flash` | Current stable Flash with vision support |
| Fallback 1 | `gemini-3.5-flash` | Supported until at least 2027-05-19 |
| Fallback 2 | `gemini-3.5-flash-lite` | Supported until at least 2027-07-21 |
| Fallback 3 | `gemini-2.5-flash` | Last 2.5-generation seat; retiring 2026-10-20 |
| Fallback 4 | `gemini-flash-latest` | Google's rolling alias — survives the point releases that retire 3.x ids |

The mix is deliberate. Google designates the 3.6/3.7/3.8 Flash ids as
*short-availability* models that rotate, and the `latest` aliases move with
them, so a chain built only from those can 404 in full at once — which is
exactly how this orchestrator ended up answering every photo from MobileNetV2.
At least one long-lived id is always in the chain.

Ids excluded on purpose: `gemini-2.0-flash*` (shut down 2026-06-01) and
`gemini-3.6` — a bare `gemini-3.6` was never a real id; the real one is
`gemini-3.6-flash`. `gemini-2.5-flash` is IN the chain as fallback 3 (it still
serves existing keys until its 2026-10-20 shutdown) but Google refuses it to
NEW API keys — which is exactly why a model id is only used once the key's own
1-hour `GET /v1beta/models` catalog lists it. `test/unit/gemini-models.unit.test.ts`
fails if a retired id reappears (2.5-flash is asserted for its 2.5-era
`thinkingBudget` payload instead).

### The manual model selector (chat)

The composer carries a model pill; the picker offers three friendly names, and
the choice travels to the server as the stable catalog id in the request body:

| Picker label | Request `model` | Gemini id | Character |
| --- | --- | --- | --- |
| `phyto 3.8` | `phyto-3.8` | `gemini-3.8-flash` | **default** — balanced |
| `phyto 3.5` | `phyto-3.5` | `gemini-3.5-flash` | fast |
| `phyto 2.5` | `phyto-2.5` | `gemini-2.5-flash` | economy |

`POST /api/assistant` accepts the catalog id (`phyto-3.5`), the label
(`phyto 3.5`) or the raw Gemini id; anything else is **ignored** rather than
rejected, so a stale stored preference can never fail a request. The catalog
itself lives in `src/lib/assistant/model-choice.ts` and is imported by both the
picker and the route — the two cannot drift.

- **The pick is moved to the HEAD of the chain, not substituted for it.** The
  default id and every built-in fallback stay behind the selection, so choosing
  the cheapest model never costs the request its safety net; if the pick is
  retired, refused for this key, or missing from the key's 1-hour catalog, the
  next seat answers and the substitution is reported to the client in
  `warnings[]` (never silently).
- **`GEMINI_API_KEY_4` leads that request's key draw** (the other keys keep
  their random order) — the manually selected model is optimized to spend the
  predictable project first. Without a selection the pure random rotation is
  untouched: the pill always *shows* a model, but the browser sends the `model`
  field only once the user has actually chosen one, so a request from an
  untouched picker carries no choice and is treated exactly as before.
- The per-attempt window stays exactly **8 s** and the whole request stays
  inside the single **60 s** deadline (503 `DEADLINE_EXCEEDED`).
- The browser remembers the choice in `localStorage["phytoscan.model"]`,
  validated against the catalog on read.

### Verifying the chain

```bash
npm run check:models                 # human-readable
npm run check:models -- --json      # machine-readable, for CI
```

It calls `GET /v1beta/models` with your first `GEMINI_API_KEY*`, compares the
live catalog against the configured chain, and exits `0` when every id is
present, `1` when one is missing or the catalog could not be reached. The same
check runs automatically inside the server — once per process, on a 6-hour TTL —
and logs a single `[Gemini Health]` verdict. Ids it proves unavailable are then
dropped from the request chain, so a retired id costs no round-trip and never
reaches a photo as a silent MobileNetV2 downgrade.

```bash
[Gemini Health] ✅ chain gemini-3.8-flash → gemini-3.5-flash → gemini-3.5-flash-lite → gemini-2.5-flash → gemini-flash-latest — 5/5 configured model ids are live.
[Gemini Health] ❌ 1 of 5 configured model ids are NOT available: gemini-3.8-flash.
[Gemini Health]   set GEMINI_MODEL=gemini-3.7-flash (or update GEMINI_FALLBACK_MODELS in src/lib/assistant/gemini-models.ts).
```

Set `GEMINI_MODEL` to pin a different primary; the built-in fallbacks still
apply, so an override can never brick the stage. A `GEMINI_MODEL` override is
sent without `thinkingConfig`, since only the bundled ids are known to accept
`thinkingLevel`.

**What counts as a Gemini Step 1 failure** — and therefore triggers the
MobileNetV2 fallback: (a) an API/network error or timeout; (b) Gemini refusing
or returning no usable text; (c) a response that is not valid JSON, is not an
object, or is missing a required field.

**A low `confidence` is explicitly NOT a failure.** The orchestrator has no
confidence threshold: an unsure but well-formed Gemini verdict is legitimate
data and is passed straight through to the text stage, which simply hedges its
wording. MobileNetV2 is never consulted because a score was low.

Every response carries `analysisSource` (`"gemini"` | `"mobilenet"` | `null`)
and `textSource` (`"huggingface"` | `"gemini_fallback"` | `null`) for logging
and analytics; the user only ever sees the final `reply`. The same
information is logged server-side, with a final `[Orchestrator]` line
summarising the whole route. `textSource: "gemini_fallback"` keeps its name for
wire compatibility — with Hugging Face soft-blocked it is the PRIMARY text path.

**Gemini key pool — randomized rotation.** The configured pool is
`GEMINI_API_KEY` plus its numbered variants, plus the legacy comma-separated
`GEMINI_API_KEYS` pool (read last). Each request draws that pool in a
**random order** (`shuffleGeminiKeyPool()`: a permutation without replacement),
so no key is tried twice inside one cycle and consecutive requests spread across
projects instead of all starting on the same credential; `GEMINI_API_KEY_4` is
still worth setting because it usually belongs to a different Google project
(hence its own daily quota) and heads the inventory order shown in the logs and
by `/api/health/gemini`.

For the current model every key is tried; a 429 / `RESOURCE_EXHAUSTED` / daily
quota parks that **(key name, model)** pair for 10 minutes, a 400
`API_KEY_INVALID` or 403 parks the whole key for 60 minutes, and a 503 or
network error retries the same key once before moving on. Success is logged by
name only, e.g. `Gemini OK: GEMINI_API_KEY_4 / gemini-3.5-flash`.

Every upstream attempt is bounded by an 8 s `AbortController` inside ONE 60 s
request deadline. When the deadline fires the route stops and answers HTTP 503
`{ code: "DEADLINE_EXCEEDED" }` with the Arabic
"الخدمة مشغولة حالياً، حاول بعد قليل". Since the platform limit is also 60 s,
keep a little head-room (`maxDuration = 65` where the plan allows it) so the
503 — not a bare platform timeout — is what the user receives.

Two protected operational probes report the same credentials and rotation the
pipeline uses — by NAME, never by value (both spend one real 1-token request):

```bash
curl "https://<host>/api/health/hf?key=$HEALTH_SECRET"
# → { ok, status, latencyMs, tokenPresent, tokenPrefixOk }

curl "https://<host>/api/health/gemini?key=$HEALTH_SECRET"
# → [ { name, ok, status, latencyMs, quotaExhausted, firstInRotation, model }, … ]
```

They fail closed: without `HEALTH_SECRET` on the server they answer 503
`MISSING_HEALTH_SECRET`, and a missing/wrong `?key=` answers 401. Set
`HEALTH_SECRET` (e.g. `openssl rand -hex 32`) in Vercel → Project → Settings →
Environment Variables. The required server variables are `GEMINI_API_KEY`
(plus its numbered variants), `HUGGINGFACE_API_KEY` — optional while
`ENABLE_HUGGINGFACE=false` — and `HEALTH_SECRET`.

The CodeCraft gateway and its `CODECRAFT_*` environment variables are gone;
leftover values are ignored.

Design notes and Vercel sizing: [`docs/leaf-detection.md`](docs/leaf-detection.md)
(historical — it documents the REMOVED Detection & Cropping stage and doubles as
the restore plan), and [`docs/assistant-hardening-report.md`](docs/assistant-hardening-report.md)
for the provider hardening work.

Hugging Face soft-block: `ENABLE_HUGGINGFACE = false` in
`src/lib/assistant/providers.ts` is the shipped default (Gemini-only). Setting
`ENABLE_HUGGINGFACE=1` in the environment re-enables both Hugging Face stages
without a code change; `isHuggingFaceEnabled()` is the only thing that reads it.


## Structure

```
src/
├── app/
│   ├── layout.tsx              # Cairo (AR) + Plus Jakarta Sans (FR), viewport lock
│   ├── globals.css             # theme, glass + field primitives, focus ring, a11y fallbacks
│   ├── page.tsx                # onboarding carousel
│   ├── auth|login|register/page.tsx
│   ├── guest/page.tsx          # enter guest mode → /dashboard (local bypass)
│   └── dashboard/page.tsx      # member dashboard (session required)
├── components/
│   ├── AmbientBackdrop.tsx     # shared GPU-isolated gradient + glow layer
│   ├── app/                    # signed-in shell: AppBar, TabBar, Sheet, shell tokens
│   ├── onboarding/             # carousel, header, 3 animated SVG scenes
│   ├── auth/
│   │   ├── AuthFlow.tsx        # step router (method → role → wilaya → success)
│   │   ├── AuthShell.tsx       # gradient canvas, header, progress ladder, scroll contract
│   │   ├── StepLadder.tsx      # progress + backwards navigation
│   │   ├── MethodStep.tsx      # Google · phone+OTP · e-mail form
│   │   ├── OtpInput.tsx        # 6-digit field with SMS autofill + paste
│   │   ├── RoleStep.tsx        # farmer · agronomist · investor
│   │   ├── WilayaStep.tsx      # searchable 58-wilaya picker + climate preview
│   │   ├── SuccessStep.tsx     # recap → dashboard
│   │   ├── useAuthFlow.ts      # the state machine + SDK-ready handlers
│   │   └── ui.tsx              # buttons, fields, strength meter, notice, badges
│   └── dashboard/              # DashboardView shell, HeroCard, QuickAccessGrid, QuickActions,
│                               # AccountSheet, WeatherDetailModal + WeatherCard,
│                               # CalculatorDetailModal + IrrigationCard, ScanCard,
│                               # SatelliteCard, FieldTasksCard, FieldHeatmapCard,
│                               # PerHectareFlowSheet, IrrigationWindowSheet, WilayaSelect, parts
├── lib/
│   ├── content.ts              # onboarding copy (AR/FR)
│   ├── wilayas.ts              # 58 wilayas + coords + climate/soil/crop baselines, fuzzy search
│   ├── agronomy.ts             # reference weather, ET₀, irrigation, NDVI, demo diagnosis
│   └── weather/                # live Open-Meteo layer: fetch + cache + useLiveWeather hook
│   ├── use-lang.ts             # persisted AR/FR state, keeps <html lang/dir> in sync
│   ├── auth/                   # types, gateway, validation, profile, copy
│   ├── dashboard/copy.ts       # dashboard copy (AR/FR)
│   ├── dashboard/format.ts     # Latin/numeric display formatting + `{token}` templates
│   ├── dashboard/widgets.ts    # widget figures + the one advisory cascade (pure)
│   ├── dashboard/flow.ts       # per-hectare chain exposed for the flow diagram
│   └── dashboard/heatmap.ts    # deterministic zone model behind the heatmap
├── docs/firebase-adapter.md    # how to bind Firebase Auth
└── e2e/                        # Playwright suites
```

## Tests

```bash
npx playwright install chromium   # one-time browser download
npm run test:e2e                  # boots `next dev` automatically
```

Two projects (Pixel 7 + Desktop Chrome, 148 tests) covering:

- **Onboarding** (`e2e/onboarding.spec.ts`): zero page scroll at 320/412 widths,
  48px+ targets, RTL mirroring, swipe semantics, dot jumps, AR⇄FR switching,
  CTA routing, no console errors.
- **Hero flow + field heatmap** (`e2e/field-heatmap-flow.spec.ts`): the unit
  pill opens/closes the flow (aria-expanded), the five steps print the card's own
  figures, tapping a factor highlights its term and explains its effect, the
  heatmap switches all three layers, zones inspect by tap and by arrow keys.
- **Auth + dashboard** (`e2e/auth-flow.spec.ts`): field-level validation,
  password toggle + strength meter, phone validation, wrong/expired OTP, resend
  rate limit, changing the number, role requirement, wilaya search in Arabic and
  French (accent-insensitive), the dashboard session guard, the quick-access
  widgets → detail sheets, irrigation reactivity, leaf scan, personalisation
  persistence, and a full register → setup → dashboard walk.
- **Quick-access widgets** (`e2e/quick-access-widgets.spec.ts`): the grid sits
  directly under the decision card and reprints its own figures, the weather
  widget opens the complete forecast sheet (hourly strip, 7 days, environmental
  badges, advisory), calculator edits reach the widget and the hero live and
  survive reopen, both sheets dismiss by dragging the handle, layouts hold at
  320/360/412 px without horizontal overflow and with 44px+ targets, and both
  stay fully operable under `prefers-reduced-motion`.

Set `PW_CHROMIUM_PATH=/path/to/chromium` to reuse an already-installed browser
instead of downloading one (handy in sandboxes and slim CI images).

## Behaviour notes

- **Viewport lock**: `100dvh` via `.screen-h`, `overflow-hidden` on
  `html/body`, `overscroll-behavior: none`. Each screen owns exactly one scroll
  container, so the header and step ladder stay pinned on 320px phones with the
  keyboard open.
- **Signed-in shell**: fixed translucent top bar (`.app-bar`, elevates on
  scroll via `useScroll` on the screen's own scroll container) + bottom tab bar
  (`.app-tabbar`, safe-area padded, floating pill from `sm` up). Content clears
  both with the `.scroll-pad-top` / `.scroll-pad-bottom` contracts, and
  contextual tasks open in the shared bottom sheet
  (`components/app/Sheet.tsx`, focus-trapped + drag-to-dismiss).
- **Quick-access widgets**: a 2-column grid sits directly under the hero
  decision card. Each widget is a real `<button>` (`aria-haspopup="dialog"` +
  `aria-expanded`) that opens the *complete* weather / irrigation view in the
  shared sheet — nothing is recomputed for the compact form, the figures are
  read from the same `WeatherSnapshot` / `IrrigationResult` the card renders
  (`lib/dashboard/widgets.ts`), so a widget can never advertise a number the
  card contradicts. Parcel inputs (crop, area, soil, system) live in one lifted
  state, so an edit inside the calculator sheet updates the widget and the card
  in the same frame and survives reopening.
- **RTL/LTR**: AR⇄FR flips `dir` on the screen and on `<html>`. Physical values
  (carousel swipe vectors, enter/exit offsets, phone-country ordering, SVG HUD
  labels) are pinned LTR where the content is Latin/numeric.
- **Motion**: one spring language (`SPRING`/`EASE_OUT` in `components/auth/ui.tsx`),
  GPU-isolated panels (`transform-gpu` + `will-change-transform`) and `my-auto`
  centring that never clips a tall step. `prefers-reduced-motion` is honoured
  globally in `globals.css`.
- **Accessibility**: WCAG AA contrast on the emerald palette, visible focus
  rings, full keyboard operability (roving tabindex on the channel tabs, arrow
  keys on role cards and the parcel slider, direction-agnostic range keys),
  labelled inputs, `role="alert"` errors, `aria-live` notices, and opaque
  fallbacks for glass under `prefers-reduced-transparency` / `prefers-contrast`
  / missing `backdrop-filter`.
- **Fonts**: Cairo + Plus Jakarta Sans via `next/font`. `next build` needs
  network access to fetch them; `next dev` falls back to system fonts offline.
