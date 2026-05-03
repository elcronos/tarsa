# AgentScope

Live observability for Claude Code agent sessions. Topology, timeline, tool I/O, transcripts, cost — visible while the session runs.

## Quick Start

Requires Node 20+ (or Bun 1.x).

```sh
npx agentscope        # zero-install run
# or
npm install -g agentscope && agentscope
```

First run installs hooks into `~/.claude/settings.json` and opens `http://localhost:8100`. Start a Claude Code session in any project; agents appear in real time.

## Features

- **Topology graph** — DAG of agents and subagents with depth-grid layout. Edges color-coded by relationship (root→subagent, nested, team).
- **Timeline** — Gantt with parallel-bar grouping and depth indentation.
- **Replay** — chronological event stream with expandable tool input/output, full-text search, status filters.
- **Insights** — bottleneck detection, cost breakdown (transcript-measured when available, char/tool-count fallback otherwise), error-recovery analysis, stuck-agent alerts, agent-type baselines + z-scores.
- **Detail panel** — per-agent tabs: trace, transcript thread, files touched, prompt, result. Optional LLM-generated 1-sentence prompt summary via local `claude --model haiku`.
- **Time-travel scrubber** — drag through session history; state derived via pure reducer.
- **Session diff** — side-by-side compare two sessions; agent matching by `(subagent_type, depth, sibling_order)`.
- **Global view** — all sessions at once, mini-DAG per session, filter stale/live.
- **Subagent dedup** — Agent-tool pre-create stub migrates onto the real `agent_id` when SubagentStart fires; subagent re-parenting attaches subagent processes to their spawning session.
- **Team detection** — `worker-*` and `team-*` subagent types render with team badges and orange edges.

## CLI

| Flag | Description |
|---|---|
| `--port <n>` | Listen on port `n` (default `8100`) |
| `--no-browser` | Skip auto-opening browser |
| `--install-hooks` | Install hooks into `~/.claude/settings.json`, then exit |
| `--uninstall` | Remove AgentScope hooks, then exit |
| `--append-event <name>` | Read JSON from stdin, write to event log (used by hook commands) |

## Architecture

```
Claude Code hooks
  → agentscope --append-event → /tmp/agentscope.jsonl
        ↓ tail
  src/tailer.ts        adaptive-poll JSONL tailer
  src/processor.ts     append-only event log + structural-sharing reducer
  src/shared/replay-core.ts   pure reducer, shared with frontend
  src/db.ts            SQLite persistence (better-sqlite3 / bun:sqlite)
  src/transcript.ts    Claude Code transcript reader (tokens, prompt, thread)
  src/insights.ts      bottleneck / cost / stuck / recovery / baselines
  src/search.ts        in-memory inverted index, seeded from DB on start
  src/server.ts        Hono REST + SSE on :8100, dual-runtime adapter
        ↓ SSE
  frontend/            React + Vite + Tailwind, single-page dashboard
```

State locations:
- Event log: `/tmp/agentscope.jsonl`
- DB: `~/.agentscope/history.db` (sessions, agents, tool_calls, events, baselines)
- Hooks: `~/.claude/settings.json` (entries marked with `agentscope.jsonl`)

## API

| Endpoint | Returns |
|---|---|
| `GET /api/state` | Current derived state (sessions, agents, edges, tool_calls) |
| `GET /api/events/stream` | SSE: snapshot + delta events |
| `GET /api/history` | Persisted + live sessions |
| `GET /api/session/:id` | Session header, events, agents |
| `GET /api/session/:id/thread` | Full transcript messages |
| `GET /api/session/:id/tokens` | Per-agent token usage from transcript |
| `GET /api/agent/:id/prompt` | Stored prompt or first user message from transcript |
| `GET /api/agent/:id/result` | Stored result or last assistant message |
| `GET /api/agent/:id/transcript` | Per-agent transcript |
| `GET /api/agent/:id/brief` | LLM 1-sentence summary (spawns `claude` CLI; in-memory cache) |
| `GET /api/insights` | Bottleneck, cost, parallelism gaps, stuck signals, error recovery |
| `GET /api/baselines` | Agent-type baselines (mean duration, tool count, sample size) |
| `GET /api/search?q=` | Inverted-index search across events |
| `POST /api/reset` | Clear in-memory state |

## Dev

```sh
git clone https://github.com/elcronos/agentscope
cd agentscope
npm install
npm run dev                       # vite dev server (proxies to :8100)
npx vitest run                    # tests
npx tsc --noEmit                  # type-check root
cd frontend && npx tsc --noEmit   # type-check frontend
```

Build a release:

```sh
cd frontend && npm run build      # outputs to ../src/static
cd .. && npm install -g .         # install global with bundled assets
```

## Limitations

- Desktop layout only; no mobile support.
- Single host: hooks and server must run on the same machine.
- No auth on `:8100`; do not expose to untrusted networks.
- Claude Code only; other AI coding tools are out of scope.
- Cost figures are estimates unless transcripts are available.
- Search index seeds from the most recent 10 000 persisted events on startup.
- AgentScope name overlaps with the unrelated [ModelScope/AgentScope](https://github.com/modelscope/agentscope) Python framework — verify before publishing to npm or trademark filings.

## License

MIT
