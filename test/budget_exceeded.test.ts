/**
 * Budget-exceeded SSE event tests (UX-5)
 *
 * When a session has budget_usd set and cumulative cost crosses it,
 * the server must broadcast `event: budget-exceeded` exactly once.
 */

import { describe, it, expect } from "vitest";
import { startServer } from "../src/server.js";
import { EventProcessor } from "../src/processor.js";
import type { ServerOptions, ServerHandle } from "../src/server.js";
import type { Event } from "../src/models.js";

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

const PORT_BASE = 8801;
let portCounter = 0;
function nextPort(): number {
  return PORT_BASE + portCounter++;
}

async function readBudgetExceeded(
  res: Response,
  timeoutMs: number
): Promise<{ token: string; exceeded: { session_id: string; current: number; budget: number; kill: boolean } | null }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let token = "";
  let exceeded:
    | { session_id: string; current: number; budget: number; kill: boolean }
    | null = null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE messages separated by \n\n
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      if (part.includes("event: csrf-token")) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) {
          const parsed = JSON.parse(dataLine.slice("data: ".length)) as { token: string };
          token = parsed.token;
        }
      } else if (part.includes("event: budget-exceeded")) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) {
          exceeded = JSON.parse(dataLine.slice("data: ".length));
        }
      }
    }
    if (exceeded) break;
  }
  reader.cancel();
  return { token, exceeded };
}

describe("budget-exceeded SSE broadcast", () => {
  it("emits budget-exceeded when cumulative cost crosses the session budget", async () => {
    const processor = new EventProcessor();
    const db = makeDb();
    const opts: ServerOptions = { port: nextPort(), processor, db };

    const handle: ServerHandle = await startServer(opts);
    try {
      // Open SSE connection
      const sseRes = await fetch(`http://127.0.0.1:${opts.port}/api/events/stream`);
      expect(sseRes.status).toBe(200);

      // Wait for csrf-token, then drive events.
      // Bootstrap a session by ingesting events directly
      const sessionId = "bx-sess-1";
      const sub: Event = {
        id: "ev-start",
        hook_event: "SubagentStart",
        ts: Date.now(),
        session_id: sessionId,
        agent_id: "agent-1",
        agent_type: "executor",
        subagent_type: "executor",
        cwd: "/tmp/foo",
      } as Event;
      processor.ingest(sub as unknown as Record<string, unknown>);

      // Manually wire a budget on the live session (skip POST flow to avoid
      // CSRF dance; the server's emit logic only reads session.budget_usd).
      const live = processor.state.sessions.get(sessionId);
      if (live) {
        live.budget_usd = 0.000001; // tiny budget — easily exceeded
        live.kill_on_exceed = false;
      }

      // Ingest a tool-use event with token data large enough to cross budget
      processor.ingest({
        id: "ev-tool",
        hook_event: "PostToolUse",
        ts: Date.now() + 10,
        session_id: sessionId,
        agent_id: "agent-1",
        tool_name: "Bash",
        tool_use_id: "tu-1",
        tool_input: { command: "echo big" },
        tool_response: "x".repeat(1000),
        input_tokens: 100_000,
        output_tokens: 100_000,
      } as unknown as Record<string, unknown>);

      const result = await readBudgetExceeded(sseRes, 3000);
      expect(result.exceeded).not.toBeNull();
      expect(result.exceeded!.session_id).toBe(sessionId);
      expect(result.exceeded!.current).toBeGreaterThan(result.exceeded!.budget);
    } finally {
      handle.close();
    }
  });
});
