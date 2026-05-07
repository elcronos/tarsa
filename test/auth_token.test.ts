/**
 * Tests for auth token gating — only active when --allow-remote is set.
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../src/server.js";
import { EventProcessor } from "../src/processor.js";
import type { ServerOptions } from "../src/server.js";

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

describe("Auth token — remote mode", () => {
  it("POST /api/reset returns 401 without token when allowRemote is set", async () => {
    const app = createApp(makeOpts({ allowRemote: true, authToken: "test-secret-token" }));
    const res = await app.fetch(
      new Request("http://localhost/api/reset", { method: "POST" })
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/reset returns 401 with wrong token when allowRemote is set", async () => {
    const app = createApp(makeOpts({ allowRemote: true, authToken: "test-secret-token" }));
    const res = await app.fetch(
      new Request("http://localhost/api/reset", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/reset succeeds with correct token when allowRemote is set", async () => {
    const app = createApp(makeOpts({ allowRemote: true, authToken: "test-secret-token" }));
    const res = await app.fetch(
      new Request("http://localhost/api/reset", {
        method: "POST",
        headers: { Authorization: "Bearer test-secret-token" },
      })
    );
    expect(res.status).toBe(200);
  });

  it("CORS allowHeaders includes Authorization in remote mode", async () => {
    const app = createApp(makeOpts({ allowRemote: true, authToken: "test-secret-token" }));
    const res = await app.fetch(
      new Request("http://localhost/api/reset", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8100",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Authorization",
        },
      })
    );
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed.toLowerCase()).toContain("authorization");
  });
});

describe("Auth token — localhost mode (default)", () => {
  it("POST /api/reset succeeds without any auth header in localhost mode", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/reset", { method: "POST" })
    );
    expect(res.status).toBe(200);
  });

  it("CORS allowHeaders does not include Authorization in localhost mode", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/reset", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8100",
          "Access-Control-Request-Method": "POST",
        },
      })
    );
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed.toLowerCase()).not.toContain("authorization");
  });
});
