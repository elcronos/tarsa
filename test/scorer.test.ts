/**
 * Tests for scorer.ts — z-scores and health classification.
 */

import { describe, it, expect } from "vitest";
import { zScore, scoreAgent } from "../src/scorer.js";
import type { Agent } from "../src/models.js";
import type { BaselineRow } from "../src/db.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "ag-test",
    name: "test-agent",
    parent_id: null,
    session_id: "sess-1",
    status: "done",
    subagent_type: "executor",
    description: "Test agent",
    prompt: null,
    first_seen_ms: 1000,
    last_seen_ms: 11000, // 10s duration
    tool_count: 5,
    error_count: 0,
    children: [],
    result: null,
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<BaselineRow> = {}): BaselineRow {
  return {
    agent_type: "executor",
    mean_duration: 10000,
    mean_tool_count: 5,
    mean_cost: 0,
    sample_count: 10,
    stddev_duration: 2000,
    stddev_tool_count: 2,
    updated_at: Date.now(),
    ...overrides,
  };
}

describe("zScore", () => {
  it("returns 0 for value == mean", () => {
    expect(zScore(5, 5, 2)).toBe(0);
  });

  it("returns positive for value > mean", () => {
    expect(zScore(7, 5, 2)).toBeCloseTo(1.0);
  });

  it("returns negative for value < mean", () => {
    expect(zScore(3, 5, 2)).toBeCloseTo(-1.0);
  });

  it("avoids division by zero when stddev is 0", () => {
    // safe floor: max(0, mean*0.2, 1.0) = max(0, 1.0, 1.0) = 1.0
    const result = zScore(10, 5, 0);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("uses mean*0.2 floor when larger than 1.0", () => {
    // mean=100, stddev=0 => floor = max(0, 20, 1) = 20
    const result = zScore(110, 100, 0);
    expect(result).toBeCloseTo(0.5); // (110-100)/20 = 0.5
  });
});

describe("scoreAgent", () => {
  it("returns null when baseline is null", () => {
    const agent = makeAgent();
    expect(scoreAgent(agent, null)).toBeNull();
  });

  it("returns null when sample_count < 2", () => {
    const agent = makeAgent();
    const baseline = makeBaseline({ sample_count: 1 });
    expect(scoreAgent(agent, baseline)).toBeNull();
  });

  it("returns calibrating confidence when sample_count < 5", () => {
    const agent = makeAgent();
    const baseline = makeBaseline({ sample_count: 3 });
    const result = scoreAgent(agent, baseline);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("calibrating");
  });

  it("returns confident when sample_count >= 5", () => {
    const agent = makeAgent();
    const baseline = makeBaseline({ sample_count: 10 });
    const result = scoreAgent(agent, baseline);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("confident");
  });

  it("returns green health for normal agent", () => {
    const agent = makeAgent({ tool_count: 5, first_seen_ms: 0, last_seen_ms: 10000 });
    const baseline = makeBaseline({
      mean_tool_count: 5,
      stddev_tool_count: 2,
      mean_duration: 10000,
      stddev_duration: 2000,
      sample_count: 10,
    });
    const result = scoreAgent(agent, baseline);
    expect(result).not.toBeNull();
    expect(result!.health).toBe("green");
    expect(result!.healthScore).toBeCloseTo(0, 0);
  });

  it("returns red health for highly anomalous agent", () => {
    // 5x normal tool count => toolZ very high
    const agent = makeAgent({ tool_count: 25, first_seen_ms: 0, last_seen_ms: 50000 });
    const baseline = makeBaseline({
      mean_tool_count: 5,
      stddev_tool_count: 2,
      mean_duration: 10000,
      stddev_duration: 2000,
      sample_count: 10,
    });
    const result = scoreAgent(agent, baseline);
    expect(result).not.toBeNull();
    expect(result!.health).toBe("red");
  });

  it("adds completion penalty when agent is still active past 2x duration", () => {
    const agent = makeAgent({
      status: "active",
      first_seen_ms: 0,
      last_seen_ms: 25000, // 2.5x mean
    });
    const baseline = makeBaseline({
      mean_duration: 10000,
      stddev_duration: 2000,
      sample_count: 10,
    });
    const result = scoreAgent(agent, baseline);
    expect(result).not.toBeNull();
    // Should be higher than the same agent that's done
    const doneAgent = makeAgent({ status: "done", first_seen_ms: 0, last_seen_ms: 25000 });
    const doneResult = scoreAgent(doneAgent, baseline);
    expect(result!.healthScore).toBeGreaterThan(doneResult!.healthScore);
  });

  it("reports toolZ and durationZ", () => {
    const agent = makeAgent({ tool_count: 9, first_seen_ms: 0, last_seen_ms: 14000 });
    const baseline = makeBaseline({
      mean_tool_count: 5,
      stddev_tool_count: 2,
      mean_duration: 10000,
      stddev_duration: 2000,
      sample_count: 10,
    });
    const result = scoreAgent(agent, baseline);
    expect(result).not.toBeNull();
    expect(result!.toolZ).toBeGreaterThan(0);
    expect(result!.durationZ).toBeGreaterThan(0);
  });

  it("includes anomaly description for high tool count deviation", () => {
    const agent = makeAgent({ tool_count: 20 });
    const baseline = makeBaseline({
      mean_tool_count: 5,
      stddev_tool_count: 2,
      sample_count: 10,
    });
    const result = scoreAgent(agent, baseline);
    expect(result).not.toBeNull();
    expect(result!.anomalies.some((a) => a.includes("Tool count"))).toBe(true);
  });
});
