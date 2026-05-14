/**
 * Tests for commitCostBreakdown() in src/insights.ts
 */

import { describe, it, expect } from "vitest";
import { commitCostBreakdown } from "../src/insights.js";
import type { SessionCostRow } from "../src/insights.js";

type EventLike = { [key: string]: unknown };

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

function makeEvent(overrides: EventLike): EventLike {
  return {
    id: Math.random().toString(36).slice(2, 10),
    hook_event: "PostToolUse",
    ts: Date.now(),
    session_id: "sess-1",
    schema_version: 1,
    git_commit: SHA,
    ...overrides,
  };
}

describe("commitCostBreakdown", () => {
  it("empty event array returns zero cost with sha echoed", () => {
    const result = commitCostBreakdown([], SHA);
    expect(result.sha).toBe(SHA);
    expect(result.totalUsd).toBe(0);
    expect(result.perAgent).toHaveLength(0);
    expect(result.eventCount).toBe(0);
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
    const result = commitCostBreakdown(events, SHA);
    expect(result.totalUsd).toBeCloseTo(18, 2);
    expect(result.perModel.sonnet.usd).toBeCloseTo(18, 2);
    expect(result.coveragePercent).toBe(100);
    expect(result.sha).toBe(SHA);
  });

  it("cache tokens are priced correctly", () => {
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
    const result = commitCostBreakdown(events, SHA);
    expect(result.totalUsd).toBeCloseTo(4.05, 4); // 0.30 + 3.75
  });

  it("folds all events blindly (no re-filtering by sha)", () => {
    // Events for two different commits — commitCostBreakdown receives pre-filtered
    // events from db.getEventsByCommit and does NOT re-filter. This tests that
    // even an event with a different git_commit is counted if passed in.
    const events: EventLike[] = [
      makeEvent({ agent_id: "a1", input_tokens: 100_000, output_tokens: 0, model: "claude-sonnet-4-5", git_commit: SHA }),
      makeEvent({ agent_id: "a2", input_tokens: 100_000, output_tokens: 0, model: "claude-sonnet-4-5", git_commit: SHA2 }),
    ];
    const result = commitCostBreakdown(events, SHA);
    // Both agents counted — DB does the filtering, not commitCostBreakdown
    expect(result.perAgent).toHaveLength(2);
    expect(result.eventCount).toBe(2);
  });

  it("determinism: same (events, sha) produces identical result twice", () => {
    const events: EventLike[] = [
      makeEvent({ agent_id: "a1", input_tokens: 500_000, output_tokens: 250_000, model: "claude-sonnet-4-5" }),
    ];
    const r1 = commitCostBreakdown(events, SHA);
    const r2 = commitCostBreakdown(events, SHA);
    expect(r1.totalUsd).toBe(r2.totalUsd);
    expect(r1.coveragePercent).toBe(r2.coveragePercent);
    expect(JSON.stringify(r1.perModel)).toBe(JSON.stringify(r2.perModel));
  });

  it("perAgent rows are structurally identical to SessionCostRow (shared type)", () => {
    const events: EventLike[] = [
      makeEvent({ agent_id: "a1", input_tokens: 100, output_tokens: 50, model: "claude-sonnet-4-5" }),
    ];
    const result = commitCostBreakdown(events, SHA);
    const row = result.perAgent[0] as SessionCostRow;
    // SessionCostRow fields must all be present
    expect(typeof row.agentId).toBe("string");
    expect(typeof row.model).toBe("string");
    expect(typeof row.inputTokens).toBe("number");
    expect(typeof row.outputTokens).toBe("number");
    expect(typeof row.cacheReadTokens).toBe("number");
    expect(typeof row.cacheCreationTokens).toBe("number");
    expect(typeof row.usd).toBe("number");
    expect(["measured", "estimated_chars", "tool_count_fallback"]).toContain(row.source);
  });
});
