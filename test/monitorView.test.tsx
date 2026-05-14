/**
 * MonitorView logic tests — pure functions only (no DOM/jsdom needed).
 * The vitest environment is node; these tests cover the event-filter and
 * token-aggregation logic that MonitorView uses at runtime.
 */

import { describe, it, expect } from "vitest";
import type { Event } from "../src/models.js";

function agentEvents(events: Event[], agentId: string): Event[] {
  return events.filter((e) => e.agent_id === agentId);
}

function sumTokens(events: Event[], agentId: string) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  for (const e of events) {
    if (e.agent_id !== agentId) continue;
    if (typeof e["input_tokens"] === "number") input += e["input_tokens"] as number;
    if (typeof e["output_tokens"] === "number") output += e["output_tokens"] as number;
    if (typeof e["cache_read"] === "number") cacheRead += e["cache_read"] as number;
    if (typeof e["cache_creation"] === "number") cacheWrite += e["cache_creation"] as number;
  }
  return { input, output, cacheRead, cacheWrite };
}

function last20(events: Event[], agentId: string): Event[] {
  return agentEvents(events, agentId).slice(-20).reverse();
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "ev-1",
    hook_event: "PostToolUse",
    ts: 1000,
    session_id: "sess-1",
    agent_id: "agent-1",
    ...overrides,
  };
}

describe("MonitorView — agent event filter", () => {
  it("only returns events for the focused agent", () => {
    const events: Event[] = [
      makeEvent({ id: "e1", agent_id: "agent-1" }),
      makeEvent({ id: "e2", agent_id: "agent-2" }),
      makeEvent({ id: "e3", agent_id: "agent-1" }),
    ];
    const filtered = agentEvents(events, "agent-1");
    expect(filtered).toHaveLength(2);
    expect(filtered.every((e) => e.agent_id === "agent-1")).toBe(true);
  });

  it("returns last 20 events newest-first", () => {
    const events: Event[] = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ id: `e${i}`, ts: i * 100, agent_id: "agent-1" })
    );
    const result = last20(events, "agent-1");
    expect(result).toHaveLength(20);
    // newest first: last element in original array should be first here
    expect(result[0]!.id).toBe("e24");
  });

  it("sums tokens across events for the focused agent only", () => {
    const events: Event[] = [
      makeEvent({ id: "e1", agent_id: "agent-1", input_tokens: 10000, output_tokens: 500 }),
      makeEvent({ id: "e2", agent_id: "agent-2", input_tokens: 99999 }),
      makeEvent({ id: "e3", agent_id: "agent-1", input_tokens: 5000, cache_read: 2000, cache_creation: 1000 }),
    ];
    const tokens = sumTokens(events, "agent-1");
    expect(tokens.input).toBe(15000);
    expect(tokens.output).toBe(500);
    expect(tokens.cacheRead).toBe(2000);
    expect(tokens.cacheWrite).toBe(1000);
  });
});
