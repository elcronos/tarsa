/**
 * Security regression tests — Block B
 *
 * HIGH-1: Static file path traversal (server catch-all)
 * HIGH-2: Transcript path validation (readTranscriptByPath)
 * MED-5:  SSE client cap (MAX_SSE_CLIENTS)
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../src/server.js";
import { readTranscriptByPath } from "../src/transcript.js";
import { EventProcessor } from "../src/processor.js";
import type { ServerOptions } from "../src/server.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDb() {
  return {
    listSessions: () => [],
    queryEvents: () => [],
    getSession: () => null,
    queryBaselines: () => null,
    listAllBaselines: () => [],
  } as unknown as import("../src/db.js").Database;
}

function makeOpts(processor?: EventProcessor): ServerOptions {
  return {
    port: 8199,
    processor: processor ?? new EventProcessor(),
    db: makeDb(),
  };
}

// ── HIGH-1: Static path traversal ────────────────────────────────────────

describe("HIGH-1: static file path traversal", () => {
  it("GET /../../../etc/passwd returns 404 (or no-static fallback, not file contents)", async () => {
    const app = createApp(makeOpts());
    // Hono normalises the path before our handler sees it; the important thing
    // is we never serve /etc/passwd contents. We accept 404 or the "not built"
    // HTML fallback — both are safe. We only fail if the response body contains
    // the literal string "root:" which would indicate passwd file was served.
    const res = await app.fetch(
      new Request("http://localhost/../../../etc/passwd")
    );
    const body = await res.text();
    expect(body).not.toContain("root:");
  });

  it("GET with encoded traversal (%2F..%2F..%2Fetc%2Fpasswd) does not serve sensitive file", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/%2F..%2F..%2Fetc%2Fpasswd")
    );
    const body = await res.text();
    expect(body).not.toContain("root:");
  });
});

// ── HIGH-2: Transcript path validation ───────────────────────────────────

describe("HIGH-2: readTranscriptByPath path validation", () => {
  it("returns empty array for /etc/passwd", () => {
    const result = readTranscriptByPath("/etc/passwd");
    expect(result).toEqual([]);
  });

  it("returns empty array for /etc/hosts", () => {
    const result = readTranscriptByPath("/etc/hosts");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    const result = readTranscriptByPath("");
    expect(result).toEqual([]);
  });

  it("returns empty array for path that doesn't exist", () => {
    const result = readTranscriptByPath("/nonexistent/path/file.jsonl");
    expect(result).toEqual([]);
  });

  it("returns empty array for path escaping projects dir via traversal", () => {
    // Even if the path string contains .claude/projects as a prefix, a real
    // path that traverses out should be rejected
    const result = readTranscriptByPath(
      `${process.env.HOME}/.claude/projects/../../../etc/passwd`
    );
    expect(result).toEqual([]);
  });
});

// ── MED-5: SSE client cap ─────────────────────────────────────────────────

describe("MED-5: SSE connection cap", () => {
  it("33rd SSE connection returns 429", async () => {
    // We use a fresh createApp for isolation; the module-level `clients` Set
    // is shared, so we need to drain connections after the test.
    const app = createApp(makeOpts());

    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

    // Open 32 connections (should all succeed)
    for (let i = 0; i < 32; i++) {
      const res = await app.fetch(
        new Request("http://localhost/api/events/stream")
      );
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      // Read the initial chunk to advance the stream start callback
      await reader.read();
      readers.push(reader);
    }

    // 33rd should be rejected
    const res33 = await app.fetch(
      new Request("http://localhost/api/events/stream")
    );
    expect(res33.status).toBe(429);

    // Cleanup: cancel all readers so streams close
    for (const r of readers) {
      r.cancel();
    }
  });
});
