/**
 * Tests for sessionCostBreakdown() in src/insights.ts
 */

import { describe, it, expect } from "vitest";
import { sessionCostBreakdown } from "../src/insights.js";

type EventLike = { [key: string]: unknown };

function makeEvent(overrides: EventLike): EventLike {
  return {
    id: Math.random().toString(36).slice(2, 10),
    hook_event: "PostToolUse",
    ts: Date.now(),
    session_id: "sess-1",
    schema_version: 1,
    ...overrides,
  };
}

describe("sessionCostBreakdown", () => {
  it("empty event array returns zero cost and empty perAgent", () => {
    const result = sessionCostBreakdown("sess-1", []);
    expect(result.totalUsd).toBe(0);
    expect(result.perAgent).toHaveLength(0);
    expect(result.eventCount).toBe(0);
    expect(result.coveragePercent).toBe(100);
  });

  it("one agent with 1M input + 1M output on sonnet yields ~$18", () => {
    const events: EventLike[] = [
      makeEvent({
        agent_id: "agent-1",
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        model: "claude-sonnet-4-5",
      }),
    ];
    const result = sessionCostBreakdown("sess-1", events);
    expect(result.totalUsd).toBeCloseTo(18, 2); // $3 input + $15 output
    expect(result.perModel.sonnet.usd).toBeCloseTo(18, 2);
    expect(result.coveragePercent).toBe(100);
    expect(result.perAgent).toHaveLength(1);
    expect(result.perAgent[0]!.model).toBe("sonnet");
  });

  it("two agents on different models produce correct perModel split", () => {
    const events: EventLike[] = [
      makeEvent({
        agent_id: "agent-sonnet",
        input_tokens: 1_000_000,
        output_tokens: 0,
        model: "claude-sonnet-4-5",
      }),
      makeEvent({
        agent_id: "agent-haiku",
        input_tokens: 1_000_000,
        output_tokens: 0,
        model: "claude-haiku-4-5",
      }),
    ];
    const result = sessionCostBreakdown("sess-1", events);
    expect(result.perAgent).toHaveLength(2);
    expect(result.perModel.sonnet.usd).toBeCloseTo(3, 4); // $3/M input
    expect(result.perModel.haiku.usd).toBeCloseTo(0.8, 4); // $0.8/M input
    expect(result.perModel.opus.usd).toBe(0);
  });

  it("cache tokens are priced correctly", () => {
    // 1M cache_read ($0.30) + 1M cache_creation ($3.75) on sonnet
    const events: EventLike[] = [
      makeEvent({
        agent_id: "agent-1",
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 1_000_000,
        cache_creation: 1_000_000,
        model: "claude-sonnet-4-5",
      }),
    ];
    const result = sessionCostBreakdown("sess-1", events);
    expect(result.totalUsd).toBeCloseTo(4.05, 4); // 0.30 + 3.75
  });

  it("source is 'measured' when token counts are present", () => {
    const events: EventLike[] = [
      makeEvent({ agent_id: "a1", input_tokens: 100, output_tokens: 50, model: "claude-sonnet-4-5" }),
    ];
    const result = sessionCostBreakdown("sess-1", events);
    expect(result.perAgent[0]!.source).toBe("measured");
  });

  it("source is 'tool_count_fallback' when no token data available", () => {
    const events: EventLike[] = [
      makeEvent({ agent_id: "a1" }), // no token fields
    ];
    const result = sessionCostBreakdown("sess-1", events);
    expect(result.perAgent[0]!.source).toBe("tool_count_fallback");
  });

  it("determinism: same events produce same result twice", () => {
    const events: EventLike[] = [
      makeEvent({ agent_id: "a1", input_tokens: 500_000, output_tokens: 250_000, model: "claude-sonnet-4-5" }),
      makeEvent({ agent_id: "a2", input_tokens: 100_000, output_tokens: 50_000, model: "claude-haiku-4-5" }),
    ];
    const r1 = sessionCostBreakdown("sess-1", events);
    const r2 = sessionCostBreakdown("sess-1", events);
    expect(r1.totalUsd).toBe(r2.totalUsd);
    expect(r1.coveragePercent).toBe(r2.coveragePercent);
    expect(JSON.stringify(r1.perModel)).toBe(JSON.stringify(r2.perModel));
  });
});
