/**
 * Ralph iteration detection — three-marker parser, in-memory state, and
 * persistence threshold (confidence >= 0.85 AND tool_count >= 3).
 */
import { describe, it, expect } from "vitest";
import { applyEvent, emptyState } from "../src/replay.js";
import type { Event, State } from "../src/models.js";

const SESSION_ID = "ralph-sess-1";

function ev(overrides: Partial<Event> & { hook_event: string; ts: number }): Event {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: SESSION_ID,
    ...overrides,
  } as Event;
}

function fold(events: Event[]): State {
  let s = emptyState();
  for (const e of events) s = applyEvent(s, e);
  return s;
}

function pre(ts: number, toolUseId: string): Event {
  return ev({
    hook_event: "PreToolUse",
    ts,
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "echo hi" },
  });
}

describe("ralph iteration detection", () => {
  it("marker A (regex): confidence 0.95, n parsed, tool_count tracked", () => {
    const events: Event[] = [
      ev({
        hook_event: "UserPromptSubmit",
        ts: 1000,
        prompt: "[RALPH + ULTRAWORK - ITERATION 3/10] do the thing",
      }),
      pre(1100, "tu-a-1"),
      pre(1200, "tu-a-2"),
      pre(1300, "tu-a-3"),
    ];
    const state = fold(events);
    const iters = state.iterations.get(SESSION_ID) ?? [];
    expect(iters.length).toBe(1);
    const it = iters[0]!;
    expect(it.confidence).toBeCloseTo(0.95);
    expect(it.marker_source).toBe("regex");
    expect(it.n).toBe(3);
    expect(it.tool_count).toBe(3);
    // meets persistence threshold
    expect(it.confidence >= 0.85 && it.tool_count >= 3).toBe(true);
  });

  it("marker B (env): ralph_active='1' yields confidence 0.85", () => {
    const events: Event[] = [
      ev({
        hook_event: "UserPromptSubmit",
        ts: 2000,
        prompt: "do the thing",
        ralph_active: "1",
      }),
      pre(2100, "tu-b-1"),
      pre(2200, "tu-b-2"),
      pre(2300, "tu-b-3"),
    ];
    const state = fold(events);
    const iters = state.iterations.get(SESSION_ID) ?? [];
    expect(iters.length).toBe(1);
    const it = iters[0]!;
    expect(it.confidence).toBeCloseTo(0.85);
    expect(it.marker_source).toBe("env");
    expect(it.tool_count).toBe(3);
  });

  it("marker C (repeat): 3 identical prompts within 5min, confidence 0.75 — NOT persisted (below 0.85)", () => {
    const prompt = "same prompt over and over";
    const events: Event[] = [
      ev({ hook_event: "UserPromptSubmit", ts: 1_000_000, prompt }),
      ev({ hook_event: "UserPromptSubmit", ts: 1_060_000, prompt }),
      ev({ hook_event: "UserPromptSubmit", ts: 1_120_000, prompt }),
      pre(1_120_500, "tu-c-1"),
      pre(1_121_000, "tu-c-2"),
      pre(1_121_500, "tu-c-3"),
    ];
    const state = fold(events);
    const iters = state.iterations.get(SESSION_ID) ?? [];
    // Iteration is created in memory but its confidence is below the persist threshold
    expect(iters.length).toBeGreaterThanOrEqual(1);
    const last = iters[iters.length - 1]!;
    expect(last.marker_source).toBe("repeat");
    expect(last.confidence).toBeCloseTo(0.75);
    expect(last.confidence >= 0.85).toBe(false);
  });

  it("no markers: no iterations created", () => {
    const events: Event[] = [
      ev({
        hook_event: "UserPromptSubmit",
        ts: 3000,
        prompt: "regular request, nothing special",
      }),
      pre(3100, "tu-n-1"),
    ];
    const state = fold(events);
    expect(state.iterations.size).toBe(0);
  });

  it("marker A with tool_count=2 → in-memory iteration exists, NOT persisted", () => {
    const events: Event[] = [
      ev({
        hook_event: "UserPromptSubmit",
        ts: 4000,
        prompt: "[RALPH + ULTRAWORK - ITERATION 1/5] kick off",
      }),
      pre(4100, "tu-d-1"),
      pre(4200, "tu-d-2"),
    ];
    const state = fold(events);
    const iters = state.iterations.get(SESSION_ID) ?? [];
    expect(iters.length).toBe(1);
    const it = iters[0]!;
    expect(it.tool_count).toBe(2);
    expect(it.confidence).toBeCloseTo(0.95);
    // Below persistence threshold
    expect(it.confidence >= 0.85 && it.tool_count >= 3).toBe(false);
  });

  it("opening a new iteration closes the previous one (sets ended_at)", () => {
    const events: Event[] = [
      ev({
        hook_event: "UserPromptSubmit",
        ts: 5000,
        prompt: "[RALPH + ULTRAWORK - ITERATION 1/5] one",
      }),
      pre(5100, "tu-e-1"),
      ev({
        hook_event: "UserPromptSubmit",
        ts: 5500,
        prompt: "[RALPH + ULTRAWORK - ITERATION 2/5] two",
      }),
    ];
    const state = fold(events);
    const iters = state.iterations.get(SESSION_ID) ?? [];
    expect(iters.length).toBe(2);
    expect(iters[0]!.ended_at).toBe(5500);
    expect(iters[1]!.ended_at).toBeNull();
  });
});
