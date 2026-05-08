# ADR-0006: Spawn is an Action Endpoint

**Status:** Accepted

## Context

Tarsa's architecture derives all state from an append-only event log via a pure reducer (`replayToTimestamp`). Every other API endpoint reads from this derived state. The question arose whether `POST /api/spawn` — which creates a tmux session containing a new `claude` process — should be modeled as an event-sourced operation.

**Severity:** Low. This is a deliberate, narrow exception to the event-sourcing model; it does not compromise the integrity of the existing event log.

## Decision

`/api/spawn` is an imperative action endpoint. It spawns a tmux process and returns the session name and attach command. The spawn action is not recorded as an event and spawn results are not replayed.

## Rationale

Spawn creates an external OS process. Modeling this as an event would require:
- Tracking external process lifecycle (started, stopped, exited) as events.
- Replaying "spawn" events — which would attempt to re-create tmux sessions on replay, a side effect that makes no sense in a time-travel context.
- Listening for process exit to emit a matching "spawn-ended" event.

None of this provides value. The event log is for deriving Tarsa UI state, not for auditing OS process history.

## Consequences

**Positive:**
- Simple 20-line implementation with no event-log coupling.
- No risk of accidental process re-creation during replay.
- Clear conceptual boundary: events = state derivation; spawn = side effect.

**Negative:**
- `/api/spawn` is the only endpoint that does not derive from event history. Future developers must understand this exception.
- There is no built-in way to list "sessions spawned by Tarsa" from the event log. If tracking is needed in the future, a lightweight polling mechanism (e.g., `tmux list-sessions`) is preferred over retrofitting event-sourcing to process lifecycle.

**Auth note:** Spawn is only permitted in default localhost mode. When `--allow-remote` is set, `/api/spawn` returns 403 unconditionally, before any handler logic runs. See ADR-0003.
