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

## The leaf diagnosis pipeline (Detection & Cropping → MobileNetV2 classification)

`/api/assistant` processes an attached photo through a staged, fail-proof
vision pipeline before the LLM stages run:

```
photo (base64)
  │
  ├─ Step 0 · Detection & Cropping ── open-source object detector on the FREE
  │    Hugging Face Inference router (facebook/detr-resnet-50 COCO
  │    DETR-ResNet-50, plant labels only; chain overridable with
  │    HF_LEAF_DETECT_MODELS). The dominant detection cluster becomes a
  │    padded, clamped crop window and sharp crops the photo, so hands, soil
  │    and pots never reach the classifier.
  │    Every failure (no key, undecodable image, detector down/loading, no
  │    leaf, near-full-frame box) is non-fatal and falls back to the ORIGINAL
  │    frame — the outcome lands in `preprocessing` on the API response.
  │
  ├─ Step 1 · vision classification — PlantVillage classifier, MobileNetV2
  │    (linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification, the
  │    single clean default; overridable with HF_VISION_MODEL) on the free
  │    Hugging Face router; receives ONLY the Step 0 crop when detection
  │    succeeded, the full frame otherwise. STREAMLINED: the former CodeCraft
  │    vision engine (the OpenAI-compatible gateway at codecraftapi.com) was
  │    REMOVED from the chain — its WAF 403 stalls and the extra network
  │    round-trip only added latency, so every photo now goes DIRECTLY to
  │    MobileNetV2 with no intermediate vision call. A vision outage stays
  │    non-fatal: the degradation is logged in `warnings[]` and the request
  │    continues to the LLM stages.
  │
  └─ Stages 1–3 · Stage 1 = PRIMARY LLM — the Hugging Face Inference
     Providers router (open Qwen chain led by Qwen/Qwen3-4B-Instruct-2507,
     Bearer HUGGINGFACE_API_KEY / HF_TOKEN)
     → Stage 2 = FALLBACK LLM — Google Gemini (gemini-3.6-flash → 2.5-flash →
     2.0-flash-exp on a retired-id 404), reached ONLY when the primary HF
     stage failed, timed out or has no token. Gemini inspects the image itself
     (inlineData) with the reference diagnosis when Step 1 produced one
     (HYBRID path) and independently when it did not (Fallback A); when every
     LLM stage is down the built-in formatter answers from the Step 1
     findings (direct diagnosis card, Fallback B).
     Gemini key pool: GEMINI_API_KEY + GEMINI_API_KEYS + numbered
     GEMINI_API_KEY_N — rotated on 429 / RESOURCE_EXHAUSTED / quota.
```

Vision is therefore SINGLE-ENGINE: every photo is classified by the
known-good MobileNetV2 PlantVillage checkpoint and the diagnosis is handed to
the dual-tiered LLM chain — Hugging Face first (Qwen/Qwen3-4B-Instruct-2507),
Google Gemini as the seamless fallback. The CodeCraft gateway and its
`CODECRAFT_*` environment variables are gone; leftover values are ignored.

Design notes and Vercel sizing: [`docs/leaf-detection.md`](docs/leaf-detection.md).


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
