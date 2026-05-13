# Fix cost estimation: wire cache_read + cache_creation tokens

## Goal
`src/insights.ts:78-157` `costEstimate` already accepts `cache_read` and `cache_creation` in the `tokensMap` signature but never reads them. Add cache token accounting so cost reflects reality.

## Files to touch
- `src/insights.ts` (lines 8-14 pricing constants, 78-157 costEstimate)
- `src/shared/pricing.ts` (NEW — consolidated pricing module, both backend and `frontend/src/utils/cost.ts` import from here)
- `frontend/src/utils/cost.ts` (re-export from shared)
- `test/insights.test.ts` or similar (NEW — vitest cases for cache pricing)

## Acceptance
- `costEstimate` adds `(cache_read / 1_000_000) * cacheReadRate` and `(cache_creation / 1_000_000) * cacheWriteRate` to USD per agent
- Pricing constants:
  - Sonnet 4.5: input $3, output $15, cache_read $0.30, cache_write $3.75 (per Mtok)
  - Opus 4.7: input $15, output $75, cache_read $1.50, cache_write $18.75
  - Haiku 4.5: input $0.80, output $4, cache_read $0.08, cache_write $1
- Model detection covers haiku (`m.toLowerCase().includes("haiku")` branch added before opus check)
- `AgentCost` interface extends with `cacheReadTokens`, `cacheCreationTokens`
- vitest case: input 1M, output 1M, cache_read 1M, cache_write 1M, Sonnet → asserts USD ≈ 3 + 15 + 0.30 + 3.75 = 22.05
- `npm run typecheck && npm test && npm run build` all pass

## Notes
- Don't break existing tests. The `tokensMap` signature already has the fields — no migration needed.
- Keep `source: "measured" | "estimated_chars" | "tool_count_fallback"` semantics. Cache tokens count as measured only if non-zero in tokensMap.
- Pricing should be exported as a plain `Record<modelKey, {input, output, cacheRead, cacheWrite}>` from `src/shared/pricing.ts`.

## Implementation notes

- **NEW** `src/shared/pricing.ts` — single source of truth. Exports `PRICING` (Record<ModelKey, ModelPricing>), `detectModel(s)`, `priceUsd(in, out, cacheRead, cacheCreation, model)`, types `ModelKey` / `ModelPricing`. Rates: Sonnet 4.5 $3/$15/$0.30/$3.75, Opus 4.7 $15/$75/$1.50/$18.75, Haiku 4.5 $0.80/$4/$0.08/$1.
- `src/insights.ts`:
  - Imports `PRICING`, `detectModel`, `priceUsd`, `ModelKey` from shared module. Old `SONNET_*` / `OPUS_*` constants re-exported (back-compat with existing tests) plus new `*_CACHE_READ`, `*_CACHE_WRITE`, `HAIKU_*`.
  - `AgentCost` interface extended with `cacheReadTokens`, `cacheCreationTokens`. `model` widened to `ModelKey` ("sonnet" | "opus" | "haiku").
  - `costEstimate` now reads `cache_read` + `cache_creation` from `tokensMap`, from event stream, and pipes them through `priceUsd`. Cache tokens alone → `source = "measured"`. Model detection via `detectModel(m)` covers haiku branch (haiku before opus before sonnet).
- `frontend/src/utils/cost.ts` rewritten as re-export of shared module + back-compat `estimateCost(input, output, model, cacheRead?, cacheCreation?)` wrapper. Frontend imports via `../../../src/shared/pricing` — bundled fine by vite.
- **NEW** `test/insights_cache_pricing.test.ts` — 13 vitest cases covering: PRICING constants for all 3 models, `detectModel` ordering, `priceUsd` math, acceptance case (1M each at Sonnet → 22.05 USD), AgentCost shape, cache-only measured source, haiku/opus detection, event-stream cache token flow.
- Verification: `npm run typecheck` ✓, `npm run build` ✓, cost-related vitest suites ✓ (insights, insights_token_wiring, insights_cache_pricing, cost_fallback, agent_perf_table, budget_exceeded — 46/46 passing). The 10 currently-failing tests in `npm test` are pre-existing `better-sqlite3` native-binding errors (15 failures baseline → 10 after change, no regressions introduced).
