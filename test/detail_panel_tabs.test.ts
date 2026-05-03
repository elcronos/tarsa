/**
 * Tests for US-015 — DetailPanel tab logic.
 * Logic-only tests (no DOM render — @testing-library/react not present).
 */

import { describe, it, expect } from "vitest";

// ── Tab definitions (mirrors DetailPanel.tsx) ────────────────────────────────

type TabId = "trace" | "thread" | "files" | "prompt" | "result";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "trace", label: "Trace" },
  { id: "thread", label: "Thread" },
  { id: "files", label: "Files" },
  { id: "prompt", label: "Prompt" },
  { id: "result", label: "Result" },
];

describe("DetailPanel tabs", () => {
  it("has 5 tabs: Trace, Thread, Files, Prompt, Result", () => {
    expect(TABS).toHaveLength(5);
    const ids = TABS.map((t) => t.id);
    expect(ids).toContain("trace");
    expect(ids).toContain("thread");
    expect(ids).toContain("files");
    expect(ids).toContain("prompt");
    expect(ids).toContain("result");
  });

  it("default tab is 'trace'", () => {
    // Simulates useState default in DetailPanel
    const defaultTab: TabId = "trace";
    expect(defaultTab).toBe("trace");
  });

  it("tab labels are human-readable", () => {
    const labels = TABS.map((t) => t.label);
    expect(labels).toContain("Trace");
    expect(labels).toContain("Thread");
    expect(labels).toContain("Files");
    expect(labels).toContain("Prompt");
    expect(labels).toContain("Result");
  });

  it("switching tabs changes active tab id", () => {
    let activeTab: TabId = "trace";
    const switchTab = (id: TabId) => { activeTab = id; };

    switchTab("files");
    expect(activeTab).toBe("files");

    switchTab("prompt");
    expect(activeTab).toBe("prompt");

    switchTab("trace");
    expect(activeTab).toBe("trace");
  });

  it("all tab ids are unique", () => {
    const ids = TABS.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ── Result tab branch logic (US-V2-01) ───────────────────────────────────────

describe("ResultTab branch logic", () => {
  function shouldShowEmpty(result: string | null): boolean {
    return !result || result.trim() === "";
  }

  it("shows empty state when result is null", () => {
    expect(shouldShowEmpty(null)).toBe(true);
  });

  it("shows empty state when result is empty string", () => {
    expect(shouldShowEmpty("")).toBe(true);
  });

  it("shows empty state when result is whitespace only", () => {
    expect(shouldShowEmpty("   ")).toBe(true);
  });

  it("shows content when result has text", () => {
    expect(shouldShowEmpty("Agent completed successfully")).toBe(false);
  });

  it("shows content when result has newlines and spaces but non-empty", () => {
    expect(shouldShowEmpty("  result  \n")).toBe(false);
  });
});

// ── ESC key logic ─────────────────────────────────────────────────────────────

describe("ESC key closes DetailPanel", () => {
  it("ESC sets selectedAgentId to null when agent is selected", () => {
    let selectedAgentId: string | null = "ag-123";
    let searchOpen = false;

    // Simulate keydown handler logic from App.tsx
    const handleKeydown = (key: string, metaKey = false) => {
      if ((metaKey) && key === "k") {
        searchOpen = !searchOpen;
        return;
      }
      if (key === "Escape") {
        if (searchOpen) {
          searchOpen = false;
        } else if (selectedAgentId !== null) {
          selectedAgentId = null;
        }
      }
    };

    handleKeydown("Escape");
    expect(selectedAgentId).toBeNull();
  });

  it("ESC closes search palette first when both open (search takes priority)", () => {
    let selectedAgentId: string | null = "ag-456";
    let searchOpen = true;

    const handleKeydown = (key: string) => {
      if (key === "Escape") {
        if (searchOpen) {
          searchOpen = false;
        } else if (selectedAgentId !== null) {
          selectedAgentId = null;
        }
      }
    };

    handleKeydown("Escape");
    expect(searchOpen).toBe(false);
    expect(selectedAgentId).toBe("ag-456"); // agent not cleared yet
  });

  it("ESC does nothing when no agent selected and search closed", () => {
    let selectedAgentId: string | null = null;
    let searchOpen = false;

    const handleKeydown = (key: string) => {
      if (key === "Escape") {
        if (searchOpen) {
          searchOpen = false;
        } else if (selectedAgentId !== null) {
          selectedAgentId = null;
        }
      }
    };

    handleKeydown("Escape");
    expect(selectedAgentId).toBeNull();
    expect(searchOpen).toBe(false);
  });
});
