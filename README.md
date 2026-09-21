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
| `/dashboard` | Member dashboard — requires an authenticated session |
| `/guest` | Removed — forwards to `/auth` (guest mode is gone) |

Every route is interactive end to end. There are no "coming soon" screens:
every CTA leads to a working destination, and every dashboard feature requires
an authenticated account (Google, Algerian phone OTP, or e-mail). An
unauthenticated visitor is always routed to the auth wizard.

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
members only. Every number is derived from the wilaya baseline (temperature,
humidity, wind, rainfall, soil, crops) through `src/lib/agronomy.ts`, which is
deterministic and offline — no hydration mismatch, no fake "live" data.

- **Weather + water need**: hourly and 7-day views, ET₀, agronomic advice line.
- **Irrigation calculator**: crop × area × soil × system → L/ha, m³/day, m³/week
  and water saved versus furrow (FAO-56 style: `ET₀ × Kc × soil ÷ efficiency`).
- **Leaf scan**: file picker / drag & drop / camera capture, local preview,
  progress, diagnosis with confidence, severity and numbered field steps.
- **Vegetation index**: NDVI reading, 8-week sparkline, stress share.
- **Field tasks**: checklist derived from the same weather and irrigation
  numbers, with progress.

Values are labelled as decision-support estimates, not measurements.

## The leaf diagnosis pipeline (Gemini Vision primary → HF MobileNet fallback)

`/api/assistant` processes an attached photo through a staged, fail-proof
vision pipeline:

```
photo (base64)
  │
  ├─ Step 0 · Detection & Cropping (non-blocking) ── open-source object
  │    detector on the FREE Hugging Face Inference router (DETR-ResNet-50
  │    fine-tuned on PlantDoc → facebook/detr-resnet-50 COCO fallback, plant
  │    labels only; chain overridable with HF_LEAF_DETECT_MODELS). The
  │    dominant detection cluster becomes a padded, clamped crop window and
  │    sharp crops the photo, so hands, soil and pots never reach the vision
  │    stage. Every failure (no key, undecodable image, detector down/loading,
  │    no leaf, near-full-frame box) is non-fatal and passes the ORIGINAL
  │    frame straight to the primary vision step — the outcome lands in
  │    `preprocessing` on the API response.
  │
  ├─ Step 1a · PRIMARY — Gemini Vision direct diagnostician ── the (cropped)
  │    photo is passed RAW to the multimodal Gemini chain as an inline part
  │    with a direct-inspection instruction: identify the plant species and
  │    symptoms, name the most likely disease/gall/deficiency with a
  │    confidence %, list the alternatives, and answer with the structured
  │    Arabic diagnostic card. ONE round-trip does vision + reasoning
  │    end-to-end (source: "hybrid"; no other stage runs).
  │
  ├─ Step 1b · SECONDARY fallback (kept intact) ── if Gemini Vision is
  │    unconfigured, times out or errors, the request falls back seamlessly
  │    to the Hugging Face PlantVillage cascade on the same free router
  │    (field-trained ViT models → the MobileNetV2 baseline
  │    linkanjarad/mobilenet_v2_1.0_224-plant-disease-identification);
  │    it receives the Step 0 crop when detection succeeded, the full frame
  │    otherwise.
  │
  └─ Stages 1–3 · Gemini text → HF LLM chain → built-in formatter (the
       structured Step 1b diagnosis feeds these stages exactly as before).
```

Design notes and Vercel sizing: [`docs/leaf-detection.md`](docs/leaf-detection.md).


## Structure

```
src/
├── app/
│   ├── layout.tsx              # Cairo (AR) + Plus Jakarta Sans (FR), viewport lock
│   ├── globals.css             # theme, glass + field primitives, focus ring, a11y fallbacks
│   ├── page.tsx                # onboarding carousel
│   ├── auth|login|register/page.tsx
│   ├── guest/page.tsx          # redirect to /auth (guest mode removed)
│   └── dashboard/page.tsx      # member dashboard (session required)
├── components/
│   ├── AmbientBackdrop.tsx     # shared GPU-isolated gradient + glow layer
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
│   └── dashboard/              # WeatherCard, IrrigationCard, ScanCard, SatelliteCard,
│                               # FieldTasksCard, UpgradeCard, WilayaSelect, parts
├── lib/
│   ├── content.ts              # onboarding copy (AR/FR)
│   ├── wilayas.ts              # 58 wilayas + climate/soil/crop baselines, fuzzy search
│   ├── agronomy.ts             # weather, ET₀, irrigation, NDVI, demo diagnosis
│   ├── use-lang.ts             # persisted AR/FR state, keeps <html lang/dir> in sync
│   ├── auth/                   # types, gateway, validation, profile, copy
│   └── dashboard/copy.ts       # dashboard copy (AR/FR)
├── docs/firebase-adapter.md    # how to bind Firebase Auth
└── e2e/                        # Playwright suites
```

## Tests

```bash
npx playwright install chromium   # one-time browser download
npm run test:e2e                  # boots `next dev` automatically
```

Two projects (Pixel 7 + Desktop Chrome, 66 tests) covering:

- **Onboarding** (`e2e/onboarding.spec.ts`): zero page scroll at 320/412 widths,
  48px+ targets, RTL mirroring, swipe semantics, dot jumps, AR⇄FR switching,
  CTA routing, no console errors.
- **Auth + dashboard** (`e2e/auth-flow.spec.ts`): field-level validation,
  password toggle + strength meter, phone validation, wrong/expired OTP, resend
  rate limit, changing the number, role requirement, wilaya search in Arabic and
  French (accent-insensitive), the dashboard session guard, irrigation
  reactivity, leaf scan, personalisation persistence, and a full register →
  setup → dashboard walk.

Set `PW_CHROMIUM_PATH=/path/to/chromium` to reuse an already-installed browser
instead of downloading one (handy in sandboxes and slim CI images).

## Behaviour notes

- **Viewport lock**: `100dvh` via `.screen-h`, `overflow-hidden` on
  `html/body`, `overscroll-behavior: none`. Each screen owns exactly one scroll
  container, so the header and step ladder stay pinned on 320px phones with the
  keyboard open.
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
