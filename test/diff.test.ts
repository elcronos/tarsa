/**
 * Tests for session diff agent-matching logic.
 * Tests the matchingKey function and compareSnapshots behavior
 * using the useSessionCompare hook's exported helpers.
 */

import { describe, it, expect } from "vitest";
import { matchingKey } from "../frontend/src/hooks/useSessionCompare.js";
import type { Agent } from "../frontend/src/types.js";

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    parent_id: overrides.parent_id ?? null,
    session_id: "sess-test",
    status: "done",
    subagent_type: overrides.subagent_type ?? null,
    description: overrides.name ?? overrides.id,
    prompt: null,
    first_seen_ms: overrides.first_seen_ms ?? 1000,
    last_seen_ms: overrides.last_seen_ms ?? 2000,
    tool_count: overrides.tool_count ?? 0,
    error_count: 0,
    children: overrides.children ?? [],
    result: null,
  };
}

describe("matchingKey", () => {
  it("produces same key for agents with same type, depth, and spawn order", () => {
    const agentA = makeAgent({ id: "a1", subagent_type: "executor", parent_id: "root" });
    const agentB = makeAgent({ id: "b1", subagent_type: "executor", parent_id: "root2" });

    const depthMap = new Map([["a1", 1], ["b1", 1]]);
    const spawnOrderMap = new Map([["a1", 0], ["b1", 0]]);

    expect(matchingKey(agentA, depthMap, spawnOrderMap)).toBe(
      matchingKey(agentB, depthMap, spawnOrderMap)
    );
  });

  it("produces different keys for same type at different depths", () => {
    const agentA = makeAgent({ id: "a1", subagent_type: "executor" });
    const agentB = makeAgent({ id: "b1", subagent_type: "executor" });

    const depthA = new Map([["a1", 1]]);
    const depthB = new Map([["b1", 2]]);
    const spawnA = new Map([["a1", 0]]);
    const spawnB = new Map([["b1", 0]]);

    expect(matchingKey(agentA, depthA, spawnA)).not.toBe(
      matchingKey(agentB, depthB, spawnB)
    );
  });

  it("produces different keys for same type at different spawn orders", () => {
    const agentA = makeAgent({ id: "a1", subagent_type: "executor" });
    const agentB = makeAgent({ id: "b1", subagent_type: "executor" });

    const depthMap = new Map([["a1", 1], ["b1", 1]]);
    const spawnA = new Map([["a1", 0]]);
    const spawnB = new Map([["b1", 1]]);

    expect(matchingKey(agentA, depthMap, spawnA)).not.toBe(
      matchingKey(agentB, depthMap, spawnB)
    );
  });

  it("uses 'root' as type for agents with null subagent_type", () => {
    const agent = makeAgent({ id: "r1", subagent_type: null });
    const depthMap = new Map([["r1", 0]]);
    const spawnOrderMap = new Map([["r1", 0]]);

    const key = matchingKey(agent, depthMap, spawnOrderMap);
    expect(key).toBe("root|d0|o0");
  });

  it("key format is type|dDEPTH|oORDER", () => {
    const agent = makeAgent({ id: "x1", subagent_type: "planner" });
    const depthMap = new Map([["x1", 3]]);
    const spawnOrderMap = new Map([["x1", 2]]);

    const key = matchingKey(agent, depthMap, spawnOrderMap);
    expect(key).toBe("planner|d3|o2");
  });
});
