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
       └─ generateDailyTaskSet()  Gemini → OpenAI prompt → 3–5 structured JSON
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

## Collapsible checklist (mobile space)

`HeroTasksChecklist` renders **collapsed by default**: the section header and
the day's first task — always the generator's highest-priority one — plus a
faint `mt-2 h-3` row sliver under it, masked with a bottom gradient
(`mask-image: linear-gradient(to bottom, #000, transparent)`). At 360–414 px
that keeps the hero decision card roughly one task tall instead of four, so the
calculator and the field cards stay near the fold.

- **Toggle**: a full-width glass pill (≥ 44 px tall) at the bottom of the card.
  Collapsed it reads `عرض باقي المهام (3+) ▾` (`{count}` = hidden tasks, live
  from `tasks.length - 1`); expanded it reads `طي القائمة ▴`. The chevron is the
  `▾` glyph rotated 180° with a spring — no icon swap, so the shape morphs.
  `aria-expanded` + `aria-controls` point at the animated wrapper (which stays
  mounted in both states, so the reference never dangles).
- **Motion**: the revealed block animates `height: 0 → auto` with
  `duration: 0.3` and `AnimatePresence`; rows fade/slide in with a small
  stagger (≤ 120 ms) and carry `layout`, so the sections below the hero are
  pushed down smoothly. Under `prefers-reduced-motion` the height step is
  replaced by a 120 ms fade (the `layout` prop is dropped) and `initial` is
  suppressed — no travel, no stagger.
- **State**: the open/closed flag is component-local (`useState`) — collapsed is
  the default on every visit, so the card never grows back on its own. Checked
  state is untouched by either state: it lives in the per-day done map above,
  so a task keeps its tick through collapse, expand, reload and the day's cache
  resolution. Task data, order and the card's numbers are never recomputed by
  the toggle.

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
| `GEMINI_API_KEY*` | Stage-1 LLM (same key pool as `/api/assistant`), model chain `gemini-1.5-flash` → `2.0-flash` → `2.5-flash`, `GEMINI_MODEL` overrides |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Stage-2 LLM (`gpt-4o-mini` by default) |
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
