/**
 * Tests for US-012 — session inactivity timeout.
 * Uses injectable clock/timer to advance mock time.
 */

import { describe, it, expect } from "vitest";
import { EventProcessor } from "../src/processor.js";
import type { Clock } from "../src/processor.js";
import type { Event } from "../src/models.js";

function makeEvent(overrides: Partial<Event> & { hook_event: string }): Record<string, unknown> {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: "sess-idle",
    ts: Date.now(),
    ...overrides,
  };
}

/** Creates a controllable mock clock. */
function makeMockClock(): Clock & { tick: (ms: number) => void } {
  let now = Date.now();
  const callbacks: Array<{ fn: () => void; intervalMs: number; nextFire: number; id: number }> = [];
  let nextId = 1;

  const clock: Clock & { tick: (ms: number) => void } = {
    now: () => now,
    setInterval: (fn, ms) => {
      const id = nextId++;
      callbacks.push({ fn, intervalMs: ms, nextFire: now + ms, id });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (id) => {
      const idx = callbacks.findIndex((c) => c.id === (id as unknown as number));
      if (idx !== -1) callbacks.splice(idx, 1);
    },
    tick: (ms: number) => {
      now += ms;
      for (const cb of callbacks) {
        while (cb.nextFire <= now) {
          cb.fn();
          cb.nextFire += cb.intervalMs;
        }
      }
    },
  };

  return clock;
}

describe("session idle timeout", () => {
  it("does not end a session that received a recent event", () => {
    const clock = makeMockClock();
    const processor = new EventProcessor(undefined, clock);

    // Ingest an event with current timestamp
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: {}, ts: clock.now() }));

    // Advance 3 minutes — should NOT timeout (< 5min idle)
    clock.tick(3 * 60 * 1000);

    const session = processor.state.sessions.get("sess-idle");
    expect(session).toBeDefined();
    expect(session?.status).toBe("active");

    processor.stopIdleCheck();
  });

  it("ends a session after 5 minutes of inactivity", () => {
    const clock = makeMockClock();
    const processor = new EventProcessor(undefined, clock);

    const eventTs = clock.now();
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", tool_use_id: "t2", tool_input: {}, ts: eventTs }));

    // Advance 6 minutes past the event — past 5min idle threshold
    clock.tick(6 * 60 * 1000);

    const session = processor.state.sessions.get("sess-idle");
    expect(session).toBeDefined();
    // Session should have been ended by idle timeout
    expect(session?.status).not.toBe("active");

    processor.stopIdleCheck();
  });

  it("notifies subscribers with synthetic Stop event on idle timeout", () => {
    const clock = makeMockClock();
    const processor = new EventProcessor(undefined, clock);

    const eventTs = clock.now();
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", tool_use_id: "t3", tool_input: {}, ts: eventTs }));

    const received: string[] = [];
    processor.subscribe((event) => {
      received.push(String(event.hook_event));
    });

    // Advance past idle threshold
    clock.tick(6 * 60 * 1000);

    expect(received).toContain("Stop");

    processor.stopIdleCheck();
  });

  it("stopIdleCheck prevents further timeout checks", () => {
    const clock = makeMockClock();
    const processor = new EventProcessor(undefined, clock);

    const eventTs = clock.now();
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", tool_use_id: "t4", tool_input: {}, ts: eventTs }));

    // Stop idle check immediately
    processor.stopIdleCheck();

    // Advance well past threshold — timer is stopped, no timeout should fire
    clock.tick(10 * 60 * 1000);

    const session = processor.state.sessions.get("sess-idle");
    // Session was never ended because timer was stopped
    expect(session?.status).toBe("active");
  });

  it("does not double-end an already ended session", () => {
    const clock = makeMockClock();
    const processor = new EventProcessor(undefined, clock);

    const eventTs = clock.now();
    processor.ingest(makeEvent({ hook_event: "PreToolUse", tool_name: "Bash", tool_use_id: "t5", tool_input: {}, ts: eventTs }));

    // Advance past idle threshold
    clock.tick(6 * 60 * 1000);

    const stopEventsBefore = processor.events.filter((e) => e.hook_event === "Stop").length;

    // Advance again — should NOT generate another Stop for same session
    clock.tick(6 * 60 * 1000);

    const stopEventsAfter = processor.events.filter((e) => e.hook_event === "Stop").length;
    expect(stopEventsAfter).toBe(stopEventsBefore);

    processor.stopIdleCheck();
  });
});
