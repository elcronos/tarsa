/**
 * Tests for US-013 — session dismiss/restore reducer logic.
 * Logic-only (no localStorage calls — pure reducer functions tested here).
 */

import { describe, it, expect } from "vitest";

// ── Pure reducer functions (mirrors frontend/src/utils/session_storage.ts) ───

function addDismissed(ids: Set<string>, sessionId: string): Set<string> {
  const next = new Set(ids);
  next.add(sessionId);
  return next;
}

function removeDismissed(ids: Set<string>, sessionId: string): Set<string> {
  const next = new Set(ids);
  next.delete(sessionId);
  return next;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("addDismissed", () => {
  it("adds a session id to the set", () => {
    const result = addDismissed(new Set(), "sess-1");
    expect(result.has("sess-1")).toBe(true);
  });

  it("does not mutate the original set", () => {
    const original = new Set(["sess-a"]);
    addDismissed(original, "sess-b");
    expect(original.has("sess-b")).toBe(false);
  });

  it("adding an already-dismissed id is idempotent", () => {
    const s = new Set(["sess-1"]);
    const result = addDismissed(s, "sess-1");
    expect(result.size).toBe(1);
  });

  it("can dismiss multiple sessions", () => {
    let ids = new Set<string>();
    ids = addDismissed(ids, "sess-1");
    ids = addDismissed(ids, "sess-2");
    expect(ids.size).toBe(2);
    expect(ids.has("sess-1")).toBe(true);
    expect(ids.has("sess-2")).toBe(true);
  });
});

describe("removeDismissed", () => {
  it("removes a session id from the set", () => {
    const s = new Set(["sess-1", "sess-2"]);
    const result = removeDismissed(s, "sess-1");
    expect(result.has("sess-1")).toBe(false);
    expect(result.has("sess-2")).toBe(true);
  });

  it("does not mutate the original set", () => {
    const original = new Set(["sess-1"]);
    removeDismissed(original, "sess-1");
    expect(original.has("sess-1")).toBe(true);
  });

  it("removing a non-existent id is a no-op", () => {
    const s = new Set(["sess-1"]);
    const result = removeDismissed(s, "sess-999");
    expect(result.size).toBe(1);
  });

  it("can restore all dismissed sessions", () => {
    let ids = new Set(["sess-1", "sess-2", "sess-3"]);
    ids = removeDismissed(ids, "sess-1");
    ids = removeDismissed(ids, "sess-2");
    ids = removeDismissed(ids, "sess-3");
    expect(ids.size).toBe(0);
  });
});

describe("dismiss / restore round-trip", () => {
  it("dismiss then restore returns to original state", () => {
    let ids = new Set<string>();
    ids = addDismissed(ids, "sess-1");
    expect(ids.has("sess-1")).toBe(true);
    ids = removeDismissed(ids, "sess-1");
    expect(ids.has("sess-1")).toBe(false);
    expect(ids.size).toBe(0);
  });

  it("dismissed sessions are excluded from visible, included in history", () => {
    const allSessions = [
      { id: "sess-1", name: "Alpha" },
      { id: "sess-2", name: "Beta" },
      { id: "sess-3", name: "Gamma" },
    ];
    const dismissed = new Set(["sess-2"]);

    const visible = allSessions.filter((s) => !dismissed.has(s.id));
    const history = allSessions.filter((s) => dismissed.has(s.id));

    expect(visible.map((s) => s.id)).toEqual(["sess-1", "sess-3"]);
    expect(history.map((s) => s.id)).toEqual(["sess-2"]);
  });
});
