# Tarsa vs claude-view — feature & accuracy comparison

Comparison against [claudeview.ai](https://claudeview.ai/#features) (public beta).
Scope: the **local observability** surface that both tools share. Tarsa is
deliberately local-only and Claude-Code-only, so claude-view's cloud/mobile/
commercial features are out of scope by design, not by omission.

## Parity on shared (local observability) features

| Feature | claude-view | Tarsa | Notes |
|---|---|---|---|
| Real-time dashboard | ✅ | ✅ | Global / Topology / Timeline / Replay views, live SSE |
| Sub-agent tree visualization | ✅ | ✅ | Topology view with parent/child edges |
| Hook event timeline | ✅ | ✅ | Timeline view (Gantt) + Replay event log |
| Session search | ✅ (Rust grep) | ✅ | `src/search.ts` full-text index over events |
| Cost tracking | ✅ | ✅ | Per-agent + per-session + per-commit USD |
| Cost / token breakdown (input/output/cache read/write) | ✅ (hover) | ✅ | Color-coded Token Breakdown card in Insights |
| Cache efficiency metric | ✅ ("94% cache") | ✅ | Cache hit-rate = cacheRead / (input + cacheRead + cacheWrite) |
| AI Fluency Score | ✅ | ✅ | 0–100 + grade, 4 weighted components |
| Live updates | ✅ | ✅ | SSE event stream |
| 100% local / zero telemetry | ✅ | ✅ | Events in `~/.tarsa`, no cloud calls |
| Embedded terminal | — | ✅ | Tarsa embeds cc-web; claude-view does not advertise this |
| Context-window fill % + cache TTL countdown | — | ✅ | Tarsa Insights + Monitor mode |
| Monitor mode (focused single agent) | partial | ✅ | Full-screen single-agent live view |
| Git context on events (commit/branch/dirty) | partial (branch drift) | ✅ | Captured per event; powers per-commit cost |
| Per-commit cost analytics | — | ✅ | `GET /api/commits/:sha/cost` |
| Budget guardrail (alert/kill on exceed) | — | ✅ | Per-session budget with measured-token detection |

## Accuracy

- **Measured-first.** When a transcript is available, cost uses Anthropic
  API-reported token counts (`source: "measured"`), including cache read and
  cache write — the categories that dominate real Claude Code spend.
- **Honest fallback.** Without a transcript, Tarsa falls back to event-token
  fields, then a char/4 heuristic, and labels the result (`estimated_chars`)
  with a `~est (N% measured)` coverage badge — it never presents an estimate
  as a measured figure.
- **Cache-aware budget.** Budget-exceeded detection uses measured tokens incl.
  cache, so it does not silently undercount.
- **Cache efficiency** is derived from the same measured token fields, so the
  "% cache" figure is consistent with the cost numbers shown beside it.

## Deliberately out of scope (claude-view has, Tarsa does not)

These are not gaps — they conflict with Tarsa's stated vision (hook-based,
Claude-Code-only, local-only, viewer-not-controller):

- **Cloud relay / mobile app / remote agent control** — Tarsa is local-only and
  read-only; it observes, it does not approve/reject tool calls or relay to a
  phone.
- **Encrypted session sharing** — requires a cloud trust boundary.
- **Commercial tiers (Pro/Max/Team/Enterprise, SSO, SCIM, audit logs)** — Tarsa
  is MIT/OSS, not a SaaS.
- **Kanban swimlanes** — claude-view groups agents into project/branch
  swimlanes. Tarsa's Global view already groups by session and has a project
  filter; a dedicated swimlane layout is a possible future UI option, not an
  accuracy gap.
- **Branch drift detection** — Tarsa captures git branch/commit per event; a
  dedicated drift detector is a possible follow-up built on that data.

## Verdict

On the shared local-observability surface Tarsa is at parity or ahead, and its
cost/cache numbers are at least as accurate (measured-first, honest fallback,
cache-aware). The features claude-view has that Tarsa lacks are its commercial
and cloud surface, which are intentionally outside Tarsa's scope.
