/**
 * Tests for src/search.ts — full-text index correctness + ranking ordering.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildIndex, indexEvent, searchEvents } from "../src/search.js";
import type { Event } from "../src/models.js";

function makeEvent(overrides: Partial<Event> & { hook_event: string }): Event {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: "sess-search",
    ts: Date.now(),
    ...overrides,
  } as Event;
}

describe("search index", () => {
  beforeEach(() => {
    buildIndex([]); // clear
  });

  it("returns empty results for empty query", () => {
    const e = makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hello" } });
    indexEvent(e);
    const results = searchEvents("", 10);
    expect(results).toHaveLength(0);
  });

  it("finds events by tool name", () => {
    const e = makeEvent({ hook_event: "PreToolUse", tool_name: "BashRunner", tool_input: {} });
    indexEvent(e);
    const results = searchEvents("bashrunner", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.event.id).toBe(e.id);
  });

  it("finds events by tool_input content", () => {
    const e = makeEvent({
      hook_event: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
    });
    indexEvent(e);
    // tokenizer splits on non-alphanumeric: "git", "status", "short"
    const results = searchEvents("status", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("ranks more recent events higher", () => {
    const now = Date.now();
    const old = makeEvent({
      hook_event: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "uniquetoken123" },
      ts: now - 3_600_000, // 1 hour ago
    });
    const recent = makeEvent({
      hook_event: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "uniquetoken123" },
      ts: now - 1_000, // 1 second ago
    });
    buildIndex([old, recent]);
    const results = searchEvents("uniquetoken", 10);
    expect(results.length).toBe(2);
    // Recent should rank higher due to recency bias
    expect(results[0]?.event.id).toBe(recent.id);
  });

  it("returns snippet containing matched term", () => {
    const e = makeEvent({
      hook_event: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "run_specific_command_xyz" },
    });
    indexEvent(e);
    const results = searchEvents("specific", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.snippet).toBeTruthy();
  });

  it("supports prefix matching", () => {
    const e = makeEvent({
      hook_event: "PreToolUse",
      tool_name: "WebSearch",
      tool_input: { query: "anthropic claude" },
    });
    indexEvent(e);
    // Prefix "anthro" should match "anthropic"
    const results = searchEvents("anthro", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("respects limit parameter", () => {
    const events: Event[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(makeEvent({
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: `common_token_abc cmd${i}` },
        ts: Date.now() - i * 1000,
      }));
    }
    buildIndex(events);
    const results = searchEvents("commontoken", 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("buildIndex replaces previous index", () => {
    const e1 = makeEvent({ hook_event: "PreToolUse", tool_name: "OldTool", tool_input: {} });
    indexEvent(e1);
    // Now rebuild with a different set
    const e2 = makeEvent({ hook_event: "PreToolUse", tool_name: "NewTool", tool_input: {} });
    buildIndex([e2]);
    const oldResults = searchEvents("oldtool", 10);
    expect(oldResults).toHaveLength(0);
    const newResults = searchEvents("newtool", 10);
    expect(newResults.length).toBeGreaterThan(0);
  });
});
