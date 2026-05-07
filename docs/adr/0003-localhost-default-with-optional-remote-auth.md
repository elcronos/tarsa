# ADR-0003: Localhost Default with Optional Remote Auth

**Status:** Accepted

## Context

ClaudeLens binds its HTTP server on `:8100`. The bind address and authentication posture determine the attack surface for the mutating endpoints (`POST /api/reset`, `POST /api/budget`, `POST /api/spawn`).

Two postures were evaluated:

1. **Always bind `0.0.0.0`, no auth:** Simple; any client on any interface can reach the server.
2. **Bind `127.0.0.1` by default; `0.0.0.0` only with explicit `--allow-remote` flag + mandatory auth token.**

## Decision

The server binds `127.0.0.1` by default. Remote access requires the user to pass `--allow-remote` (optionally combined with `--host <addr>`). Passing `--host 0.0.0.0` without `--allow-remote` is rejected at startup with an error message.

When `--allow-remote` is set, a Jupyter-style auth token is generated and all auth machinery activates. When `--allow-remote` is NOT set, no token is generated, no auth middleware is registered, and no CORS headers are modified. Zero UX tax in the default case.

See ADR-0005 for the token delivery mechanism used in remote mode.

## Consequences

**Positive:**
- Default users (the vast majority) experience no auth friction at all.
- Remote state wipe via unauthenticated `POST /api/reset` is impossible unless the user explicitly opts into remote mode.
- Clear, auditable surface: auth presence is entirely controlled by a single CLI flag.

**Negative:**
- Any process running as the same local user can still reach `127.0.0.1:8100` in default mode. This is an accepted risk for a single-user dev tool.
- Remote mode users must manage the token file (`~/.claudelens/token`) and pass it in scripts that call POST endpoints.
