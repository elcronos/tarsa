/**
 * Migration v5 — verify schema changes apply atomically and are idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { applyMigrations, type Migratable } from "../src/migrations.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudelens-mig5-"));
  dbPath = path.join(tmpDir, "history.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function open(): InstanceType<typeof BetterSqlite3> {
  return new BetterSqlite3(dbPath);
}

describe("migration v5", () => {
  it("creates iterations table and adds cwd / budget cols on a fresh DB", () => {
    const db = open();
    applyMigrations(db as unknown as Migratable);

    // schema_version should include 1..5
    const rows = db.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>;
    const versions = rows.map((r) => r.version);
    expect(versions).toContain(5);

    // iterations table exists with the right columns
    const cols = db.prepare("PRAGMA table_info(iterations)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        "id",
        "session_id",
        "n",
        "started_at",
        "ended_at",
        "tool_count",
        "cost_usd",
        "confidence",
        "marker_source",
      ])
    );

    // sessions table has new cwd/budget cols
    const sessCols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(sessCols).toEqual(expect.arrayContaining(["cwd", "budget_usd", "kill_on_exceed"]));

    db.close();
  });

  it("is idempotent — re-running migrations does nothing", () => {
    const db = open();
    applyMigrations(db as unknown as Migratable);
    const before = db.prepare("SELECT COUNT(*) AS c FROM schema_version").get() as { c: number };

    // Re-run: must be no-op
    applyMigrations(db as unknown as Migratable);
    const after = db.prepare("SELECT COUNT(*) AS c FROM schema_version").get() as { c: number };

    expect(after.c).toBe(before.c);
    db.close();
  });

  it("UNIQUE(session_id, n) prevents duplicate iteration rows", () => {
    const db = open();
    applyMigrations(db as unknown as Migratable);

    db.prepare(
      `INSERT INTO sessions (id, started_at, root_agent_id, project_path, status)
       VALUES ('s1', 100, 'root:s1', '', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO iterations (session_id, n, started_at, confidence, marker_source)
       VALUES ('s1', 1, 200, 0.9, 'regex')`
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO iterations (session_id, n, started_at, confidence, marker_source)
           VALUES ('s1', 1, 300, 0.9, 'regex')`
        )
        .run()
    ).toThrow();
    db.close();
  });
});
