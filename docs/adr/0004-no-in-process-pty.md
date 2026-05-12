# ADR-0004: No In-Process PTY

**Status:** Superseded by [ADR-0007](0007-embed-cc-web-as-terminal.md)

> The original decision (rejecting in-process PTY in favor of `POST /api/spawn`
> + tmux) is preserved below for historical context. The current
> implementation vendors cc-web as a *sibling subprocess* — PTY I/O still
> does not live inside the Tarsa Node/Bun process, so the isolation goal
> is preserved while gaining an in-browser terminal UX. See ADR-0007.

## Context

A recurring feature request is an in-browser terminal for spawning new Claude Code sessions directly from the Tarsa UI. Two implementation paths were considered:

1. **In-process PTY via xterm.js + node-pty:** Embed a terminal emulator in the frontend; relay PTY I/O over WebSocket through the Tarsa server process.
2. **External multiplexer spawn:** The server spawns a detached `tmux` or `zellij` session containing `claude`; the UI shows the attach command.

## Decision

In-process PTY is rejected. Tarsa uses external multiplexer spawn: `POST /api/spawn` creates a detached tmux session and returns the `tmux attach` command. The user attaches in their own terminal.

See ADR-0006 for why `/api/spawn` is implemented as an action endpoint rather than an event-sourced operation.

A future `tarsa-shell` sister project may explore browser-embedded terminal UX for users who need it.

## Consequences

**Positive:**
- Full process isolation: the PTY lives in tmux, not inside the web-accessible Node/Bun process.
- No server memory exposure from PTY I/O buffers.
- Zero new npm dependencies; 20 lines of implementation.
- Users retain their existing terminal workflow (scrollback, split panes, etc.).

**Negative:**
- Requires tmux or zellij to be installed. The server returns a clear 400 error with instructions if neither is found.
- No in-browser terminal UX. Users must switch to a terminal to attach.
- `claude` binary must be in PATH; checked at spawn time.
