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

import { installHooks, uninstallHooks, JSONL_PATH } from "./hooks.js";
import { tailJsonl } from "./tailer.js";
import { EventProcessor } from "./processor.js";
import { detectRuntime, isBun } from "./runtime.js";
import { openDatabase, setDb } from "./db.js";
import { startServer } from "./server.js";
import { seedFromDatabase } from "./search.js";
import { spawn } from "node:child_process";
import fs from "node:fs";

function parseArgs(argv: string[]): {
  installOnly: boolean;
  uninstall: boolean;
  port: number;
  noBrowser: boolean;
} {
  const args = argv.slice(2);
  return {
    installOnly: args.includes("--install-hooks"),
    uninstall: args.includes("--uninstall"),
    port: (() => {
      const idx = args.indexOf("--port");
      return idx !== -1 ? parseInt(args[idx + 1] ?? "8100", 10) : 8100;
    })(),
    noBrowser: args.includes("--no-browser"),
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
  const line = JSON.stringify(payload) + "\n";
  const fd = fs.openSync(JSONL_PATH, "a");
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

  // Always install hooks (idempotent)
  const changed = installHooks();
  if (changed) {
    console.log("[claudelens] Hooks installed into ~/.claude/settings.json");
  } else {
    console.log("[claudelens] Hooks already installed.");
  }

  if (opts.installOnly) {
    process.exit(0);
  }

  const runtime = detectRuntime();
  console.log(`[claudelens] Runtime: ${runtime}`);

  // Open database
  const db = await openDatabase();
  setDb(db);
  console.log("[claudelens] Database ready.");

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

  // Start tailing JSONL
  console.log("[claudelens] Tailing /tmp/claudelens.jsonl ...");

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
    "/tmp/claudelens.jsonl",
    controller.signal
  );
}

main().catch((err) => {
  console.error("[claudelens] Fatal:", err);
  process.exit(1);
});
