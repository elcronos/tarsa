/**
 * Tests for US-011: char-based cost fallback in costEstimate().
 */

import { describe, it, expect } from "vitest";
import { costEstimate } from "../src/insights.js";
import type { Agent, State, Session, ToolCall } from "../src/models.js";

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    parent_id: null,
    session_id: "sess-1",
    status: "done",
    subagent_type: null,
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
    events: [],
  };
}

describe("costEstimate char-based fallback (US-011)", () => {
  it("returns source=tool_count_fallback for agent with no tokens and no tool_calls", () => {
    const agent = makeAgent("a");
    const state = makeState([agent]);
    const result = costEstimate(state);
    const agentCost = result.perAgent.find((p) => p.agentId === "a")!;
    expect(agentCost.source).toBe("tool_count_fallback");
    expect(agentCost.usd).toBe(0);
  });

  it("returns source=estimated_chars and cost > 0 when tool_calls have input/output chars", () => {
    const agent = makeAgent("a");
    // input = {"command":"a very long command string"} ≈ some chars
    // response = "output result string" ≈ some chars
    const bigInput = { command: "x".repeat(400) }; // 400+ chars in JSON
    const bigResponse = "y".repeat(400);
    const tc = makeToolCall("tc-1", "a", {
      input: bigInput,
      response: bigResponse,
    });
    const toolCalls = new Map([["a", [tc]]]);
    const state = makeState([agent], toolCalls);
    const result = costEstimate(state);

    const agentCost = result.perAgent.find((p) => p.agentId === "a")!;
    expect(agentCost.source).toBe("estimated_chars");
    expect(agentCost.usd).toBeGreaterThan(0);
    expect(agentCost.inputTokens).toBeGreaterThan(0);
    expect(agentCost.outputTokens).toBeGreaterThan(0);
  });

  it("uses measured tokens from tokensMap when provided, ignoring chars", () => {
    const agent = makeAgent("a");
    const tc = makeToolCall("tc-1", "a", {
      input: { command: "x".repeat(400) },
      response: "y".repeat(400),
    });
    const toolCalls = new Map([["a", [tc]]]);
    const state = makeState([agent], toolCalls);

    const tokensMap = {
      a: { input_tokens: 1000, output_tokens: 500, cache_read: 0, cache_creation: 0 },
    };
    const result = costEstimate(state, tokensMap);

    const agentCost = result.perAgent.find((p) => p.agentId === "a")!;
    expect(agentCost.source).toBe("measured");
    expect(agentCost.inputTokens).toBe(1000);
    expect(agentCost.outputTokens).toBe(500);
  });

  it("top-level source reflects most informative source across agents", () => {
    const agentA = makeAgent("a");
    const agentB = makeAgent("b");
    const tc = makeToolCall("tc-1", "b", {
      input: { command: "x".repeat(400) },
      response: "y".repeat(400),
    });
    const toolCalls = new Map([
      ["a", []],
      ["b", [tc]],
    ]);
    const state = makeState([agentA, agentB], toolCalls);
    const result = costEstimate(state);
    // b has chars → estimated_chars takes priority over tool_count_fallback
    expect(result.source).toBe("estimated_chars");
  });

  it("computes tokens as chars/4", () => {
    const agent = makeAgent("a");
    const inputObj = { command: "a".repeat(400) }; // JSON: {"command":"aaa...400 chars"} ~ 414 chars
    const response = "b".repeat(400);
    const tc = makeToolCall("tc-1", "a", { input: inputObj, response });
    const toolCalls = new Map([["a", [tc]]]);
    const state = makeState([agent], toolCalls);
    const result = costEstimate(state);

    const agentCost = result.perAgent.find((p) => p.agentId === "a")!;
    const inputChars = JSON.stringify(inputObj).length;
    const outputChars = response.length;
    expect(agentCost.inputTokens).toBe(Math.round(inputChars / 4));
    expect(agentCost.outputTokens).toBe(Math.round(outputChars / 4));
  });
});
