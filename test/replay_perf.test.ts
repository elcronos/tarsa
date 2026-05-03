/**
 * Performance benchmark for the reducer.
 *
 * Asserts that 1000 synthetic PreToolUse + PostToolUse events fold into the
 * empty state in under 500ms. This is a loose CI bound — the structural-
 * sharing refactor (US-V2-05) typically completes the same workload in
 * well under 200ms locally, but CI machines vary.
 */
import { describe, it, expect } from "vitest";
import { applyEvent, emptyState } from "../src/replay.js";
import type { Event } from "../src/models.js";

function makeEvents(n: number): Event[] {
  const events: Event[] = [];
  const sessionId = "perf-session";
  let ts = 1000;
  for (let i = 0; i < n; i++) {
    const toolUseId = `tu-${i}`;
    events.push({
      id: `pre-${i}`,
      hook_event: "PreToolUse",
      ts: ts++,
      session_id: sessionId,
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command: `echo ${i}` },
    });
    events.push({
      id: `post-${i}`,
      hook_event: "PostToolUse",
      ts: ts++,
      session_id: sessionId,
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_response: `out-${i}`,
    });
  }
  return events;
}

describe("replay perf — structural sharing", () => {
  it("folds 1000 PreToolUse + PostToolUse events in < 500ms", () => {
    const events = makeEvents(1000);
    const start = performance.now();
    let state = emptyState();
    for (const e of events) {
      state = applyEvent(state, e);
    }
    const elapsed = performance.now() - start;

    // Sanity-check the resulting state is correct
    expect(state.events.length).toBe(2000);
    const calls = state.tool_calls.get("root:perf-session") ?? [];
    expect(calls.length).toBe(1000);
    expect(calls.every((c) => c.status === "done")).toBe(true);

    // Loose CI bound; locally this should run in ~50-150ms.
    expect(elapsed).toBeLessThan(500);
  });
});
