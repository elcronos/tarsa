/**
 * Storage abstraction — hides bun:sqlite (Bun) vs better-sqlite3 (Node).
 *
 * Both libraries are synchronous; we expose a synchronous interface.
 * The correct binding is selected at startup via isBun().
 * Dynamic import() ensures the unused binding is never required.
 */

import type { Agent, Event, Iteration, Session, State, ToolCall } from "./models.js";
import { isBun } from "./runtime.js";
import { applyMigrations, ensureDbDir, DB_PATH, type Migratable } from "./migrations.js";
import { costEstimate } from "./insights.js";

// ── Shared row types ──────────────────────────────────────────────────────

export interface BaselineRow {
  agent_type: string;
  mean_duration: number;
  mean_tool_count: number;
  mean_cost: number;
  sample_count: number;
  stddev_duration: number;
  stddev_tool_count: number;
  updated_at: number;
  tool_sequence_common: string | null;
}

// ── Public Database interface ─────────────────────────────────────────────

export interface Database {
  upsertSession(s: Session): void;
  upsertAgent(a: Agent): void;
  insertToolCall(t: ToolCall & { session_id: string }): void;
  insertEvent(e: Event): void;
  queryEvents(sessionId: string, limit?: number): Event[];
  queryAllEvents(limit: number): Event[];
  getEventsByCommit(commit: string): Event[];
  queryBaselines(agentType: string): BaselineRow | null;
  listAllBaselines(): BaselineRow[];
  listSessions(): Session[];
  getSession(id: string): Session | null;
  updateBaseline(agentType: string, durationMs: number, toolCount: number, costUsd: number, toolSequenceCommon: string | null): void;
  upsertIteration(sessionId: string, it: Iteration): void;
  listIterations(sessionId: string): Iteration[];
  listSessionsMissingCwd(): string[];
  setSessionCwd(sessionId: string, cwd: string): void;
  setBudget(sessionId: string, budgetUsd: number, killOnExceed: number): void;
  close(): void;
}

// ── Internal raw-driver wrapper ───────────────────────────────────────────

interface RawStatement {
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

// ── Implementation ────────────────────────────────────────────────────────

class SqliteDatabase implements Database {
  private db: RawDb;

  constructor(db: RawDb) {
    this.db = db;
    // WAL mode for better concurrency
    this.db.exec("PRAGMA journal_mode=WAL");
    applyMigrations(this.db as unknown as Migratable);
  }

  upsertSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, started_at, ended_at, project_path, root_agent_id, status, name,
            cwd, budget_usd, kill_on_exceed, git_commit, git_branch, git_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = COALESCE(excluded.ended_at, ended_at),
           status = excluded.status,
           name = COALESCE(excluded.name, name),
           cwd = COALESCE(excluded.cwd, cwd),
           budget_usd = COALESCE(excluded.budget_usd, budget_usd),
           kill_on_exceed = COALESCE(excluded.kill_on_exceed, kill_on_exceed),
           git_commit = COALESCE(excluded.git_commit, git_commit),
           git_branch = COALESCE(excluded.git_branch, git_branch),
           git_dirty = COALESCE(excluded.git_dirty, git_dirty)`
      )
      .run(
        s.id,
        s.started_at,
        s.ended_at ?? null,
        s.project_path,
        s.root_agent_id,
        s.status,
        s.name ?? null,
        s.cwd ?? null,
        s.budget_usd ?? null,
        s.kill_on_exceed == null ? null : (s.kill_on_exceed ? 1 : 0),
        s.git_commit ?? null,
        s.git_branch ?? null,
        s.git_dirty == null ? null : (s.git_dirty ? 1 : 0)
      );
  }

  upsertIteration(sessionId: string, it: Iteration): void {
    this.db
      .prepare(
        `INSERT INTO iterations
           (session_id, n, started_at, ended_at, tool_count, cost_usd, confidence, marker_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, n) DO UPDATE SET
           ended_at = COALESCE(excluded.ended_at, ended_at),
           tool_count = excluded.tool_count,
           cost_usd = excluded.cost_usd,
           confidence = excluded.confidence,
           marker_source = excluded.marker_source`
      )
      .run(
        sessionId,
        it.n,
        it.started_at,
        it.ended_at ?? null,
        it.tool_count,
        it.cost_usd ?? 0,
        it.confidence,
        it.marker_source
      );
  }

  listIterations(sessionId: string): Iteration[] {
    const rows = this.db
      .prepare(
        `SELECT n, started_at, ended_at, tool_count, cost_usd, confidence, marker_source
         FROM iterations WHERE session_id = ? ORDER BY n ASC`
      )
      .all(sessionId) as Array<{
        n: number;
        started_at: number;
        ended_at: number | null;
        tool_count: number;
        cost_usd: number;
        confidence: number;
        marker_source: string;
      }>;
    return rows.map((r) => ({
      n: r.n,
      started_at: r.started_at,
      ended_at: r.ended_at,
      tool_count: r.tool_count,
      cost_usd: r.cost_usd,
      confidence: r.confidence,
      marker_source: r.marker_source as Iteration["marker_source"],
    }));
  }

  listSessionsMissingCwd(): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM sessions WHERE cwd IS NULL OR cwd = ''`)
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  setSessionCwd(sessionId: string, cwd: string): void {
    this.db
      .prepare(`UPDATE sessions SET cwd = ? WHERE id = ? AND (cwd IS NULL OR cwd = '')`)
      .run(cwd, sessionId);
  }

  setBudget(sessionId: string, budgetUsd: number, killOnExceed: number): void {
    // UPSERT: insert a stub session row if missing, or update the budget cols.
    // The session may not exist in DB yet (live-only), so use INSERT OR IGNORE
    // followed by UPDATE — keeps existing started_at/etc untouched.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions
           (id, started_at, ended_at, project_path, root_agent_id, status, name,
            cwd, budget_usd, kill_on_exceed)
         VALUES (?, ?, NULL, '', '', 'active', NULL, NULL, ?, ?)`
      )
      .run(sessionId, Date.now(), budgetUsd, killOnExceed);
    this.db
      .prepare(`UPDATE sessions SET budget_usd = ?, kill_on_exceed = ? WHERE id = ?`)
      .run(budgetUsd, killOnExceed, sessionId);
  }

  upsertAgent(a: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents
           (id, session_id, name, parent_id, status, subagent_type, description,
            prompt, first_seen_ms, last_seen_ms, tool_count, error_count, result,
            prompt_hash, anomaly_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           last_seen_ms = excluded.last_seen_ms,
           tool_count = excluded.tool_count,
           error_count = excluded.error_count,
           result = COALESCE(excluded.result, result),
           prompt_hash = COALESCE(excluded.prompt_hash, prompt_hash),
           anomaly_score = COALESCE(excluded.anomaly_score, anomaly_score)`
      )
      .run(
        a.id,
        a.session_id,
        a.name,
        a.parent_id ?? null,
        a.status,
        a.subagent_type ?? null,
        a.description,
        a.prompt ?? null,
        a.first_seen_ms,
        a.last_seen_ms,
        a.tool_count,
        a.error_count,
        a.result ?? null,
        a.prompt_hash ?? null,
        a.anomaly_score ?? null
      );
  }

  insertToolCall(t: ToolCall & { session_id: string }): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls
           (id, agent_id, session_id, tool_name, input, input_preview,
            started_ms, ended_ms, status, output_preview, response, duration_ms, retry_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ended_ms = COALESCE(excluded.ended_ms, ended_ms),
           status = excluded.status,
           output_preview = COALESCE(excluded.output_preview, output_preview),
           response = COALESCE(excluded.response, response),
           duration_ms = COALESCE(excluded.duration_ms, duration_ms)`
      )
      .run(
        t.id,
        t.agent_id,
        t.session_id,
        t.tool_name,
        JSON.stringify(t.input),
        t.input_preview,
        t.started_ms,
        t.ended_ms ?? null,
        t.status,
        t.output_preview ?? null,
        t.response ?? null,
        t.duration_ms ?? null,
        t.retry_of ?? null
      );
  }

  insertEvent(e: Event): void {
    // Serialize the full event as payload, excluding indexed columns
    const { id, session_id, ts, hook_event, agent_id, tool_name, ...rest } = e;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (id, session_id, ts, hook_event, agent_id, tool_name, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        session_id,
        ts,
        hook_event,
        agent_id ?? null,
        tool_name ?? null,
        JSON.stringify(rest)
      );
  }

  queryAllEvents(limit: number): Event[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, ts, hook_event, agent_id, tool_name, payload
         FROM events ORDER BY ts DESC LIMIT ?`
      )
      .all(limit) as Array<{
        id: string;
        session_id: string;
        ts: number;
        hook_event: string;
        agent_id: string | null;
        tool_name: string | null;
        payload: string;
      }>;

    return rows.map((r) => {
      const payload = JSON.parse(r.payload) as Record<string, unknown>;
      return {
        ...payload,
        id: r.id,
        session_id: r.session_id,
        ts: r.ts,
        hook_event: r.hook_event,
        ...(r.agent_id != null ? { agent_id: r.agent_id } : {}),
        ...(r.tool_name != null ? { tool_name: r.tool_name } : {}),
      } as Event;
    });
  }

  queryEvents(sessionId: string, limit = 1000): Event[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, ts, hook_event, agent_id, tool_name, payload
         FROM events WHERE session_id = ? ORDER BY ts ASC LIMIT ?`
      )
      .all(sessionId, limit) as Array<{
        id: string;
        session_id: string;
        ts: number;
        hook_event: string;
        agent_id: string | null;
        tool_name: string | null;
        payload: string;
      }>;

    return rows.map((r) => {
      const payload = JSON.parse(r.payload) as Record<string, unknown>;
      return {
        ...payload,
        id: r.id,
        session_id: r.session_id,
        ts: r.ts,
        hook_event: r.hook_event,
        ...(r.agent_id != null ? { agent_id: r.agent_id } : {}),
        ...(r.tool_name != null ? { tool_name: r.tool_name } : {}),
      } as Event;
    });
  }

  queryBaselines(agentType: string): BaselineRow | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_baselines WHERE agent_type = ?`)
      .get(agentType) as BaselineRow | undefined;
    return row ?? null;
  }

  listAllBaselines(): BaselineRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_baselines ORDER BY sample_count DESC`)
      .all() as BaselineRow[];
    return rows;
  }

  updateBaseline(
    agentType: string,
    durationMs: number,
    toolCount: number,
    costUsd: number,
    toolSequenceCommon: string | null
  ): void {
    const existing = this.queryBaselines(agentType);
    const now = Date.now();

    if (!existing || existing.sample_count === 0) {
      // Insert first row
      this.db
        .prepare(
          `INSERT INTO agent_baselines
             (agent_type, mean_duration, mean_tool_count, mean_cost, sample_count,
              stddev_duration, stddev_tool_count, updated_at, tool_sequence_common)
           VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)
           ON CONFLICT(agent_type) DO UPDATE SET
             mean_duration = excluded.mean_duration,
             mean_tool_count = excluded.mean_tool_count,
             mean_cost = excluded.mean_cost,
             sample_count = 1,
             stddev_duration = 0,
             stddev_tool_count = 0,
             updated_at = excluded.updated_at,
             tool_sequence_common = COALESCE(excluded.tool_sequence_common, tool_sequence_common)`
        )
        .run(agentType, durationMs, toolCount, costUsd, now, toolSequenceCommon);
    } else {
      // Welford online update for running mean + variance
      const n = existing.sample_count + 1;
      const delta = durationMs - existing.mean_duration;
      const newMeanDuration = existing.mean_duration + delta / n;
      const delta2 = durationMs - newMeanDuration;
      // Welford M2 approximation: stddev stored directly, recover M2 = stddev^2 * (n-1)
      const oldM2Duration = existing.stddev_duration * existing.stddev_duration * (existing.sample_count - 1);
      const newM2Duration = oldM2Duration + delta * delta2;
      const newStddevDuration = n >= 2 ? Math.sqrt(newM2Duration / (n - 1)) : 0;

      const deltaTools = toolCount - existing.mean_tool_count;
      const newMeanTools = existing.mean_tool_count + deltaTools / n;
      const deltaTools2 = toolCount - newMeanTools;
      const oldM2Tools = existing.stddev_tool_count * existing.stddev_tool_count * (existing.sample_count - 1);
      const newM2Tools = oldM2Tools + deltaTools * deltaTools2;
      const newStddevTools = n >= 2 ? Math.sqrt(newM2Tools / (n - 1)) : 0;

      const newMeanCost = existing.mean_cost + (costUsd - existing.mean_cost) / n;

      this.db
        .prepare(
          `UPDATE agent_baselines SET
             mean_duration = ?, mean_tool_count = ?, mean_cost = ?,
             sample_count = ?, stddev_duration = ?, stddev_tool_count = ?,
             updated_at = ?,
             tool_sequence_common = COALESCE(?, tool_sequence_common)
           WHERE agent_type = ?`
        )
        .run(
          newMeanDuration, newMeanTools, newMeanCost, n,
          newStddevDuration, newStddevTools, now,
          toolSequenceCommon, agentType
        );
    }
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 200`)
      .all() as Array<{
        id: string;
        started_at: number;
        ended_at: number | null;
        project_path: string;
        root_agent_id: string;
        status: string;
        name: string | null;
        cwd: string | null;
        budget_usd: number | null;
        kill_on_exceed: number | null;
        git_commit: string | null;
        git_branch: string | null;
        git_dirty: number | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      project_path: r.project_path,
      root_agent_id: r.root_agent_id,
      status: r.status as Session["status"],
      name: r.name,
      cwd: r.cwd ?? undefined,
      budget_usd: r.budget_usd ?? undefined,
      kill_on_exceed: r.kill_on_exceed == null ? undefined : !!r.kill_on_exceed,
      git_commit: r.git_commit ?? undefined,
      git_branch: r.git_branch ?? undefined,
      git_dirty: r.git_dirty == null ? undefined : !!r.git_dirty,
    }));
  }

  getSession(id: string): Session | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as
      | {
          id: string;
          started_at: number;
          ended_at: number | null;
          project_path: string;
          root_agent_id: string;
          status: string;
          name: string | null;
          cwd: string | null;
          budget_usd: number | null;
          kill_on_exceed: number | null;
          git_commit: string | null;
          git_branch: string | null;
          git_dirty: number | null;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      project_path: row.project_path,
      root_agent_id: row.root_agent_id,
      status: row.status as Session["status"],
      name: row.name,
      cwd: row.cwd ?? undefined,
      budget_usd: row.budget_usd ?? undefined,
      kill_on_exceed: row.kill_on_exceed == null ? undefined : !!row.kill_on_exceed,
      git_commit: row.git_commit ?? undefined,
      git_branch: row.git_branch ?? undefined,
      git_dirty: row.git_dirty == null ? undefined : !!row.git_dirty,
    };
  }

  getEventsByCommit(commit: string): Event[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, ts, hook_event, agent_id, tool_name, payload
         FROM events
         WHERE json_extract(payload, '$.git_commit') = ?
         ORDER BY ts ASC`
      )
      .all(commit) as Array<{
        id: string;
        session_id: string;
        ts: number;
        hook_event: string;
        agent_id: string | null;
        tool_name: string | null;
        payload: string;
      }>;

    return rows.map((r) => {
      const payload = JSON.parse(r.payload) as Record<string, unknown>;
      return {
        ...payload,
        id: r.id,
        session_id: r.session_id,
        ts: r.ts,
        hook_event: r.hook_event,
        ...(r.agent_id != null ? { agent_id: r.agent_id } : {}),
        ...(r.tool_name != null ? { tool_name: r.tool_name } : {}),
      } as Event;
    });
  }

  close(): void {
    this.db.close();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

let _db: Database | null = null;

export async function openDatabase(dbPath: string = DB_PATH): Promise<Database> {
  ensureDbDir();

  let rawDb: RawDb;
  if (isBun()) {
    // bun:sqlite — synchronous, zero-dependency on Bun
    const { Database: BunDatabase } = await import("bun:sqlite" as string);
    rawDb = new (BunDatabase as new (path: string) => RawDb)(dbPath);
  } else {
    // better-sqlite3 — synchronous wrapper for Node
    const BetterSqlite3 = (await import("better-sqlite3")).default as new (
      path: string
    ) => RawDb;
    rawDb = new BetterSqlite3(dbPath);
  }

  return new SqliteDatabase(rawDb);
}

export function getDb(): Database {
  if (!_db) throw new Error("Database not initialized — call openDatabase() first");
  return _db;
}

export function setDb(db: Database): void {
  _db = db;
}

/**
 * Update baselines table from completed session state.
 * Called on session end. Groups agents by subagent_type, computes
 * duration, tool_count, cost, and top-3 tool_name sequences.
 */
export function updateBaselines(db: Database, state: State): void {
  const cost = costEstimate(state);
  const costById = new Map(cost.perAgent.map((a) => [a.agentId, a.usd]));

  // Group agents by type
  const groups = new Map<string, Array<{ durationMs: number; toolCount: number; costUsd: number; toolNames: string[] }>>();

  for (const agent of state.agents.values()) {
    const type = agent.subagent_type ?? "root";
    const durationMs = agent.last_seen_ms - agent.first_seen_ms;
    const toolCount = agent.tool_count;
    const costUsd = costById.get(agent.id) ?? 0;

    const calls = state.tool_calls.get(agent.id) ?? [];
    const toolNames = calls.map((tc) => tc.tool_name);

    const g = groups.get(type) ?? [];
    g.push({ durationMs, toolCount, costUsd, toolNames });
    groups.set(type, g);
  }

  for (const [agentType, entries] of groups) {
    for (const entry of entries) {
      // Compute top-3 tool_name sequences (consecutive pairs)
      let toolSequenceCommon: string | null = null;
      if (entry.toolNames.length > 0) {
        const seqCounts = new Map<string, number>();
        for (let i = 0; i < entry.toolNames.length - 1; i++) {
          const seq = `${entry.toolNames[i]}→${entry.toolNames[i + 1]}`;
          seqCounts.set(seq, (seqCounts.get(seq) ?? 0) + 1);
        }
        const top3 = Array.from(seqCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([seq]) => seq);
        if (top3.length > 0) {
          toolSequenceCommon = JSON.stringify(top3);
        }
      }

      db.updateBaseline(agentType, entry.durationMs, entry.toolCount, entry.costUsd, toolSequenceCommon);
    }
  }
}
