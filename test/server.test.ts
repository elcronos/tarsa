/**
 * Tests for createApp — SSE id: field emission and CORS restriction.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/server.js";
import { EventProcessor } from "../src/processor.js";
import type { ServerOptions } from "../src/server.js";

// Minimal Database stub
function makeDb(sessions?: import("../src/shared/models.js").Session[]) {
  return {
    listSessions: () => sessions ?? [],
    queryEvents: () => [],
    getSession: () => null,
    queryBaselines: () => null,
  } as unknown as import("../src/db.js").Database;
}

function makeSession(
  overrides: Partial<import("../src/shared/models.js").Session>
): import("../src/shared/models.js").Session {
  return {
    id: "s1",
    started_at: 1_000,
    ended_at: null,
    project_path: "/home/user/proj",
    root_agent_id: "a1",
    status: "active",
    name: null,
    ...overrides,
  };
}

function makeOpts(
  processor?: EventProcessor,
  sessions?: import("../src/shared/models.js").Session[]
): ServerOptions {
  return {
    port: 8199,
    processor: processor ?? new EventProcessor(),
    db: makeDb(sessions),
  };
}

/** Read chunks from an SSE reader until we have the snapshot (id: line) or timeout. */
async function readUntilSnapshot(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const dec = new TextDecoder();
  let text = "";
  for (let i = 0; i < 5; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
    if (text.includes("id: ")) break;
  }
  return text;
}

describe("SSE /api/events/stream id: field", () => {
  it("snapshot message includes id: line with timestamp", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(new Request("http://localhost/api/events/stream"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const text = await readUntilSnapshot(reader);
    reader.cancel();

    // Must contain an id: line (snapshot) and data: line
    expect(text).toMatch(/id: \d+\n/);
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
    const text = await readUntilSnapshot(reader);
    reader.cancel();

    expect(text).toMatch(/id: 1700000000000\n/);
  });

  it("snapshot id falls back to a recent timestamp when no events", async () => {
    const before = Date.now();
    const app = createApp(makeOpts());
    const res = await app.fetch(new Request("http://localhost/api/events/stream"));
    const reader = res.body!.getReader();
    const text = await readUntilSnapshot(reader);
    reader.cancel();
    const after = Date.now();

    const match = text.match(/id: (\d+)\n/);
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

describe("GET /api/sessions?status=closed", () => {
  it("returns only sessions with ended_at set", async () => {
    const sessions = [
      makeSession({ id: "s1", ended_at: 2_000, status: "complete" }),
      makeSession({ id: "s2", ended_at: 3_000, status: "complete" }),
      makeSession({ id: "s3", ended_at: null, status: "active" }),
    ];
    const app = createApp(makeOpts(undefined, sessions));
    const res = await app.fetch(
      new Request("http://localhost/api/sessions?status=closed")
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string }[];
    expect(data).toHaveLength(2);
    expect(data.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("returns 400 for unknown status value", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/sessions?status=bogus")
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/bogus/);
  });
});
