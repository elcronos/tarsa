/**
 * Tests for subagent deduplication via SubagentStart migration.
 *
 * Background: PreToolUse(Agent/Task) pre-creates a child agent keyed by
 * tool_use_id. SubagentStart arrives with a new agent_id (unrelated to
 * tool_use_id). Without dedup, two agents exist. With dedup, the stub is
 * migrated to the real agent_id — one agent, correct metadata preserved.
 */

import { describe, it, expect } from "vitest";
import { replayToTimestamp } from "../src/replay.js";
import type { Event } from "../src/models.js";

const SESSION_ID = "sess-dedup-001";
let _ts = 1000;
function nextTs() { return _ts++; }

function makeEvent(overrides: Partial<Event> & { hook_event: string }): Event {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: SESSION_ID,
    ts: nextTs(),
    ...overrides,
  } as Event;
}

describe("subagent dedup via SubagentStart migration", () => {
  it("single agent: stub migrated, only one agent at real agent_id with description preserved", () => {
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "t1",
        tool_input: {
          description: "Batch A: bug + UX polish",
          subagent_type: "oh-my-claudecode:executor",
          prompt: "Fix the bug and polish UX",
        },
      }),
      makeEvent({
        hook_event: "SubagentStart",
        agent_id: "a1",
        agent_type: "oh-my-claudecode:executor",
      }),
      makeEvent({
        hook_event: "PreToolUse",
        agent_id: "a1",
        tool_name: "Read",
        tool_use_id: "tc-read-1",
        tool_input: { file_path: "/foo.ts" },
      }),
    ];

    const state = replayToTimestamp(events, Infinity);

    // Only ONE agent for this session (besides root)
    const sessionAgents = Array.from(state.agents.values()).filter(
      (a) => a.session_id === SESSION_ID && !a.id.startsWith("root:")
    );
    expect(sessionAgents).toHaveLength(1);

    // Agent is at the real agent_id
    const agent = state.agents.get("a1");
    expect(agent).toBeDefined();
    expect(agent?.description).toBe("Batch A: bug + UX polish");
    expect(agent?.subagent_type).toBe("oh-my-claudecode:executor");
    expect(agent?.prompt).toContain("Fix the bug");

    // Stub is gone
    expect(state.agents.has("t1")).toBe(false);

    // tool_calls map has entry for a1 (with the Read tool call)
    const calls = state.tool_calls.get("a1");
    expect(calls).toBeDefined();
    expect(calls?.some((c) => c.tool_name === "Read")).toBe(true);
    expect(state.tool_calls.has("t1")).toBe(false);
  });

  it("parent.children swapped from tool_use_id to agent_id after migration", () => {
    const parentAgentId = "parent-agent-dedup";
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        agent_id: parentAgentId,
        tool_name: "Bash",
        tool_use_id: "bash-p1",
        tool_input: { command: "ls" },
      }),
      makeEvent({
        hook_event: "PreToolUse",
        agent_id: parentAgentId,
        tool_name: "Agent",
        tool_use_id: "t2",
        tool_input: {
          description: "Child work",
          subagent_type: "oh-my-claudecode:executor",
          prompt: "Do child work",
        },
      }),
      makeEvent({
        hook_event: "SubagentStart",
        agent_id: "a2",
        agent_type: "oh-my-claudecode:executor",
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const parent = state.agents.get(parentAgentId);
    expect(parent?.children).toContain("a2");
    expect(parent?.children).not.toContain("t2");
    expect(state.agents.has("t2")).toBe(false);
    expect(state.agents.get("a2")?.description).toBe("Child work");
  });

  it("FIFO: 3 pre-creates of same subagent_type matched to 3 SubagentStarts in order", () => {
    const sess = "sess-fifo-001";
    let ts = 2000;

    const ev = (overrides: Partial<Event> & { hook_event: string }): Event => ({
      id: Math.random().toString(36).slice(2, 10),
      session_id: sess,
      ts: ts++,
      ...overrides,
    } as Event);

    const events: Event[] = [
      // 3 pre-creates
      ev({
        hook_event: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "stub-1",
        tool_input: { description: "Worker One", subagent_type: "executor", prompt: "p1" },
      }),
      ev({
        hook_event: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "stub-2",
        tool_input: { description: "Worker Two", subagent_type: "executor", prompt: "p2" },
      }),
      ev({
        hook_event: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "stub-3",
        tool_input: { description: "Worker Three", subagent_type: "executor", prompt: "p3" },
      }),
      // 3 SubagentStarts in order
      ev({ hook_event: "SubagentStart", agent_id: "real-1", agent_type: "executor" }),
      ev({ hook_event: "SubagentStart", agent_id: "real-2", agent_type: "executor" }),
      ev({ hook_event: "SubagentStart", agent_id: "real-3", agent_type: "executor" }),
    ];

    const state = replayToTimestamp(events, Infinity);

    // No stubs remain
    expect(state.agents.has("stub-1")).toBe(false);
    expect(state.agents.has("stub-2")).toBe(false);
    expect(state.agents.has("stub-3")).toBe(false);

    // All real agents exist with correct descriptions (FIFO order)
    expect(state.agents.get("real-1")?.description).toBe("Worker One");
    expect(state.agents.get("real-2")?.description).toBe("Worker Two");
    expect(state.agents.get("real-3")?.description).toBe("Worker Three");

    // All have correct subagent_type
    expect(state.agents.get("real-1")?.subagent_type).toBe("executor");
    expect(state.agents.get("real-2")?.subagent_type).toBe("executor");
    expect(state.agents.get("real-3")?.subagent_type).toBe("executor");

    // Exactly 3 non-root session agents
    const sessionAgents = Array.from(state.agents.values()).filter(
      (a) => a.session_id === sess && !a.id.startsWith("root:")
    );
    expect(sessionAgents).toHaveLength(3);
  });

  it("no migration when SubagentStart has no matching pending stub (auto-discover path)", () => {
    const sess = "sess-nodupe-001";
    let ts = 3000;
    const ev = (overrides: Partial<Event> & { hook_event: string }): Event => ({
      id: Math.random().toString(36).slice(2, 10),
      session_id: sess,
      ts: ts++,
      ...overrides,
    } as Event);

    const events: Event[] = [
      // SubagentStart with no prior pre-create
      ev({ hook_event: "SubagentStart", agent_id: "orphan-1", agent_type: "explore" }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const agent = state.agents.get("orphan-1");
    expect(agent).toBeDefined();
    expect(agent?.subagent_type).toBe("explore");
  });
});
