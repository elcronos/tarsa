# ClaudeLens Security

## Threat model

ClaudeLens is a **localhost-only** developer tool. It binds exclusively to
`127.0.0.1` and is not designed to be exposed to untrusted networks. The
assumptions below hold only when that constraint is respected.

---

## Design boundaries

### Loopback isolation

The HTTP server binds to `127.0.0.1` only. Do **not** expose port 8100 via
port-forwarding, reverse proxies, or `0.0.0.0` binds. Anyone who can reach
the port has full read access to your agent telemetry.

### No authentication

ClaudeLens relies on OS-level loopback isolation rather than username/password
or API-key authentication. This is intentional for a single-user CLI tool; it
is not appropriate for shared or multi-tenant environments.

### JSONL event log (trust boundary)

The event log at `~/.claudelens/events.jsonl` is created with mode **0600**
(owner-readable only). Anyone who can write to this file can inject arbitrary
events into the dashboard. The default location restricts write access to the
local user; do not change the permissions or move the file to a shared
directory.

### Transcript reader allowlist

The transcript reader (`src/transcript.ts`) only reads files whose realpath
starts with `~/.claude/projects/`. Requests for files outside this prefix
(e.g. `/etc/passwd`) are silently rejected and return an empty array. The
realpath check handles macOS `/System/Volumes/Data/` symlinks at module load
time.

### Static file handler

The static-file catch-all (`src/server.ts`) resolves the requested path via
`fs.realpathSync` and verifies containment inside the pre-resolved `STATIC_DIR`
before serving any file. Paths that escape the static directory return 404.
Hono decodes the URL path once; the handler does **not** call
`decodeURIComponent` again to prevent double-decode bypasses.

### CSRF protection for state-changing endpoints

Any web page the user visits can issue no-cors POST requests to
`localhost:8100` — this is a real browser-tab threat even on loopback. To
mitigate this, `POST /api/budget` (and future state-changing endpoints) require
an `X-Claudelens-CSRF` header containing a token issued by the SSE stream:

1. When a browser tab opens the SSE stream, the server generates a
   `crypto.randomBytes(16)` token and sends it as the first SSE event.
2. The browser stores this token and includes it in the `X-Claudelens-CSRF`
   header on every mutation request.
3. Tokens are scoped per SSE connection and cleaned up on disconnect.
4. Each connection is rate-limited to 60 budget POSTs per minute.

A cross-origin page cannot read SSE responses (same-origin policy), so token
possession proves the requester also has read access — it does not prove
identity.

### SSE connection cap

The server accepts at most **32** concurrent SSE connections. A 33rd connection
is rejected with HTTP 429. This prevents unbounded memory growth from stale
browser tabs or HMR reconnection loops.

---

## Reporting security issues

Please open an issue at **https://github.com/elcronos/claudelens** with the
label `security`. For sensitive disclosures, email the repository maintainer
directly before public disclosure.
