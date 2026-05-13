# Cost coverage % honesty badge

## Goal
Cost numbers shown in UI don't tell user when they're estimated vs measured. Borrow claude-view's `pricedCoveragePercent()` UX: surface "75% measured, 25% estimated" instead of showing fake-precision USD.

Depends on 001 being merged (uses extended cost source field).

## Files to touch
- `src/insights.ts` — add `pricedCoveragePercent(cost: CostEstimateResultWithSource): number` that returns share of agents w/ source === "measured"
- `src/server.ts` — expose in `/api/insights` payload
- `frontend/src/components/CostCard.tsx` (or wherever USD shown) — show badge

## Acceptance
- When coverage < 100%: badge shows "~est ({pct}% measured)"
- When coverage = 100%: no badge, just USD
- When all sources are `tool_count_fallback` and tokens = 0: hide USD, show "—"
- vitest case: 4 agents, 3 measured 1 estimated → 75%
- `npm test && npm run build` pass

## Notes
Tooltip on the badge explains what "measured" means (Anthropic API-reported tokens).
