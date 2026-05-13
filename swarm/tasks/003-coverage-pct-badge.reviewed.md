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

## Implementation notes

- `src/insights.ts` — added `pricedCoveragePercent(cost)` returning rounded share of `perAgent` w/ `source === "measured"`. Empty perAgent → 100.
- `src/server.ts` — `/api/insights` payload now includes `pricedCoveragePct` alongside `costEstimate`/`tokenSource`.
- `frontend/src/components/InsightsView.tsx`:
  - `InsightsData` type gained `pricedCoveragePct?: number`.
  - `CostBar` takes new `coveragePct` prop. Renders amber `~est ({pct}% measured)` badge w/ tooltip ("Anthropic API-reported tokens (transcript-measured) vs estimated. Higher = more honest.") only when coverage < 100.
  - When `source === "tool_count_fallback"` and `totalUsd === 0`, USD/bar hidden — single `—` shown (acceptance row 3).
  - Memoized cost block derives `coveragePct` from server payload, with local fallback computation when server omits it.
- `test/insights_cache_pricing.test.ts` — added 3 vitest cases: 4 agents (3 measured + 1 estimated) → 75; empty state → 100; all measured → 100.
- typecheck pass; cache-pricing suite 14/14 pass; full vitest 281/291 (10 pre-existing `better-sqlite3` native-binding failures, unrelated to this task); build pass.
