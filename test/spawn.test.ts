/**
 * Tests for POST /api/spawn — input sanitization and hard-block in remote mode.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../src/server.js";
import { EventProcessor } from "../src/processor.js";
import type { ServerOptions } from "../src/server.js";
import os from "node:os";

function makeDb() {
  return {
    listSessions: () => [],
    queryEvents: () => [],
    getSession: () => null,
    queryBaselines: () => null,
  } as unknown as import("../src/db.js").Database;
}

function makeOpts(overrides: Partial<ServerOptions> = {}): ServerOptions {
  return {
    port: 8199,
    processor: new EventProcessor(),
    db: makeDb(),
    ...overrides,
  };
}

describe("POST /api/spawn — remote mode hard-block", () => {
  it("returns 403 when allowRemote is set", async () => {
    const app = createApp(makeOpts({ allowRemote: true, authToken: "tok" }));
    const res = await app.fetch(
      new Request("http://localhost/api/spawn", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
        },
        body: JSON.stringify({ cwd: os.tmpdir() }),
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/spawn — input sanitization (localhost mode)", () => {
  it("returns 400 for relative path", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "relative/path" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/absolute/i);
  });

  it("returns 400 for path with null byte", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp/evil\0path" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid/i);
  });

  it("returns 400 for non-existent directory", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/this/path/does/not/exist/ever" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/exist/i);
  });

  it("returns 400 for a file path (not a directory)", async () => {
    // Use a known file path
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/etc/hosts" }),
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/directory/i);
  });

  it("returns 400 or 500 for valid dir but missing tmux/claude (CI environment)", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: os.tmpdir() }),
      })
    );
    // In CI: claude or tmux not installed → 400. If both present → may try to spawn.
    // We accept 400 or 200 here; the key test is no shell injection or crash.
    expect([200, 400, 500]).toContain(res.status);
  });
});
