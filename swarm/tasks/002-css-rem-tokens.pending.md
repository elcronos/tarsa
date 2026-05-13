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
