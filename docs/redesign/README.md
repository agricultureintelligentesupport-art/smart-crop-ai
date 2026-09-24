# Signed-in app shell — redesign reference

The signed-in experience (`/dashboard`, `/assistant`) was rebuilt as a native
app shell. The pre-auth screens (onboarding carousel, auth wizard) keep their
existing "glass over gradient" language; everything past the session gate now
shares one system.

## The design read

> An agricultural decision-support app for Algerian farmers, used one-handed
> in the field: calm, data-aware, thumb-friendly, Arabic-first (RTL default).

That drives the three dials to **DESIGN_VARIANCE 5 · MOTION_INTENSITY 4 ·
VISUAL_DENSITY 6** — restrained motion, denser grouped information, no
decorative noise.

## What changed (and why)

| Web tell (before) | Native pattern (after) |
| --- | --- |
| 4–5 floating icon buttons crammed across the top | One translucent app bar: brand + account status, language switch, sign-out; elevation appears only once content scrolls under it |
| All navigation lived in the header | A 3-tab bottom bar (الرئيسية · المساعد · حسابي) in the thumb zone, active tab marked by a spring-eased pill, safe-area padded, a floating pill from `sm` up |
| Identity/personalisation always open in the page body | Account & personalisation moved into a bottom sheet (`حسابي`) with drag-to-dismiss, focus trap and focus return; `#account` deep-links open it |
| Small display type, sections at 20px, body at 11px | Large title 26px, card titles 15px, body 12–13.5px on a 4/8/12/16/24 spacing beat, one column capped at 560px |
| Translucent `backdrop-blur` glass on every card | Opaque grouped cards (`.app-surface`) and nested tiles (`.app-tile`): crisper on OLED, far fewer blurred layers to composite while scrolling |
| Advisory "quick reading" buried mid-scroll | A hero decision card at the top: today's m³ for the parcel, the irrigation window, L/ha, and the three advisory lines |
| Everything reachable only by scrolling | Three thumb-zone quick actions (تشخيص ورقة / حاسبة السقي / مهام اليوم) that scroll to their section and ring it briefly |
| One long undifferentiated card list | Grouped sections (`الطقس والسقي`, `صحة النبات`) with small grouped-list headers; two columns from `lg` |

Existing entry points preserved: the intro screen (now in the account sheet
and still one tap from the tab bar on `/assistant`), sign-out, wilaya/role
personalisation, the leaf scan, the calculator, NDVI, tasks, the assistant.

## Component map

```
src/components/app/
├── shell.ts       # shared column width + chrome height constants
├── AppBar.tsx     # translucent, scroll-aware top bar (+ brand / action slots)
├── TabBar.tsx     # bottom tab bar (Link or button per tab)
└── Sheet.tsx      # bottom sheet: drag-to-dismiss, focus trap, Escape handling
src/components/dashboard/
├── HeroCard.tsx     # today's decision (water volume, window, advice)
└── AccountSheet.tsx # identity + personalisation + language + sign-out + intro
```

## Update — settings live only in the account sheet

Language switch, sign-out and the wilaya "تعديل" entry were removed from the
top bar / dashboard card and relocated into the account sheet ("حسابي" tab):
same components, same handlers, new home. The "وصول سريع" quick-action row was
removed outright — its tiles were in-page scroll shortcuts, and every target
section (tasks, calculator, scan) is still on the dashboard itself.

Surfaces, sliders, safe-area and scroll-padding contracts live in
`src/app/globals.css` under "App shell". All new surfaces inherit the existing
accessibility fallbacks (`prefers-reduced-transparency`, `prefers-contrast`,
`@supports not (backdrop-filter)`), and motion is limited to `'use client'`
leaves that already animate.

## Screenshots

Before/after pairs, captured headlessly at 412×915 (Pixel 7, RTL) unless noted:

| File | What it shows |
| --- | --- |
| `01-home.png` | The home screen: header, hero decision card, quick actions, tasks |
| `02-sections.png` | Grouped sections (weather + calculator) |
| `03-field-health.png` | NDVI + leaf-scan section |
| `04-personalisation-sheet.png` | Account sheet (replaces the inline personalisation panel) |
| `05-french-ltr.png` | The same screen in French (LTR mirror) |
| `06-assistant-shell.png` | `/assistant` on the shared shell |
| `07-desktop-centre-column.png` | Wide viewport: centred app column, floating tab bar |
| `08-narrow-320.png` | 320×568: no horizontal overflow, no clipped chrome |
