# Cmd+K command palette

## Goal
Add a Cmd/Ctrl+K command palette for fast navigation: jump to session, jump to agent, change tab, toggle filters.

## Files to touch
- `frontend/src/components/CommandPalette.tsx` (NEW)
- `frontend/src/App.tsx` (mount palette, keyboard listener)
- `frontend/src/hooks/useHotkey.ts` (NEW or extend existing)

## Acceptance
- Cmd+K (mac) / Ctrl+K (win/linux) opens palette overlay
- Esc closes
- Fuzzy search over: tabs (Sessions/Agents/Cost/Replay/Terminal), session IDs, agent names
- Enter executes selection
- Arrow keys navigate results
- Works at all viewport widths (no horizontal overflow)
- Built-in only; no `cmdk` / `kbar` dependency (keep deps small)

## Notes
Don't pull in a library — small custom impl, ~150 LOC. Reuse existing search if there's one in `src/search.ts` (that's backend; frontend will do local filter).
