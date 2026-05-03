/**
 * Tests for agentPerformanceTable() in insights.ts
 */

import { describe, it, expect } from "vitest";
import { agentPerformanceTable, costEstimate } from "../src/insights.js";
import type { Agent, State, Event, ToolCall, Session } from "../src/models.js";

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
    first_seen_ms: 0,
    last_seen_ms: 3000,
    tool_count: 5,
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

describe("agentPerformanceTable", () => {
  it("returns empty array for empty state", () => {
    const state = makeState([]);
    const cost = costEstimate(state);
    expect(agentPerformanceTable(state, cost)).toHaveLength(0);
  });

  it("returns one row per agent with correct fields", () => {
    const agents = [
      makeAgent("a1", { first_seen_ms: 0, last_seen_ms: 5000, tool_count: 3, error_count: 1 }),
      makeAgent("a2", { first_seen_ms: 1000, last_seen_ms: 4000, tool_count: 7, error_count: 0 }),
    ];
    const state = makeState(agents);
    const cost = costEstimate(state);
    const table = agentPerformanceTable(state, cost);

    expect(table).toHaveLength(2);

    const row1 = table.find((r) => r.id === "a1");
    expect(row1).toBeDefined();
    expect(row1!.duration_ms).toBe(5000);
    expect(row1!.tool_count).toBe(3);
    expect(row1!.errors).toBe(1);
    expect(row1!.name).toBe("a1");

    const row2 = table.find((r) => r.id === "a2");
    expect(row2!.duration_ms).toBe(3000);
    expect(row2!.tool_count).toBe(7);
    expect(row2!.errors).toBe(0);
  });

  it("includes cost_usd from cost estimate", () => {
    const agent = makeAgent("cost-agent");
    const events: Event[] = [
      {
        id: "ev1",
        session_id: "sess-1",
        ts: 1000,
        hook_event: "PreToolUse",
        agent_id: "cost-agent",
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      },
    ];
    const state = makeState([agent], events);
    const cost = costEstimate(state);
    const table = agentPerformanceTable(state, cost);

    const row = table.find((r) => r.id === "cost-agent");
    expect(row).toBeDefined();
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(row!.cost_usd).toBeCloseTo(18, 4);
  });

  it("includes subagent_type in type field", () => {
    const agent = makeAgent("typed-agent", { subagent_type: "oh-my-claudecode:executor" });
    const state = makeState([agent]);
    const cost = costEstimate(state);
    const table = agentPerformanceTable(state, cost);
    expect(table[0]!.type).toBe("oh-my-claudecode:executor");
  });
});
