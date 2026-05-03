/**
 * Tests for US-V2-06 — persist search index across server restart.
 *
 * Opens an in-memory SQLite database, inserts events, calls seedFromDatabase,
 * then verifies searchEvents returns those events.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildIndex, searchEvents, seedFromDatabase } from "../src/search.js";
import { openDatabase } from "../src/db.js";
import type { Event } from "../src/models.js";

function makeEvent(id: string, overrides: Partial<Event> = {}): Event {
  return {
    id,
    session_id: "sess-seed",
    ts: Date.now(),
    hook_event: "PreToolUse",
    tool_name: "Bash",
    agent_id: "agent-1",
    ...overrides,
  } as Event;
}

describe("seedFromDatabase (US-V2-06)", () => {
  beforeEach(() => {
    buildIndex([]); // reset in-memory index before each test
  });

  it("seeds index from db events and makes them searchable", async () => {
    const db = await openDatabase(":memory:");

    const e1 = makeEvent("ev-seed-1", { tool_name: "uniquetoolseed99", tool_input: { command: "run uniquetoolseed99" } });
    const e2 = makeEvent("ev-seed-2", { tool_name: "Bash", tool_input: { command: "echo hello" } });
    db.insertEvent(e1);
    db.insertEvent(e2);

    const count = seedFromDatabase(db, 10_000);
    expect(count).toBe(2);

    // Search for the unique token from e1
    const results = searchEvents("uniquetoolseed99", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.event.id).toBe("ev-seed-1");

    db.close();
  });

  it("returns 0 when db has no events", async () => {
    const db = await openDatabase(":memory:");
    const count = seedFromDatabase(db, 10_000);
    expect(count).toBe(0);
    db.close();
  });

  it("respects the limit parameter", async () => {
    const db = await openDatabase(":memory:");

    for (let i = 0; i < 10; i++) {
      db.insertEvent(makeEvent(`ev-limit-${i}`, { tool_name: `limittoken_${i}` }));
    }

    const count = seedFromDatabase(db, 3);
    expect(count).toBe(3);

    db.close();
  });

  it("does not duplicate events already in index", async () => {
    const db = await openDatabase(":memory:");

    const e = makeEvent("ev-dedup-1", { tool_name: "deduptoken99", tool_input: { command: "deduptoken99" } });
    db.insertEvent(e);

    // Seed twice
    seedFromDatabase(db, 10_000);
    seedFromDatabase(db, 10_000);

    // indexEvent is idempotent (same id overwrites), so no duplicates
    const results = searchEvents("deduptoken99", 10);
    expect(results.length).toBe(1);

    db.close();
  });

  it("events from prior session are searchable after seed", async () => {
    const db = await openDatabase(":memory:");

    const priorEvent = makeEvent("ev-prior-1", {
      session_id: "prior-session",
      tool_name: "PriorSessionTool",
      tool_input: { command: "priorsessionunique42" },
    });
    db.insertEvent(priorEvent);

    seedFromDatabase(db, 10_000);

    const results = searchEvents("priorsessionunique42", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.event.session_id).toBe("prior-session");

    db.close();
  });
});
