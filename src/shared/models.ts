/**
 * Canonical reducer types — shared between server and client.
 *
 * Both src/models.ts (server) and frontend/src/types.ts (client) re-export
 * from here. This file MUST remain runtime-free (types only) and MUST NOT
 * import any Node-specific modules (no node:path, no fs, etc.) so it can
 * be bundled by Vite for the browser.
 */

export type AgentStatus = "active" | "awaiting" | "done" | "error";

export type EventKind =
  | "PreToolUse"
  | "PostToolUse"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop";

export interface Event {
  /** Short random id (hex8) */
  id: string;
  /** hook_event field from JSONL — e.g. "PreToolUse" */
  hook_event: EventKind | string;
  /** Unix timestamp in ms */
  ts: number;
  /** Session id from Claude Code */
  session_id: string;
  /** Agent id — auto-discovered from this field */
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_use_id?: string;
  /** Raw input object for PreToolUse */
  tool_input?: Record<string, unknown>;
  /** Raw response string for PostToolUse */
  tool_response?: string;
  /** Free-form payload fields passed through from the hook */
  [key: string]: unknown;
}

export interface Agent {
  id: string;
  name: string;
  parent_id: string | null;
  session_id: string;
  status: AgentStatus;
  subagent_type: string | null;
  description: string;
  prompt: string | null;
  first_seen_ms: number;
  last_seen_ms: number;
  tool_count: number;
  error_count: number;
  children: string[];
  result: string | null;
  prompt_hash?: string;
  anomaly_score?: number;
  /** tool_use_id of the parent Agent/Task call that spawned this subagent */
  spawn_tool_use_id?: string;
  /** Wall-clock when this subagent finished (set on parent PostToolUse). */
  ended_at?: number;
  /** Path to this agent's Claude Code transcript JSONL file. */
  transcript_path?: string;
}

export interface ToolCall {
  id: string;
  agent_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  input_preview: string;
  started_ms: number;
  ended_ms: number | null;
  status: "running" | "done" | "error";
  output_preview: string | null;
  response: string | null;
  duration_ms: number | null;
  /** If this is a retry, the id of the original tool call */
  retry_of: string | null;
}

export interface Edge {
  from_id: string;
  to_id: string;
  label: string;
  prompt_preview: string;
  ts: number;
}

export interface Session {
  id: string;
  started_at: number;
  ended_at: number | null;
  project_path: string;
  root_agent_id: string;
  status: "active" | "complete";
  name: string | null;
  cwd?: string;
  budget_usd?: number;
  kill_on_exceed?: boolean;
}

/**
 * A ralph/ultrawork iteration detected from event markers.
 * Marker sources (highest confidence first):
 *   "regex"  → 0.95 (UserPromptSubmit prompt matches `[RALPH ... ITERATION N/M]`)
 *   "env"    → 0.85 (event.ralph_active === "1" injected by CLI from $RALPH_ACTIVE)
 *   "repeat" → 0.75 (repeated identical UserPromptSubmit prompts within 5 minutes)
 */
export type IterationMarkerSource = "regex" | "env" | "repeat";

export interface Iteration {
  /** 1-indexed iteration number within the session */
  n: number;
  started_at: number;
  ended_at: number | null;
  tool_count: number;
  cost_usd?: number;
  confidence: number;
  marker_source: IterationMarkerSource;
}

/**
 * Derived in-memory state — produced by the reducer in shared/replay-core.ts.
 * This is the shape consumed by the server API and SSE clients.
 */
export interface State {
  sessions: Map<string, Session>;
  agents: Map<string, Agent>;
  edges: Edge[];
  tool_calls: Map<string, ToolCall[]>;
  /** Full ordered event log */
  events: Event[];
  /**
   * FIFO queues of pre-created agent tool_use_ids awaiting a SubagentStart
   * migration. Keyed by `${sessionId}:${subagent_type}`.
   */
  pending_subagents: Map<string, string[]>;
  /** Detected ralph/ultrawork iterations keyed by session_id */
  iterations: Map<string, Iteration[]>;
}
