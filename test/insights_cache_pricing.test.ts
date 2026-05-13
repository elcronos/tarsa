/**
 * Tests for cache token wiring in costEstimate (task 001).
 *
 * Asserts that `cache_read` and `cache_creation` from tokensMap flow into
 * USD math at correct per-model rates, that haiku detection works, and that
 * the AgentCost shape exposes cache token counts.
 */

import { describe, it, expect } from "vitest";
import { costEstimate, pricedCoveragePercent } from "../src/insights.js";
import {
  PRICING,
  detectModel,
  priceUsd,
} from "../src/shared/pricing.js";
import type { Agent, State, Event, Session } from "../src/models.js";

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

function makeState(agents: Agent[], events: Event[] = []): State {
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
    tool_calls: new Map(),
    events,
    pending_subagents: new Map(),
    iterations: new Map(),
  };
}

describe("pricing module", () => {
  it("Sonnet 4.5 rates", () => {
    expect(PRICING.sonnet).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it("Opus 4.7 rates", () => {
    expect(PRICING.opus).toEqual({
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite: 18.75,
    });
  });

  it("Haiku 4.5 rates", () => {
    expect(PRICING.haiku).toEqual({
      input: 0.8,
      output: 4,
      cacheRead: 0.08,
      cacheWrite: 1.0,
    });
  });

  it("detectModel handles haiku before opus before sonnet", () => {
    expect(detectModel("claude-haiku-4-5")).toBe("haiku");
    expect(detectModel("claude-opus-4-7")).toBe("opus");
    expect(detectModel("claude-sonnet-4-5")).toBe("sonnet");
    expect(detectModel("unknown")).toBe("sonnet");
    expect(detectModel(null)).toBe("sonnet");
  });

  it("priceUsd: 1M each at Sonnet → 22.05 USD", () => {
    expect(priceUsd(1_000_000, 1_000_000, 1_000_000, 1_000_000, "sonnet")).toBeCloseTo(
      3 + 15 + 0.3 + 3.75,
      6
    );
  });
});

describe("costEstimate cache token wiring", () => {
  it("acceptance: 1M input + 1M output + 1M cache_read + 1M cache_write @ Sonnet → 22.05", () => {
    const agent = makeAgent("ag-1");
    const state = makeState([agent]);
    const tokensMap = {
      "ag-1": {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read: 1_000_000,
        cache_creation: 1_000_000,
      },
    };
    const result = costEstimate(state, tokensMap);
    expect(result.perAgent[0]?.usd).toBeCloseTo(22.05, 4);
    expect(result.totalUsd).toBeCloseTo(22.05, 4);
    expect(result.source).toBe("measured");
  });

  it("AgentCost exposes cacheReadTokens and cacheCreationTokens", () => {
    const agent = makeAgent("ag-2");
    const state = makeState([agent]);
    const tokensMap = {
      "ag-2": {
        input_tokens: 10,
        output_tokens: 20,
        cache_read: 30,
        cache_creation: 40,
      },
    };
    const result = costEstimate(state, tokensMap);
    const row = result.perAgent[0]!;
    expect(row.cacheReadTokens).toBe(30);
    expect(row.cacheCreationTokens).toBe(40);
    expect(row.inputTokens).toBe(10);
    expect(row.outputTokens).toBe(20);
  });

  it("cache tokens alone count as measured", () => {
    const agent = makeAgent("ag-cache-only");
    const state = makeState([agent]);
    const tokensMap = {
      "ag-cache-only": {
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 500_000,
        cache_creation: 0,
      },
    };
    const result = costEstimate(state, tokensMap);
    expect(result.perAgent[0]?.source).toBe("measured");
    expect(result.perAgent[0]?.usd).toBeCloseTo((500_000 / 1_000_000) * 0.3, 6);
  });

  it("haiku detection priced as haiku, not sonnet", () => {
    const agent = makeAgent("haiku-ag");
    const events: Event[] = [
      {
        id: "ev-1",
        session_id: "sess-1",
        ts: 1,
        hook_event: "PreToolUse",
        agent_id: "haiku-ag",
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        model: "claude-haiku-4-5",
      },
    ];
    const state = makeState([agent], events);
    const result = costEstimate(state);
    expect(result.perAgent[0]?.model).toBe("haiku");
    // 1M * 0.8 + 1M * 4 = 4.8
    expect(result.perAgent[0]?.usd).toBeCloseTo(4.8, 5);
  });

  it("opus detection still works", () => {
    const agent = makeAgent("opus-ag");
    const events: Event[] = [
      {
        id: "ev-1",
        session_id: "sess-1",
        ts: 1,
        hook_event: "PreToolUse",
        agent_id: "opus-ag",
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        model: "claude-opus-4-7",
      },
    ];
    const state = makeState([agent], events);
    const result = costEstimate(state);
    expect(result.perAgent[0]?.model).toBe("opus");
    expect(result.perAgent[0]?.usd).toBeCloseTo(90, 5);
  });

  it("pricedCoveragePercent: 3 measured + 1 estimated → 75%", () => {
    const agents = [
      makeAgent("a1"),
      makeAgent("a2"),
      makeAgent("a3"),
      makeAgent("a4"),
    ];
    const state = makeState(agents);
    const tokensMap = {
      a1: { input_tokens: 100, output_tokens: 100, cache_read: 0, cache_creation: 0 },
      a2: { input_tokens: 100, output_tokens: 100, cache_read: 0, cache_creation: 0 },
      a3: { input_tokens: 100, output_tokens: 100, cache_read: 0, cache_creation: 0 },
      // a4 absent from tokensMap → falls to tool_count_fallback / estimated
    };
    const result = costEstimate(state, tokensMap);
    expect(pricedCoveragePercent(result)).toBe(75);
  });

  it("pricedCoveragePercent: empty → 100", () => {
    const state = makeState([]);
    const result = costEstimate(state);
    expect(pricedCoveragePercent(result)).toBe(100);
  });

  it("pricedCoveragePercent: all measured → 100", () => {
    const agents = [makeAgent("m1"), makeAgent("m2")];
    const state = makeState(agents);
    const tokensMap = {
      m1: { input_tokens: 10, output_tokens: 10, cache_read: 0, cache_creation: 0 },
      m2: { input_tokens: 10, output_tokens: 10, cache_read: 0, cache_creation: 0 },
    };
    const result = costEstimate(state, tokensMap);
    expect(pricedCoveragePercent(result)).toBe(100);
  });

  it("cache tokens from event stream also flow into cost", () => {
    const agent = makeAgent("ev-cache");
    const events: Event[] = [
      {
        id: "ev-1",
        session_id: "sess-1",
        ts: 1,
        hook_event: "PreToolUse",
        agent_id: "ev-cache",
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 1_000_000,
        cache_creation: 1_000_000,
      },
    ];
    const state = makeState([agent], events);
    const result = costEstimate(state);
    // sonnet default: 0.3 + 3.75 = 4.05
    expect(result.perAgent[0]?.usd).toBeCloseTo(4.05, 5);
    expect(result.perAgent[0]?.cacheReadTokens).toBe(1_000_000);
    expect(result.perAgent[0]?.cacheCreationTokens).toBe(1_000_000);
  });
});
