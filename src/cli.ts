/**
 * ClaudeLens CLI entry point.
 *
 * Phase B: installs hooks + starts DB + starts tailer + starts server + opens browser.
 *
 * Usage:
 *   claudelens                   # install hooks + start server + open browser
 *   claudelens --install-hooks   # install hooks only, then exit
 *   claudelens --uninstall       # remove claudelens hooks, then exit
 *   claudelens --port 8100       # server port (default 8100)
 *   claudelens --no-browser      # skip browser open
 */

import { installHooks, uninstallHooks, upgradeHooks, JSONL_PATH } from "./hooks.js";
import { migrateLegacyDbIfPresent } from "./migrations.js";
import { cwdFromTranscriptPath } from "./transcript.js";
import { tailJsonl } from "./tailer.js";
import { EventProcessor } from "./processor.js";
import { detectRuntime, isBun } from "./runtime.js";
import { openDatabase, setDb } from "./db.js";
import { startServer } from "./server.js";
import { seedFromDatabase } from "./search.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Ensure ~/.claudelens/ exists (mode 0700) and events.jsonl is created with
 * mode 0600. Also performs a one-time migration from /tmp/claudelens.jsonl if
 * that legacy file exists and the new path does not yet.
 */
function ensureJsonlPath(): void {
  const dir = path.dirname(JSONL_PATH);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // One-time migration from /tmp/claudelens.jsonl
  const legacyPath = "/tmp/claudelens.jsonl";
  if (fs.existsSync(legacyPath) && !fs.existsSync(JSONL_PATH)) {
    try {
      fs.copyFileSync(legacyPath, JSONL_PATH);
      fs.chmodSync(JSONL_PATH, 0o600);
      process.stderr.write(
        `[claudelens] Migrated events from ${legacyPath} to ${JSONL_PATH}. ` +
        `You can delete the old file with: rm ${legacyPath}\n`
      );
    } catch {
      // Non-fatal; continue with fresh file
    }
  }

  // Ensure file exists with mode 0600
  if (!fs.existsSync(JSONL_PATH)) {
    const fd = fs.openSync(JSONL_PATH, "a", 0o600);
    fs.closeSync(fd);
  }
}

function parseArgs(argv: string[]): {
  installOnly: boolean;
  upgradeHooks: boolean;
  uninstall: boolean;
  port: number;
  noBrowser: boolean;
  enableIterationDetection: boolean;
} {
  const args = argv.slice(2);
  // Iteration detection defaults ON; explicit --no-iteration-detection disables.
  const explicitDisable = args.includes("--no-iteration-detection");
  const explicitEnable = args.includes("--enable-iteration-detection");
  return {
    installOnly: args.includes("--install-hooks"),
    upgradeHooks: args.includes("--upgrade-hooks"),
    uninstall: args.includes("--uninstall"),
    port: (() => {
      const idx = args.indexOf("--port");
      return idx !== -1 ? parseInt(args[idx + 1] ?? "8100", 10) : 8100;
    })(),
    noBrowser: args.includes("--no-browser"),
    enableIterationDetection: explicitEnable || !explicitDisable,
  };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "linux") {
    cmd = "xdg-open";
    args = [url];
  } else {
    cmd = "cmd";
    args = ["/c", "start", url];
  }

  if (isBun()) {
    const bunGlobal = globalThis as unknown as {
      Bun: { spawn: (cmd: string[]) => void };
    };
    try {
      bunGlobal.Bun.spawn([cmd, ...args]);
    } catch {
      // ignore
    }
  } else {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  }
}

/**
 * Read JSON from stdin, enrich with hook_event + ts, append atomically to JSONL.
 * Uses a single fs.writeSync call against an O_APPEND file descriptor so kernel
 * guarantees offset-correct atomic appends across concurrent invocations.
 */
async function appendEvent(eventName: string): Promise<void> {
  ensureJsonlPath();
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  payload["hook_event"] = eventName;
  payload["ts"] = Date.now();
  // Critic fix #5 / P5: read RALPH_ACTIVE at write time so the reducer can
  // stay pure (no env access in shared/replay-core.ts). Empty string when
  // unset — reducer treats only "1" as positive.
  payload["ralph_active"] = process.env["RALPH_ACTIVE"] ?? "";
  const line = JSON.stringify(payload) + "\n";
  const fd = fs.openSync(JSONL_PATH, "a", 0o600);
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

async function main(): Promise<void> {
  // Fast-path: --append-event reads stdin and writes one line, then exits.
  // Used by hook commands installed in ~/.claude/settings.json.
  const appendIdx = process.argv.indexOf("--append-event");
  if (appendIdx !== -1) {
    const name = process.argv[appendIdx + 1] ?? "Unknown";
    await appendEvent(name);
    process.exit(0);
  }

  const opts = parseArgs(process.argv);

  if (opts.uninstall) {
    const changed = uninstallHooks();
    if (changed) {
      console.log("[claudelens] Hooks removed from ~/.claude/settings.json");
    } else {
      console.log("[claudelens] No ClaudeLens hooks found to remove.");
    }
    process.exit(0);
  }

  if (opts.upgradeHooks) {
    const added = upgradeHooks();
    if (added.length > 0) {
      console.log(`[claudelens] Upgraded hooks; added: ${added.join(", ")}`);
    } else {
      console.log("[claudelens] Hooks already up to date.");
    }
    process.exit(0);
  }

  // Always install hooks (idempotent, additive — adds any newly-required events)
  const changed = installHooks();
  if (changed) {
    console.log("[claudelens] Hooks installed into ~/.claude/settings.json");
  } else {
    console.log("[claudelens] Hooks already installed.");
  }

  if (opts.installOnly) {
    process.exit(0);
  }

  // Migrate legacy AgentScope DB if present (no-op if new DB already exists).
  // Must run BEFORE openDatabase so applyMigrations sees the carried-over rows.
  try {
    await migrateLegacyDbIfPresent();
  } catch (err) {
    process.stderr.write(`[claudelens] legacy DB migration skipped: ${String(err)}\n`);
  }

  const runtime = detectRuntime();
  console.log(`[claudelens] Runtime: ${runtime}`);

  // Open database
  const db = await openDatabase();
  setDb(db);
  console.log("[claudelens] Database ready.");

  // One-time cwd backfill for sessions persisted before v5. For each session
  // missing cwd, scan its events for any agent transcript_path and derive cwd
  // from the encoded directory name. Bounded — runs once per startup.
  try {
    const missing = db.listSessionsMissingCwd();
    let backfilled = 0;
    for (const sid of missing) {
      const events = db.queryEvents(sid, 200);
      for (const ev of events) {
        const tp = typeof ev["transcript_path"] === "string"
          ? (ev["transcript_path"] as string)
          : null;
        if (!tp) continue;
        const cwd = cwdFromTranscriptPath(tp);
        if (cwd) {
          db.setSessionCwd(sid, cwd);
          backfilled++;
          break;
        }
      }
    }
    if (backfilled > 0) {
      console.log(`[claudelens] Backfilled cwd for ${backfilled} session(s)`);
    }
  } catch (err) {
    process.stderr.write(`[claudelens] cwd backfill skipped: ${String(err)}\n`);
  }

  // Tell processor whether to compute / persist iterations.
  if (!opts.enableIterationDetection) {
    process.env["CLAUDELENS_ITERATION_DETECTION"] = "0";
  }

  // Seed search index from persisted events
  const seeded = seedFromDatabase(db, 10000);
  console.log(`[claudelens] search index seeded ${seeded} events`);

  // Create processor (pass db so it can update baselines on session end)
  const processor = new EventProcessor(db);

  // Start HTTP server
  const server = await startServer({ port: opts.port, processor, db });
  const url = `http://localhost:${opts.port}`;
  console.log(`[claudelens] Server running at ${url}`);

  // Open browser after 1.5s delay
  if (!opts.noBrowser) {
    setTimeout(() => {
      openBrowser(url);
    }, 1500);
  }

  // Ensure JSONL dir/file exists before tailing
  ensureJsonlPath();
  console.log(`[claudelens] Tailing ${JSONL_PATH} ...`);

  const controller = new AbortController();

  process.on("SIGINT", () => {
    console.log("\n[claudelens] Shutting down...");
    processor.stopIdleCheck();
    controller.abort();
    server.close();
    db.close();
    process.exit(0);
  });

  await tailJsonl(
    (raw) => processor.ingest(raw),
    JSONL_PATH,
    controller.signal
  );
}

main().catch((err) => {
  console.error("[claudelens] Fatal:", err);
  process.exit(1);
});
