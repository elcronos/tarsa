/**
 * Tests for US-010: updateBaselines() updates agent_baselines table on session end.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database, BaselineRow } from "../src/db.js";
import { updateBaselines } from "../src/db.js";
import type { Agent, State, Session, ToolCall } from "../src/models.js";

// ── In-memory Database mock ────────────────────────────────────────────────

class MockDatabase implements Database {
  private baselines = new Map<string, BaselineRow>();

  upsertSession(): void {}
  upsertAgent(): void {}
  insertToolCall(): void {}
  insertEvent(): void {}
  queryEvents(): [] { return []; }
  listSessions(): [] { return []; }
  getSession(): null { return null; }
  close(): void {}

  queryBaselines(agentType: string): BaselineRow | null {
    return this.baselines.get(agentType) ?? null;
  }

  listAllBaselines(): BaselineRow[] {
    return Array.from(this.baselines.values());
  }

  updateBaseline(
    agentType: string,
    durationMs: number,
    toolCount: number,
    costUsd: number,
    toolSequenceCommon: string | null
  ): void {
    const existing = this.baselines.get(agentType);
    if (!existing || existing.sample_count === 0) {
      this.baselines.set(agentType, {
        agent_type: agentType,
        mean_duration: durationMs,
        mean_tool_count: toolCount,
        mean_cost: costUsd,
        sample_count: 1,
        stddev_duration: 0,
        stddev_tool_count: 0,
        updated_at: Date.now(),
        tool_sequence_common: toolSequenceCommon,
      });
    } else {
      const n = existing.sample_count + 1;
      const delta = durationMs - existing.mean_duration;
      const newMean = existing.mean_duration + delta / n;
      const delta2 = durationMs - newMean;
      const oldM2 = existing.stddev_duration * existing.stddev_duration * (existing.sample_count - 1);
      const newM2 = oldM2 + delta * delta2;
      const newStddev = n >= 2 ? Math.sqrt(newM2 / (n - 1)) : 0;

      const deltaTools = toolCount - existing.mean_tool_count;
      const newMeanTools = existing.mean_tool_count + deltaTools / n;

      this.baselines.set(agentType, {
        ...existing,
        mean_duration: newMean,
        mean_tool_count: newMeanTools,
        mean_cost: existing.mean_cost + (costUsd - existing.mean_cost) / n,
        sample_count: n,
        stddev_duration: newStddev,
        updated_at: Date.now(),
        tool_sequence_common: toolSequenceCommon ?? existing.tool_sequence_common,
      });
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    parent_id: null,
    session_id: "sess-1",
    status: "done",
    subagent_type: "executor",
    description: id,
    prompt: null,
    first_seen_ms: 1000,
    last_seen_ms: 3000,
    tool_count: 2,
    error_count: 0,
    children: [],
    result: null,
    ...overrides,
  };
}

function makeToolCall(id: string, agentId: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    agent_id: agentId,
    tool_name: "Bash",
    input: { command: "echo hi" },
    input_preview: "echo hi",
    started_ms: 1000,
    ended_ms: 2000,
    status: "done",
    output_preview: "hi",
    response: "hi",
    duration_ms: 1000,
    retry_of: null,
    ...overrides,
  };
}

function makeState(agents: Agent[], toolCalls: Map<string, ToolCall[]> = new Map()): State {
  const agentMap = new Map<string, Agent>(agents.map((a) => [a.id, a]));
  const session: Session = {
    id: "sess-1",
    started_at: 0,
    ended_at: 5000,
    project_path: "",
    root_agent_id: "root",
    status: "complete",
    name: null,
  };
  return {
    sessions: new Map([["sess-1", session]]),
    agents: agentMap,
    edges: [],
    tool_calls: toolCalls,
    events: [],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("updateBaselines (US-010)", () => {
  let db: MockDatabase;

  beforeEach(() => {
    db = new MockDatabase();
  });

  it("creates a baseline entry for each agent type on first session end", () => {
    const agent = makeAgent("a1", { subagent_type: "executor" });
    const state = makeState([agent]);
    updateBaselines(db, state);

    const baseline = db.queryBaselines("executor");
    expect(baseline).not.toBeNull();
    expect(baseline!.sample_count).toBe(1);
    expect(baseline!.agent_type).toBe("executor");
  });

  it("updates mean_duration on second call (Welford)", () => {
    const agent1 = makeAgent("a1", { subagent_type: "executor", first_seen_ms: 0, last_seen_ms: 2000 });
    const state1 = makeState([agent1]);
    updateBaselines(db, state1);

    const agent2 = makeAgent("a2", { subagent_type: "executor", first_seen_ms: 0, last_seen_ms: 4000 });
    const state2 = makeState([agent2]);
    updateBaselines(db, state2);

    const baseline = db.queryBaselines("executor")!;
    expect(baseline.sample_count).toBe(2);
    expect(baseline.mean_duration).toBeCloseTo(3000, 0); // (2000 + 4000) / 2
  });

  it("tracks multiple agent types independently", () => {
    const exec = makeAgent("a1", { subagent_type: "executor", first_seen_ms: 0, last_seen_ms: 1000 });
    const planner = makeAgent("a2", { subagent_type: "planner", first_seen_ms: 0, last_seen_ms: 2000 });
    const state = makeState([exec, planner]);
    updateBaselines(db, state);

    expect(db.queryBaselines("executor")).not.toBeNull();
    expect(db.queryBaselines("planner")).not.toBeNull();
    expect(db.queryBaselines("executor")!.mean_duration).toBeCloseTo(1000, 0);
    expect(db.queryBaselines("planner")!.mean_duration).toBeCloseTo(2000, 0);
  });

  it("stores tool_sequence_common as JSON string", () => {
    const agent = makeAgent("a1", { subagent_type: "executor" });
    const tc1 = makeToolCall("t1", "a1", { tool_name: "Bash" });
    const tc2 = makeToolCall("t2", "a1", { tool_name: "Read" });
    const tc3 = makeToolCall("t3", "a1", { tool_name: "Bash" });
    const toolCalls = new Map([["a1", [tc1, tc2, tc3]]]);
    const state = makeState([agent], toolCalls);
    updateBaselines(db, state);

    const baseline = db.queryBaselines("executor")!;
    // tool_sequence_common should be set (JSON array of top-3 sequences)
    expect(baseline.tool_sequence_common).not.toBeNull();
    const seqs = JSON.parse(baseline.tool_sequence_common!) as string[];
    expect(Array.isArray(seqs)).toBe(true);
    expect(seqs.length).toBeGreaterThan(0);
  });

  it("updates mean_tool_count correctly", () => {
    const agent = makeAgent("a1", { subagent_type: "executor", tool_count: 5 });
    const state = makeState([agent]);
    updateBaselines(db, state);

    const baseline = db.queryBaselines("executor")!;
    expect(baseline.mean_tool_count).toBe(5);
  });
});
