@AGENTS.md

# Design Rules (auto-applied to all UI work)

This repo has vendored design rule packs that MUST be applied to every UI task (pages, components, styling, motion, layout). Read them before writing UI code:

- **Skills** live in `.claude/skills/` — load the relevant `SKILL.md` for the task:
  - `taste-skill` (default anti-slop frontend skill: brief inference, the three dials, design-system map, pre-flight check)
  - `ui-ux-pro-max` + `ui-styling` (design intelligence: styles, palettes, font pairings, UX guidelines, stack guidance — clean layout, modern typography, glassmorphism, mobile-first, accessibility)
  - `design`, `design-system`, `brand`, `banner-design`, `slides` (supporting UI/UX Pro Max packs)
  - `minimalist-skill`, `soft-skill`, `brutalist-skill`, `redesign-skill`, `image-to-code-skill`, `imagegen-frontend-web`, `imagegen-frontend-mobile`, `brandkit`, `gpt-tasteskill`, `output-skill`, `stitch-skill`, `taste-skill-v1` (specialized directions — use only when the brief calls for them)
- **Consolidated always-on directives** are in `.cursorrules` (valid for all agents, not just Cursor).

Core standing directives: infer the design read before coding; no AI-slop defaults (AI-purple gradients, three equal cards, generic glass on everything); mobile-first responsive (`100dvh`, 44px touch targets); WCAG 2.2 AA (contrast, focus rings, keyboard, reduced-motion/transparency fallbacks); motion and state only in `'use client'` leaves; complete output with empty/loading/error states.

Sources (MIT): github.com/Leonxlnx/taste-skill, github.com/nextlevelbuilder/ui-ux-pro-max-skill.
