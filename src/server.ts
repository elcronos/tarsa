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
import { spawn, execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import { isBun } from "./runtime.js";
import type { EventProcessor } from "./processor.js";
import type { Database } from "./db.js";
import type { Event, State } from "./models.js";
import { bottleneck, costEstimate, parallelismGaps, stuckSignals, errorRecovery, agentPerformanceTable, agentTypeProfiles, pricedCoveragePercent } from "./insights.js";
import { searchEvents, indexEvent, buildIndex } from "./search.js";
import { detectBudgetExceeded } from "./insights.js";
import { readTranscript, readAgentTokens, firstUserMessage, lastAssistantMessage, readTranscriptByPath } from "./transcript.js";

// ── Static dir resolution ─────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "static");

// Resolve once at module load so symlinks on macOS (e.g. /System/Volumes/Data/)
// are handled correctly and cannot be bypassed by the request path.
let STATIC_DIR_REAL: string;
try {
  STATIC_DIR_REAL = fs.realpathSync(STATIC_DIR);
} catch {
  STATIC_DIR_REAL = STATIC_DIR;
}

// ── SSE client registry ───────────────────────────────────────────────────

interface SseClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  bytesSent: number;
}

const SSE_BUFFER_CAP = 1_000_000; // 1 MB
const SSE_KEEPALIVE_MS = 30_000;
const SSE_SNAPSHOT_CAP = 1_000;
const MAX_SSE_CLIENTS = 32;

const clients = new Set<SseClient>();

// ── CSRF token registry ───────────────────────────────────────────────────

interface CsrfEntry {
  connId: string;
  createdAt: number;
  // budget POST rate limiting
  budgetPostCount: number;
  budgetWindowStart: number;
}

const CSRF_TOKENS = new Map<string, CsrfEntry>();
const BUDGET_RATE_LIMIT = 60; // per minute per connection
const BUDGET_WINDOW_MS = 60_000;

function generateCsrfToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

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


// ── Spawn session helper ──────────────────────────────────────────────────

function checkBinaryOnPath(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [binary], (err) => resolve(!err));
  });
}

function spawnTmuxSession(sessionName: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "tmux",
      ["new-session", "-d", "-s", sessionName, "-c", cwd, "claude"],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
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
      process.stderr.write("[tarsa] SSE: slow client disconnected (buffer cap exceeded)\n");
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
  host?: string;
  allowRemote?: boolean;
  authToken?: string;
  /** Optional embedded-terminal supervisor (vendored cc-web). */
  ccWeb?: {
    getInfo(): { enabled: boolean; port: number; token: string };
    createSession(
      workingDir: string,
      name?: string
    ): Promise<{ sessionId: string } | { error: string }>;
  };
}

export function createApp(opts: ServerOptions): Hono {
  const { processor, db } = opts;
  const { allowRemote = false, authToken } = opts;
  const app = new Hono();

  // CORS — restrict to known local origins only
  // In production, drop the Vite dev-server origin (MED-4)
  const corsOrigins: string[] = [
    "http://localhost:8100",
    "http://127.0.0.1:8100",
  ];
  if (process.env.NODE_ENV !== "production") {
    corsOrigins.push("http://localhost:5173");
  }

  // In remote mode, Authorization header is also allowed (for bearer token auth)
  const allowHeaders = allowRemote
    ? ["X-Tarsa-CSRF", "Authorization"]
    : ["X-Tarsa-CSRF"];

  app.use(
    "*",
    cors({
      origin: corsOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders,
    })
  );

  // Auth middleware: only registered when --allow-remote is set.
  // All POST routes require Authorization: Bearer <token>.
  if (allowRemote && authToken) {
    app.use("*", async (c, next) => {
      if (c.req.method === "POST") {
        const authHeader = c.req.header("Authorization");
        if (!authHeader || authHeader !== `Bearer ${authToken}`) {
          return c.json({ error: "Unauthorized" }, 401);
        }
      }
      await next();
    });
  }

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
    // MED-5: cap concurrent SSE connections
    if (clients.size >= MAX_SSE_CLIENTS) {
      process.stderr.write("[tarsa] SSE: connection rejected (MAX_SSE_CLIENTS reached)\n");
      return c.text("Too many connections. Restart tarsa or reduce browser tabs.", 429);
    }

    const lastEventId = c.req.header("Last-Event-ID");
    const now = Date.now();
    const lastSeenTs = lastEventId ? parseInt(lastEventId, 10) : 0;

    const MAX_CATCHUP_MS = 60_000;
    const needsFullSnapshot = !lastEventId || now - lastSeenTs > MAX_CATCHUP_MS;

    // Issue a per-connection CSRF token (CSRF)
    const connId = crypto.randomUUID();
    const csrfToken = generateCsrfToken();
    CSRF_TOKENS.set(csrfToken, {
      connId,
      createdAt: Date.now(),
      budgetPostCount: 0,
      budgetWindowStart: Date.now(),
    });

    let client: SseClient | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = { controller, bytesSent: 0 };
        clients.add(client);

        const enc = new TextEncoder();

        // Send CSRF token as first event
        const csrfMsg =
          `event: csrf-token\n` +
          `data: ${JSON.stringify({ token: csrfToken })}\n\n`;
        controller.enqueue(enc.encode(csrfMsg));

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
        // Clean up CSRF token on disconnect
        CSRF_TOKENS.delete(csrfToken);
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

  // ── POST /api/budget ─────────────────────────────────────────────────
  // CSRF-protected; requires X-Tarsa-CSRF header with a valid token
  // issued via the SSE stream. Rate-limited to 60 POSTs/min per connection.
  app.post("/api/budget", async (c) => {
    const token = c.req.header("X-Tarsa-CSRF");
    if (!token) {
      return c.json({ error: "Missing CSRF token" }, 403);
    }
    const entry = CSRF_TOKENS.get(token);
    if (!entry) {
      return c.json({ error: "Invalid CSRF token" }, 403);
    }

    // Per-connection rate limit: 60 budget POSTs/minute
    const now = Date.now();
    if (now - entry.budgetWindowStart > BUDGET_WINDOW_MS) {
      entry.budgetPostCount = 0;
      entry.budgetWindowStart = now;
    }
    entry.budgetPostCount++;
    if (entry.budgetPostCount > BUDGET_RATE_LIMIT) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { session_id, usd, kill_on_exceed } = body;
    if (typeof session_id !== "string" || typeof usd !== "number") {
      return c.json({ error: "Missing session_id or usd" }, 400);
    }

    // Persist budget to DB
    try {
      db.setBudget(session_id, usd, kill_on_exceed === true ? 1 : 0);
    } catch (err) {
      process.stderr.write(`[tarsa] setBudget error: ${String(err)}\n`);
    }

    // Update in-memory session as well so the next event-driven budget
    // detection sees the freshly-set threshold.
    const liveSession = processor.state.sessions.get(session_id);
    if (liveSession) {
      liveSession.budget_usd = usd;
      liveSession.kill_on_exceed = kill_on_exceed === true;
    }

    return c.json({ status: "ok", session_id, usd, kill_on_exceed: kill_on_exceed === true });
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
      pricedCoveragePct: pricedCoveragePercent(cost),
      parallelismGaps: gaps,
      stuckSignals: stuck,
      errorRecovery: recovery,
      agentPerformance: agentPerf,
      agentTypeProfiles: typeProfiles,
    });
  });

  // ── GET /api/terminal/info ──────────────────────────────────────────
  // Returns the embedded cc-web port and shared auth token so the frontend
  // can mount the in-browser terminal in an iframe. Returns enabled=false
  // when the supervisor isn't configured (e.g. cc-web not vendored).
  app.get("/api/terminal/info", (c) => {
    if (!opts.ccWeb) return c.json({ enabled: false });
    return c.json(opts.ccWeb.getInfo());
  });

  // ── POST /api/project/create ────────────────────────────────────────
  // Create a new project directory under $HOME and (optionally) `git init` it.
  // Returns {cwd, name} on success. The frontend follows up with
  // /api/terminal/ensure-session so the new dir opens in the embedded shell.
  //
  // Validation rules:
  //   - parent must resolve (via realpath) to a path inside $HOME — symlink
  //     escapes are rejected.
  //   - name must match a strict allowlist; no slashes, no leading dot, no
  //     shell metacharacters.
  //   - target must not already exist.
  app.post("/api/project/create", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      parent?: string;
      name?: string;
      gitInit?: boolean;
    };
    const { parent, name, gitInit } = body;
    if (!parent || !name) {
      return c.json({ error: "parent and name are required" }, 400);
    }
    if (!/^[A-Za-z0-9 _.-]{1,80}$/.test(name) || name.startsWith(".")) {
      return c.json({ error: "invalid project name" }, 400);
    }
    const home = os.homedir();
    const expandedParent = parent.replace(/^~(?=\/|$)/, home);
    let realParent: string;
    try {
      realParent = fs.realpathSync(path.resolve(expandedParent));
    } catch {
      return c.json({ error: "parent directory does not exist" }, 400);
    }
    if (!realParent.startsWith(home + path.sep) && realParent !== home) {
      return c.json({ error: "parent must be inside your home directory" }, 400);
    }
    const cwd = path.join(realParent, name);
    if (fs.existsSync(cwd)) {
      return c.json({ error: "a folder with that name already exists" }, 409);
    }
    try {
      fs.mkdirSync(cwd, { recursive: false, mode: 0o755 });
    } catch (err) {
      return c.json({ error: `mkdir failed: ${String(err)}` }, 500);
    }
    if (gitInit) {
      try {
        execFileSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" });
      } catch {
        /* non-fatal: dir created, just no git */
      }
    }
    return c.json({ cwd, name });
  });

  // ── POST /api/project/open ──────────────────────────────────────────
  // Open an existing folder as a Tarsa project. Validates the path exists
  // and resolves (via realpath) under $HOME, then returns {cwd, name} so
  // the frontend can open an embedded terminal there.
  app.post("/api/project/open", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { cwd?: string };
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    const home = os.homedir();
    const expanded = body.cwd.replace(/^~(?=\/|$)/, home);
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(expanded));
    } catch {
      return c.json({ error: "folder does not exist" }, 404);
    }
    if (!real.startsWith(home + path.sep) && real !== home) {
      return c.json({ error: "folder must be inside your home directory" }, 400);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      return c.json({ error: "cannot stat folder" }, 500);
    }
    if (!stat.isDirectory()) {
      return c.json({ error: "path is not a directory" }, 400);
    }
    return c.json({ cwd: real, name: path.basename(real) });
  });

  // ── POST /api/terminal/ensure-session ───────────────────────────────
  // Ask cc-web to create (or reuse) a terminal session bound to a working
  // directory. Returns the cc-web sessionId. Used by the Terminal tab so
  // opening it on agent X drops the user into a shell rooted at X's cwd.
  app.post("/api/terminal/ensure-session", async (c) => {
    if (!opts.ccWeb) return c.json({ error: "Terminal disabled" }, 503);
    const body = await c.req.json().catch(() => ({})) as { cwd?: string; name?: string };
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    // Reject quickly when the cwd no longer exists — otherwise cc-web spawns
    // claude in a missing directory and the terminal looks alive but is dead.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fsMod = await import("node:fs");
      if (!fsMod.existsSync(body.cwd)) {
        return c.json({ error: `Working directory does not exist: ${body.cwd}` }, 404);
      }
    } catch {
      /* if existsSync errors, let cc-web decide */
    }
    const result = await opts.ccWeb.createSession(body.cwd, body.name);
    if ("error" in result) return c.json(result, 502);
    return c.json(result);
  });

  // ── GET /api/agent/:id/session ───────────────────────────────────────
  // Returns the session metadata (cwd, name) for an agent. The Terminal
  // tab uses this to know which cwd to spawn a shell in.
  app.get("/api/agent/:id/session", (c) => {
    const id = c.req.param("id");
    const agent = processor.state.agents.get(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const session = processor.state.sessions.get(agent.session_id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    // claudeSessionId is returned only when a Claude Code transcript still
    // exists for this session. The Terminal tab uses it to spawn cc-web's
    // claude with `--resume <id>` so the embedded shell reopens the same
    // conversation instead of starting fresh.
    let claudeSessionId: string | null = null;
    if (session.cwd) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require("node:fs") as typeof import("node:fs");
        const os = require("node:os") as typeof import("node:os");
        const path = require("node:path") as typeof import("node:path");
        const encoded = session.cwd.replace(/\//g, "-");
        const transcript = path.join(
          os.homedir(),
          ".claude",
          "projects",
          encoded,
          `${session.id}.jsonl`,
        );
        if (fs.existsSync(transcript)) {
          claudeSessionId = session.id;
        }
      } catch {
        /* best-effort */
      }
    }
    return c.json({
      id: session.id,
      cwd: session.cwd ?? null,
      name: session.name ?? null,
      claudeSessionId,
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
    // Prefer parent's spawning tool call input.prompt — for OMC team workers
    // the worker's own transcript starts with the parent's slash-command meta,
    // so firstUserMessage returns the same text for every worker. The Agent
    // tool input on the parent has the per-worker assignment.
    if (agent.spawn_tool_use_id && agent.parent_id) {
      const parentToolCalls = processor.state.tool_calls.get(agent.parent_id) ?? [];
      const tc = parentToolCalls.find((t) => t.id === agent.spawn_tool_use_id);
      const inputPrompt = tc?.input?.["prompt"];
      if (typeof inputPrompt === "string" && inputPrompt.trim()) {
        return c.json({ prompt: inputPrompt, source: "spawn_tool" });
      }
    }
    // Fallback for OMC team workers spawned outside the Agent tool: scan the
    // parent's Agent tool calls for one whose subagent_type matches and whose
    // start time is closest to (and before) this agent's first_seen_ms.
    if (agent.parent_id && agent.subagent_type) {
      const parentToolCalls = processor.state.tool_calls.get(agent.parent_id) ?? [];
      let best: { prompt: string; ts: number } | null = null;
      for (const tc of parentToolCalls) {
        if (tc.tool_name !== "Agent") continue;
        const inSub = tc.input?.["subagent_type"];
        const inPrompt = tc.input?.["prompt"];
        if (typeof inPrompt !== "string" || !inPrompt.trim()) continue;
        if (typeof inSub === "string" && inSub === agent.subagent_type) {
          if (tc.started_ms <= agent.first_seen_ms + 5000) {
            if (!best || tc.started_ms > best.ts) {
              best = { prompt: inPrompt, ts: tc.started_ms };
            }
          }
        }
      }
      if (best) {
        return c.json({ prompt: best.prompt, source: "spawn_tool" });
      }
      // Final fallback: SendMessage tool calls targeting this worker. Concatenate
      // the first few so the user sees the orchestrator's per-worker instructions.
      const sendMessages = parentToolCalls
        .filter(
          (tc) =>
            tc.tool_name === "SendMessage" &&
            tc.input?.["to"] === agent.subagent_type
        )
        .sort((a, b) => a.started_ms - b.started_ms)
        .slice(0, 5);
      if (sendMessages.length > 0) {
        const text = sendMessages
          .map((tc, i) => {
            const msg =
              tc.input?.["message"] ?? tc.input?.["prompt"] ?? tc.input?.["text"] ?? "";
            const s = typeof msg === "string" ? msg : JSON.stringify(msg);
            return `── SendMessage #${i + 1} ──\n${s}`;
          })
          .join("\n\n");
        return c.json({ prompt: text, source: "send_messages" });
      }
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
    if (!promptText && agent.spawn_tool_use_id && agent.parent_id) {
      const parentToolCalls = processor.state.tool_calls.get(agent.parent_id) ?? [];
      const tc = parentToolCalls.find((t) => t.id === agent.spawn_tool_use_id);
      const inputPrompt = tc?.input?.["prompt"];
      if (typeof inputPrompt === "string" && inputPrompt.trim()) {
        promptText = inputPrompt;
      }
    }
    if (!promptText && agent.transcript_path) {
      promptText = firstUserMessage(agent.transcript_path);
    }
    if (!promptText) return c.json({ brief: null, source: "no_prompt" });
    try {
      const brief = await runClaudeBrief(promptText);
      briefCache.set(id, brief);
      return c.json({ brief, source: "llm" });
    } catch (err) {
      process.stderr.write(`[tarsa] brief error: ${String(err)}\n`);
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

  // ── POST /api/spawn ──────────────────────────────────────────────────
  // Spawn a new tmux session running `claude` in a given cwd.
  // ONLY permitted in localhost (default) mode. Returns 403 in --allow-remote mode.
  // Uses execFile (argv array) — no shell interpolation.
  app.post("/api/spawn", async (c) => {
    if (allowRemote) {
      return c.json({ error: "Spawn is not permitted in remote mode" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const cwd = body["cwd"];
    if (typeof cwd !== "string" || !cwd) {
      return c.json({ error: "cwd is required" }, 400);
    }

    // Input sanitization
    if (!path.isAbsolute(cwd)) {
      return c.json({ error: "cwd must be an absolute path" }, 400);
    }
    if (cwd.includes("\0")) {
      return c.json({ error: "cwd contains invalid characters" }, 400);
    }
    if (!fs.existsSync(cwd)) {
      return c.json({ error: "cwd does not exist" }, 400);
    }
    if (!fs.statSync(cwd).isDirectory()) {
      return c.json({ error: "cwd is not a directory" }, 400);
    }

    const hasClaudeOnPath = await checkBinaryOnPath("claude");
    if (!hasClaudeOnPath) {
      return c.json({ error: "claude not found in PATH. Install Claude Code first." }, 400);
    }

    const hasTmux = await checkBinaryOnPath("tmux");
    if (!hasTmux) {
      return c.json({ error: "tmux not found. Install tmux to use spawn." }, 400);
    }

    const id = crypto.randomBytes(4).toString("hex");
    const sessionName = `tarsa-${id}`;

    try {
      await spawnTmuxSession(sessionName, cwd);
    } catch (err) {
      return c.json({ error: `Failed to spawn tmux session: ${String(err)}` }, 500);
    }

    return c.json({
      session_name: sessionName,
      attach_cmd: `tmux attach -t ${sessionName}`,
    });
  });

  // ── Static files + SPA fallback ─────────────────────────────────────
  // HIGH-1: path traversal guard via realpathSync containment check.
  // c.req.path is already URL-decoded by Hono — do NOT call decodeURIComponent.
  app.get("*", (c) => {
    const reqPath = c.req.path;

    if (fs.existsSync(STATIC_DIR_REAL)) {
      // Resolve the candidate path and verify it stays inside STATIC_DIR_REAL
      const relative = reqPath === "/" ? "index.html" : reqPath.replace(/^\//, "");
      const candidate = path.resolve(STATIC_DIR_REAL, relative);

      let realCandidate: string;
      try {
        realCandidate = fs.realpathSync(candidate);
      } catch {
        // File doesn't exist; fall through to SPA index or 404
        realCandidate = "";
      }

      if (
        realCandidate &&
        (realCandidate === STATIC_DIR_REAL ||
          realCandidate.startsWith(STATIC_DIR_REAL + path.sep))
      ) {
        if (fs.statSync(realCandidate).isFile()) {
          const content = fs.readFileSync(realCandidate);
          const ext = path.extname(realCandidate);
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
      } else if (realCandidate && !realCandidate.startsWith(STATIC_DIR_REAL + path.sep)) {
        // Path escapes static dir — reject
        return c.notFound();
      }

      // SPA fallback
      const indexPath = path.join(STATIC_DIR_REAL, "index.html");
      if (fs.existsSync(indexPath)) {
        return new Response(fs.readFileSync(indexPath), {
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    return new Response(
      `<html><body>
        <h2>Tarsa</h2>
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

  // Build full-text search index from existing events.
  // Only rebuild when the processor has its own event log; otherwise we'd
  // wipe out the index seeded from the database in cli.ts.
  if (processor.events.length > 0) {
    buildIndex(Array.from(processor.events));
  }

  // Track sessions whose budget has already been reported as exceeded so
  // we only emit one budget-exceeded event per crossing.
  const budgetExceededSessions = new Set<string>();

  // Wire processor events to SSE broadcast + search index
  processor.subscribe((event: Event) => {
    indexEvent(event);
    const msg = `id: ${event.ts}\ndata: ${JSON.stringify({ type: "event", event })}\n\n`;
    broadcast(msg);

    // Budget-exceeded detection: emit once per session per crossing.
    try {
      // Build a tokensMap of Anthropic-reported transcript tokens (incl. cache)
      // for agents in sessions that have a budget set. Without this, the budget
      // check falls back to a char/4 heuristic and badly undercounts.
      const st = processor.state;
      const budgetedSessions = new Set<string>();
      for (const [sid, session] of st.sessions) {
        if (typeof session.budget_usd === "number" && session.budget_usd > 0) {
          budgetedSessions.add(sid);
        }
      }
      let tokensMap:
        | Record<string, { input_tokens: number; output_tokens: number; cache_read: number; cache_creation: number }>
        | undefined;
      if (budgetedSessions.size > 0) {
        tokensMap = {};
        for (const agent of st.agents.values()) {
          if (!budgetedSessions.has(agent.session_id)) continue;
          // readAgentTokens is mtime-cached (30s TTL) so this is cheap on the hot path.
          tokensMap[agent.id] = readAgentTokens(agent.session_id, agent.id);
        }
      }
      const exceeded = detectBudgetExceeded(processor.state, tokensMap);
      for (const be of exceeded) {
        if (budgetExceededSessions.has(be.session_id)) continue;
        budgetExceededSessions.add(be.session_id);
        const beMsg =
          `event: budget-exceeded\n` +
          `data: ${JSON.stringify(be)}\n\n`;
        broadcast(beMsg);
      }
    } catch (err) {
      process.stderr.write(`[tarsa] budget detect error: ${String(err)}\n`);
    }
  });

  const bindHost = opts.host ?? "127.0.0.1";

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
      hostname: bindHost,
      fetch: app.fetch,
    });
    return {
      close() {
        server.stop();
      },
    };
  } else {
    const { serve } = await import("@hono/node-server");
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: bindHost });
    return {
      close() {
        server.close();
      },
    };
  }
}
