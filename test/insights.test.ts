/**
 * Tests for insights.ts — bottleneck, cost estimation, parallelism gaps, stuck signals.
 */

import { describe, it, expect } from "vitest";
import { bottleneck, costEstimate, contextUsage, parallelismGaps, stuckSignals, SONNET_INPUT, SONNET_OUTPUT, OPUS_INPUT, OPUS_OUTPUT } from "../src/insights.js";
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

function makeEvent(overrides: Partial<Event>): Event {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: "sess-1",
    ts: Date.now(),
    hook_event: "PreToolUse",
    ...overrides,
  };
}

function makeToolCall(id: string, agentId: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    agent_id: agentId,
    tool_name: "Bash",
    input: { command: "echo hi" },
    input_preview: "echo hi",
    started_ms: 1000,
    ended_ms: 2000,
    status: "done",
    output_preview: "hi",
    response: "hi",
    duration_ms: 1000,
    retry_of: null,
    ...overrides,
  };
}

// ── bottleneck ─────────────────────────────────────────────────────────

describe("bottleneck", () => {
  it("returns nulls for empty state", () => {
    const state = makeState([]);
    const result = bottleneck(state);
    expect(result.longestAgent).toBeNull();
    expect(result.highestErrorAgent).toBeNull();
  });

  it("identifies the longest-duration agent", () => {
    const fast = makeAgent("fast", { first_seen_ms: 0, last_seen_ms: 1000 });
    const slow = makeAgent("slow", { first_seen_ms: 0, last_seen_ms: 9000 });
    const state = makeState([fast, slow]);
    const result = bottleneck(state);
    expect(result.longestAgent?.id).toBe("slow");
    expect(result.longestDurationMs).toBe(9000);
  });

  it("identifies the highest-error agent", () => {
    const low = makeAgent("low-err", { error_count: 1 });
    const high = makeAgent("high-err", { error_count: 7 });
    const state = makeState([low, high]);
    const result = bottleneck(state);
    expect(result.highestErrorAgent?.id).toBe("high-err");
    expect(result.highestErrorCount).toBe(7);
  });

  it("handles multiple agents correctly", () => {
    const agents = [
      makeAgent("a", { first_seen_ms: 0, last_seen_ms: 5000, error_count: 2 }),
      makeAgent("b", { first_seen_ms: 0, last_seen_ms: 3000, error_count: 5 }),
      makeAgent("c", { first_seen_ms: 0, last_seen_ms: 8000, error_count: 1 }),
    ];
    const state = makeState(agents);
    const result = bottleneck(state);
    expect(result.longestAgent?.id).toBe("c");
    expect(result.highestErrorAgent?.id).toBe("b");
  });
});

// ── costEstimate ───────────────────────────────────────────────────────

describe("costEstimate", () => {
  it("returns zero cost for agents with no token data", () => {
    const state = makeState([makeAgent("a")]);
    const result = costEstimate(state);
    expect(result.totalUsd).toBe(0);
    expect(result.perAgent[0]?.usd).toBe(0);
  });

  it("computes correct Sonnet cost from token events", () => {
    const agent = makeAgent("sonnet-ag");
    // 1M input tokens + 1M output tokens at Sonnet rates
    const events: Event[] = [
      makeEvent({ agent_id: "sonnet-ag", input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ];
    const state = makeState([agent], events);
    const result = costEstimate(state);
    const expected = (1_000_000 / 1_000_000) * SONNET_INPUT + (1_000_000 / 1_000_000) * SONNET_OUTPUT;
    expect(result.totalUsd).toBeCloseTo(expected, 5);
  });

  it("computes correct Opus cost when model contains opus", () => {
    const agent = makeAgent("opus-ag");
    const events: Event[] = [
      makeEvent({ agent_id: "opus-ag", input_tokens: 1_000_000, output_tokens: 1_000_000, model: "claude-opus-4-7" }),
    ];
    const state = makeState([agent], events);
    const result = costEstimate(state);
    const expected = (1_000_000 / 1_000_000) * OPUS_INPUT + (1_000_000 / 1_000_000) * OPUS_OUTPUT;
    expect(result.totalUsd).toBeCloseTo(expected, 5);
  });

  it("sums tokens across multiple events for same agent", () => {
    const agent = makeAgent("multi-ag");
    const events: Event[] = [
      makeEvent({ agent_id: "multi-ag", input_tokens: 500_000, output_tokens: 0 }),
      makeEvent({ agent_id: "multi-ag", input_tokens: 500_000, output_tokens: 200_000 }),
    ];
    const state = makeState([agent], events);
    const result = costEstimate(state);
    // 1M input + 200k output at Sonnet rates
    const expected = (1_000_000 / 1_000_000) * SONNET_INPUT + (200_000 / 1_000_000) * SONNET_OUTPUT;
    expect(result.totalUsd).toBeCloseTo(expected, 5);
  });

  it("pricing constants are correct", () => {
    expect(SONNET_INPUT).toBe(3);
    expect(SONNET_OUTPUT).toBe(15);
    expect(OPUS_INPUT).toBe(15);
    expect(OPUS_OUTPUT).toBe(75);
  });

  it("aggregates totalUsd across multiple agents", () => {
    const a1 = makeAgent("a1");
    const a2 = makeAgent("a2");
    const events: Event[] = [
      makeEvent({ agent_id: "a1", input_tokens: 100_000, output_tokens: 10_000 }),
      makeEvent({ agent_id: "a2", input_tokens: 200_000, output_tokens: 20_000 }),
    ];
    const state = makeState([a1, a2], events);
    const result = costEstimate(state);
    expect(result.perAgent).toHaveLength(2);
    expect(result.totalUsd).toBeGreaterThan(0);
    const sum = result.perAgent.reduce((acc, a) => acc + a.usd, 0);
    expect(result.totalUsd).toBeCloseTo(sum, 6);
  });
});

// ── parallelismGaps ────────────────────────────────────────────────────

describe("parallelismGaps", () => {
  it("returns empty for single agent", () => {
    const state = makeState([makeAgent("solo")]);
    expect(parallelismGaps(state)).toHaveLength(0);
  });

  it("detects sequential siblings with no dependency", () => {
    const parent = makeAgent("parent");
    const a = makeAgent("a", { parent_id: "parent", first_seen_ms: 0, last_seen_ms: 5000 });
    const b = makeAgent("b", { parent_id: "parent", first_seen_ms: 6000, last_seen_ms: 10000 });
    const state = makeState([parent, a, b]);
    const gaps = parallelismGaps(state);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.agents).toEqual(["a", "b"]);
    expect(gaps[0]!.overlapOpportunityMs).toBe(1000);
  });

  it("does not flag agents that already overlap in time", () => {
    const parent = makeAgent("parent");
    const a = makeAgent("a", { parent_id: "parent", first_seen_ms: 0, last_seen_ms: 8000 });
    const b = makeAgent("b", { parent_id: "parent", first_seen_ms: 3000, last_seen_ms: 10000 });
    const state = { ...makeState([parent, a, b]) };
    const gaps = parallelismGaps(state);
    expect(gaps).toHaveLength(0);
  });

  it("sorts gaps by largest opportunity first", () => {
    const parent = makeAgent("parent");
    const a = makeAgent("a", { parent_id: "parent", first_seen_ms: 0, last_seen_ms: 1000 });
    const b = makeAgent("b", { parent_id: "parent", first_seen_ms: 6000, last_seen_ms: 8000 }); // gap=5000
    const c = makeAgent("c", { parent_id: "parent", first_seen_ms: 9000, last_seen_ms: 11000 }); // gap=1000
    const state = makeState([parent, a, b, c]);
    const gaps = parallelismGaps(state);
    expect(gaps.length).toBeGreaterThan(0);
    // Largest gap first
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i - 1]!.overlapOpportunityMs).toBeGreaterThanOrEqual(gaps[i]!.overlapOpportunityMs);
    }
  });
});

// ── stuckSignals ───────────────────────────────────────────────────────

describe("stuckSignals", () => {
  it("returns empty for agent with no tool calls", () => {
    const agent = makeAgent("quiet", { status: "active" });
    const state = makeState([agent], [], new Map([["quiet", []]]));
    expect(stuckSignals(state)).toHaveLength(0);
  });

  it("does not flag done agents", () => {
    const agent = makeAgent("done-ag", { status: "done" });
    const calls = Array.from({ length: 5 }, (_, i) =>
      makeToolCall(`tc-${i}`, "done-ag", { tool_name: "Bash", input: { command: "echo hi" }, status: "error" })
    );
    const state = makeState([agent], [], new Map([["done-ag", calls]]));
    expect(stuckSignals(state)).toHaveLength(0);
  });

  it("detects repeated tool calls with same input", () => {
    const agent = makeAgent("looping", { status: "active" });
    const now = Date.now();
    const calls = Array.from({ length: 4 }, (_, i) =>
      makeToolCall(`tc-${i}`, "looping", {
        tool_name: "Bash",
        input: { command: "echo hi" },
        started_ms: now + i * 1000,
        status: "done",
      })
    );
    const state = makeState([agent], [], new Map([["looping", calls]]));
    const signals = stuckSignals(state);
    expect(signals.some((s) => s.reason === "repeated_tool")).toBe(true);
  });

  it("detects consecutive failures", () => {
    const agent = makeAgent("failing", { status: "active" });
    const calls: ToolCall[] = [
      makeToolCall("tc-ok", "failing", { status: "done" }),
      makeToolCall("tc-e1", "failing", { tool_name: "Read", input: { file_path: "x.ts" }, status: "error" }),
      makeToolCall("tc-e2", "failing", { tool_name: "Read", input: { file_path: "y.ts" }, status: "error" }),
      makeToolCall("tc-e3", "failing", { tool_name: "Read", input: { file_path: "z.ts" }, status: "error" }),
    ];
    const state = makeState([agent], [], new Map([["failing", calls]]));
    const signals = stuckSignals(state);
    expect(signals.some((s) => s.reason === "consecutive_failures")).toBe(true);
    const sig = signals.find((s) => s.reason === "consecutive_failures")!;
    expect(sig.count).toBe(3);
  });

  it("does not flag consecutive failures below threshold", () => {
    const agent = makeAgent("minor-err", { status: "active" });
    const calls: ToolCall[] = [
      makeToolCall("tc-ok", "minor-err", { status: "done" }),
      makeToolCall("tc-e1", "minor-err", { status: "error" }),
      makeToolCall("tc-e2", "minor-err", { status: "error" }),
    ];
    const state = makeState([agent], [], new Map([["minor-err", calls]]));
    const signals = stuckSignals(state);
    expect(signals.filter((s) => s.reason === "consecutive_failures")).toHaveLength(0);
  });
});

// ── contextUsage ────────────────────────────────────────────────────────

describe("contextUsage", () => {
  it("computes fillPercent = 85 for 50k input + 100k cache_read + 20k cache_creation on Sonnet", () => {
    const agent = makeAgent("a1", { status: "active" });
    const state = makeState([agent]);
    const tokensMap = {
      a1: { input_tokens: 50_000, output_tokens: 0, cache_read: 100_000, cache_creation: 20_000 },
    };
    const result = contextUsage(state, tokensMap);
    expect(result.perAgent).toHaveLength(1);
    const row = result.perAgent[0]!;
    // (50000 + 100000 + 20000) / 200000 * 100 = 85
    expect(row.fillPercent).toBe(85);
    expect(row.tokensInContext).toBe(170_000);
    expect(row.contextWindow).toBe(200_000);
  });

  it("picks max timestamp across multiple cache_creation events for lastCacheWriteMs", () => {
    const agent = makeAgent("a2", { status: "active" });
    const events: Event[] = [
      { id: "e1", hook_event: "PostToolUse", ts: 1000, session_id: "sess-1", agent_id: "a2", cache_creation: 5000 },
      { id: "e2", hook_event: "PostToolUse", ts: 3000, session_id: "sess-1", agent_id: "a2", cache_creation: 2000 },
      { id: "e3", hook_event: "PostToolUse", ts: 2000, session_id: "sess-1", agent_id: "a2", cache_creation: 1000 },
    ];
    const state = makeState([agent], events);
    const result = contextUsage(state);
    const row = result.perAgent[0]!;
    expect(row.lastCacheWriteMs).toBe(3000);
    expect(row.cacheExpiresMs).toBe(3000 + 300_000);
  });

  it("excludes done agents", () => {
    const active = makeAgent("active", { status: "active" });
    const done = makeAgent("done", { status: "done" });
    const state = makeState([active, done]);
    const result = contextUsage(state);
    expect(result.perAgent.map((r) => r.agentId)).not.toContain("done");
    expect(result.perAgent.map((r) => r.agentId)).toContain("active");
  });

  it("returns null lastCacheWriteMs and cacheExpiresMs when no cache_creation events", () => {
    const agent = makeAgent("a3", { status: "active" });
    const state = makeState([agent]);
    const result = contextUsage(state);
    const row = result.perAgent[0]!;
    expect(row.lastCacheWriteMs).toBeNull();
    expect(row.cacheExpiresMs).toBeNull();
  });
});
