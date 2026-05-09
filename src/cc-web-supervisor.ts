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
import path from "node:path";
import crypto from "node:crypto";
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
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("node:fs");
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export class CcWebSupervisor {
  private child: ChildProcess | null = null;
  private info: CcWebInfo;

  constructor(opts: SupervisorOptions = {}) {
    this.info = {
      enabled: opts.enabled ?? true,
      port: opts.port ?? DEFAULT_PORT,
      token: crypto.randomBytes(16).toString("hex"),
    };
  }

  /** Start the cc-web child process. Idempotent. */
  start(): void {
    if (!this.info.enabled || this.child) return;

    const bin = findCcWebBin();
    if (!bin) {
      process.stderr.write(
        "[tarsa] cc-web not found at vendor/cc-web — embedded terminal disabled\n"
      );
      this.info.enabled = false;
      return;
    }

    const args = [
      bin,
      "--port",
      String(this.info.port),
      "--auth",
      this.info.token,
      "--no-open",
    ];

    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
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

  stop(): void {
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
