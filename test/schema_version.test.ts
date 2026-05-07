import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventProcessor } from "../src/processor.js";

function makeEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: Math.random().toString(36).slice(2, 10),
    session_id: "sess-sv",
    ts: Date.now(),
    hook_event: "PreToolUse",
    tool_name: "Bash",
    agent_id: "ag-sv",
    tool_use_id: "tu-sv",
    tool_input: {},
    ...overrides,
  };
}

describe("schema_version defensive read", () => {
  let processor: EventProcessor;

  beforeEach(() => {
    processor = new EventProcessor();
  });

  it("processes event with schema_version: 1 normally", () => {
    processor.ingest(makeEvent({ schema_version: 1 }));
    expect(processor.events.length).toBe(1);
  });

  it("processes event with missing schema_version (treated as v1)", () => {
    const ev = makeEvent({});
    delete ev["schema_version"];
    processor.ingest(ev);
    expect(processor.events.length).toBe(1);
  });

  it("warns and skips event with unknown schema_version 99", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    processor.ingest(makeEvent({ schema_version: 99 }));
    expect(processor.events.length).toBe(0);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown schema_version 99")
    );
    stderrSpy.mockRestore();
  });
});
