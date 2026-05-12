# Tarsa Patches to cc-web

cc-web (`claude-code-web`, MIT) is vendored under this directory and modified
in-tree. Every change is tagged with a `// TARSA PATCH:` comment so the diff
against upstream is greppable.

Upstream: https://github.com/vultuk/claude-code-web

| Patch | File | Purpose |
|---|---|---|
| Single-session mode | `src/public/app.js`, `src/public/style.css` | When loaded with `?single=1`, hide the session-tab bar so the embedded per-agent Terminal in Tarsa shows exactly one cc-web session. |
| Force-new-project mode | `src/public/app.js` | When loaded with `?action=newproject`, jump straight to the folder picker (used by Tarsa's `+ terminal` flow). |
| Auto-restart claude in single mode | `src/public/app.js` | When an embedded session's claude exits or starts fresh and `?single=1` is active, auto-call `startClaudeSession()` so the iframe never strands the user on a blank shell with no visible Start button. |
| Deeplink to specific session | `src/public/app.js` | When loaded with `?session=<cc-id>`, switch to that tab on init instead of always picking the oldest session in the Map. Lets Tarsa target the agent's matching cc-web session. |
| Resume Claude Code session | `src/public/app.js`, `src/server.js`, `src/claude-bridge.js` | When loaded with `?resume=<claude-session-id>`, pass `resumeSessionId` through `start_claude` → `claudeBridge.startSession` → `claude --resume <id>` so the embedded terminal reopens the agent's actual conversation. The id is validated against `^[A-Za-z0-9._-]{1,128}$` before reaching argv. |

## Update procedure

1. Pull upstream into a scratch clone.
2. `diff -r` against `vendor/cc-web/`.
3. Apply non-conflicting upstream changes; re-apply Tarsa patches if upstream
   touched the same lines. Each TARSA PATCH block has explanatory comments so
   re-applying after upstream churn is mechanical.
4. Run `bun bin/tarsa.mjs` and exercise the Terminal tab end-to-end:
   - new session via `+ terminal`
   - click a known agent → resume into existing transcript
   - click an agent whose transcript was deleted → fresh claude in same cwd
