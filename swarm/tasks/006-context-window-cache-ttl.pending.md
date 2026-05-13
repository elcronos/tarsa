# Context window fill % + cache expiration countdown

## Goal
G3 item #2 from SPEC.md. Surface per-agent context-window utilization and time-until-prompt-cache-expiry. Anthropic prompt cache TTL = 5 min from last cache write; agent rendering 180k/200k tokens or 30s from cache eviction is critical signal users currently can't see.

Backend first (this task), UI card consumes the new field. Depends on 001 having landed (needs `cache_read` / `cache_creation` in `tokensMap`).

## Files to touch
- `src/insights.ts` — new exported `contextUsage(state, tokensMap?)` returning `ContextUsageResult`
- `src/shared/pricing.ts` — extend per-model record w/ `contextWindow` (Sonnet 4.5 200_000, Opus 4.7 200_000, Haiku 4.5 200_000) and `cacheTtlMs` (300_000) constants
- `src/server.ts` — embed `contextUsage` output in `/api/insights` payload
- `frontend/src/components/ContextWindowCard.tsx` (NEW) — fill bar + TTL countdown per active agent
- `frontend/src/App.tsx` (or wherever insights render) — mount card
- `test/insights.test.ts` — vitest cases

## Acceptance
- `contextUsage(state, tokensMap?)` returns:
  ```ts
  interface ContextUsageRow {
    agentId: string;
    agentName: string;
    model: "sonnet" | "opus" | "haiku";
    tokensInContext: number;       // input + cache_read + cache_creation
    contextWindow: number;          // from pricing module
    fillPercent: number;            // 0-100 rounded to 1 decimal
    lastCacheWriteMs: number | null;// from last event w/ cache_creation > 0
    cacheExpiresMs: number | null;  // lastCacheWriteMs + 300_000, null if no cache
  }
  interface ContextUsageResult { perAgent: ContextUsageRow[]; }
  ```
- Only emit rows for agents w/ `status !== "done"` (active only — cache only matters live)
- `lastCacheWriteMs` derived by scanning events for that agent w/ `cache_creation > 0`, taking max timestamp
- Frontend card:
  - Fill bar colored: green <70%, yellow 70-90%, red >90%
  - Countdown `mm:ss until cache expires` using client-side ticker, recomputed every 1s
  - When countdown hits 0 → show "cache expired" pill
  - Hidden when no active agents
- vitest:
  - 1 agent, 50k input + 100k cache_read + 20k cache_creation on Sonnet → fillPercent = 85
  - lastCacheWriteMs picks max across multiple cache_creation events
  - Done agents excluded
- `npm test && npm run build` pass

## Notes
- Don't add a polling endpoint for the countdown — frontend computes locally from `cacheExpiresMs`. Saves server load.
- Cache TTL constant lives in pricing module so backend and frontend agree.
- Functional React component, rem-based sizing using tokens from task 002 (if 002 already landed; otherwise inline px is acceptable and fold into 002).
- Keep ContextWindowCard small (<120 LOC). One file.
