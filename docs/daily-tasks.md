# Daily AI Task Engine — 23:55 → 00:00 workflow

The hero decision card's old static advice lines (`سق بمعدل…`, `أفضل نافذة…`,
`راقب القمح الصلب…`) and the standalone "مهام اليوم" card are replaced by one
interactive **"مهام اليوم الموصى بها (AI)"** checklist, generated every day by
a scheduled AI pipeline and cached so it is always available — even offline.

```
23:55  /api/cron/daily-snapshot   phase 1 — DATA SNAPSHOT
       └─ collectDailyContext()   Open-Meteo 24-h forecast (temp max/min, rain
                                  probability, humidity, wind) + ET₀ + net
                                  irrigation need (m³) + optimal watering
                                  window + crop / growth stage / soil / wilaya
       └─ publishSnapshot()       dailySnapshots/{date}/{contextKey}

00:00  /api/cron/daily-tasks      phase 2 — AI GENERATION & PUBLISH
       └─ readSnapshot()          the 23:55 payload (re-collected when missed)
       └─ generateDailyTaskSet()  OpenAI → Gemini prompt → 3–5 structured JSON
                                  tasks (id, title, subtitle, category,
                                  priority, titleFr, subtitleFr)
                                  └─ offline fallback: generateRuleTasks()
       └─ publishTaskSet()        dailyTasks/{date}/{contextKey}
```

Both phases run in **Africa/Algiers** (UTC+1, no DST): `vercel.json` schedules
them at `55 22 * * *` and `0 23 * * *` UTC = 23:55 and 00:00 local. The target
date (`YYYY-MM-DD`) is computed with a +10-minute bias (`targetDate()`), so both
phases index the same upcoming day.

## Client resolution (`useDailyTasks`)

| Step | Source | Notes |
| --- | --- | --- |
| 1 | LocalStorage `smart-crop.daily-tasks.v1.{date}.{contextKey}` | instant render |
| 2 | `POST /api/daily-tasks` | on-demand AI generation (lazy publish) |
| 3 | `generateRuleTasks()` in the browser | never-empty guarantee |

Checked state lives in `smart-crop.daily-tasks.done.v1.{date}.{contextKey}` —
refresh-proof, and rolls over with the date. A progress bar + the
`4/4 اكتملت مهام اليوم 🎉` mini-badge celebrate a fully checked day; the card
footer carries the publish stamp
`✨ تم تحديث المهام بواسطة الذكاء الاصطناعي - اليوم 00:00`.

## Seamless hero architecture (one container, two zones)

The hero decision card is **one** master container — `app-hero`: a
`rounded-3xl` deep-emerald → teal gradient (`#065f46 → #064e3b → #042f2e`) with
one soft light source top-corner, a hairline inner highlight, a light emerald
glow underneath and the faded row texture. Nothing inside it is a card:

| Zone | Contents | Surface |
| --- | --- | --- |
| 1 · metrics | `110.0 m³` headline, `5.0 mm` / `55,100 L/ha`, the window tile and the per-hectare tile | translucent washes — `bg-white/5 border-white/10`, hover to `bg-white/10 border-white/20` |
| seam | one hairline `<div data-hero-seam class="my-3 border-t border-white/10">` | no second radius, no second card |
| 2 · task tray | header row, task rows, expand handle, publish stamp | no fill, no ring, no border of its own |

`HeroTasksChecklist` therefore renders a plain `<section>` (labelled by its own
`✨ مهام اليوم الذكية` heading) and each task row is a borderless wash
(`bg-white/10 hover:bg-white/15`, radius only). The e2e spec asserts this
structurally: the tray computes `background: rgba(0,0,0,0)` + `box-shadow: none`
+ zero border widths, every row is borderless, and there is exactly one 1px
seam inside the card.

## Task tray: compact header + collapsible rows

Header row (one line, both edges used):

- start edge: `✨ مهام اليوم الذكية` — the sparkle is part of the string; the old
  descriptive subtitle key was deleted with the nested-card layout;
- end edge: the live counter (`0/5 منجزة`, or `4/4 اكتملت مهام اليوم 🎉` when the
  day is complete) plus a minimal `h-1.5 w-16` rail (`bg-white/20` track,
  emerald fill, `role="progressbar"` carries the same label).

Rows: checkbox → title + quiet category tint → priority chip on the trailing
edge (solid amber `عالية`, ghost `عادية`). Rows are **not** nested cards.

Collapsed by default: the day's first — always highest-priority — task is
pinned and the rest wait behind the integrated handle.

- **Handle**: `bg-white/10 backdrop-blur-md hover:bg-white/20`, hairline
  `border-white/15` glass pill attached to the tray's foot (`≥ 44 px` touch
  target). Collapsed it reads `عرض باقي المهام (3+) ⚡` + a `ChevronDown` that
  rotates on open; expanded only the chevron/label swap, so the pill reads
  `طي القائمة`. `{count}` is live from `tasks.length - 1`; `aria-expanded` +
  `aria-controls` point at the animated wrapper, which stays mounted in both
  states so the reference never dangles.
- **Motion**: `AnimatePresence` height `0 → auto` with the tray's one spring
  (`stiffness: 300, damping: 30`); revealed rows fade/slide in with a small
  stagger (≤ 120 ms). Under `prefers-reduced-motion` the height step becomes a
  120 ms fade and `initial`/stagger are suppressed.
- **State**: the open/closed flag is component-local (`useState`) — collapsed is
  the default on every visit. Checked state is untouched by either state: it
  lives in the per-day done map above, so a task keeps its tick through
  collapse, expand, reload and the day's cache resolution. Task data, order and
  the card's numbers are never recomputed by the toggle.

## API

- `POST /api/daily-tasks` — body `{ wilayaCode, crop, soil, areaHa, system, date? }`
  → `{ date, source: "ai"|"rules", tasks, context, warnings }`. The `context`
  block quotes the same `computeIrrigation` chain the hero card renders (ET₀,
  net m³, window 05:30–08:30, growth stage…). Never returns 500.
- `GET /api/daily-tasks?date=&wilayaCode=&crop=&soil=&area=&system=` — the
  published set (or a lazy generation on cache miss).
- `GET /api/cron/daily-snapshot` / `GET /api/cron/daily-tasks` — the scheduled
  phases; authorized with `Authorization: Bearer $CRON_SECRET` (or `?secret=`)
  whenever `CRON_SECRET` is set.

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Stage-1 LLM (PRIMARY, `gpt-4o-mini` by default) with JSON mode |
| `GEMINI_API_KEY*` | Stage-2 LLM (FALLBACK, same key pool as `/api/assistant`), model chain `gemini-3.6-flash` → `2.5-flash` → `2.0-flash`, `GEMINI_MODEL` overrides |
| `FIREBASE_DATABASE_URL`, `FIREBASE_DATABASE_AUTH` | optional RTDB REST persistence (`dailyTasks/…`, `dailySnapshots/…`); omit to keep everything client-side |
| `DAILY_TASK_CONTEXTS` | JSON array of pinned parcels the midnight job publishes for (defaults to the app's default wilaya + lead crop) |
| `CRON_SECRET` | protects the two cron endpoints |

## Failure behaviour

Every stage degrades, nothing throws: Open-Meteo down → reference climate in
the snapshot; every AI key down / malformed JSON / thin output (`< 3` valid
tasks) → the deterministic bilingual rule engine (`rules.ts`, same JSON shape
as the AI); RTDB unconfigured → LocalStorage remains the store. The rule
generator always emits 3–5 tasks whose numbers come from the exact
`computeIrrigation` chain the hero card shows — so the checklist can never
quote a figure the dashboard would contradict.

Unit tests: `test/unit/daily-tasks.unit.test.ts` and
`test/unit/daily-tasks-route.unit.test.ts` (`npm run test:unit`).
