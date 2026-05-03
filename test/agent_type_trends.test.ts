/**
 * Tests for US-010: agentTypeTrends() — per-type plain-English summary from baselines.
 */

import { describe, it, expect } from "vitest";
import { agentTypeTrends, zScoreBadge } from "../src/insights.js";
import type { BaselineRow } from "../src/insights.js";

function makeBaseline(overrides: Partial<BaselineRow> = {}): BaselineRow {
  return {
    agent_type: "executor",
    mean_duration: 3000,
    mean_tool_count: 5,
    mean_cost: 0.001,
    sample_count: 10,
    stddev_duration: 1000,
    stddev_tool_count: 2,
    updated_at: Date.now(),
    tool_sequence_common: null,
    ...overrides,
  };
}

describe("agentTypeTrends", () => {
  it("returns empty array for no baselines", () => {
    expect(agentTypeTrends([])).toHaveLength(0);
  });

  it("produces one trend per baseline", () => {
    const baselines = [
      makeBaseline({ agent_type: "executor" }),
      makeBaseline({ agent_type: "planner" }),
    ];
    const trends = agentTypeTrends(baselines);
    expect(trends).toHaveLength(2);
  });

  it("includes agent type in output", () => {
    const trends = agentTypeTrends([makeBaseline({ agent_type: "my-type" })]);
    expect(trends[0]!.type).toBe("my-type");
  });

  it("includes sample_count in output", () => {
    const trends = agentTypeTrends([makeBaseline({ sample_count: 42 })]);
    expect(trends[0]!.sample_count).toBe(42);
  });

  it("summary contains tool range and duration range", () => {
    const baseline = makeBaseline({
      mean_tool_count: 5,
      stddev_tool_count: 2,
      mean_duration: 3000,
      stddev_duration: 1000,
      sample_count: 12,
    });
    const trends = agentTypeTrends([baseline]);
    const summary = trends[0]!.summary;
    // tool range: 3-7, duration range: 2.0-4.0s, 12 prior runs
    expect(summary).toMatch(/tool call/);
    expect(summary).toMatch(/s/); // duration in seconds
    expect(summary).toMatch(/12 prior run/);
  });

  it("summary uses singular 'run' for sample_count=1", () => {
    const baseline = makeBaseline({ sample_count: 1 });
    const trends = agentTypeTrends([baseline]);
    expect(trends[0]!.summary).toContain("1 prior run");
    expect(trends[0]!.summary).not.toMatch(/1 prior runs/);
  });

  it("summary shows correct tool range with mean ± stddev", () => {
    const baseline = makeBaseline({
      mean_tool_count: 4,
      stddev_tool_count: 1,
    });
    const trends = agentTypeTrends([baseline]);
    // toolLow = max(0, round(4-1)) = 3, toolHigh = round(4+1) = 5
    expect(trends[0]!.summary).toMatch(/3-5/);
  });

  it("shows single value when stddev=0", () => {
    const baseline = makeBaseline({
      mean_tool_count: 4,
      stddev_tool_count: 0,
      mean_duration: 2000,
      stddev_duration: 0,
    });
    const trends = agentTypeTrends([baseline]);
    // toolRange = "4", durRange = "2.0s"
    expect(trends[0]!.summary).toMatch(/4 tool call/);
  });
});

describe("zScoreBadge", () => {
  const baseline = makeBaseline({
    mean_duration: 3000,
    stddev_duration: 1000,
    sample_count: 10,
  });

  it("returns null when sample_count < 5", () => {
    const b = { ...baseline, sample_count: 4 };
    expect(zScoreBadge(5000, b)).toBeNull();
  });

  it("returns null when stddev=0", () => {
    const b = { ...baseline, stddev_duration: 0 };
    expect(zScoreBadge(5000, b)).toBeNull();
  });

  it("returns 'fast' for z < -1 (agent much faster than average)", () => {
    // z = (1000 - 3000) / 1000 = -2
    expect(zScoreBadge(1000, baseline)).toBe("fast");
  });

  it("returns 'slow' for z > 1 (agent much slower than average)", () => {
    // z = (5000 - 3000) / 1000 = 2
    expect(zScoreBadge(5000, baseline)).toBe("slow");
  });

  it("returns 'normal' for -1 <= z <= 1", () => {
    // z = (3500 - 3000) / 1000 = 0.5
    expect(zScoreBadge(3500, baseline)).toBe("normal");
  });

  it("returns 'normal' at exact mean", () => {
    expect(zScoreBadge(3000, baseline)).toBe("normal");
  });
});
