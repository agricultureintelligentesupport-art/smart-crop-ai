# محصولي الذكي · Smart Crop AI — Pre-Auth Onboarding

Full-screen, mobile-first, 3-step pre-authentication onboarding flow (Arabic RTL default, French LTR option) built with **Next.js (App Router) + Tailwind CSS v4 + Framer Motion + Lucide React**.

```bash
npm install
npm run dev   # http://localhost:3000
```

## Structure

```
src/
├── app/
│   ├── layout.tsx            # Cairo (AR) + Plus Jakarta Sans (FR) via next/font, theme-color, viewport lock
│   ├── globals.css           # Tailwind theme, art palette vars (light/dark), glass/screen-h/safe-area utilities
│   ├── page.tsx              # renders <OnboardingScreen/>
│   ├── register/page.tsx     # CTA stub → "Créer un compte" destination
│   └── guest/page.tsx        # CTA stub → "Continuer comme invité" destination
├── components/onboarding/
│   ├── OnboardingScreen.tsx  # carousel orchestration: swipe/drag, RTL direction math, dots, dynamic CTA, backdrop
│   ├── HeaderBar.tsx         # brand badge + AR/FR language pill + skip button (fixed slot, 48px targets)
│   └── graphics/
│       ├── LeafScannerArt.tsx  # slide 1 — glowing leaf + camera viewfinder + scanline + AI result chips
│       ├── IrrigationArt.tsx   # slide 2 — smart water drop + weather widget + irrigation schedule card
│       └── SatelliteArt.tsx    # slide 3 — satellite NDVI heatmap map + live downlink + legend
├── lib/content.ts            # all AR/FR copy (one source of truth for both languages)
├── e2e/
│   └── onboarding.spec.ts    # Playwright suite (22 tests × 2 projects)
└── playwright.config.ts      # mobile (Pixel 7) + desktop Chromium projects
```

## Tests

```bash
npx playwright install chromium   # one-time browser download
npm run test:e2e                  # boots `next dev` automatically (reuses one already running)
```

Covers: viewport stability (zero page scroll on 412/390/320 widths, 48px+ touch targets), RTL defaults, swipe/pointer-drag navigation with RTL semantics, dot jumps, skip → final step, AR⇄FR switching (dir + strings + mirrored header), CTA routing to `/register` & `/guest`, and a zero-console-errors health check.


## Behaviour notes

- **Viewport lock**: root uses `h-screen` upgraded to `100dvh` (`.screen-h`), `overflow-hidden` on `html/body` + `overscroll-behavior: none` → zero page scrolling from 320×568 up.
- **RTL/LTR**: switching AR↔FR flips `dir` on the whole screen *and* on `<html>`. The carousel inverts swipe semantics too (in RTL, dragging content to the right advances the slide). Brand badge sits at the start (right in AR), skip at the end (left in AR).
- **Skip**: jumps straight to the final action step (sign-up CTAs); auto-hides once there.
- **Slides**: 3 animated SVG scenes (Framer Motion loops), spring-driven enter/exit + drag-to-dismiss with velocity flick support; keyboard arrows work too.
- **Bottom controls**: glowing animated page dots (clickable) + CTA that morphs on the last step into "إنشاء حساب" (emerald) and "متابعة كزائر" (glassmorphism). The swap zone has a fixed height, so the layout never jumps.
- **Touch**: every button is ≥48px tall; safe-area insets respected (`pt-safe`/`pb-safe`).
- **Dark mode**: follows the OS automatically; SVG art adapts through CSS variables in `globals.css`.

## Next steps (suggested)

- Replace `/register` & `/guest` stubs with the real auth flow.
- Persist "seen onboarding" in a cookie/localStorage and skip this screen on return visits.
- Optional: `next-intl` if the app grows past two languages (copy already isolated in `lib/content.ts`).
