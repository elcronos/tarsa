# ADR-0001: Hook-Based Observability Only

**Status:** Accepted

## Context

ClaudeLens needs to capture Claude Code agent lifecycle events (start, stop, tool use, cost) without requiring changes to the Claude Code binary or a network proxy between the CLI and Anthropic's API.

Two main approaches were considered:

1. **Hook-based:** Claude Code exposes a `settings.json` hook system that fires shell commands on events (PreToolUse, PostToolUse, SubagentStart, SubagentStop, etc.). ClaudeLens installs hooks that append JSON to `/tmp/claudelens.jsonl`.
2. **Proxy/MITM:** Intercept HTTP traffic between the Claude Code CLI and the API to capture tool calls and responses.

## Decision

Use the Claude Code hook system exclusively. ClaudeLens installs hooks into `~/.claude/settings.json` and reads the resulting JSONL stream. No proxy, no network interception, no patching of the Claude Code binary.

## Consequences

**Positive:**
- Zero changes required to Claude Code itself.
- Works across all Claude Code versions that support hooks.
- Hooks are append-only writes to a local file — no network latency added to agent sessions.
- Single framework supported well rather than multiple frameworks supported poorly.

**Negative:**
- Only Claude Code is supported. Other AI coding tools are out of scope.
- Hook reliability varies: SubagentStart/SubagentStop hooks are unreliable; agent identity is inferred from `agent_id` fields on PreToolUse/PostToolUse events instead.
- Hook data is a projection of events, not a complete API trace. Some fields (token counts) require reading Claude Code transcript files separately.
