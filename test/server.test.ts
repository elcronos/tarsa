/**
 * Tests for createApp — SSE id: field emission and CORS restriction.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/server.js";
import { EventProcessor } from "../src/processor.js";
import type { ServerOptions } from "../src/server.js";

// Minimal Database stub
function makeDb() {
  return {
    listSessions: () => [],
    queryEvents: () => [],
    getSession: () => null,
    queryBaselines: () => null,
  } as unknown as import("../src/db.js").Database;
}

function makeOpts(processor?: EventProcessor): ServerOptions {
  return {
    port: 8199,
    processor: processor ?? new EventProcessor(),
    db: makeDb(),
  };
}

describe("SSE /api/events/stream id: field", () => {
  it("snapshot message includes id: line with timestamp", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(new Request("http://localhost/api/events/stream"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read just the first chunk from the stream
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.cancel();

    const text = new TextDecoder().decode(value);
    // Must contain an id: line before the data: line
    expect(text).toMatch(/^id: \d+\n/);
    expect(text).toContain('\ndata: ');
  });

  it("snapshot id equals last event ts when events exist", async () => {
    const processor = new EventProcessor();
    processor.ingest({
      id: "ev1",
      hook_event: "PreToolUse",
      session_id: "s1",
      ts: 1_700_000_000_000,
      tool_name: "Bash",
      tool_use_id: "tu1",
      tool_input: {},
    });

    const app = createApp(makeOpts(processor));
    const res = await app.fetch(new Request("http://localhost/api/events/stream"));
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.cancel();

    const text = new TextDecoder().decode(value);
    expect(text).toMatch(/^id: 1700000000000\n/);
  });

  it("snapshot id falls back to a recent timestamp when no events", async () => {
    const before = Date.now();
    const app = createApp(makeOpts());
    const res = await app.fetch(new Request("http://localhost/api/events/stream"));
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.cancel();
    const after = Date.now();

    const text = new TextDecoder().decode(value);
    const match = text.match(/^id: (\d+)\n/);
    expect(match).not.toBeNull();
    const id = parseInt(match![1]!, 10);
    expect(id).toBeGreaterThanOrEqual(before);
    expect(id).toBeLessThanOrEqual(after);
  });
});

describe("CORS restriction", () => {
  it("allows requests from http://localhost:5173", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/state", {
        headers: { Origin: "http://localhost:5173" },
      })
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("does not reflect arbitrary origins", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/state", {
        headers: { Origin: "http://evil.example.com" },
      })
    );
    // With a restricted allowlist, the origin header should not be echoed back
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao).not.toBe("http://evil.example.com");
  });
});
