/**
 * Tests for EventProcessor — chain reconstruction from event sequences.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventProcessor } from "../src/processor.js";
import type { Event } from "../src/models.js";

function makeEvent(overrides: Partial<Event> & { hook_event: string }): Record<string, unknown> {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: "sess-proc",
    ts: Date.now(),
    ...overrides,
  };
}

describe("EventProcessor", () => {
  let processor: EventProcessor;

  beforeEach(() => {
    processor = new EventProcessor();
  });

  it("starts with empty state", () => {
    expect(processor.state.agents.size).toBe(0);
    expect(processor.state.sessions.size).toBe(0);
    expect(processor.events.length).toBe(0);
  });

  it("auto-discovers session and root agent on first event", () => {
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", agent_id: "ag-1", tool_use_id: "tu-1", tool_input: { command: "echo hi" } }));
    expect(processor.state.sessions.has("sess-proc")).toBe(true);
    expect(processor.state.agents.has("root:sess-proc")).toBe(true);
    expect(processor.state.agents.has("ag-1")).toBe(true);
  });

  it("increments tool_count per PreToolUse", () => {
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", agent_id: "ag-2", tool_use_id: "t1", tool_input: {} }));
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Read", agent_id: "ag-2", tool_use_id: "t2", tool_input: {} }));
    expect(processor.state.agents.get("ag-2")?.tool_count).toBe(2);
  });

  it("matches PostToolUse to running tool call", () => {
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", agent_id: "ag-3", tool_use_id: "tu-x", tool_input: { command: "pwd" } }));
    processor.ingest(makeEvent({ hook_event: "PostToolUse", tool_name: "Bash", agent_id: "ag-3", tool_use_id: "tu-x", tool_response: "/home/user" }));
    const calls = processor.state.tool_calls.get("ag-3") ?? [];
    expect(calls.length).toBe(1);
    expect(calls[0]?.status).toBe("done");
    expect(calls[0]?.response).toBe("/home/user");
  });

  it("builds agent tree from SubagentStart events", () => {
    processor.ingest(makeEvent({
      hook_event: "SubagentStart",
      agent_id: "child-a",
      tool_input: { description: "Executor", subagent_type: "executor", prompt: "do work" },
    }));
    processor.ingest(makeEvent({
      hook_event: "SubagentStart",
      agent_id: "child-b",
      tool_input: { description: "Planner", subagent_type: "planner", prompt: "make plan" },
    }));
    expect(processor.state.agents.size).toBe(3); // root + 2 children
    expect(processor.state.edges.length).toBe(2);
  });

  it("notifies subscribers on each event", () => {
    const received: string[] = [];
    processor.subscribe((event) => {
      received.push(String(event.hook_event));
    });
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: {} }));
    processor.ingest(makeEvent({ hook_event: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_response: "ok" }));
    expect(received).toEqual(["PreToolUse", "PostToolUse"]);
  });

  it("unsubscribe removes subscriber", () => {
    const received: string[] = [];
    const unsub = processor.subscribe((event) => {
      received.push(String(event.hook_event));
    });
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: {} }));
    unsub();
    processor.ingest(makeEvent({ hook_event: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_response: "ok" }));
    expect(received.length).toBe(1); // only the first one
  });

  it("reset clears all state", () => {
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", agent_id: "ag-r", tool_use_id: "t1", tool_input: {} }));
    expect(processor.events.length).toBe(1);
    processor.reset();
    expect(processor.events.length).toBe(0);
    expect(processor.state.agents.size).toBe(0);
  });

  it("error_count increments on PostToolUseFailure", () => {
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", agent_id: "ag-e", tool_use_id: "te1", tool_input: {} }));
    processor.ingest(makeEvent({ hook_event: "PostToolUseFailure", tool_name: "Bash", agent_id: "ag-e", tool_use_id: "te1", tool_response: "error msg" }));
    expect(processor.state.agents.get("ag-e")?.error_count).toBe(1);
  });

  // ── Runtime validator tests ───────────────────────────────────────────────

  it("drops events where id is present but not a string", () => {
    // id field must be a string when present
    processor.ingest({ id: 42, hook_event: "PreToolUse", session_id: "sess-proc", ts: Date.now(), tool_name: "Bash", tool_use_id: "tv1", tool_input: {} });
    expect(processor.events.length).toBe(0);
  });

  it("drops events where ts is present but not a number", () => {
    processor.ingest({ id: "abc", hook_event: "PreToolUse", session_id: "sess-proc", ts: "not-a-number", tool_name: "Bash", tool_use_id: "tv2", tool_input: {} });
    expect(processor.events.length).toBe(0);
  });

  it("accepts valid events without id (auto-assigned downstream)", () => {
    processor.ingest({ hook_event: "PreToolUse", session_id: "sess-proc", ts: Date.now(), tool_name: "Bash", tool_use_id: "tv3", tool_input: {} });
    expect(processor.events.length).toBe(1);
  });
});
