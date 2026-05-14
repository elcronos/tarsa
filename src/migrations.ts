/**
 * Schema migrations for Tarsa SQLite database.
 *
 * Each migration has a version number and SQL to execute.
 * applyMigrations() checks schema_version and runs any missing migrations in order.
 * DB path: ~/.tarsa/history.db
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DB_DIR = path.join(os.homedir(), ".tarsa");
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
  {
    // v4 reserved for legacy DB migration (handled via VACUUM INTO BEFORE
    // applyMigrations runs — see migrateLegacyDbIfPresent). This row exists
    // only so the schema_version table records the upgrade.
    version: 4,
    sql: `-- legacy DB copy handled out-of-band; no schema change`,
  },
  {
    // v5: cwd grouping + iterations table + budget cols. Single transaction
    // so partial application can't leave the DB in an inconsistent state.
    version: 5,
    sql: `BEGIN;
ALTER TABLE sessions ADD COLUMN cwd TEXT;
CREATE TABLE iterations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  tool_count INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  confidence REAL NOT NULL,
  marker_source TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, n)
);
ALTER TABLE sessions ADD COLUMN budget_usd REAL;
ALTER TABLE sessions ADD COLUMN kill_on_exceed INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS iterations_session_idx ON iterations(session_id, n);
COMMIT;`,
  },
  {
    // v6: git context columns on sessions table + index on event git_commit.
    version: 6,
    sql: `ALTER TABLE sessions ADD COLUMN git_commit TEXT;
ALTER TABLE sessions ADD COLUMN git_branch TEXT;
ALTER TABLE sessions ADD COLUMN git_dirty INTEGER;
CREATE INDEX IF NOT EXISTS idx_events_git_commit ON events(json_extract(payload, '$.git_commit'));`,
  },
];

/**
 * Copy a legacy AgentScope DB at ~/.agentscope/history.db into the Tarsa
 * DB path via SQLite VACUUM INTO if the new DB does not yet exist.
 *
 * VACUUM INTO does not support parameter binding for the destination filename,
 * so the path is interpolated with single-quote escaping. Safe because the
 * path is internally constructed (not user input).
 *
 * Called BEFORE applyMigrations so the copied schema_version is honored.
 * Returns true if a copy occurred.
 */
export interface LegacyMigrateOpts {
  /** Override legacy path (testing only). Defaults to ~/.agentscope/history.db */
  legacyPath?: string;
  /** Override new path (testing only). Defaults to ~/.tarsa/history.db */
  newPath?: string;
  /** Logger for the user-facing notice. Defaults to stderr. */
  log?: (msg: string) => void;
}

export async function migrateLegacyDbIfPresent(opts: LegacyMigrateOpts = {}): Promise<boolean> {
  const legacyPath = opts.legacyPath ?? path.join(os.homedir(), ".agentscope", "history.db");
  const newPath = opts.newPath ?? DB_PATH;
  const log = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));

  if (!fs.existsSync(legacyPath) || fs.existsSync(newPath)) return false;

  // Open legacy DB read-only and VACUUM INTO new path. We don't know the
  // runtime here; resolve the binding lazily via a sync require dance is
  // fragile, so we accept either bun:sqlite via globalThis.Bun or
  // better-sqlite3. Caller may also pre-attach a custom opener via opts.
  const escapedNewPath = newPath.replace(/'/g, "''");
  const sql = `VACUUM INTO '${escapedNewPath}'`;

  // Ensure parent dir exists for the destination
  fs.mkdirSync(path.dirname(newPath), { recursive: true });

  try {
    const bunGlobal = globalThis as unknown as { Bun?: unknown };
    let openDb: (p: string) => { exec: (s: string) => void; close: () => void };
    if (bunGlobal.Bun) {
      const bunMod = (await import("bun:sqlite" as string)) as {
        Database: new (p: string, opts?: { readonly?: boolean }) => {
          exec: (s: string) => void;
          close: () => void;
        };
      };
      openDb = (p) => new bunMod.Database(p, { readonly: true });
    } else {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const BetterSqlite3 = req("better-sqlite3") as new (
        p: string,
        opts?: { readonly?: boolean }
      ) => { exec: (s: string) => void; close: () => void };
      openDb = (p) => new BetterSqlite3(p, { readonly: true });
    }

    const db = openDb(legacyPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  } catch (err) {
    log(`[tarsa] Legacy DB migration failed: ${String(err)}`);
    return false;
  }

  log(`[tarsa] Legacy DB at ${legacyPath} preserved. Delete with: rm -rf ${path.dirname(legacyPath)}`);
  return true;
}

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
      } else if (migration.version === 4) {
        // v4 is a marker-only row; legacy DB copy happens in
        // migrateLegacyDbIfPresent before applyMigrations runs.
      } else if (migration.version === 6) {
        // v6: ALTER TABLE + CREATE INDEX — tolerate duplicate column/index errors.
        for (const stmt of migration.sql.split(";")) {
          const trimmed = stmt.trim();
          if (!trimmed) continue;
          try {
            db.exec(trimmed);
          } catch (err) {
            const msg = String(err);
            if (msg.includes("duplicate column name")) continue;
            if (msg.includes("already exists")) continue;
            throw err;
          }
        }
      } else if (migration.version === 5) {
        // v5 mixes ALTER TABLE + CREATE TABLE inside a transaction. If the
        // db was carried over from a partially upgraded install, individual
        // statements may already exist; tolerate "duplicate column" and
        // "table ... already exists" while still failing other errors.
        for (const stmt of migration.sql.split(";")) {
          const trimmed = stmt.trim();
          if (!trimmed) continue;
          if (/^begin$/i.test(trimmed) || /^commit$/i.test(trimmed)) {
            try { db.exec(trimmed); } catch { /* allow nested */ }
            continue;
          }
          try {
            db.exec(trimmed);
          } catch (err) {
            const msg = String(err);
            if (msg.includes("duplicate column name")) continue;
            if (msg.includes("already exists")) continue;
            // Roll back transaction on real failure
            try { db.exec("ROLLBACK"); } catch { /* ignore */ }
            throw err;
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
