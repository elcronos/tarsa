# ADR-0007: Embed cc-web as Sibling Terminal Subprocess

**Status:** Accepted (supersedes [ADR-0004](0004-no-in-process-pty.md))

## Context

ADR-0004 rejected an in-browser terminal because in-process PTY would have
put `node-pty` buffers and `claude` stdio inside the same Node/Bun process
that serves the web UI — a real isolation concern. The proposed alternative
(`POST /api/spawn` returning a `tmux attach` command) shipped, but the UX
gap remained: clicking on an agent in Tarsa never landed the user inside
that agent's actual Claude Code conversation.

Two practical needs emerged:

1. **Per-agent Terminal tab.** When the user inspects an agent, they should
   be one click from the live shell for that session — not a copy-paste of a
   `tmux attach` command.
2. **Resume the real conversation.** Spawning a fresh `claude` in the agent's
   cwd is not "open that agent's terminal"; the user expects
   `claude --resume <session-id>`.

## Decision

Vendor [`claude-code-web`](https://github.com/vultuk/claude-code-web) (MIT,
referred to here as **cc-web**) under `vendor/cc-web/` and run it as a
**sibling subprocess** managed by `CcWebSupervisor`. The Tarsa server proxies
session-create requests via `POST /api/terminal/ensure-session`; the iframe
loads `http://127.0.0.1:8101/?token=…&single=1&session=<cc-id>&resume=<claude-id>`.

The Tarsa Node/Bun process **never owns a PTY**. cc-web spawns and reads from
its own PTY in its own process; Tarsa speaks to it only through cc-web's
WebSocket as a regular client.

Patches applied to the vendored cc-web are tagged `// TARSA PATCH:` in the
source and summarized in [PATCHES.md](../../vendor/cc-web/PATCHES.md).

## Consequences

**Positive:**
- Isolation goal of ADR-0004 preserved: no `node-pty` in the Tarsa server.
- `--resume` deeplink lands users inside the actual Claude Code session they
  clicked on — assuming the transcript still exists.
- cc-web continues to receive upstream improvements; vendoring + tagged
  patches keep merges tractable.

**Negative:**
- Two listening ports instead of one (8100 + 8101). Both bind `127.0.0.1`.
- Vendored MIT code that must be tracked for upstream security fixes.
- cc-web auth token is passed via URL query param to the iframe, subject to
  the same browser-history caveats documented in [SECURITY.md](../../SECURITY.md).

**Opt-out:**

Set `TARSA_TERMINAL=0` to disable. The Terminal tab disappears, no cc-web
subprocess is spawned, and `POST /api/spawn` (ADR-0006) remains available
for users who prefer the tmux flow.
