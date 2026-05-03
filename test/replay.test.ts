/**
 * Tests for the pure reducer: determinism, session/agent creation, Stop event.
 */

import { describe, it, expect } from "vitest";
import { replayToTimestamp, applyEvent, emptyState } from "../src/replay.js";
import type { Event } from "../src/models.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const SESSION_ID = "sess-001";
const AGENT_ID = "agent-abc";

function makeEvent(overrides: Partial<Event> & { hook_event: string }): Event {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: SESSION_ID,
    ts: Date.now(),
    ...overrides,
  } as Event;
}

const sampleEvents: Event[] = [
  makeEvent({ hook_event: "PreToolUse", agent_id: AGENT_ID, tool_name: "Bash", tool_use_id: "tu-1", tool_input: { command: "ls" }, ts: 1000 }),
  makeEvent({ hook_event: "PostToolUse", agent_id: AGENT_ID, tool_name: "Bash", tool_use_id: "tu-1", tool_response: "file1.ts\nfile2.ts", ts: 1200 }),
  makeEvent({ hook_event: "PreToolUse", agent_id: AGENT_ID, tool_name: "Read", tool_use_id: "tu-2", tool_input: { file_path: "/src/foo.ts" }, ts: 1300 }),
  makeEvent({ hook_event: "PostToolUse", agent_id: AGENT_ID, tool_name: "Read", tool_use_id: "tu-2", tool_response: "content here", ts: 1500 }),
  makeEvent({ hook_event: "Stop", ts: 2000 }),
];

// ── Tests ─────────────────────────────────────────────────────────────

describe("replayToTimestamp", () => {
  it("produces empty state for empty events array", () => {
    const state = replayToTimestamp([], Infinity);
    expect(state.sessions.size).toBe(0);
    expect(state.agents.size).toBe(0);
    expect(state.events.length).toBe(0);
  });

  it("is deterministic — same events produce same state twice", () => {
    const state1 = replayToTimestamp(sampleEvents, Infinity);
    const state2 = replayToTimestamp(sampleEvents, Infinity);

    expect(state1.sessions.size).toBe(state2.sessions.size);
    expect(state1.agents.size).toBe(state2.agents.size);
    expect(state1.events.length).toBe(state2.events.length);
    expect(state1.edges.length).toBe(state2.edges.length);

    // Agent ids match
    const ids1 = [...state1.agents.keys()].sort();
    const ids2 = [...state2.agents.keys()].sort();
    expect(ids1).toEqual(ids2);

    // Tool counts match
    const agent1 = state1.agents.get(AGENT_ID);
    const agent2 = state2.agents.get(AGENT_ID);
    expect(agent1?.tool_count).toBe(agent2?.tool_count);
  });

  it("auto-creates session and root agent from first event", () => {
    const state = replayToTimestamp([sampleEvents[0]!], Infinity);
    expect(state.sessions.has(SESSION_ID)).toBe(true);
    expect(state.agents.has(`root:${SESSION_ID}`)).toBe(true);
  });

  it("auto-discovers agent from agent_id field", () => {
    const state = replayToTimestamp(sampleEvents, Infinity);
    expect(state.agents.has(AGENT_ID)).toBe(true);
    const agent = state.agents.get(AGENT_ID);
    expect(agent?.tool_count).toBe(2); // two PreToolUse events
  });

  it("replayToTimestamp(events, T) stops at T", () => {
    // ts=1000 and ts=1200 — replay up to ts=1100 should have only 1 tool call
    const stateAt1100 = replayToTimestamp(sampleEvents, 1100);
    const agent = stateAt1100.agents.get(AGENT_ID);
    expect(agent?.tool_count).toBe(1);

    // At ts=1300, 2 PreToolUse events processed
    const stateAt1300 = replayToTimestamp(sampleEvents, 1300);
    const agent2 = stateAt1300.agents.get(AGENT_ID);
    expect(agent2?.tool_count).toBe(2);
  });

  it("Synthetic idle-stop event sets session.ended_at and status=complete", () => {
    // Claude Code's Stop hook fires per assistant turn, not session end.
    // Only synthetic idle-stop events (emitted by processor on 5min idle) end sessions.
    const idleStop: Event = makeEvent({
      hook_event: "Stop",
      ts: 2500,
      id: "idle-stop-1",
    });
    const state = replayToTimestamp([...sampleEvents, idleStop], Infinity);
    const session = state.sessions.get(SESSION_ID);
    expect(session?.status).toBe("complete");
    expect(session?.ended_at).toBe(2500);
  });

  it("PostToolUse matches running tool call by tool_use_id and marks done", () => {
    const state = replayToTimestamp(sampleEvents, Infinity);
    const calls = state.tool_calls.get(AGENT_ID) ?? [];
    const tc = calls.find((c) => c.id === "tu-1");
    expect(tc).toBeDefined();
    expect(tc?.status).toBe("done");
    expect(tc?.response).toBe("file1.ts\nfile2.ts");
    expect(tc?.duration_ms).toBe(200); // 1200 - 1000
  });
});

describe("applyEvent incremental", () => {
  it("applyEvent produces same result as replayToTimestamp for single event", () => {
    const e = sampleEvents[0]!;
    const via_apply = applyEvent(emptyState(), e);
    const via_replay = replayToTimestamp([e], Infinity);

    expect(via_apply.sessions.size).toBe(via_replay.sessions.size);
    expect(via_apply.agents.size).toBe(via_replay.agents.size);
  });

  it("sequential applyEvent calls match full replay", () => {
    let state = emptyState();
    for (const e of sampleEvents) {
      state = applyEvent(state, e);
    }
    const replayed = replayToTimestamp(sampleEvents, Infinity);

    expect(state.agents.size).toBe(replayed.agents.size);
    expect(state.events.length).toBe(replayed.events.length);

    const agentIncr = state.agents.get(AGENT_ID);
    const agentReplay = replayed.agents.get(AGENT_ID);
    expect(agentIncr?.tool_count).toBe(agentReplay?.tool_count);
    expect(agentIncr?.status).toBe(agentReplay?.status);
  });
});

describe("SubagentStart / child agent tree", () => {
  it("SubagentStart creates edge and adds child", () => {
    const spawnEvent = makeEvent({
      hook_event: "SubagentStart",
      agent_id: "child-1",
      tool_input: {
        description: "Test executor",
        subagent_type: "executor",
        prompt: "Do a thing",
      },
      ts: 500,
    });

    const state = replayToTimestamp([spawnEvent], Infinity);
    expect(state.agents.has("child-1")).toBe(true);
    const child = state.agents.get("child-1");
    expect(child?.name).toBe("Test executor");
    expect(child?.subagent_type).toBe("executor");
    expect(state.edges.length).toBe(1);
    expect(state.edges[0]?.from_id).toBe(`root:${SESSION_ID}`);
    expect(state.edges[0]?.to_id).toBe("child-1");
  });

  it("SubagentStop marks child as done with result", () => {
    const events: Event[] = [
      makeEvent({ hook_event: "SubagentStart", agent_id: "child-2", tool_input: { description: "Worker", subagent_type: "worker", prompt: "" }, ts: 100 }),
      makeEvent({ hook_event: "SubagentStop", agent_id: "child-2", result: "finished work", ts: 900 }),
    ];
    const state = replayToTimestamp(events, Infinity);
    const agent = state.agents.get("child-2");
    expect(agent?.status).toBe("done");
    expect(agent?.result).toBe("finished work");
  });
});
