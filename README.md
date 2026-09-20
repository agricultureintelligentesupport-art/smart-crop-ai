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
| `/guest` | Guest dashboard — live on first paint, no account needed |
| `/dashboard` | Member dashboard (redirects to `/auth` without a session) |

Every route is interactive end to end. There are no "coming soon" screens:
`/guest` renders the dashboard immediately, and every CTA leads to a working
destination.

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
  [`docs/firebase-adapter.md`](docs/firebase-adapter.md). Flipping
  `NEXT_PUBLIC_AUTH_BACKEND=firebase` is the only behavioural switch.
- **Persistence**: `src/lib/auth/profile.ts` keeps the session on-device
  (`localStorage`, mirroring `users/{uid}`), plus device preferences (role +
  wilaya) that survive signing out, so a returning farmer skips the setup steps.

## The dashboard

One component, two modes (`DashboardView`): `/guest` for visitors, `/dashboard`
for members. Every number is derived from the wilaya baseline (temperature,
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
- **Guest → account**: conversion card linking to `/register` and `/login`.

Values are labelled as decision-support estimates, not measurements.

## Structure

```
src/
├── app/
│   ├── layout.tsx              # Cairo (AR) + Plus Jakarta Sans (FR), viewport lock
│   ├── globals.css             # theme, glass + field primitives, focus ring, a11y fallbacks
│   ├── page.tsx                # onboarding carousel
│   ├── auth|login|register/page.tsx
│   ├── guest/page.tsx          # guest dashboard
│   └── dashboard/page.tsx      # member dashboard
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
  French (accent-insensitive), guest mode, irrigation reactivity, leaf scan,
  personalisation persistence, and a full register → setup → dashboard walk.

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
