/**
 * Hono HTTP server — REST API + SSE event stream + static file serving.
 *
 * Runtime adapter:
 *   - Bun:  Bun.serve({ port, fetch: app.fetch })
 *   - Node: @hono/node-server serve()
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { isBun } from "./runtime.js";
import type { EventProcessor } from "./processor.js";
import type { Database } from "./db.js";
import type { Event, State } from "./models.js";
import { bottleneck, costEstimate, parallelismGaps, stuckSignals, errorRecovery, agentPerformanceTable, agentTypeProfiles } from "./insights.js";
import { searchEvents, indexEvent, buildIndex } from "./search.js";
import { readTranscript, readAgentTokens, firstUserMessage, lastAssistantMessage, readTranscriptByPath } from "./transcript.js";

// ── Static dir resolution ─────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "static");

// ── SSE client registry ───────────────────────────────────────────────────

interface SseClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  bytesSent: number;
}

const SSE_BUFFER_CAP = 1_000_000; // 1 MB
const SSE_KEEPALIVE_MS = 30_000;
const SSE_SNAPSHOT_CAP = 1_000;

const clients = new Set<SseClient>();

// ── On-demand LLM brief (in-memory only, no SQLite) ───────────────────────
const briefCache = new Map<string, string>();
const BRIEF_TIMEOUT_MS = 30_000;
const BRIEF_MAX_INPUT = 8_000;

function runClaudeBrief(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const truncated = promptText.slice(0, BRIEF_MAX_INPUT);
    const instruction =
      "Summarize in ONE concise sentence (max 25 words) what this prompt asks the agent to do. " +
      "Do not preface with 'this prompt' or quote the prompt; just state the action.\n\n" +
      truncated;
    const cp = spawn("claude", ["-p", "--model", "haiku", "--output-format", "text"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cp.kill("SIGTERM");
      reject(new Error("brief: claude CLI timed out"));
    }, BRIEF_TIMEOUT_MS);
    cp.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    cp.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    cp.on("error", (err) => { clearTimeout(timer); reject(err); });
    cp.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(stdout.trim());
    });
    cp.stdin.write(instruction);
    cp.stdin.end();
  });
}


function broadcast(data: string): void {
  const encoded = new TextEncoder().encode(data);
  const toRemove: SseClient[] = [];
  for (const client of clients) {
    client.bytesSent += encoded.length;
    if (client.bytesSent > SSE_BUFFER_CAP) {
      const msg = `data: ${JSON.stringify({ type: "disconnect", reason: "slow_client" })}\n\n`;
      try {
        client.controller.enqueue(new TextEncoder().encode(msg));
        client.controller.close();
      } catch {
        // already closed
      }
      toRemove.push(client);
      process.stderr.write("[claudelens] SSE: slow client disconnected (buffer cap exceeded)\n");
      continue;
    }
    try {
      client.controller.enqueue(encoded);
    } catch {
      toRemove.push(client);
    }
  }
  for (const c of toRemove) clients.delete(c);
}

// ── State serialization ───────────────────────────────────────────────────

function serializeState(state: State): Record<string, unknown> {
  return {
    sessions: Object.fromEntries(state.sessions),
    agents: Object.fromEntries(state.agents),
    edges: state.edges,
    tool_calls: Object.fromEntries(state.tool_calls),
    event_count: state.events.length,
  };
}

// ── App factory ───────────────────────────────────────────────────────────

export interface ServerOptions {
  port: number;
  processor: EventProcessor;
  db: Database;
}

export function createApp(opts: ServerOptions): Hono {
  const { processor, db } = opts;
  const app = new Hono();

  // CORS — restrict to known local origins only
  app.use(
    "*",
    cors({
      origin: [
        "http://localhost:8100",
        "http://127.0.0.1:8100",
        "http://localhost:5173",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
    })
  );

  // ── GET /api/state ──────────────────────────────────────────────────
  app.get("/api/state", (c) => {
    const sessionFilter = c.req.query("session");
    let state = processor.state;

    if (sessionFilter) {
      state = {
        ...state,
        sessions: new Map(
          Array.from(state.sessions.entries()).filter(([id]) => id === sessionFilter)
        ),
        agents: new Map(
          Array.from(state.agents.entries()).filter(
            ([, a]) => a.session_id === sessionFilter
          )
        ),
        events: state.events.filter((e) => e.session_id === sessionFilter),
      };
    }

    return c.json(serializeState(state));
  });

  // ── GET /api/events/stream (SSE) ────────────────────────────────────
  app.get("/api/events/stream", (c) => {
    const lastEventId = c.req.header("Last-Event-ID");
    const now = Date.now();
    const lastSeenTs = lastEventId ? parseInt(lastEventId, 10) : 0;

    const MAX_CATCHUP_MS = 60_000;
    const needsFullSnapshot = !lastEventId || now - lastSeenTs > MAX_CATCHUP_MS;

    let client: SseClient | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = { controller, bytesSent: 0 };
        clients.add(client);

        const enc = new TextEncoder();

        // Send initial snapshot
        const snapshotEvents = needsFullSnapshot
          ? processor.events.slice(-SSE_SNAPSHOT_CAP)
          : processor.events.filter((e) => e.ts > lastSeenTs).slice(-SSE_SNAPSHOT_CAP);

        const snapshotId =
          snapshotEvents.length > 0
            ? String(snapshotEvents[snapshotEvents.length - 1]!.ts)
            : String(Date.now());
        const snapshotMsg =
          `id: ${snapshotId}\n` +
          `data: ${JSON.stringify({ type: "snapshot", events: snapshotEvents, state: serializeState(processor.state) })}\n\n`;
        controller.enqueue(enc.encode(snapshotMsg));

        // Keepalive every 30s
        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": keepalive\n\n"));
          } catch {
            if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
          }
        }, SSE_KEEPALIVE_MS);
      },
      cancel() {
        if (client !== null) clients.delete(client);
        if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // ── POST /api/reset ─────────────────────────────────────────────────
  app.post("/api/reset", (c) => {
    processor.reset();
    return c.json({ status: "reset" });
  });

  // ── GET /api/history ────────────────────────────────────────────────
  // Merges persisted DB sessions with currently-live in-memory sessions so
  // that compare/diff works for sessions that haven't ended yet.
  app.get("/api/history", (c) => {
    const persisted = db.listSessions();
    const live = Array.from(processor.state.sessions.values());
    const merged = new Map<string, (typeof persisted)[number] | (typeof live)[number]>();
    for (const s of persisted) merged.set(s.id, s);
    for (const s of live) merged.set(s.id, s);
    const out = Array.from(merged.values()).sort(
      (a, b) => (b.started_at ?? 0) - (a.started_at ?? 0)
    );
    return c.json(out);
  });

  // ── GET /api/baselines ──────────────────────────────────────────────
  app.get("/api/baselines", (c) => {
    const baselines = db.listAllBaselines();
    return c.json(baselines);
  });

  // ── GET /api/session/:id ────────────────────────────────────────────
  // Falls back to in-memory state when the session has not been persisted yet.
  app.get("/api/session/:id", (c) => {
    const id = c.req.param("id");
    const persisted = db.getSession(id);
    const liveSession = processor.state.sessions.get(id);
    const session = persisted ?? liveSession;
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const persistedEvents = persisted ? db.queryEvents(id) : [];
    const liveEvents = processor.events.filter((e) => e.session_id === id);
    const events = persistedEvents.length > 0 ? persistedEvents : liveEvents;
    const agents = Array.from(processor.state.agents.values()).filter(
      (a) => a.session_id === id
    );
    return c.json({ session, events, agents });
  });

  // ── GET /api/insights ───────────────────────────────────────────────
  app.get("/api/insights", (c) => {
    const sessionFilter = c.req.query("session");
    let state = processor.state;

    if (sessionFilter) {
      const filteredAgents = new Map(
        Array.from(state.agents.entries()).filter(
          ([, a]) => a.session_id === sessionFilter
        )
      );
      state = {
        ...state,
        sessions: new Map(
          Array.from(state.sessions.entries()).filter(([id]) => id === sessionFilter)
        ),
        agents: filteredAgents,
        events: state.events.filter((e) => e.session_id === sessionFilter),
        tool_calls: new Map(
          Array.from(state.tool_calls.entries()).filter(([id]) =>
            filteredAgents.has(id)
          )
        ),
      };
    }

    const bn = bottleneck(state);

    // Optionally load transcript tokens for measured cost
    let tokensMap: Record<string, { input_tokens: number; output_tokens: number; cache_read: number; cache_creation: number }> | undefined;
    if (sessionFilter) {
      const session_total = readAgentTokens(sessionFilter);
      if (session_total.input_tokens > 0 || session_total.output_tokens > 0) {
        tokensMap = {};
        for (const agent of state.agents.values()) {
          const t = readAgentTokens(sessionFilter, agent.id);
          tokensMap[agent.id] = t;
        }
      }
    }

    const cost = costEstimate(state, tokensMap);
    const gaps = parallelismGaps(state);
    const stuck = stuckSignals(state);
    const recovery = errorRecovery(state);
    const agentPerf = agentPerformanceTable(state, cost);
    const typeProfiles = agentTypeProfiles(state);

    return c.json({
      bottleneck: {
        longestAgentId: bn.longestAgent?.id ?? null,
        longestAgentName: bn.longestAgent?.name ?? null,
        longestDurationMs: bn.longestDurationMs,
        highestErrorAgentId: bn.highestErrorAgent?.id ?? null,
        highestErrorAgentName: bn.highestErrorAgent?.name ?? null,
        highestErrorCount: bn.highestErrorCount,
      },
      costEstimate: cost,
      tokenSource: cost.source,
      parallelismGaps: gaps,
      stuckSignals: stuck,
      errorRecovery: recovery,
      agentPerformance: agentPerf,
      agentTypeProfiles: typeProfiles,
    });
  });

  // ── GET /api/search?q= ──────────────────────────────────────────────
  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    if (!q.trim()) return c.json({ results: [] });
    const results = searchEvents(q, limit);
    return c.json({ results });
  });

  // ── GET /api/session/:id/thread ─────────────────────────────────────
  app.get("/api/session/:id/thread", async (c) => {
    const id = c.req.param("id");
    try {
      const messages = await readTranscript(id);
      return c.json({ messages });
    } catch {
      return c.json({ messages: [] });
    }
  });

  // ── GET /api/agent/:id/prompt ───────────────────────────────────────
  // Returns the agent's stored prompt, or falls back to the first user
  // message in its transcript file. Useful for OMC team workers spawned
  // outside the Agent tool whose prompt isn't in the hook payload.
  app.get("/api/agent/:id/prompt", (c) => {
    const id = c.req.param("id");
    const agent = processor.state.agents.get(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    if (agent.prompt && agent.prompt.trim()) {
      return c.json({ prompt: agent.prompt, source: "stored" });
    }
    if (agent.transcript_path) {
      const fromTranscript = firstUserMessage(agent.transcript_path);
      if (fromTranscript) {
        return c.json({ prompt: fromTranscript, source: "transcript" });
      }
    }
    return c.json({ prompt: null, source: "none" });
  });

  // ── GET /api/agent/:id/brief ────────────────────────────────────────
  // On-demand LLM summary via local `claude` CLI with the haiku model.
  // Cached in-memory only (no DB) per user preference.
  app.get("/api/agent/:id/brief", async (c) => {
    const id = c.req.param("id");
    const cached = briefCache.get(id);
    if (cached !== undefined) {
      return c.json({ brief: cached, source: "cached" });
    }
    const agent = processor.state.agents.get(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    let promptText = agent.prompt && agent.prompt.trim() ? agent.prompt : null;
    if (!promptText && agent.transcript_path) {
      promptText = firstUserMessage(agent.transcript_path);
    }
    if (!promptText) return c.json({ brief: null, source: "no_prompt" });
    try {
      const brief = await runClaudeBrief(promptText);
      briefCache.set(id, brief);
      return c.json({ brief, source: "llm" });
    } catch (err) {
      process.stderr.write(`[claudelens] brief error: ${String(err)}\n`);
      return c.json({ brief: null, source: "error", error: String(err) });
    }
  });

  // ── GET /api/agent/:id/result ───────────────────────────────────────
  // Returns agent.result, or the parent's tool_response for this agent's
  // spawn_tool_use_id, or the last assistant message from transcript.
  app.get("/api/agent/:id/result", (c) => {
    const id = c.req.param("id");
    const agent = processor.state.agents.get(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    // 1. Agent has a stored result
    if (agent.result && agent.result.trim()) {
      return c.json({ result: agent.result, source: "stored" });
    }

    // 2. Look for parent tool_response matching spawn_tool_use_id
    if (agent.spawn_tool_use_id && agent.parent_id) {
      const parentToolCalls = processor.state.tool_calls.get(agent.parent_id) ?? [];
      const tc = parentToolCalls.find(
        (t) => t.id === agent.spawn_tool_use_id && t.status === "done"
      );
      if (tc && tc.response) {
        return c.json({ result: tc.response, source: "tool" });
      }
    }

    // 3. Fall back to last assistant message in transcript
    if (agent.transcript_path) {
      const fromTranscript = lastAssistantMessage(agent.transcript_path);
      if (fromTranscript) {
        return c.json({ result: fromTranscript, source: "transcript" });
      }
    }

    return c.json({ result: null, source: "none" });
  });

  // ── GET /api/agent/:id/transcript ──────────────────────────────────
  // Returns the messages from the agent's transcript file.
  app.get("/api/agent/:id/transcript", (c) => {
    const id = c.req.param("id");
    const agent = processor.state.agents.get(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    if (!agent.transcript_path) {
      return c.json({ messages: [], source: "none" });
    }

    const messages = readTranscriptByPath(agent.transcript_path);
    return c.json({ messages, source: "transcript" });
  });

  // ── GET /api/session/:id/tokens ─────────────────────────────────────
  app.get("/api/session/:id/tokens", (c) => {
    const id = c.req.param("id");
    // Path traversal guard: reuse findTranscriptPath guard (sessionId checked in readAgentTokens)
    if (/[/\\]|\.\./.test(id)) {
      return c.json({ error: "Invalid session id" }, 400);
    }

    const session_total = readAgentTokens(id);

    // Build per_agent map for agents belonging to this session
    const sessionAgents = Array.from(processor.state.agents.values()).filter(
      (a) => a.session_id === id
    );
    const per_agent: Record<string, ReturnType<typeof readAgentTokens>> = {};
    for (const agent of sessionAgents) {
      const agentTokens = readAgentTokens(id, agent.id);
      per_agent[agent.id] = agentTokens;
    }

    return c.json({ session_total, per_agent });
  });

  // ── Static files + SPA fallback ─────────────────────────────────────
  app.get("*", (c) => {
    const reqPath = c.req.path;

    if (fs.existsSync(STATIC_DIR)) {
      const filePath = path.join(STATIC_DIR, reqPath === "/" ? "index.html" : reqPath);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const content = fs.readFileSync(filePath);
        const ext = path.extname(filePath);
        const mimeTypes: Record<string, string> = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".png": "image/png",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".woff2": "font/woff2",
          ".woff": "font/woff",
        };
        const contentType = mimeTypes[ext] ?? "application/octet-stream";
        return new Response(content, { headers: { "Content-Type": contentType } });
      }

      const indexPath = path.join(STATIC_DIR, "index.html");
      if (fs.existsSync(indexPath)) {
        return new Response(fs.readFileSync(indexPath), {
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    return new Response(
      `<html><body>
        <h2>ClaudeLens</h2>
        <p>Frontend not built yet.</p>
        <p>API: <a href="/api/state">/api/state</a></p>
      </body></html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  });

  return app;
}

// ── Server handle ─────────────────────────────────────────────────────────

export interface ServerHandle {
  close(): void;
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const { processor } = opts;
  const app = createApp(opts);

  // Build full-text search index from existing events
  buildIndex(Array.from(processor.events));

  // Wire processor events to SSE broadcast + search index
  processor.subscribe((event: Event) => {
    indexEvent(event);
    const msg = `id: ${event.ts}\ndata: ${JSON.stringify({ type: "event", event })}\n\n`;
    broadcast(msg);
  });

  if (isBun()) {
    const bunGlobal = globalThis as unknown as {
      Bun: {
        serve: (o: {
          port: number;
          hostname?: string;
          fetch: (req: Request) => Response | Promise<Response>;
        }) => { stop(): void };
      };
    };
    const server = bunGlobal.Bun.serve({
      port: opts.port,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    return {
      close() {
        server.stop();
      },
    };
  } else {
    const { serve } = await import("@hono/node-server");
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" });
    return {
      close() {
        server.close();
      },
    };
  }
}
