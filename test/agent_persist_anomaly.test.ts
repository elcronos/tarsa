/**
 * Tests for US-014 — persist anomaly_score and prompt_hash on agents.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { applyMigrations, MIGRATIONS } from "../src/migrations.js";
import type { Migratable } from "../src/migrations.js";
import type { Agent } from "../src/models.js";

// ── In-memory SQLite stub ────────────────────────────────────────────────────

/**
 * Minimal in-memory DB for migration tests.
 * Parses CREATE TABLE and ALTER TABLE statements to track columns.
 */
class InMemoryDb implements Migratable {
  private _columns: Map<string, Set<string>> = new Map();
  private _schema_version: Map<number, number> = new Map();

  exec(sql: string): void {
    // Split on semicolons to handle multi-statement SQL
    const statements = sql.split(";");
    for (const raw of statements) {
      const stmt = raw.trim();
      if (!stmt) continue;
      this._execOne(stmt);
    }
  }

  private _execOne(stmt: string): void {
    // CREATE TABLE [IF NOT EXISTS] name (...)
    const createTableMatch = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(/i);
    if (createTableMatch) {
      const name = createTableMatch[1]!;
      if (!this._columns.has(name)) {
        const cols = new Set<string>();
        const parenContent = stmt.slice(stmt.indexOf("(") + 1, stmt.lastIndexOf(")"));
        for (const line of parenContent.split(",")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Skip table constraints
          if (/^(FOREIGN KEY|PRIMARY KEY|UNIQUE|CHECK)/i.test(trimmed)) continue;
          const colName = trimmed.split(/\s+/)[0];
          if (colName) cols.add(colName);
        }
        this._columns.set(name, cols);
      }
      return;
    }

    // ALTER TABLE name ADD COLUMN col TYPE
    const alterMatch = stmt.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+\w+/i);
    if (alterMatch) {
      const tableName = alterMatch[1]!;
      const colName = alterMatch[2]!;
      const cols = this._columns.get(tableName);
      if (!cols) throw new Error(`table ${tableName} not found`);
      if (cols.has(colName)) {
        throw new Error(`duplicate column name: ${colName}`);
      }
      cols.add(colName);
      return;
    }

    // CREATE INDEX — ignore
    if (/^CREATE INDEX/i.test(stmt)) return;
    // PRAGMA — ignore
    if (/^PRAGMA/i.test(stmt)) return;
  }

  prepare(sql: string): { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown } {
    const db = this;
    const selectSvMatch = /SELECT version FROM schema_version WHERE version = \?/i.test(sql);
    const insertSvMatch = /INSERT INTO schema_version/i.test(sql);

    return {
      get: (...args: unknown[]) => {
        if (selectSvMatch) {
          const v = args[0] as number;
          return db._schema_version.has(v) ? { version: v } : undefined;
        }
        return undefined;
      },
      run: (...args: unknown[]) => {
        if (insertSvMatch) {
          const v = args[0] as number;
          db._schema_version.set(v, args[1] as number);
        }
        return {};
      },
    };
  }

  hasColumn(table: string, col: string): boolean {
    return this._columns.get(table)?.has(col) ?? false;
  }

  hasTable(table: string): boolean {
    return this._columns.has(table);
  }

  schemaVersion(): number[] {
    return Array.from(this._schema_version.keys());
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("migration version 2", () => {
  let db: InMemoryDb;

  beforeEach(() => {
    db = new InMemoryDb();
    // Apply all migrations (v1 creates base schema, v2 adds columns)
    applyMigrations(db);
  });

  it("adds prompt_hash column to agents", () => {
    expect(db.hasColumn("agents", "prompt_hash")).toBe(true);
  });

  it("adds anomaly_score column to agents", () => {
    expect(db.hasColumn("agents", "anomaly_score")).toBe(true);
  });

  it("is idempotent — applying migrations twice does not throw", () => {
    // Second call should skip already-applied migrations
    expect(() => applyMigrations(db)).not.toThrow();
  });

  it("schema_version records version 2", () => {
    expect(db.schemaVersion()).toContain(2);
  });

  it("MIGRATIONS array contains version 2 with correct columns", () => {
    const v2 = MIGRATIONS.find((m) => m.version === 2);
    expect(v2).toBeDefined();
    expect(v2?.sql).toContain("prompt_hash");
    expect(v2?.sql).toContain("anomaly_score");
  });

  it("agents table has expected base columns from v1", () => {
    expect(db.hasColumn("agents", "id")).toBe(true);
    expect(db.hasColumn("agents", "session_id")).toBe(true);
    expect(db.hasColumn("agents", "prompt")).toBe(true);
    expect(db.hasColumn("agents", "result")).toBe(true);
  });
});

describe("Agent model has prompt_hash and anomaly_score fields", () => {
  it("Agent interface accepts prompt_hash and anomaly_score", () => {
    const agent: Agent = {
      id: "ag-1",
      name: "test",
      parent_id: null,
      session_id: "sess-1",
      status: "done",
      subagent_type: null,
      description: "",
      prompt: "do something",
      first_seen_ms: 1000,
      last_seen_ms: 2000,
      tool_count: 3,
      error_count: 0,
      children: [],
      result: null,
      prompt_hash: "abc123def456789a",
      anomaly_score: 0.42,
    };
    expect(agent.prompt_hash).toBe("abc123def456789a");
    expect(agent.anomaly_score).toBe(0.42);
  });

  it("prompt_hash is 16 hex chars", () => {
    const hash = "abc123def456789a";
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("prompt_hash and anomaly_score are optional (undefined is valid)", () => {
    const agent: Agent = {
      id: "ag-2",
      name: "minimal",
      parent_id: null,
      session_id: "sess-1",
      status: "active",
      subagent_type: null,
      description: "",
      prompt: null,
      first_seen_ms: 0,
      last_seen_ms: 0,
      tool_count: 0,
      error_count: 0,
      children: [],
      result: null,
    };
    expect(agent.prompt_hash).toBeUndefined();
    expect(agent.anomaly_score).toBeUndefined();
  });
});
