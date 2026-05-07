# ADR-0002: Append-Only Events with Pure Reducer

**Status:** Accepted

## Context

ClaudeLens must display real-time agent state (topology, timeline, tool I/O) while also supporting time-travel replay. Two state management approaches were evaluated:

1. **Mutable in-memory model:** Update agent/session records in place as events arrive.
2. **Append-only event log + pure reducer:** Store raw events; derive all state by replaying events through a pure function.

## Decision

All events are appended to an in-memory list. Derived state (sessions, agents, edges, tool calls) is computed by running `replayToTimestamp(events, ts)` over the full event log. This pure reducer is the single source of truth and is shared between the backend (`src/shared/replay-core.ts`) and the frontend bundle.

Each persisted JSONL event carries a `schema_version` field (integer). Missing `schema_version` is treated as v1 for backward compatibility. When a v2 schema lands, branch processing logic on `schema_version` here. See the defensive read in `src/processor.ts` (`KNOWN_SCHEMA_VERSION` constant).

## Consequences

**Positive:**
- Time-travel scrubber is trivially correct: pass any `ts` to `replayToTimestamp`.
- Session diff is a direct comparison of two replay outputs.
- Frontend and backend share identical state logic — no divergence bugs.
- Easy to test: pure function with no side effects.

**Negative:**
- Full replay on every state read is O(n) in event count. Mitigated by structural sharing and snapshot caching for large sessions.
- Event schema changes require backward-compatible additions only; fields may never be removed.
- The spawn endpoint (`/api/spawn`) is the one deliberate exception — it is an action endpoint, not event-sourced. See ADR-0006.
