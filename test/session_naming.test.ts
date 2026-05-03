/**
 * Tests for US-002: session naming from cwd + Task tool description.
 */

import { describe, it, expect } from "vitest";
import { replayToTimestamp, applyEvent, emptyState } from "../src/replay.js";
import type { Event } from "../src/models.js";

const SESSION_ID = "sess-naming-001";

function makeEvent(overrides: Partial<Event> & { hook_event: string }): Event {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: SESSION_ID,
    ts: Date.now(),
    ...overrides,
  } as Event;
}

describe("session naming", () => {
  it("stores cwd from event payload onto session", () => {
    const e = makeEvent({
      hook_event: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "ls" },
      cwd: "/home/user/my-project",
      ts: 1000,
    });

    const state = replayToTimestamp([e], Infinity);
    const session = state.sessions.get(SESSION_ID);
    expect(session?.cwd).toBe("/home/user/my-project");
  });

  it("auto-names session as <cwd-basename>: <description> when Task fires", () => {
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tu-0",
        tool_input: { command: "ls" },
        cwd: "/home/user/my-project",
        ts: 1000,
      }),
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "tu-task-1",
        tool_input: {
          description: "Implement the feature",
          subagent_type: "executor",
          prompt: "Do something",
        },
        cwd: "/home/user/my-project",
        ts: 2000,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const session = state.sessions.get(SESSION_ID);
    expect(session?.name).toBe("my-project: Implement the feature");
  });

  it("truncates description to 40 chars in session name", () => {
    const longDesc = "A".repeat(60);
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tu-0",
        tool_input: { command: "ls" },
        cwd: "/home/user/project",
        ts: 1000,
      }),
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "tu-task-2",
        tool_input: {
          description: longDesc,
          subagent_type: "executor",
          prompt: "",
        },
        ts: 2000,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const session = state.sessions.get(SESSION_ID);
    expect(session?.name).toBe(`project: ${"A".repeat(40)}`);
  });

  it("falls back to <cwd-basename> when no Task description", () => {
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tu-0",
        tool_input: { command: "ls" },
        cwd: "/home/user/fallback-project",
        ts: 1000,
      }),
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "tu-task-3",
        tool_input: {
          description: "",
          subagent_type: "executor",
          prompt: "",
        },
        ts: 2000,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const session = state.sessions.get(SESSION_ID);
    expect(session?.name).toBe("fallback-project");
  });

  it("does not overwrite name on subsequent Task events", () => {
    const events: Event[] = [
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "tu-0",
        tool_input: { command: "ls" },
        cwd: "/home/user/project",
        ts: 1000,
      }),
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "tu-task-4",
        tool_input: { description: "First task", subagent_type: "executor", prompt: "" },
        ts: 2000,
      }),
      makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "tu-task-5",
        tool_input: { description: "Second task", subagent_type: "executor", prompt: "" },
        ts: 3000,
      }),
    ];

    const state = replayToTimestamp(events, Infinity);
    const session = state.sessions.get(SESSION_ID);
    expect(session?.name).toBe("project: First task");
  });
});
