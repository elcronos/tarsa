/**
 * Tests for US-005: named subagent labels from Task tool inputs.
 */

import { describe, it, expect } from "vitest";
import { replayToTimestamp } from "../src/replay.js";
import type { Event } from "../src/models.js";

const SESSION_ID = "sess-subagent-001";

function makeEvent(overrides: Partial<Event> & { hook_event: string }): Event {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: SESSION_ID,
    ts: Date.now(),
    ...overrides,
  } as Event;
}

describe("subagent labels from Task tool", () => {
  it("PreToolUse Task creates child agent with subagent_type and description", () => {
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "tu-child-1",
        tool_input: {
          description: "Implement the login feature",
          subagent_type: "oh-my-claudecode:executor",
          prompt: "You are an executor. Implement the login feature.",
        },
        ts: 1000,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const agent = state.agents.get("tu-child-1");
    expect(agent).toBeDefined();
    expect(agent?.subagent_type).toBe("oh-my-claudecode:executor");
    expect(agent?.description).toBe("Implement the login feature");
    expect(agent?.prompt).toContain("executor");
  });

  it("SubagentStart upserts existing agent created by Task PreToolUse", () => {
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "tu-child-2",
        tool_input: {
          description: "Research task",
          subagent_type: "explore",
          prompt: "Research the codebase",
        },
        ts: 1000,
      }),
      makeEvent({
        hook_event: "SubagentStart",
        agent_id: "tu-child-2",
        tool_input: {
          description: "Research task",
          subagent_type: "explore",
          prompt: "Research the codebase",
        },
        ts: 1100,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const agent = state.agents.get("tu-child-2");
    expect(agent).toBeDefined();
    expect(agent?.subagent_type).toBe("explore");
    expect(agent?.description).toBe("Research task");
    // Should not duplicate in agents map
    const allAgentIds = Array.from(state.agents.keys());
    expect(allAgentIds.filter((id) => id === "tu-child-2").length).toBe(1);
  });

  it("agent created from agent_id without prior Task event has undefined subagent_type", () => {
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        agent_id: "unknown-agent-xyz",
        tool_name: "Bash",
        tool_use_id: "tu-bash-1",
        tool_input: { command: "ls" },
        ts: 1000,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const agent = state.agents.get("unknown-agent-xyz");
    expect(agent).toBeDefined();
    // subagent_type is null when not set via Task tool
    expect(agent?.subagent_type).toBeNull();
  });

  it("child agent is linked as child of parent agent", () => {
    const parentAgentId = "parent-agent-001";
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        agent_id: parentAgentId,
        tool_name: "Bash",
        tool_use_id: "tu-bash-p",
        tool_input: { command: "ls" },
        ts: 500,
      }),
      makeEvent({
        hook_event: "PreToolUse",
        agent_id: parentAgentId,
        tool_name: "Task",
        tool_use_id: "tu-child-3",
        tool_input: {
          description: "Child work",
          subagent_type: "executor",
          prompt: "Do child work",
        },
        ts: 1000,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const parent = state.agents.get(parentAgentId);
    expect(parent?.children).toContain("tu-child-3");
  });

  it("OMC namespaced subagent_type preserved verbatim", () => {
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "tu-omc-1",
        tool_input: {
          description: "Plan the architecture",
          subagent_type: "oh-my-claudecode:planner",
          prompt: "Plan it",
        },
        ts: 1000,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const agent = state.agents.get("tu-omc-1");
    expect(agent?.subagent_type).toBe("oh-my-claudecode:planner");
  });
});
