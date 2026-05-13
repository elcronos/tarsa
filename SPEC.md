# Tarsa SPEC

## What

Real-time Claude Code agent observability tool. Hook-based, append-only events, reducer-derived state.

## Tech Stack

- TypeScript strict, no `any`
- Backend: Node (`tsx`/`node`) + Bun runtime support. Hono HTTP server. `better-sqlite3` (Node) / `bun:sqlite` (Bun), unified behind `src/db.ts`.
- Frontend: React (functional only) + Vite, `frontend/src/`. `app.css` (currently hardcoded px — pain point).
- Tests: `vitest`
- Distribution: `bunx tarsa` / `npx tarsa`. Entry shim `bin/tarsa.mjs`.
- Port: 8100
- Events sink: `~/.tarsa/events.jsonl` (legacy `/tmp/tarsa.jsonl` migrated)
- Hook marker: `tarsa --append-event`

## Hard Rules (from CLAUDE.md)

- All hooks `"async": true`
- Don't break existing agentpeek hooks
- No proxy / no multi-framework. Claude Code only.
- TypeScript strict, no `any`
- Functional React components, small focused files
- No ORM — direct SQL with typed wrappers in `src/db.ts`

## Goals (priority order)

### G1 — Fix cost estimation (high)

Current bugs:
- `src/insights.ts:78-157` `costEstimate` accepts `cache_read` / `cache_creation` in `tokensMap` signature but **never reads them**. Cache writes = 125% base, cache reads = 10%. Result: silent undercount.
- `src/insights.ts:108` model detection only matches `"opus"` — Haiku silently priced as Sonnet.
- `src/insights.ts:124` `chars/4` heuristic shown as USD without "estimated" badge in UI.
- Prices: Sonnet 4.5 at $3/$15 OK. Opus 4.7 needs verification. No cache prices anywhere.
- `frontend/src/utils/cost.ts:6-11` separate stale pricing table — must consolidate.

Fix:
- Wire `cache_read` * 0.1 + `cache_creation` * 1.25 into rate math.
- Add Sonnet 4.5 cache prices: $0.30/Mtok read, $3.75/Mtok write.
- Add Haiku detection branch w/ Haiku pricing.
- Expose `source` ("measured" | "estimated_chars" | "tool_count_fallback") → UI badge.
- Add `pricedCoveragePercent()` honesty signal — hide USD when source ≠ measured, show "~est" instead.
- Single pricing module shared backend/frontend (`src/shared/pricing.ts`).

### G2 — Fix UI scaling (high)

Pain: text doesn't scale across screens. `frontend/src/app.css` hardcoded px.

Fix:
- Design tokens file: CSS custom properties for color, space, font-size (rem-based).
- Convert components from px → rem.
- `:root { font-size: clamp(14px, 1vw + 0.5rem, 18px) }` baseline.
- Test at 1280×800, 1920×1080, 2560×1440, mobile 390w.

### G3 — Port claude-view features (vision-aligned)

In order:
1. Cache-aware cost breakdown card + coverage % badge
2. Context window fill % + cache expiration countdown
3. Cmd+K command palette
4. "Open file in editor" (auto-detect VS Code/Cursor/Zed via launch URL scheme)
5. Recently-closed sessions panel (persist after exit)
6. Monitor mode (focused single-agent view)
7. Per-session / per-commit cost analytics

### Skip (violates vision)

- Rust backend rewrite
- iOS/mobile app
- OpenAI-compatible endpoints (Claude Code only)
- Proxy mode
- VS Code extension launcher
- Dockview drag-splits
- 77 auto-generated MCP tool integrations

## Architecture invariants

- Events append-only. Never mutate.
- `replayToTimestamp(events, ts)` is single source of truth for derived state.
- Reducer pure. Tests in `src/replay.ts` / `test/`.
- Frontend reads from `/api/state` snapshots or SSE stream — never directly from sqlite.

## Done = ?

For each goal: vitest passing, `npm run build` clean, manual smoke on local Tarsa dashboard, screenshot at 3 viewport widths, commit on `main` (no Claude co-author trailer per memory).
