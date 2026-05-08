# Contributing to Tarsa

## Prerequisites

- Node 20+ or Bun 1.x
- Claude Code installed (`npm install -g @anthropic-ai/claude-code`)
- tmux (optional, for spawn endpoint testing)

## Dev Setup

```sh
git clone https://github.com/elcronos/tarsa
cd tarsa
npm install
cd frontend && npm install && cd ..
npm run dev          # Vite dev server at :5173, proxies API to :8100
```

In a second terminal:

```sh
npx tarsa --no-browser   # start the server without opening browser
```

## Testing

```sh
npx vitest run                # run all tests
npx tsc --noEmit              # type-check backend
cd frontend && npx tsc --noEmit   # type-check frontend
```

Tests live under `test/`. Each test file maps to a source module. Add tests alongside any new functionality.

## Code Style

- TypeScript strict mode, no `any`
- Functional React components only
- Small focused files; avoid cross-cutting abstractions
- No ORM — raw SQL with typed wrappers via `src/db.ts`
- No comments unless the WHY is non-obvious

## PR Guidelines

1. One logical change per PR.
2. All tests must pass (`npx vitest run`).
3. Both type-checks must pass (root + frontend).
4. New features need corresponding tests.
5. Keep diffs small; split large changes into stacked PRs.
6. Use the PR template when opening a pull request.

## Architecture Notes

- Events are append-only; never mutate persisted events.
- `replayToTimestamp(events, ts)` in `src/shared/replay-core.ts` is the single source of truth for derived state.
- Hooks write to `/tmp/tarsa.jsonl`; the tailer picks them up. Do not write directly to the DB from hooks.
- All auth machinery is gated behind `--allow-remote`. Default localhost mode has zero auth overhead.
- The `bun:sqlite` / `better-sqlite3` split is abstracted in `src/db.ts` — do not import either directly outside that file.

## Commit Messages

Use imperative mood: `add X`, `fix Y`, `remove Z`. One sentence is usually enough.
