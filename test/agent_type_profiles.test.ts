/**
 * Tests for agentTypeProfiles() in insights.ts
 */

import { describe, it, expect } from "vitest";
import { agentTypeProfiles } from "../src/insights.js";
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
    last_seen_ms: 2000,
    tool_count: 3,
    error_count: 0,
    children: [],
    result: null,
    ...overrides,
  };
}

function makeState(agents: Agent[]): State {
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
    tool_calls: new Map<string, ToolCall[]>(),
    events: [] as Event[],
  };
}

describe("agentTypeProfiles", () => {
  it("returns empty array for empty state", () => {
    const state = makeState([]);
    expect(agentTypeProfiles(state)).toHaveLength(0);
  });

  it("groups agents by subagent_type", () => {
    const agents = [
      makeAgent("e1", { subagent_type: "executor", tool_count: 3, first_seen_ms: 0, last_seen_ms: 2000 }),
      makeAgent("e2", { subagent_type: "executor", tool_count: 5, first_seen_ms: 0, last_seen_ms: 4000 }),
      makeAgent("p1", { subagent_type: "planner", tool_count: 1, first_seen_ms: 0, last_seen_ms: 1000 }),
    ];
    const state = makeState(agents);
    const profiles = agentTypeProfiles(state);

    // executor has 2 samples, planner has 1 — executor should appear first
    expect(profiles[0]!.type).toBe("executor");
    expect(profiles[0]!.sample_count).toBe(2);

    const plannerProfile = profiles.find((p) => p.type === "planner");
    expect(plannerProfile).toBeDefined();
    expect(plannerProfile!.sample_count).toBe(1);
  });

  it("computes correct averages", () => {
    const agents = [
      makeAgent("a1", { subagent_type: "executor", tool_count: 2, first_seen_ms: 0, last_seen_ms: 1000 }),
      makeAgent("a2", { subagent_type: "executor", tool_count: 4, first_seen_ms: 0, last_seen_ms: 3000 }),
    ];
    const state = makeState(agents);
    const profiles = agentTypeProfiles(state);
    const exec = profiles.find((p) => p.type === "executor")!;

    expect(exec.avg_tool_count).toBe(3); // (2 + 4) / 2
    expect(exec.avg_duration_ms).toBe(2000); // (1000 + 3000) / 2
  });

  it("generates plain-English summary string", () => {
    const agents = [
      makeAgent("a1", { subagent_type: "executor", tool_count: 3, first_seen_ms: 0, last_seen_ms: 2000 }),
      makeAgent("a2", { subagent_type: "executor", tool_count: 5, first_seen_ms: 0, last_seen_ms: 4000 }),
    ];
    const state = makeState(agents);
    const profiles = agentTypeProfiles(state);
    const exec = profiles.find((p) => p.type === "executor")!;

    // Summary should mention tool calls and timing
    expect(exec.summary).toMatch(/tool call/);
    expect(exec.summary).toMatch(/sample/);
    expect(exec.summary).toContain("2 samples");
  });

  it("falls back to 'root' for agents with null subagent_type", () => {
    const agents = [
      makeAgent("root-agent", { subagent_type: null }),
    ];
    const state = makeState(agents);
    const profiles = agentTypeProfiles(state);
    expect(profiles[0]!.type).toBe("root");
  });

  it("never crashes on empty tool_count data", () => {
    const agents = [
      makeAgent("minimal", { subagent_type: "explore", tool_count: 0, first_seen_ms: 100, last_seen_ms: 100 }),
    ];
    const state = makeState(agents);
    expect(() => agentTypeProfiles(state)).not.toThrow();
    const profiles = agentTypeProfiles(state);
    expect(profiles[0]!.summary).toContain("1 sample");
  });
});
