/**
 * CSRF protection tests for POST /api/budget — Block B
 *
 * Acceptance criteria:
 *  1. POST without X-Claudelens-CSRF → 403
 *  2. POST with valid token from SSE → 200
 *  3. Reusing same token → still 200 (tokens are per-connection, not single-use per spec)
 *  4. Token from a different string (forged) → 403
 *  5. >60 POSTs/min from same connection → 429
 */

import { describe, it, expect } from "vitest";
import { createApp } from "../src/server.js";
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
    setBudget: () => {},
  } as unknown as import("../src/db.js").Database;
}

function makeOpts(): ServerOptions {
  return {
    port: 8199,
    processor: new EventProcessor(),
    db: makeDb(),
  };
}

/**
 * Open an SSE stream, read the first event (csrf-token), return the token
 * and a cleanup function to cancel the reader.
 */
async function getCsrfToken(
  app: ReturnType<typeof createApp>
): Promise<{ token: string; cleanup: () => void }> {
  const res = await app.fetch(
    new Request("http://localhost/api/events/stream")
  );
  expect(res.status).toBe(200);

  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);

  // First event is csrf-token
  const match = text.match(/data: (\{.*\})/);
  expect(match).not.toBeNull();
  const parsed = JSON.parse(match![1]!) as { token: string };
  expect(typeof parsed.token).toBe("string");
  expect(parsed.token.length).toBeGreaterThan(0);

  return {
    token: parsed.token,
    cleanup: () => reader.cancel(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("CSRF: POST /api/budget", () => {
  it("returns 403 when no X-Claudelens-CSRF header", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s1", usd: 5 }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 with a forged/unknown token", async () => {
    const app = createApp(makeOpts());
    const res = await app.fetch(
      new Request("http://localhost/api/budget", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claudelens-CSRF": "deadbeefdeadbeefdeadbeefdeadbeef",
        },
        body: JSON.stringify({ session_id: "s1", usd: 5 }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 with a valid token obtained from SSE", async () => {
    const app = createApp(makeOpts());
    const { token, cleanup } = await getCsrfToken(app);

    const res = await app.fetch(
      new Request("http://localhost/api/budget", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Claudelens-CSRF": token,
        },
        body: JSON.stringify({ session_id: "s1", usd: 5 }),
      })
    );
    expect(res.status).toBe(200);
    cleanup();
  });

  it("returns 200 on subsequent uses of same token (per-connection, not single-use)", async () => {
    const app = createApp(makeOpts());
    const { token, cleanup } = await getCsrfToken(app);

    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(
        new Request("http://localhost/api/budget", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Claudelens-CSRF": token,
          },
          body: JSON.stringify({ session_id: "s1", usd: i + 1 }),
        })
      );
      expect(res.status).toBe(200);
    }
    cleanup();
  });

  it("returns 429 after exceeding 60 requests per minute", async () => {
    const app = createApp(makeOpts());
    const { token, cleanup } = await getCsrfToken(app);

    let lastStatus = 200;
    for (let i = 0; i < 65; i++) {
      const res = await app.fetch(
        new Request("http://localhost/api/budget", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Claudelens-CSRF": token,
          },
          body: JSON.stringify({ session_id: "s1", usd: 1 }),
        })
      );
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    cleanup();
  });
});
