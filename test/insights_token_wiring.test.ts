/**
 * Tests for US-V2-04 — wire transcript tokens into per-agent cost attribution.
 */

import { describe, it, expect } from "vitest";
import { costEstimate, detectBudgetExceeded, SONNET_INPUT, SONNET_OUTPUT } from "../src/insights.js";
import type { Agent, State, Event, ToolCall, Session } from "../src/models.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    parent_id: null,
    session_id: "sess-1",
    status: "done",
    subagent_type: "executor",
    description: id,
    prompt: null,
    first_seen_ms: 1000,
    last_seen_ms: 2000,
    tool_count: 1,
    error_count: 0,
    children: [],
    result: null,
    ...overrides,
  };
}

function makeState(agents: Agent[], events: Event[] = [], toolCalls: Map<string, ToolCall[]> = new Map()): State {
  const agentMap = new Map<string, Agent>(agents.map((a) => [a.id, a]));
  const session: Session = {
    id: "sess-1",
    started_at: 0,
    ended_at: null,
    project_path: "",
    root_agent_id: "root",
    status: "active",
    name: null,
  };
  return {
    sessions: new Map([["sess-1", session]]),
    agents: agentMap,
    edges: [],
    tool_calls: toolCalls,
    events,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("costEstimate with perAgentTokens (US-V2-04)", () => {
  it("uses measured tokens when tokensMap has entry for agent", () => {
    const agent = makeAgent("ag-1");
    const state = makeState([agent]);

    const tokensMap = {
      "ag-1": { input_tokens: 100_000, output_tokens: 10_000, cache_read: 0, cache_creation: 0 },
    };

    const result = costEstimate(state, tokensMap);
    const expectedUsd =
      (100_000 / 1_000_000) * SONNET_INPUT + (10_000 / 1_000_000) * SONNET_OUTPUT;

    expect(result.perAgent[0]?.source).toBe("measured");
    expect(result.perAgent[0]?.inputTokens).toBe(100_000);
    expect(result.perAgent[0]?.outputTokens).toBe(10_000);
    expect(result.perAgent[0]?.usd).toBeCloseTo(expectedUsd, 6);
    expect(result.source).toBe("measured");
    expect(result.totalUsd).toBeCloseTo(expectedUsd, 6);
  });

  it("falls back to estimated source when tokensMap has no entry for agent", () => {
    const agent = makeAgent("ag-no-tokens");
    // Give it tool calls so it uses estimated_chars fallback
    const tc: ToolCall = {
      id: "tc-1",
      agent_id: "ag-no-tokens",
      tool_name: "Bash",
      input: { command: "echo hello" },
      input_preview: "echo hello",
      started_ms: 1000,
      ended_ms: 2000,
      status: "done",
      output_preview: "hello",
      response: "hello",
      duration_ms: 1000,
      retry_of: null,
    };
    const state = makeState([agent], [], new Map([["ag-no-tokens", [tc]]]));

    // Pass empty tokensMap — agent not in it
    const result = costEstimate(state, {});
    expect(result.perAgent[0]?.source).not.toBe("measured");
    expect(result.source).not.toBe("measured");
  });

  it("mixed agents: one measured, one fallback — top-level source is measured", () => {
    const a1 = makeAgent("measured-ag");
    const a2 = makeAgent("fallback-ag");
    const state = makeState([a1, a2]);

    const tokensMap = {
      "measured-ag": { input_tokens: 50_000, output_tokens: 5_000, cache_read: 0, cache_creation: 0 },
      // fallback-ag intentionally missing
    };

    const result = costEstimate(state, tokensMap);
    const m = result.perAgent.find((a) => a.agentId === "measured-ag")!;
    const f = result.perAgent.find((a) => a.agentId === "fallback-ag")!;

    expect(m.source).toBe("measured");
    expect(f.source).not.toBe("measured");
    // Top-level source: measured if any agent is measured
    expect(result.source).toBe("measured");
  });

  it("token math is correct: 1M input + 1M output at Sonnet rates", () => {
    const agent = makeAgent("math-ag");
    const state = makeState([agent]);

    const tokensMap = {
      "math-ag": { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read: 0, cache_creation: 0 },
    };

    const result = costEstimate(state, tokensMap);
    const expected = SONNET_INPUT + SONNET_OUTPUT; // both per-million rates
    expect(result.totalUsd).toBeCloseTo(expected, 5);
    expect(result.perAgent[0]?.usd).toBeCloseTo(expected, 5);
  });

  it("zero tokens in tokensMap does not produce measured source", () => {
    const agent = makeAgent("zero-ag");
    const state = makeState([agent]);

    const tokensMap = {
      "zero-ag": { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_creation: 0 },
    };

    const result = costEstimate(state, tokensMap);
    // Entry exists but has no tokens — should fall through to tool_count_fallback
    expect(result.perAgent[0]?.source).not.toBe("measured");
  });

  it("undefined tokensMap falls back to event-based estimation", () => {
    const agent = makeAgent("event-ag");
    const events: Event[] = [
      {
        id: "ev-1",
        session_id: "sess-1",
        ts: Date.now(),
        hook_event: "PreToolUse",
        agent_id: "event-ag",
        input_tokens: 200_000,
        output_tokens: 20_000,
      },
    ];
    const state = makeState([agent], events);

    const result = costEstimate(state); // no tokensMap
    expect(result.perAgent[0]?.inputTokens).toBe(200_000);
    expect(result.perAgent[0]?.outputTokens).toBe(20_000);
    // source is tool_count_fallback (not "measured") when using event fields
    expect(result.perAgent[0]?.source).toBe("tool_count_fallback");
  });
});

describe("detectBudgetExceeded with tokensMap", () => {
  it("counts measured cache tokens against the budget", () => {
    const agent = makeAgent("cache-ag");
    const state = makeState([agent]);
    state.sessions.get("sess-1")!.budget_usd = 1.0;

    // Heavy cache_read — the dominant token type in Claude Code sessions.
    const tokensMap = {
      "cache-ag": {
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 10_000_000,
        cache_creation: 0,
      },
    };

    // Without tokensMap: no events, no tool calls → cost 0 → budget not crossed.
    expect(detectBudgetExceeded(state)).toHaveLength(0);

    // With tokensMap: measured cache tokens are priced and cross the budget.
    const exceeded = detectBudgetExceeded(state, tokensMap);
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.session_id).toBe("sess-1");
    expect(exceeded[0]?.current).toBeGreaterThan(exceeded[0]!.budget);
  });
});
