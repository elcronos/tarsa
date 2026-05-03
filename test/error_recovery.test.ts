/**
 * Tests for errorRecovery() in insights.ts
 */

import { describe, it, expect } from "vitest";
import { errorRecovery } from "../src/insights.js";
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
    tool_count: 1,
    error_count: 0,
    children: [],
    result: null,
    ...overrides,
  };
}

function makeState(agents: Agent[], toolCalls: Map<string, ToolCall[]> = new Map()): State {
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
    events: [] as Event[],
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

describe("errorRecovery", () => {
  it("returns empty array when no tool calls", () => {
    const state = makeState([makeAgent("a")]);
    expect(errorRecovery(state)).toHaveLength(0);
  });

  it("returns no_retry when failed tool has no follow-up", () => {
    const agent = makeAgent("a");
    const calls = [
      makeToolCall("tc-fail", "a", { status: "error", tool_name: "Read", started_ms: 1000 }),
    ];
    const state = makeState([agent], new Map([["a", calls]]));
    const result = errorRecovery(state);
    expect(result).toHaveLength(1);
    expect(result[0]!.recovery).toBe("no_retry");
    expect(result[0]!.retry_tool_id).toBeNull();
  });

  it("classifies retried_succeeded when retry of same tool succeeds within 60s", () => {
    const agent = makeAgent("a");
    const now = 5000;
    const calls = [
      makeToolCall("tc-fail", "a", { status: "error", tool_name: "Bash", started_ms: now }),
      makeToolCall("tc-retry", "a", { status: "done", tool_name: "Bash", started_ms: now + 5000 }),
    ];
    const state = makeState([agent], new Map([["a", calls]]));
    const result = errorRecovery(state);

    const entry = result.find((e) => e.failed_tool_id === "tc-fail");
    expect(entry).toBeDefined();
    expect(entry!.recovery).toBe("retried_succeeded");
    expect(entry!.retry_tool_id).toBe("tc-retry");
  });

  it("classifies retried_failed when retry also fails", () => {
    const agent = makeAgent("a");
    const now = 5000;
    const calls = [
      makeToolCall("tc-fail1", "a", { status: "error", tool_name: "Bash", started_ms: now }),
      makeToolCall("tc-fail2", "a", { status: "error", tool_name: "Bash", started_ms: now + 3000 }),
    ];
    const state = makeState([agent], new Map([["a", calls]]));
    const result = errorRecovery(state);

    // tc-fail1 has retry: tc-fail2 (failed)
    const entry1 = result.find((e) => e.failed_tool_id === "tc-fail1");
    expect(entry1!.recovery).toBe("retried_failed");
    expect(entry1!.retry_tool_id).toBe("tc-fail2");
  });

  it("does not match retry outside 60s window", () => {
    const agent = makeAgent("a");
    const now = 5000;
    const calls = [
      makeToolCall("tc-fail", "a", { status: "error", tool_name: "Bash", started_ms: now }),
      makeToolCall("tc-late", "a", { status: "done", tool_name: "Bash", started_ms: now + 65_000 }),
    ];
    const state = makeState([agent], new Map([["a", calls]]));
    const result = errorRecovery(state);

    const entry = result.find((e) => e.failed_tool_id === "tc-fail");
    expect(entry!.recovery).toBe("no_retry");
  });

  it("handles multiple agents independently", () => {
    const a1 = makeAgent("a1");
    const a2 = makeAgent("a2");
    const now = 5000;
    const a1Calls = [
      makeToolCall("tc-a1-fail", "a1", { status: "error", tool_name: "Read", started_ms: now }),
      makeToolCall("tc-a1-retry", "a1", { status: "done", tool_name: "Read", started_ms: now + 1000 }),
    ];
    const a2Calls = [
      makeToolCall("tc-a2-fail", "a2", { status: "error", tool_name: "Write", started_ms: now }),
    ];
    const state = makeState(
      [a1, a2],
      new Map([["a1", a1Calls], ["a2", a2Calls]])
    );
    const result = errorRecovery(state);

    const a1Entry = result.find((e) => e.agentId === "a1" && e.failed_tool_id === "tc-a1-fail");
    expect(a1Entry!.recovery).toBe("retried_succeeded");

    const a2Entry = result.find((e) => e.agentId === "a2");
    expect(a2Entry!.recovery).toBe("no_retry");
  });
});
