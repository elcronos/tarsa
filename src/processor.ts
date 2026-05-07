/**
 * EventProcessor — thin stateful wrapper around the pure reducer.
 *
 * Holds the append-only events[] array and the derived live state.
 * On each new event:
 *   1. Push to events[]
 *   2. Call applyEvent() to get new state (incremental, not full replay)
 *   3. Notify subscribers with (event, newState)
 *
 * Subscribers receive both the raw event (for SSE delta) and the full
 * derived state (for initial connection snapshot).
 */

import { applyEvent, emptyState } from "./replay.js";
import type { Agent, Event, State } from "./models.js";
import type { Database } from "./db.js";
import { updateBaselines } from "./db.js";
import { scoreAgent } from "./scorer.js";
import { createHash } from "node:crypto";

/**
 * Minimal runtime guard — rejects objects that cannot possibly be valid events.
 * Accepts anything with a string session_id (or none, applyEvent defaults to "default").
 * Rejects if `id` is present but not a string, or if `ts` is present but not a number.
 */
function isValidEventShape(raw: Record<string, unknown>): raw is Partial<Event> {
  if (typeof raw !== "object" || raw === null) return false;
  if ("id" in raw && typeof raw["id"] !== "string") return false;
  if ("ts" in raw && typeof raw["ts"] !== "number") return false;
  return true;
}

/** Injectable clock/timer for testability. */
export interface Clock {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

const defaultClock: Clock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

const KNOWN_SCHEMA_VERSION = 1;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

export type Subscriber = (event: Event, state: State) => void;

export class EventProcessor {
  private _events: Event[] = [];
  private _state: State = emptyState();
  private _subscribers: Set<Subscriber> = new Set();
  private _db: Database | null = null;
  private _clock: Clock;
  private _idleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db?: Database, clock?: Clock) {
    this._db = db ?? null;
    this._clock = clock ?? defaultClock;
    this._idleCheckTimer = this._clock.setInterval(
      () => this._checkIdleSessions(),
      IDLE_CHECK_INTERVAL_MS
    );
  }

  /** Append-only event log. */
  get events(): readonly Event[] {
    return this._events;
  }

  /** Current derived state. */
  get state(): State {
    return this._state;
  }

  /**
   * Ingest a raw parsed object from the JSONL stream.
   * Validates shape before casting; skips and logs on invalid input.
   */
  ingest(raw: Record<string, unknown>): void {
    if (!isValidEventShape(raw)) {
      process.stderr.write(
        `[claudelens] dropped invalid event shape: ${JSON.stringify(raw).slice(0, 200)}\n`
      );
      return;
    }
    // When v2 lands, branch processing logic on schema_version here. See ADR-0002.
    if (raw["schema_version"] !== undefined && (raw["schema_version"] as number) > KNOWN_SCHEMA_VERSION) {
      process.stderr.write(
        `[claudelens] Unknown schema_version ${String(raw["schema_version"])}, skipping event\n`
      );
      return;
    }
    const event = raw as unknown as Event;
    this._events.push(event);
    this._state = applyEvent(this._state, event);
    this._notifySubscribers(event, this._state);

    // On Stop event, update baselines for the ended session
    if (String(event.hook_event) === "Stop" && this._db) {
      const sessionId = event.session_id;
      if (sessionId) {
        this._finalizeSession(sessionId);
      }
    }
  }

  /** Subscribe to new events. Returns an unsubscribe function. */
  subscribe(fn: Subscriber): () => void {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  /** Reset all state (used for testing and manual reset). */
  reset(): void {
    this._events = [];
    this._state = emptyState();
  }

  /** Stop the idle check timer. Call on process shutdown. */
  stopIdleCheck(): void {
    if (this._idleCheckTimer !== null) {
      this._clock.clearInterval(this._idleCheckTimer);
      this._idleCheckTimer = null;
    }
  }

  /** Check for sessions that have been idle for more than IDLE_TIMEOUT_MS. */
  private _checkIdleSessions(): void {
    const now = this._clock.now();
    const cutoff = now - IDLE_TIMEOUT_MS;

    for (const session of this._state.sessions.values()) {
      if (session.status !== "active") continue;

      // Find the most recent event timestamp for this session
      let lastEventTs = session.started_at;
      for (const e of this._state.events) {
        if (e.session_id === session.id && e.ts > lastEventTs) {
          lastEventTs = e.ts;
        }
      }

      if (lastEventTs < cutoff) {
        // Session is idle — synthesize a Stop event and end the session
        const syntheticStop: Event = {
          id: `idle-stop-${session.id}`,
          hook_event: "Stop",
          ts: now,
          session_id: session.id,
        };
        this._events.push(syntheticStop);
        this._state = applyEvent(this._state, syntheticStop);
        this._notifySubscribers(syntheticStop, this._state);

        if (this._db) {
          this._finalizeSession(session.id);
        }
      }
    }
  }

  /** Finalize a session: update baselines + persist anomaly scores. */
  private _finalizeSession(sessionId: string): void {
    if (!this._db) return;

    const sessionAgents = new Map(
      Array.from(this._state.agents.entries()).filter(
        ([, a]) => a.session_id === sessionId
      )
    );
    const sessionState: State = {
      ...this._state,
      agents: sessionAgents,
      tool_calls: new Map(
        Array.from(this._state.tool_calls.entries()).filter(([id]) =>
          sessionAgents.has(id)
        )
      ),
      events: this._state.events.filter((e) => e.session_id === sessionId),
    };

    try {
      updateBaselines(this._db, sessionState);
    } catch (err) {
      process.stderr.write(`[claudelens] updateBaselines error: ${String(err)}\n`);
    }

    // Persist the session row first so agents.session_id FK resolves.
    const session = this._state.sessions.get(sessionId);
    if (session) {
      try {
        this._db.upsertSession(session);
      } catch (err) {
        process.stderr.write(`[claudelens] upsertSession error: ${String(err)}\n`);
      }
    }

    // Persist iterations (Critic fix #11 / N6): only those clearing the
    // confidence + tool_count threshold get cross-restart history. Honor the
    // CLAUDELENS_ITERATION_DETECTION=0 opt-out from --no-iteration-detection.
    if (process.env["CLAUDELENS_ITERATION_DETECTION"] !== "0") {
      const iters = this._state.iterations.get(sessionId) ?? [];
      for (const it of iters) {
        if (it.confidence >= 0.85 && it.tool_count >= 3) {
          try {
            this._db.upsertIteration(sessionId, it);
          } catch (err) {
            process.stderr.write(`[claudelens] upsertIteration error: ${String(err)}\n`);
          }
        }
      }
    }

    // Topological order: persist parents before children so parent_id FK resolves.
    const ordered: Agent[] = [];
    const persisted = new Set<string>();
    const remaining = new Map(sessionAgents);
    while (remaining.size > 0) {
      let progress = false;
      for (const [id, agent] of Array.from(remaining)) {
        if (
          agent.parent_id === null ||
          !sessionAgents.has(agent.parent_id) ||
          persisted.has(agent.parent_id)
        ) {
          ordered.push(agent);
          persisted.add(id);
          remaining.delete(id);
          progress = true;
        }
      }
      if (!progress) {
        // Cycle or unresolvable — flush remainder anyway.
        for (const a of remaining.values()) ordered.push(a);
        break;
      }
    }

    // Persist prompt_hash and anomaly_score per agent
    for (const agent of ordered) {
      const updates: { prompt_hash?: string; anomaly_score?: number } = {};

      if (agent.prompt) {
        updates.prompt_hash = createHash("sha256")
          .update(agent.prompt)
          .digest("hex")
          .slice(0, 16);
      }

      const agentType = agent.subagent_type ?? "root";
      try {
        const baseline = this._db.queryBaselines(agentType);
        const score = scoreAgent(agent, baseline);
        if (score !== null) {
          updates.anomaly_score = score.healthScore;
        }
      } catch (err) {
        process.stderr.write(`[claudelens] scoreAgent error: ${String(err)}\n`);
      }

      // Always upsert so child agents' parent_id FK resolves.
      try {
        this._db.upsertAgent({ ...agent, ...updates });
      } catch (err) {
        process.stderr.write(`[claudelens] upsertAgent error: ${String(err)}\n`);
      }
    }
  }

  private _notifySubscribers(event: Event, state: State): void {
    for (const fn of this._subscribers) {
      try {
        fn(event, state);
      } catch (err) {
        process.stderr.write(`[claudelens] subscriber error: ${String(err)}\n`);
      }
    }
  }
}
