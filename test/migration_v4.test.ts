/**
 * Migration v4 — verify VACUUM INTO copy of a legacy ~/.agentscope/history.db
 * into the new Tarsa DB path runs once and only when no new DB exists.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { migrateLegacyDbIfPresent } from "../src/migrations.js";

let tmpDir: string;
let legacyPath: string;
let newPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsa-mig4-"));
  legacyPath = path.join(tmpDir, "agentscope", "history.db");
  newPath = path.join(tmpDir, "tarsa", "history.db");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedLegacy(): void {
  const db = new BetterSqlite3(legacyPath);
  db.exec("CREATE TABLE marker (id INTEGER PRIMARY KEY, note TEXT)");
  db.prepare("INSERT INTO marker (id, note) VALUES (1, 'legacy-row')").run();
  db.close();
}

describe("migrateLegacyDbIfPresent", () => {
  it("copies legacy DB into new path via VACUUM INTO", async () => {
    seedLegacy();
    expect(fs.existsSync(newPath)).toBe(false);

    const logs: string[] = [];
    const copied = await migrateLegacyDbIfPresent({ legacyPath, newPath, log: (m) => logs.push(m) });

    expect(copied).toBe(true);
    expect(fs.existsSync(newPath)).toBe(true);

    // The carried-over row should be queryable
    const db = new BetterSqlite3(newPath);
    const row = db.prepare("SELECT note FROM marker WHERE id = 1").get() as { note: string };
    expect(row.note).toBe("legacy-row");
    db.close();

    expect(logs.some((m) => m.includes("Legacy DB"))).toBe(true);
  });

  it("does not copy when the new DB already exists", async () => {
    seedLegacy();
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, "");

    const copied = await migrateLegacyDbIfPresent({ legacyPath, newPath, log: () => {} });
    expect(copied).toBe(false);
  });

  it("returns false when the legacy DB does not exist", async () => {
    const copied = await migrateLegacyDbIfPresent({ legacyPath, newPath, log: () => {} });
    expect(copied).toBe(false);
    expect(fs.existsSync(newPath)).toBe(false);
  });
});
