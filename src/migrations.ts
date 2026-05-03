/**
 * Schema migrations for AgentScope SQLite database.
 *
 * Each migration has a version number and SQL to execute.
 * applyMigrations() checks schema_version and runs any missing migrations in order.
 * DB path: ~/.agentscope/history.db
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DB_DIR = path.join(os.homedir(), ".agentscope");
export const DB_PATH = path.join(DB_DIR, "history.db");

export function ensureDbDir(): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  project_path TEXT NOT NULL DEFAULT '',
  root_agent_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  name TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  subagent_type TEXT,
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT,
  first_seen_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_ms INTEGER NOT NULL DEFAULT 0,
  tool_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL DEFAULT '',
  input TEXT NOT NULL DEFAULT '{}',
  input_preview TEXT NOT NULL DEFAULT '',
  started_ms INTEGER NOT NULL DEFAULT 0,
  ended_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  output_preview TEXT,
  response TEXT,
  duration_ms INTEGER,
  retry_of TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  hook_event TEXT NOT NULL,
  agent_id TEXT,
  tool_name TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, session_id)
);

CREATE TABLE IF NOT EXISTS agent_baselines (
  agent_type TEXT PRIMARY KEY,
  mean_duration REAL NOT NULL DEFAULT 0,
  mean_tool_count REAL NOT NULL DEFAULT 0,
  mean_cost REAL NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  stddev_duration REAL NOT NULL DEFAULT 0,
  stddev_tool_count REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  tool_sequence_common TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(subagent_type);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    `.trim(),
  },
  {
    version: 2,
    // ALTER TABLE is not idempotent in SQLite; each statement is wrapped in
    // try/catch inside applyMigrations so duplicate-column errors are ignored.
    sql: `ALTER TABLE agents ADD COLUMN prompt_hash TEXT;
ALTER TABLE agents ADD COLUMN anomaly_score REAL;`,
  },
  {
    version: 3,
    sql: `ALTER TABLE agent_baselines ADD COLUMN tool_sequence_common TEXT;`,
  },
];

/**
 * DB interface used by migrations — minimal subset needed here.
 * The full Database interface is in db.ts.
 */
export interface Migratable {
  exec(sql: string): void;
  prepare(sql: string): { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown };
}

export function applyMigrations(db: Migratable): void {
  // Ensure schema_version table exists so we can read from it
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  for (const migration of MIGRATIONS) {
    const existing = db
      .prepare("SELECT version FROM schema_version WHERE version = ?")
      .get(migration.version);

    if (!existing) {
      if (migration.version === 2 || migration.version === 3) {
        // ALTER TABLE migrations: errors if column already exists.
        // Run each statement individually, ignoring duplicate-column errors.
        for (const stmt of migration.sql.split(";")) {
          const trimmed = stmt.trim();
          if (!trimmed) continue;
          try {
            db.exec(trimmed);
          } catch (err) {
            // Ignore "duplicate column name" errors — column already exists
            const msg = String(err);
            if (!msg.includes("duplicate column name")) {
              throw err;
            }
          }
        }
      } else {
        db.exec(migration.sql);
      }
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        Date.now()
      );
    }
  }
}
