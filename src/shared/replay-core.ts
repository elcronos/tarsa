/**
 * Pure event reducer — shared/replay-core.ts
 *
 * Single source of truth for state derivation. Both server (src/replay.ts)
 * and client (frontend/src/replay.ts) re-export from here.
 *
 * replayToTimestamp(events, ts): State  — canonical source of truth.
 * applyEvent(state, event): State       — incremental helper (live path).
 *
 * Both are pure: no side effects, no mutation of input state. Uses
 * structural sharing: each step returns a new top-level State object
 * but reuses Map references for collections that were not modified.
 *
 * This file MUST stay runtime-free of Node-only APIs (no node:path,
 * no fs, etc.) so Vite can bundle it for the browser.
 */

import type {
  Agent,
  Edge,
  Event,
  Session,
  State,
  ToolCall,
} from "./models.js";

// ── Helpers ────────────────────────────────────────────────────────────

export function rootAgentId(sessionId: string): string {
  return `root:${sessionId}`;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Portable basename — works in both Node and browser. Splits on `/` or `\\`
 * and returns the last segment, falling back to the whole string when no
 * separator is present.
 */
export function basenameOf(cwd: string): string {
  if (!cwd) return cwd;
  const parts = cwd.split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function toolPreview(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return String(input["command"] ?? "").slice(0, 80);
    case "Read":
    case "Write":
    case "Edit": {
      const fp = String(input["file_path"] ?? "");
      return fp.split("/").pop() ?? fp.slice(0, 60);
    }
    case "Grep":
    case "Glob":
      return String(input["pattern"] ?? "").slice(0, 60);
    case "WebSearch":
      return String(input["query"] ?? input["prompt"] ?? "").slice(0, 80);
    case "Agent":
      return String(input["description"] ?? "spawn agent").slice(0, 60);
    default:
      return JSON.stringify(input).slice(0, 60);
  }
}

// ── Empty state factory ────────────────────────────────────────────────

export function emptyState(): State {
  return {
    sessions: new Map(),
    agents: new Map(),
    edges: [],
    tool_calls: new Map(),
    events: [],
    pending_subagents: new Map(),
  };
}

// ── State cloning ──────────────────────────────────────────────────────

/**
 * Full deep-ish clone — shallow-copies every collection. Retained for
 * compatibility with callers that need an isolated snapshot. Internal
 * reducer paths now prefer structural sharing via withSessions/withAgents
 * /withToolCalls/withEdges/withEvents and only clone the Maps they mutate.
 */
export function cloneState(s: State): State {
  return {
    sessions: new Map(s.sessions),
    agents: new Map(s.agents),
    edges: [...s.edges],
    tool_calls: new Map(
      Array.from(s.tool_calls.entries()).map(([k, v]) => [k, [...v]])
    ),
    events: [...s.events],
    pending_subagents: new Map(
      Array.from(s.pending_subagents.entries()).map(([k, v]) => [k, [...v]])
    ),
  };
}

// ── Structural-sharing helpers ─────────────────────────────────────────
// Each helper returns a new top-level State, cloning ONLY the affected
// Map / array. Unchanged collections share references with the input.

function withSessions(s: State, sessions: Map<string, Session>): State {
  return {
    sessions,
    agents: s.agents,
    edges: s.edges,
    tool_calls: s.tool_calls,
    events: s.events,
    pending_subagents: s.pending_subagents,
  };
}

function withAgents(s: State, agents: Map<string, Agent>): State {
  return {
    sessions: s.sessions,
    agents,
    edges: s.edges,
    tool_calls: s.tool_calls,
    events: s.events,
    pending_subagents: s.pending_subagents,
  };
}

function withToolCalls(s: State, tool_calls: Map<string, ToolCall[]>): State {
  return {
    sessions: s.sessions,
    agents: s.agents,
    edges: s.edges,
    tool_calls,
    events: s.events,
    pending_subagents: s.pending_subagents,
  };
}

function withEdges(s: State, edges: Edge[]): State {
  return {
    sessions: s.sessions,
    agents: s.agents,
    edges,
    tool_calls: s.tool_calls,
    events: s.events,
    pending_subagents: s.pending_subagents,
  };
}

function withEvents(s: State, events: Event[]): State {
  return {
    sessions: s.sessions,
    agents: s.agents,
    edges: s.edges,
    tool_calls: s.tool_calls,
    events,
    pending_subagents: s.pending_subagents,
  };
}

function withPendingSubagents(
  s: State,
  pending_subagents: Map<string, string[]>
): State {
  return {
    sessions: s.sessions,
    agents: s.agents,
    edges: s.edges,
    tool_calls: s.tool_calls,
    events: s.events,
    pending_subagents,
  };
}

function setSession(s: State, id: string, value: Session): State {
  const m = new Map(s.sessions);
  m.set(id, value);
  return withSessions(s, m);
}

function setAgent(s: State, id: string, value: Agent): State {
  const m = new Map(s.agents);
  m.set(id, value);
  return withAgents(s, m);
}

function setToolCalls(s: State, agentId: string, calls: ToolCall[]): State {
  const m = new Map(s.tool_calls);
  m.set(agentId, calls);
  return withToolCalls(s, m);
}

// ── Session/agent bootstrapping ────────────────────────────────────────

export function ensureSession(state: State, sessionId: string, tsMs: number): State {
  if (state.sessions.has(sessionId)) return state;

  const rootId = rootAgentId(sessionId);

  const session: Session = {
    id: sessionId,
    started_at: tsMs,
    ended_at: null,
    project_path: "",
    root_agent_id: rootId,
    status: "active",
    name: null,
  };

  const rootAgent: Agent = {
    id: rootId,
    name: "Claude Code",
    parent_id: null,
    session_id: sessionId,
    status: "active",
    subagent_type: null,
    description: "Main session",
    prompt: null,
    first_seen_ms: tsMs,
    last_seen_ms: tsMs,
    tool_count: 0,
    error_count: 0,
    children: [],
    result: null,
  };

  // Three Maps mutated: sessions, agents, tool_calls.
  const sessions = new Map(state.sessions);
  sessions.set(sessionId, session);
  const agents = new Map(state.agents);
  agents.set(rootId, rootAgent);
  const tool_calls = new Map(state.tool_calls);
  tool_calls.set(rootId, []);

  return {
    sessions,
    agents,
    edges: state.edges,
    tool_calls,
    events: state.events,
    pending_subagents: state.pending_subagents,
  };
}

export function ensureAgent(
  state: State,
  agentId: string,
  sessionId: string,
  agentType: string | undefined,
  tsMs: number
): State {
  if (state.agents.has(agentId)) return state;

  const rootId = rootAgentId(sessionId);
  const label = (agentType && agentType.trim()) || agentId.slice(0, 12);

  const agent: Agent = {
    id: agentId,
    name: label,
    parent_id: rootId,
    session_id: sessionId,
    status: "active",
    subagent_type: agentType ?? null,
    description: label,
    prompt: null,
    first_seen_ms: tsMs,
    last_seen_ms: tsMs,
    tool_count: 0,
    error_count: 0,
    children: [],
    result: null,
  };

  const agents = new Map(state.agents);
  agents.set(agentId, agent);

  const root = agents.get(rootId);
  if (root && !root.children.includes(agentId)) {
    agents.set(rootId, { ...root, children: [...root.children, agentId] });
  }

  const tool_calls = new Map(state.tool_calls);
  tool_calls.set(agentId, []);

  // Spawn edge from root → new agent so the topology shows the link.
  const edges = state.edges.some(
    (ed) => ed.from_id === rootId && ed.to_id === agentId
  )
    ? state.edges
    : [...state.edges, { from_id: rootId, to_id: agentId, label: label, prompt_preview: "", ts: tsMs }];

  return {
    sessions: state.sessions,
    agents,
    edges,
    tool_calls,
    events: state.events,
    pending_subagents: state.pending_subagents,
  };
}

// ── Migration helper ───────────────────────────────────────────────────

/**
 * Migrate a pre-created agent stub from `fromId` to `toId`.
 * Preserves all fields. Updates parent.children and tool_calls map key.
 */
export function migrateAgentId(s: State, fromId: string, toId: string, tsMs: number): State {
  const stub = s.agents.get(fromId);
  if (!stub) return s;

  const agents = new Map(s.agents);
  // Remove old stub
  agents.delete(fromId);
  // Insert at new id, updating last_seen
  agents.set(toId, { ...stub, id: toId, last_seen_ms: tsMs });

  // Update parent.children: swap fromId -> toId
  const parentId = stub.parent_id;
  if (parentId) {
    const parent = agents.get(parentId);
    if (parent) {
      const newChildren = parent.children.map((c) => (c === fromId ? toId : c));
      agents.set(parentId, { ...parent, children: newChildren });
    }
  }

  // Migrate tool_calls entries
  const tool_calls = new Map(s.tool_calls);
  const oldCalls = tool_calls.get(fromId);
  tool_calls.delete(fromId);
  tool_calls.set(toId, oldCalls ?? []);

  return {
    sessions: s.sessions,
    agents,
    edges: s.edges,
    tool_calls,
    events: s.events,
    pending_subagents: s.pending_subagents,
  };
}

// ── Per-event handlers ─────────────────────────────────────────────────

export function handlePreToolUse(s: State, e: Event): State {
  const sessionId = e.session_id;
  const tsMs = e.ts;
  const toolName = String(e.tool_name ?? "unknown");
  const toolInput = (e.tool_input ?? {}) as Record<string, unknown>;
  const toolUseId = String(e.tool_use_id ?? shortId());
  const agentId = e.agent_id ?? rootAgentId(sessionId);

  let next = s;

  const agent = next.agents.get(agentId);
  if (agent) {
    next = setAgent(next, agentId, {
      ...agent,
      status: agent.status === "awaiting" ? "active" : agent.status,
      tool_count: agent.tool_count + 1,
      last_seen_ms: tsMs,
    });
  }

  // Handle Task tool: auto-name session and pre-create child agent record.
  // Task description is preferred over the cwd-only fallback name, so upgrade
  // when the current name is just the cwd basename.
  // "Agent" is the current Claude Code name for the subagent-spawning tool;
  // "Task" was its prior name. Match both for forward+backward compatibility.
  if (toolName === "Task" || toolName === "Agent") {
    const session = next.sessions.get(sessionId);
    const cwdBaseOnly =
      session && session.cwd
        ? session.name === basenameOf(session.cwd)
        : false;
    if (session && (session.name === null || cwdBaseOnly)) {
      const cwd = session.cwd ?? "";
      const cwdBase = cwd ? basenameOf(cwd) : sessionId.slice(0, 8);
      const desc = String(toolInput["description"] ?? "").trim();
      const name = desc
        ? `${cwdBase}: ${desc.slice(0, 40)}`
        : cwdBase;
      next = setSession(next, sessionId, { ...session, name });
    }

    // Pre-create child agent keyed by tool_use_id so SubagentStart can migrate it
    const childId = toolUseId;
    if (!next.agents.has(childId)) {
      const rootId = rootAgentId(sessionId);
      const desc = String(toolInput["description"] ?? "").trim();
      const subType = String(toolInput["subagent_type"] ?? "").trim() || null;
      const prompt = String(toolInput["prompt"] ?? "").slice(0, 2000);
      const childAgent: Agent = {
        id: childId,
        name: desc || subType || childId.slice(0, 12),
        parent_id: agentId !== rootAgentId(sessionId) ? agentId : rootId,
        session_id: sessionId,
        status: "active",
        subagent_type: subType,
        description: desc,
        prompt: prompt || null,
        first_seen_ms: tsMs,
        last_seen_ms: tsMs,
        tool_count: 0,
        error_count: 0,
        children: [],
        result: null,
        spawn_tool_use_id: toolUseId,
      };
      const agents = new Map(next.agents);
      agents.set(childId, childAgent);
      const parent = agents.get(agentId);
      if (parent && !parent.children.includes(childId)) {
        agents.set(agentId, { ...parent, children: [...parent.children, childId] });
      }
      const tool_calls = new Map(next.tool_calls);
      tool_calls.set(childId, []);

      // Enqueue toolUseId in pending_subagents for SubagentStart dedup.
      // Key: `${sessionId}:${subType}` — SubagentStart will shift FIFO.
      const queueKey = `${sessionId}:${subType ?? ""}`;
      const oldQueue = next.pending_subagents.get(queueKey) ?? [];
      const pending_subagents = new Map(next.pending_subagents);
      pending_subagents.set(queueKey, [...oldQueue, childId]);

      next = {
        sessions: next.sessions,
        agents,
        edges: next.edges,
        tool_calls,
        events: next.events,
        pending_subagents,
      };
    }
  }

  const tc: ToolCall = {
    id: toolUseId,
    agent_id: agentId,
    tool_name: toolName,
    input: toolInput,
    input_preview: toolPreview(toolName, toolInput),
    started_ms: tsMs,
    ended_ms: null,
    status: "running",
    output_preview: null,
    response: null,
    duration_ms: null,
    retry_of: null,
  };

  const existing = next.tool_calls.get(agentId) ?? [];
  next = setToolCalls(next, agentId, [...existing, tc]);

  return next;
}

export function handlePostToolUse(s: State, e: Event, isError = false): State {
  const sessionId = e.session_id;
  const tsMs = e.ts;
  const toolName = String(e.tool_name ?? "unknown");
  const toolUseId = String(e.tool_use_id ?? "");
  const agentId = e.agent_id ?? rootAgentId(sessionId);
  const response = String(e.tool_response ?? "").slice(0, 2000);
  const status = isError ? ("error" as const) : ("done" as const);

  let next = s;

  if (isError) {
    const agent = next.agents.get(agentId);
    if (agent) {
      next = setAgent(next, agentId, { ...agent, error_count: agent.error_count + 1 });
    }
  }

  const calls = [...(next.tool_calls.get(agentId) ?? [])];
  let matched = false;
  for (let i = calls.length - 1; i >= 0; i--) {
    const tc = calls[i];
    if (!tc) continue;
    if (tc.id === toolUseId || (tc.tool_name === toolName && tc.status === "running")) {
      calls[i] = {
        ...tc,
        status,
        output_preview: response.slice(0, 300),
        response,
        ended_ms: tsMs,
        duration_ms: tsMs - tc.started_ms,
      };
      matched = true;
      break;
    }
  }
  if (!matched && toolUseId) {
    // PostToolUse arrived without a matching PreToolUse — create a stub
    calls.push({
      id: toolUseId,
      agent_id: agentId,
      tool_name: toolName,
      input: {},
      input_preview: "",
      started_ms: tsMs,
      ended_ms: tsMs,
      status,
      output_preview: response.slice(0, 300),
      response,
      duration_ms: 0,
      retry_of: null,
    });
  }
  next = setToolCalls(next, agentId, calls);

  // Mark spawned subagent as done when its parent Agent/Task PostToolUse arrives.
  if ((toolName === "Agent" || toolName === "Task") && toolUseId) {
    for (const sub of next.agents.values()) {
      if (sub.spawn_tool_use_id === toolUseId && sub.status !== "done" && sub.status !== "error") {
        next = setAgent(next, sub.id, {
          ...sub,
          status: isError ? "error" : "done",
          ended_at: tsMs,
          last_seen_ms: tsMs,
          result: response || sub.result,
        });
        break;
      }
    }
  }

  void sessionId;
  return next;
}

export function handleSubagentStart(s: State, e: Event): State {
  const sessionId = e.session_id;
  const tsMs = e.ts;
  const toolInput = (e.tool_input ?? {}) as Record<string, unknown>;
  const agentId = e.agent_id ?? String(e.tool_use_id ?? shortId());
  const agentType = String((e as Record<string, unknown>)["agent_type"] ?? "");
  // The queue key uses the same subagent_type source as handlePreToolUse:
  // prefer tool_input.subagent_type, fall back to agent_type event field.
  const queueSubType =
    String(toolInput["subagent_type"] ?? agentType ?? "") || agentType;

  // ── Dedup via pending_subagents migration ──────────────────────────────
  // If a pre-created stub exists for this (sessionId, subagent_type), shift the
  // FIFO queue and migrate the stub to the new agent_id before doing anything
  // else. This prevents orphaned stubs when SubagentStart arrives with a
  // different id than the tool_use_id used for pre-creation.
  const queueKey = `${sessionId}:${queueSubType}`;
  const queue = s.pending_subagents.get(queueKey);
  if (queueSubType && queue && queue.length > 0) {
    const fromId = queue[0];
    const newQueue = queue.slice(1);
    const pending_subagents = new Map(s.pending_subagents);
    if (newQueue.length === 0) {
      pending_subagents.delete(queueKey);
    } else {
      pending_subagents.set(queueKey, newQueue);
    }
    let next = withPendingSubagents(s, pending_subagents);

    // Only migrate if the stub actually exists and the toId is different
    if (fromId !== agentId && next.agents.has(fromId)) {
      next = migrateAgentId(next, fromId, agentId, tsMs);
    }

    // Capture transcript_path from SubagentStart payload if present.
    const tp = typeof e["transcript_path"] === "string" ? (e["transcript_path"] as string) : undefined;
    if (tp) {
      const ag = next.agents.get(agentId);
      if (ag && !ag.transcript_path) {
        next = setAgent(next, agentId, { ...ag, transcript_path: tp });
      }
    }

    // Now ensure the edge exists from the (now-migrated) parent to agentId
    const migratedAgent = next.agents.get(agentId);
    const parentId = migratedAgent?.parent_id ?? rootAgentId(sessionId);
    let edges = next.edges;
    const edgeExists = edges.some(
      (ed) => ed.from_id === parentId && ed.to_id === agentId
    );
    if (!edgeExists) {
      const stub = next.agents.get(agentId);
      const edgeLabel = stub?.description ?? agentType;
      const edgePrompt = stub?.prompt?.slice(0, 300) ?? "";
      edges = [
        ...edges,
        { from_id: parentId, to_id: agentId, label: edgeLabel, prompt_preview: edgePrompt, ts: tsMs },
      ];
      next = withEdges(next, edges);
    }

    return next;
  }

  // ── Fallback: upsert path (no pending stub matched) ────────────────────
  const parentId = e.agent_id
    ? (s.agents.get(e.agent_id)?.parent_id ?? rootAgentId(sessionId))
    : rootAgentId(sessionId);

  const description = String(
    toolInput["description"] ?? (agentType || "subagent")
  );
  const subagentType =
    String(toolInput["subagent_type"] ?? agentType ?? "") || null;
  const prompt = String(toolInput["prompt"] ?? "").slice(0, 2000);

  // Mutates: agents, possibly tool_calls, possibly edges.
  const agents = new Map(s.agents);

  const existing = agents.get(agentId);
  const transcriptPath =
    typeof e["transcript_path"] === "string" ? (e["transcript_path"] as string) : undefined;
  const newAgent: Agent = {
    id: agentId,
    name: description,
    parent_id: parentId,
    session_id: sessionId,
    status: "active",
    subagent_type: subagentType,
    description,
    prompt: prompt || null,
    first_seen_ms: existing?.first_seen_ms ?? tsMs,
    last_seen_ms: tsMs,
    tool_count: existing?.tool_count ?? 0,
    error_count: existing?.error_count ?? 0,
    children: existing?.children ?? [],
    result: null,
    transcript_path: transcriptPath ?? existing?.transcript_path,
  };
  agents.set(agentId, newAgent);

  // Update parent's children list
  const parent = agents.get(parentId);
  if (parent && !parent.children.includes(agentId)) {
    agents.set(parentId, { ...parent, children: [...parent.children, agentId] });
  }

  let tool_calls = s.tool_calls;
  if (!tool_calls.has(agentId)) {
    tool_calls = new Map(tool_calls);
    tool_calls.set(agentId, []);
  }

  let edges = s.edges;
  const edgeExists = edges.some(
    (ed) => ed.from_id === parentId && ed.to_id === agentId
  );
  if (!edgeExists) {
    const edge: Edge = {
      from_id: parentId,
      to_id: agentId,
      label: description,
      prompt_preview: prompt.slice(0, 300),
      ts: tsMs,
    };
    edges = [...edges, edge];
  }

  return {
    sessions: s.sessions,
    agents,
    edges,
    tool_calls,
    events: s.events,
    pending_subagents: s.pending_subagents,
  };
}

export function handleSubagentStop(s: State, e: Event): State {
  const sessionId = e.session_id;
  const tsMs = e.ts;
  const agentId =
    e.agent_id ??
    (String(e.tool_use_id ?? "") || rootAgentId(sessionId));

  const agent = s.agents.get(agentId);
  if (!agent || agentId.startsWith("root:")) return s;

  const result = String((e as Record<string, unknown>)["result"] ?? "").slice(0, 2000);

  return setAgent(s, agentId, {
    ...agent,
    status: "done",
    last_seen_ms: tsMs,
    result: result || null,
  });
}

export function handleStop(s: State, e: Event): State {
  const sessionId = e.session_id;
  const tsMs = e.ts;

  const session = s.sessions.get(sessionId);
  if (!session) return s;

  // Claude Code's Stop hook fires after every assistant turn, not session end.
  // Only treat synthetic idle-stop events as session-complete signals.
  const isIdleStop = typeof e.id === "string" && e.id.startsWith("idle-stop-");

  const rootId = rootAgentId(sessionId);

  if (isIdleStop) {
    let next = setSession(s, sessionId, { ...session, status: "complete", ended_at: tsMs });
    const root = next.agents.get(rootId);
    if (root) {
      next = setAgent(next, rootId, { ...root, status: "done", last_seen_ms: tsMs });
    }
    return next;
  }

  // Turn-end Stop: session stays active but root is awaiting next user input.
  const root = s.agents.get(rootId);
  if (root) {
    return setAgent(s, rootId, { ...root, status: "awaiting", last_seen_ms: tsMs });
  }
  return s;
}

// ── Core public API ────────────────────────────────────────────────────

/**
 * Apply a single event to a state, returning a new state.
 * This is the incremental helper used by the live processor.
 */
export function applyEvent(state: State, e: Event): State {
  let sessionId = e.session_id || "default";
  const rawTs = typeof e.ts === "number" ? e.ts : Date.now();
  // Hooks historically wrote ts as Unix seconds via jq's `now`; normalize to ms.
  // Range gate: only treat as seconds if it falls within plausible Unix-seconds
  // window (2001-5138). Smaller values (test fixtures) pass through unchanged.
  const tsMs = rawTs >= 1e9 && rawTs < 1e12 ? rawTs * 1000 : rawTs;

  // Subagent re-parenting: SubagentStart events arrive with their own
  // session_id (a fresh Claude Code subprocess), but we want them attached
  // to the PARENT session that spawned them via the Agent/Task tool.
  // Scan pending_subagents for a queue matching this subagent's type and
  // rewrite session_id to the parent's.
  const hookEvent = String(e.hook_event ?? "");
  if (hookEvent === "SubagentStart") {
    const agentType = String(e.agent_type ?? "");
    const toolInput = (e.tool_input ?? {}) as Record<string, unknown>;
    const subType = String(toolInput["subagent_type"] ?? agentType ?? "") || agentType;
    if (subType) {
      for (const [key, queue] of state.pending_subagents) {
        if (queue.length === 0) continue;
        if (key.endsWith(`:${subType}`)) {
          const parentSession = key.slice(0, key.length - subType.length - 1);
          if (parentSession && state.sessions.has(parentSession)) {
            sessionId = parentSession;
          }
          break;
        }
      }
    }
  }

  const normalizedEvent: Event = { ...e, session_id: sessionId, ts: tsMs };

  // Ensure session + root agent exist
  let next = ensureSession(state, sessionId, tsMs);

  // Store cwd on session if provided and not yet set; auto-derive name from
  // cwd basename when no Task description has set one yet.
  const eventCwd = typeof e["cwd"] === "string" ? e["cwd"] : undefined;
  if (eventCwd) {
    const session = next.sessions.get(sessionId);
    if (session && (!session.cwd || !session.name)) {
      const cwd = session.cwd ?? eventCwd;
      const name = session.name ?? basenameOf(cwd);
      next = setSession(next, sessionId, { ...session, cwd, name });
    }
  }

  // Auto-discover agent from agent_id field
  if (normalizedEvent.agent_id) {
    next = ensureAgent(
      next,
      normalizedEvent.agent_id,
      sessionId,
      normalizedEvent.agent_type,
      tsMs
    );
  }

  // Append event to log (only the events array changes)
  next = withEvents(next, [...next.events, normalizedEvent]);

  // Dispatch to handler
  const hook = String(normalizedEvent.hook_event ?? "");
  switch (hook) {
    case "PreToolUse":
      return handlePreToolUse(next, normalizedEvent);
    case "PostToolUse":
      return handlePostToolUse(next, normalizedEvent, false);
    case "PostToolUseFailure":
      return handlePostToolUse(next, normalizedEvent, true);
    case "SubagentStart":
      return handleSubagentStart(next, normalizedEvent);
    case "SubagentStop":
      return handleSubagentStop(next, normalizedEvent);
    case "Stop":
      return handleStop(next, normalizedEvent);
    default:
      return next;
  }
}

/**
 * Pure replay: fold all events up to (and including) timestamp `ts`.
 * Deterministic — same input always produces identical output.
 * Pass Infinity (or omit) to replay all events.
 */
export function replayToTimestamp(events: Event[], ts: number = Infinity): State {
  let state = emptyState();
  for (const e of events) {
    if (e.ts > ts) break;
    state = applyEvent(state, e);
  }
  return state;
}

// Re-export types so consumers can `import { State, Event } from '.../replay-core'`
export type { Agent, Edge, Event, Session, State, ToolCall } from "./models.js";
