/**
 * Tests for git context propagation in the reducer (replay-core).
 */

import { describe, it, expect } from "vitest";
import { applyEvent, emptyState } from "../src/shared/replay-core.js";
import type { Event } from "../src/models.js";

function makeEvent(overrides: Partial<Event> & { session_id: string }): Event {
  return {
    id: Math.random().toString(36).slice(2, 10),
    hook_event: "PreToolUse",
    ts: 1_700_000_000_000 + Math.floor(Math.random() * 1_000_000),
    tool_name: "Bash",
    tool_use_id: Math.random().toString(36).slice(2, 10),
    tool_input: { command: "echo hi" },
    schema_version: 1,
    ...overrides,
  } as Event;
}

describe("git context reducer propagation", () => {
  it("first event with git_commit populates session git fields", () => {
    const sessionId = "sess-1";
    const e = makeEvent({
      session_id: sessionId,
      git_commit: "abc".padEnd(40, "0"),
      git_branch: "main",
      git_dirty: false,
    });
    const state = applyEvent(emptyState(), e);
    const session = state.sessions.get(sessionId);
    expect(session).toBeDefined();
    expect(session!.git_commit).toBe("abc".padEnd(40, "0"));
    expect(session!.git_branch).toBe("main");
    expect(session!.git_dirty).toBe(false);
  });

  it("subsequent event with different commit updates git_commit", () => {
    const sessionId = "sess-2";
    const sha1 = "aaa".padEnd(40, "a");
    const sha2 = "bbb".padEnd(40, "b");
    const e1 = makeEvent({ session_id: sessionId, git_commit: sha1, git_branch: "main", git_dirty: false });
    const e2 = makeEvent({ session_id: sessionId, git_commit: sha2, git_branch: "main", git_dirty: false });
    let state = applyEvent(emptyState(), e1);
    state = applyEvent(state, e2);
    const session = state.sessions.get(sessionId);
    expect(session!.git_commit).toBe(sha2);
  });

  it("event without git fields leaves session git fields untouched", () => {
    const sessionId = "sess-3";
    const sha = "ccc".padEnd(40, "c");
    const e1 = makeEvent({ session_id: sessionId, git_commit: sha, git_branch: "feat", git_dirty: true });
    const e2 = makeEvent({ session_id: sessionId }); // no git fields
    let state = applyEvent(emptyState(), e1);
    state = applyEvent(state, e2);
    const session = state.sessions.get(sessionId);
    expect(session!.git_commit).toBe(sha);
    expect(session!.git_branch).toBe("feat");
    expect(session!.git_dirty).toBe(true);
  });

  it("same commit twice does not reset branch/dirty", () => {
    const sessionId = "sess-4";
    const sha = "ddd".padEnd(40, "d");
    const e1 = makeEvent({ session_id: sessionId, git_commit: sha, git_branch: "main", git_dirty: false });
    // Second event with same commit but dirty=true — session should be unchanged (commit not changed)
    const e2 = makeEvent({ session_id: sessionId, git_commit: sha, git_branch: "main", git_dirty: true });
    let state = applyEvent(emptyState(), e1);
    state = applyEvent(state, e2);
    const session = state.sessions.get(sessionId);
    // commit hasn't changed so no update
    expect(session!.git_dirty).toBe(false);
  });

  it("git fields are isolated per session", () => {
    const sha1 = "eee".padEnd(40, "e");
    const sha2 = "fff".padEnd(40, "f");
    const e1 = makeEvent({ session_id: "s-a", git_commit: sha1, git_branch: "main", git_dirty: false });
    const e2 = makeEvent({ session_id: "s-b", git_commit: sha2, git_branch: "dev", git_dirty: true });
    let state = applyEvent(emptyState(), e1);
    state = applyEvent(state, e2);
    expect(state.sessions.get("s-a")!.git_commit).toBe(sha1);
    expect(state.sessions.get("s-b")!.git_commit).toBe(sha2);
    expect(state.sessions.get("s-a")!.git_branch).toBe("main");
    expect(state.sessions.get("s-b")!.git_branch).toBe("dev");
  });
});
