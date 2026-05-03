/**
 * Tests for TimelineView buildRows — hierarchy, parallel layout, row assignments.
 */

import { describe, it, expect } from "vitest";
import { buildRows } from "../frontend/src/components/TimelineView";
import type { Agent, State, Session } from "../src/models.js";

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    parent_id: null,
    session_id: "sess-1",
    status: "done",
    subagent_type: null,
    description: id,
    prompt: null,
    first_seen_ms: 1000,
    last_seen_ms: 2000,
    tool_count: 0,
    error_count: 0,
    children: [],
    result: null,
    ...overrides,
  };
}

function makeState(agents: Agent[]): State {
  const agentMap = new Map<string, Agent>(agents.map((a) => [a.id, a]));
  const session: Session = {
    id: "sess-1",
    started_at: 0,
    ended_at: null,
    project_path: "",
    root_agent_id: "root",
    status: "active",
    name: null,
  };
  return {
    sessions: new Map([["sess-1", session]]),
    agents: agentMap,
    edges: [],
    tool_calls: new Map(),
    events: [],
  };
}

describe("buildRows", () => {
  it("returns empty array for empty state", () => {
    const state = makeState([]);
    expect(buildRows(state)).toHaveLength(0);
  });

  it("computes depth=0 for root agent", () => {
    const root = makeAgent("root", { parent_id: null });
    const state = makeState([root]);
    const rows = buildRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.depth).toBe(0);
  });

  it("computes depth=1 for direct child", () => {
    const root = makeAgent("root", { parent_id: null, children: ["child"] });
    const child = makeAgent("child", { parent_id: "root" });
    const state = makeState([root, child]);
    const rows = buildRows(state);
    const childRow = rows.find((r) => r.agent.id === "child")!;
    expect(childRow.depth).toBe(1);
  });

  it("computes depth=2 for grandchild", () => {
    const root = makeAgent("root", { parent_id: null, children: ["child"] });
    const child = makeAgent("child", { parent_id: "root", children: ["grandchild"] });
    const grandchild = makeAgent("grandchild", { parent_id: "child" });
    const state = makeState([root, child, grandchild]);
    const rows = buildRows(state);
    const gcRow = rows.find((r) => r.agent.id === "grandchild")!;
    expect(gcRow.depth).toBe(2);
  });

  it("assigns leftPadding = depth * 16", () => {
    const root = makeAgent("root", { parent_id: null, children: ["child"] });
    const child = makeAgent("child", { parent_id: "root" });
    const state = makeState([root, child]);
    const rows = buildRows(state);
    const rootRow = rows.find((r) => r.agent.id === "root")!;
    const childRow = rows.find((r) => r.agent.id === "child")!;
    expect(rootRow.leftPadding).toBe(0);
    expect(childRow.leftPadding).toBe(16);
  });

  it("parallel siblings get distinct rowIndex values", () => {
    // Two siblings that overlap in time → parallel → distinct rows
    const root = makeAgent("root", { parent_id: null, children: ["a", "b"] });
    const a = makeAgent("a", {
      parent_id: "root",
      first_seen_ms: 1000,
      last_seen_ms: 3000,
    });
    const b = makeAgent("b", {
      parent_id: "root",
      first_seen_ms: 1500, // overlaps with a
      last_seen_ms: 4000,
    });
    const state = makeState([root, a, b]);
    const rows = buildRows(state);
    const aRow = rows.find((r) => r.agent.id === "a")!;
    const bRow = rows.find((r) => r.agent.id === "b")!;
    expect(aRow.rowIndex).not.toBe(bRow.rowIndex);
  });

  it("sequential siblings can share same rowIndex", () => {
    // Two siblings that do NOT overlap → sequential → same row is allowed
    const root = makeAgent("root", { parent_id: null, children: ["a", "b"] });
    const a = makeAgent("a", {
      parent_id: "root",
      first_seen_ms: 1000,
      last_seen_ms: 2000,
    });
    const b = makeAgent("b", {
      parent_id: "root",
      first_seen_ms: 3000, // starts after a ends
      last_seen_ms: 4000,
    });
    const state = makeState([root, a, b]);
    const rows = buildRows(state);
    const aRow = rows.find((r) => r.agent.id === "a")!;
    const bRow = rows.find((r) => r.agent.id === "b")!;
    // Sequential siblings share the same rowIndex (compact layout)
    expect(aRow.rowIndex).toBe(bRow.rowIndex);
  });

  it("parent appears before children in sorted output", () => {
    const root = makeAgent("root", { parent_id: null, children: ["child"], first_seen_ms: 0, last_seen_ms: 5000 });
    const child = makeAgent("child", { parent_id: "root", first_seen_ms: 1000, last_seen_ms: 3000 });
    const state = makeState([root, child]);
    const rows = buildRows(state);
    const rootIdx = rows.findIndex((r) => r.agent.id === "root");
    const childIdx = rows.findIndex((r) => r.agent.id === "child");
    expect(rootIdx).toBeLessThan(childIdx);
  });

  it("sequential grandchild has distinct rowIndex from parallel siblings", () => {
    // parent + 2 parallel children + 1 sequential grandchild of a
    const root = makeAgent("root", { parent_id: null, children: ["a", "b"] });
    const a = makeAgent("a", {
      parent_id: "root",
      children: ["gc"],
      first_seen_ms: 1000,
      last_seen_ms: 3000,
    });
    const b = makeAgent("b", {
      parent_id: "root",
      first_seen_ms: 1500, // overlaps a → parallel
      last_seen_ms: 4000,
    });
    const gc = makeAgent("gc", {
      parent_id: "a",
      first_seen_ms: 3500, // after a ends → sequential grandchild
      last_seen_ms: 5000,
    });
    const state = makeState([root, a, b, gc]);
    const rows = buildRows(state);

    const aRow = rows.find((r) => r.agent.id === "a")!;
    const bRow = rows.find((r) => r.agent.id === "b")!;
    const gcRow = rows.find((r) => r.agent.id === "gc")!;

    // a and b are parallel → distinct rows
    expect(aRow.rowIndex).not.toBe(bRow.rowIndex);

    // gc is depth 2
    expect(gcRow.depth).toBe(2);
  });
});
