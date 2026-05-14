/**
 * Tests for fluencyScore — the AI Fluency Score insight.
 */

import { describe, it, expect } from "vitest";
import { fluencyScore } from "../src/insights.js";
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
    first_seen_ms: 1000,
    last_seen_ms: 2000,
    tool_count: 0,
    error_count: 0,
    children: [],
    result: null,
    ...overrides,
  };
}

function makeState(
  agents: Agent[],
  events: Event[] = [],
  toolCalls: Map<string, ToolCall[]> = new Map()
): State {
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
    pending_subagents: new Map(),
    iterations: new Map(),
  };
}

describe("fluencyScore", () => {
  it("returns null when there are no agents", () => {
    expect(fluencyScore(makeState([]))).toBeNull();
  });

  it("a single clean agent scores 100 / grade A", () => {
    const agent = makeAgent("clean", { tool_count: 8, error_count: 0 });
    const result = fluencyScore(makeState([agent]));
    expect(result).not.toBeNull();
    expect(result!.score).toBe(100);
    expect(result!.grade).toBe("A");
  });

  it("component weights sum to 1", () => {
    const result = fluencyScore(makeState([makeAgent("a", { tool_count: 1 })]));
    const sum = result!.components.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("error rate drags the score down via the clean-execution component", () => {
    // 5 errors / 10 tool calls = 50% error rate → error component = 50.
    // recovery/focus/parallelism stay at 100 (no tool_calls, no edges).
    // total = 50*0.3 + 100*0.25 + 100*0.25 + 100*0.2 = 85 → grade B.
    const agent = makeAgent("noisy", { tool_count: 10, error_count: 5 });
    const result = fluencyScore(makeState([agent]));
    expect(result!.score).toBe(85);
    expect(result!.grade).toBe("B");
    const errComp = result!.components.find((c) => c.key === "error_rate")!;
    expect(errComp.score).toBe(50);
  });

  it("a fully-failing agent floors the clean-execution component at 0", () => {
    const agent = makeAgent("broken", { tool_count: 4, error_count: 4 });
    const result = fluencyScore(makeState([agent]));
    const errComp = result!.components.find((c) => c.key === "error_rate")!;
    expect(errComp.score).toBe(0);
    // 0*0.3 + 100*0.25 + 100*0.25 + 100*0.2 = 70 → grade C.
    expect(result!.score).toBe(70);
    expect(result!.grade).toBe("C");
  });

  it("repeated identical tool calls (stuck) lower the focus component", () => {
    const agent = makeAgent("looper", { tool_count: 3, error_count: 0, status: "active" });
    const now = 1000;
    const calls: ToolCall[] = [0, 1, 2].map((i) => ({
      id: `tc-${i}`,
      agent_id: "looper",
      tool_name: "Bash",
      input: { command: "echo same" },
      input_preview: "echo same",
      started_ms: now + i * 1000,
      ended_ms: now + i * 1000 + 100,
      status: "done",
      output_preview: "same",
      response: "same",
      duration_ms: 100,
      retry_of: null,
    }));
    const result = fluencyScore(
      makeState([agent], [], new Map([["looper", calls]]))
    );
    const focus = result!.components.find((c) => c.key === "focus")!;
    expect(focus.score).toBeLessThan(100);
  });
});
