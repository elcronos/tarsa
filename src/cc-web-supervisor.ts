/**
 * cc-web supervisor — spawns the vendored claude-code-web server as a child
 * process so Tarsa can embed an in-browser terminal for any active CC session.
 *
 * Design choices:
 *   - Child process (not in-process import) keeps the CommonJS / ESM boundary
 *     clean and isolates node-pty crashes from the Tarsa server.
 *   - Auth token is generated once per Tarsa start and shared with cc-web via
 *     CLI flag, so the iframe URL Tarsa hands to the browser is the only way
 *     in. cc-web is bound to localhost only.
 *   - Lifecycle is tied to Tarsa: SIGINT in Tarsa shuts cc-web down too.
 *
 * The vendored copy lives at vendor/cc-web; see vendor/cc-web/TARSA-VENDOR.md
 * for license/attribution and re-vendoring instructions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CcWebInfo {
  enabled: boolean;
  port: number;
  token: string;
  /** Process id when running, undefined when child has exited. */
  pid?: number;
}

export interface SupervisorOptions {
  port?: number;
  /** Set to false to disable the embedded terminal entirely. */
  enabled?: boolean;
}

const DEFAULT_PORT = 8101;
const PORT_PROBE_ATTEMPTS = 20;
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 1_000;

/**
 * Resolve the vendored cc-web bin script. Walks up from this source file so
 * it works in both the dev (tsx) and built (dist) layouts.
 */
function findCcWebBin(): string | null {
  const candidates = [
    path.resolve(__dirname, "../vendor/cc-web/bin/cc-web.js"),
    path.resolve(__dirname, "../../vendor/cc-web/bin/cc-web.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** True if `port` can be bound (on all interfaces, matching cc-web's bind). */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

/** First free port at or after `start`, or null if none in the probe window. */
async function findFreePort(start: number): Promise<number | null> {
  for (let p = start; p < start + PORT_PROBE_ATTEMPTS; p++) {
    if (await portIsFree(p)) return p;
  }
  return null;
}

export class CcWebSupervisor {
  private child: ChildProcess | null = null;
  private info: CcWebInfo;
  private readonly basePort: number;
  private restarts = 0;
  private stopped = false;

  constructor(opts: SupervisorOptions = {}) {
    this.basePort = opts.port ?? DEFAULT_PORT;
    this.info = {
      enabled: opts.enabled ?? true,
      port: this.basePort,
      token: crypto.randomBytes(16).toString("hex"),
    };
  }

  /**
   * Start the cc-web child process. Idempotent.
   *
   * Probes for a free port first: a stale cc-web from a prior run (or anything
   * else on 8101) would otherwise crash the child with EADDRINUSE and leave the
   * embedded terminal permanently dead. Unexpected crashes are retried a few
   * times with backoff.
   */
  async start(): Promise<void> {
    if (!this.info.enabled || this.child) return;

    const bin = findCcWebBin();
    if (!bin) {
      process.stderr.write(
        "[tarsa] cc-web not found at vendor/cc-web — embedded terminal disabled\n"
      );
      this.info.enabled = false;
      return;
    }

    const freePort = await findFreePort(this.basePort);
    if (freePort == null) {
      process.stderr.write(
        `[tarsa] no free port near ${this.basePort} — embedded terminal disabled\n`
      );
      this.info.enabled = false;
      return;
    }
    if (freePort !== this.info.port) {
      process.stderr.write(
        `[tarsa] cc-web port ${this.info.port} busy, using ${freePort}\n`
      );
    }
    this.info.port = freePort;

    const args = [
      bin,
      "--port",
      String(this.info.port),
      "--auth",
      this.info.token,
      "--no-open",
    ];

    // Launch cc-web with cwd = $HOME so its baseFolder validation accepts
    // any project path under home. Without this, attempts to attach the
    // terminal to an agent's actual working directory get rejected as
    // "outside the allowed area".
    // cc-web depends on node-pty (native, ABI-locked to node). When Tarsa
    // runs under bun, process.execPath = bun and the child fails to load
    // node-pty. Honor TARSA_NODE_BIN if set, else fall back to "node" on
    // PATH, else process.execPath.
    const nodeBin = process.env["TARSA_NODE_BIN"]
      || (process.execPath.endsWith("/bun") || process.execPath.endsWith("/bun.exe") ? "node" : process.execPath);
    const child = spawn(nodeBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: os.homedir(),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    child.stdout?.on("data", (buf: Buffer) => {
      process.stderr.write(`[cc-web] ${buf.toString("utf8").trimEnd()}\n`);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      process.stderr.write(`[cc-web!] ${buf.toString("utf8").trimEnd()}\n`);
    });
    child.on("exit", (code, signal) => {
      process.stderr.write(
        `[tarsa] cc-web exited (code=${code} signal=${signal ?? "-"})\n`
      );
      this.child = null;
      this.info.pid = undefined;

      // Auto-restart on unexpected crash. stop() sets `stopped` so an
      // intentional shutdown doesn't trigger a respawn. Re-running start()
      // re-probes the port, so a transient conflict resolves itself.
      if (!this.stopped && code !== 0 && this.restarts < MAX_RESTARTS) {
        this.restarts++;
        process.stderr.write(
          `[tarsa] restarting cc-web (attempt ${this.restarts}/${MAX_RESTARTS})\n`
        );
        setTimeout(() => {
          void this.start();
        }, RESTART_BACKOFF_MS);
      } else if (!this.stopped && this.restarts >= MAX_RESTARTS) {
        process.stderr.write(
          "[tarsa] cc-web crashed repeatedly — embedded terminal disabled\n"
        );
        this.info.enabled = false;
      }
    });

    this.child = child;
    this.info.pid = child.pid;
    process.stderr.write(
      `[tarsa] cc-web started on port ${this.info.port} (pid=${child.pid})\n`
    );
  }

  /** Public info safe to expose to the Tarsa frontend. */
  getInfo(): CcWebInfo {
    return { ...this.info };
  }

  /**
   * Ask cc-web to create (or reuse) a terminal session bound to a working
   * directory. Returns the session id cc-web assigned. The Tarsa frontend
   * uses this so that opening an agent's Terminal tab drops the user into a
   * shell rooted at that agent's project, instead of vultuk's folder picker.
   */
  async createSession(
    workingDir: string,
    name?: string
  ): Promise<{ sessionId: string } | { error: string }> {
    if (!this.info.enabled || !this.child) {
      return { error: "cc-web is not running" };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${this.info.port}/api/sessions/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.info.token}`,
        },
        body: JSON.stringify({
          name: name ?? path.basename(workingDir) ?? "session",
          workingDir,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { error: `cc-web ${res.status}: ${text.slice(0, 200)}` };
      }
      const data = (await res.json()) as { sessionId?: string; id?: string };
      const sessionId = data.sessionId ?? data.id;
      if (!sessionId) return { error: "cc-web returned no sessionId" };
      return { sessionId };
    } catch (err) {
      return { error: String(err) };
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.child = null;
      this.info.pid = undefined;
    }
  }
}
