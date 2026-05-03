# AgentScope

## Critical Rules

- **All hooks must have `"async": true`** — blocking hooks kill Claude Code sessions
- **SubagentStart/SubagentStop hooks are unreliable** — auto-discover agents from `agent_id` field on PreToolUse/PostToolUse events
- **Don't break existing agentpeek hooks** — AgentScope uses `/tmp/agentscope.jsonl` (distinct from `/tmp/agentpeek.jsonl`)
- **Hook marker**: `agentscope.jsonl` — never touch entries containing `agentpeek.jsonl`
- **Port**: 8100 — avoid 8099 collision with agentpeek

## Code Style

- TypeScript strict, no `any`
- Functional components in React
- Small focused files
- No ORM — direct SQL with typed wrappers in `src/db.ts`

## Architecture

- Hook-based only (no proxy, no multi-framework)
- Claude Code only
- Events append-only in memory; state derived by running reducer over events
- `replayToTimestamp(events, ts)` is the single source of truth for derived state
- Storage: `bun:sqlite` on Bun, `better-sqlite3` on Node — unified behind `db.ts` interface

## Distribution

- `bunx agentscope` — Bun users (zero additional install)
- `npx agentscope` — Node users (`better-sqlite3` requires native compile ~2-3s)
- Entry shim: `bin/agentscope.mjs` — detects runtime, loads appropriate entry
