# ADR-0005: Remote Auth Token (Jupyter-Style)

**Status:** Accepted

## Context

When `--allow-remote` is set, Tarsa's mutating endpoints are reachable from any network interface. Without authentication, any machine that can reach the server can wipe state, manipulate budgets, or spawn processes. An authentication mechanism is needed that:

- Adds zero overhead when not in remote mode.
- Requires no interactive setup (passwords, OAuth flows).
- Is familiar to developer-tooling users.

Jupyter Notebook uses a file-based token delivered via URL query parameter (`?token=`). This pattern was evaluated against password prompts, mTLS, and always-on auth.

## Decision

When `--allow-remote` is active:

1. On startup, generate a 32-byte cryptographically random hex token.
2. Write the token to `~/.tarsa/token` with permissions `0o600`.
3. Log the token file path to stderr: `[tarsa] Auth token: ~/.tarsa/token`.
4. The auto-opened browser URL includes `?token=<value>` as a query parameter.
5. The frontend reads the token from `window.location.search` on first load, stores it in `sessionStorage`, and attaches it as `Authorization: Bearer <token>` on all POST requests.
6. All POST routes require a valid `Authorization: Bearer <token>` header; missing or wrong token returns 401.
7. CORS `allowHeaders` is extended to include `Authorization` only in remote mode.

Token is rotated on every server restart (file overwritten, not appended).

## Tradeoffs

**URL and history visibility:** The token appears in the browser URL bar and is stored in browser history. This is an accepted tradeoff, consistent with Jupyter's approach. Mitigations: use incognito mode, clear browser history after session, or use `--no-browser` and distribute the URL manually.

**Localhost mode is unaffected:** No token file, no middleware, no CORS changes. This is the 95%+ use case.

## Consequences

**Positive:**
- Zero friction: token is auto-generated and auto-delivered via URL.
- Follows established Jupyter precedent familiar to the target audience.
- Protects all three dangerous surfaces: reset, budget, spawn.
- CSRF for `/api/budget` remains as a defense-in-depth layer alongside token auth.

**Negative:**
- Token visible in URL bar and browser history in remote mode.
- Scripts calling POST endpoints in remote mode must read and pass the token.
- Token file requires Unix `chmod 0o600`; best-effort on Windows (documented limitation).
