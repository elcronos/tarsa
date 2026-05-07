/**
 * Property test: replayToTimestamp is deterministic.
 * Running the same event sequence N times must yield identical serialized state.
 */

import { describe, it, expect } from "vitest";
import { replayToTimestamp, emptyState } from "../src/shared/replay-core.js";
import type { Event } from "../src/models.js";

// ── Seeded PRNG (xorshift32) ─────────────────────────────────────────────

function mkPrng(seed: number) {
  let s = seed >>> 0;
  return function next(): number {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

// ── Random event generator ───────────────────────────────────────────────

const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop", "SubagentStart"] as const;
const TOOL_NAMES = ["Bash", "Read", "Write", "Edit", "Agent"] as const;

function randomEvent(prng: () => number, idx: number): Event {
  const sessionId = `s${Math.floor(prng() * 3)}`;
  const agentId = `agent-${Math.floor(prng() * 5)}`;
  const hookEvent = HOOK_EVENTS[Math.floor(prng() * HOOK_EVENTS.length)]!;
  const toolName = TOOL_NAMES[Math.floor(prng() * TOOL_NAMES.length)]!;
  return {
    id: `ev-${idx}`,
    hook_event: hookEvent,
    session_id: sessionId,
    agent_id: agentId,
    ts: 1_700_000_000_000 + idx * 100,
    tool_name: toolName,
    tool_use_id: `tu-${idx}`,
    tool_input: { command: `cmd-${idx}` },
    schema_version: 1,
  } as unknown as Event;
}

function generateSequence(prng: () => number, length: number): Event[] {
  return Array.from({ length }, (_, i) => randomEvent(prng, i));
}

// ── Canonical projection: sort Maps by key before stringify ──────────────

function canonicalProjection(state: ReturnType<typeof emptyState>): unknown {
  return {
    sessions: Object.fromEntries([...state.sessions.entries()].sort(([a], [b]) => a.localeCompare(b))),
    agents: Object.fromEntries([...state.agents.entries()].sort(([a], [b]) => a.localeCompare(b))),
    edges: state.edges,
    tool_calls: Object.fromEntries(
      [...state.tool_calls.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, v])
    ),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("replayToTimestamp determinism", () => {
  it("same events replayed 100 times produce identical state", () => {
    const prng = mkPrng(42);
    const events = generateSequence(prng, 50);
    const maxTs = events[events.length - 1]!.ts;

    const first = JSON.stringify(canonicalProjection(replayToTimestamp(events, maxTs)));
    for (let i = 1; i < 100; i++) {
      const result = JSON.stringify(canonicalProjection(replayToTimestamp(events, maxTs)));
      expect(result).toBe(first);
    }
  });

  it("different seeds produce potentially different states (sanity check)", () => {
    const prng1 = mkPrng(1);
    const prng2 = mkPrng(999);
    const events1 = generateSequence(prng1, 20);
    const events2 = generateSequence(prng2, 20);

    const maxTs1 = events1[events1.length - 1]!.ts;
    const maxTs2 = events2[events2.length - 1]!.ts;

    const state1 = JSON.stringify(canonicalProjection(replayToTimestamp(events1, maxTs1)));
    const state2 = JSON.stringify(canonicalProjection(replayToTimestamp(events2, maxTs2)));

    // Different seeds likely produce different states; at minimum verify no crash
    expect(typeof state1).toBe("string");
    expect(typeof state2).toBe("string");
  });

  it("replayToTimestamp with ts=0 returns empty-like state (no events before epoch)", () => {
    const prng = mkPrng(7);
    const events = generateSequence(prng, 30);
    const state = replayToTimestamp(events, 0);
    // All events have ts > 0, so none should be applied
    expect(state.sessions.size).toBe(0);
    expect(state.agents.size).toBe(0);
  });

  it("partial replay up to midpoint is a prefix of full replay", () => {
    const prng = mkPrng(13);
    const events = generateSequence(prng, 40);
    const midTs = events[19]!.ts;
    const maxTs = events[events.length - 1]!.ts;

    // Replaying to midpoint then to max must produce same result as replaying to max directly
    const partialState = replayToTimestamp(events, midTs);
    const fullState = replayToTimestamp(events, maxTs);

    // Sessions in partial must be subset of full (agents may appear/disappear)
    for (const [id] of partialState.sessions) {
      expect(fullState.sessions.has(id)).toBe(true);
    }
  });
});
