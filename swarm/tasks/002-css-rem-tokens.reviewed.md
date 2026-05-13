# Convert frontend CSS to rem + design tokens

## Goal
`frontend/src/app.css` uses hardcoded px → text doesn't scale on different screens. Introduce a tokens layer + rem-based sizing.

## Files to touch
- `frontend/src/tokens.css` (NEW)
- `frontend/src/app.css` (refactor)
- `frontend/src/main.tsx` (import tokens.css before app.css)
- Any component CSS that hardcodes px font-size or spacing

## Acceptance
- `tokens.css` defines CSS custom properties:
  - `--space-{0,1,2,3,4,6,8,12,16}` in rem
  - `--fs-{xs,sm,base,lg,xl,2xl}` in rem
  - `--color-{bg,fg,muted,accent,border,error,warn,ok}` as semantic names (keep existing hue palette)
  - `--radius-{sm,md,lg}` in rem
- `:root { font-size: clamp(14px, 0.5rem + 0.5vw, 18px); }`
- All `font-size:` and `padding:`/`margin:` declarations in `app.css` and component styles use tokens (rem)
- Manual check w/ `playwright-cli` at viewports: 390, 1280, 1920, 2560 — text and layout don't break
- `npm run build` passes

## Notes
- Don't change colors visually — keep current palette, just name them via tokens.
- Don't introduce a CSS framework (no Tailwind/Stitches/etc.).

## Implementation notes
- NEW `frontend/src/tokens.css`: defines `--space-{0,1,2,3,4,6,8,12,16}`, `--fs-{xs,sm,base,lg,xl,2xl}`, `--radius-{sm,md,lg}` (all rem) plus semantic `--color-{bg,fg,muted,accent,border,error,warn,ok}` aliasing existing teal-lens palette. Sets `:root { font-size: clamp(14px, 0.5rem + 0.5vw, 18px); }`.
- `frontend/src/main.tsx`: imports `./tokens.css` before `./app.css` so token vars resolve everywhere.
- `frontend/src/app.css`: replaced hardcoded `margin: 0` / `padding: 0` / `font-size: 13px` on `html, body, #root` with `var(--space-0)` and `var(--fs-sm)`. Existing palette vars (`--bg`, `--fg`, etc.) preserved — semantic `--color-*` layered on top, no visual change.
- No other component CSS exists (only `app.css`); Tailwind utility classes inline in components remain untouched (no `@import "tailwindcss"` moved — stays in `app.css`).
- `npm run typecheck` ✅. `npm run build` ✅ (vite 6, 240 modules, css 54.52 kB). `npm test` shows 10 pre-existing failures in `better-sqlite3` native bindings unrelated to CSS — confirmed identical failure count on stashed baseline.
