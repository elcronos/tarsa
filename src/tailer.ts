/**
 * Async JSONL file tailer with adaptive poll and rotation/truncation handling.
 *
 * Adaptive poll:
 *   - 100ms during activity (new data within last 5s)
 *   - 1000ms after 5s idle (no new data)
 *
 * Handles:
 *   - File not existing: waits/polls until it appears
 *   - Truncation (size < last position): resets offset to 0
 *   - Inode change (rotation/replace): reopens file
 */

import fs from "node:fs";
import readline from "node:readline";

import os from "node:os";
export const JSONL_PATH = `${os.homedir()}/.tarsa/events.jsonl`;

const ACTIVE_POLL_MS = 100;
const IDLE_POLL_MS = 1000;
const IDLE_THRESHOLD_MS = 5_000;

export type EventCallback = (event: Record<string, unknown>) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FileState {
  fd: number;
  inode: number;
  offset: number;
}

function tryOpenFile(filePath: string): FileState | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    return { fd, inode: stat.ino, offset: 0 };
  } catch {
    return null;
  }
}

function tryStatFile(filePath: string): { ino: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return { ino: stat.ino, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * Read all complete lines from the current file position.
 * Returns [lines, newOffset].
 */
function readNewLines(fd: number, offset: number): [string[], number] {
  const CHUNK = 65536;
  const chunks: Buffer[] = [];
  let pos = offset;

  while (true) {
    const buf = Buffer.allocUnsafe(CHUNK);
    const bytesRead = fs.readSync(fd, buf, 0, CHUNK, pos);
    if (bytesRead === 0) break;
    chunks.push(buf.subarray(0, bytesRead));
    pos += bytesRead;
    if (bytesRead < CHUNK) break;
  }

  if (chunks.length === 0) return [[], offset];

  const text = Buffer.concat(chunks).toString("utf8");
  const allLines = text.split("\n");

  // Last element may be incomplete — keep it for next read by not advancing past it
  const completeLines = allLines.slice(0, -1);
  const lastPartial = allLines[allLines.length - 1] ?? "";
  const consumedBytes = Buffer.byteLength(
    completeLines.join("\n") + (completeLines.length > 0 ? "\n" : ""),
    "utf8"
  );

  void lastPartial; // partial line stays in file, we don't need to track it separately
  return [completeLines.filter((l) => l.trim().length > 0), offset + consumedBytes];
}

/**
 * Tail a JSONL file, calling callback for each parsed JSON line.
 * Runs indefinitely until the abort signal fires.
 */
export async function tailJsonl(
  callback: EventCallback,
  filePath: string = JSONL_PATH,
  signal?: AbortSignal
): Promise<void> {
  let fileState: FileState | null = null;
  let lastActivityMs = Date.now();

  // Open at offset 0 so existing JSONL events are processed
  const initialStat = tryStatFile(filePath);
  if (initialStat) {
    const state = tryOpenFile(filePath);
    if (state) {
      fileState = state;
    }
  }

  while (!signal?.aborted) {
    // Determine poll interval based on activity
    const idleMs = Date.now() - lastActivityMs;
    const pollMs = idleMs < IDLE_THRESHOLD_MS ? ACTIVE_POLL_MS : IDLE_POLL_MS;

    // If file not open, try to open it
    if (!fileState) {
      fileState = tryOpenFile(filePath);
      if (!fileState) {
        await sleep(pollMs);
        continue;
      }
    }

    // Check for inode change (rotation) or truncation
    const stat = tryStatFile(filePath);
    if (!stat) {
      // File disappeared
      fs.closeSync(fileState.fd);
      fileState = null;
      await sleep(pollMs);
      continue;
    }

    if (stat.ino !== fileState.inode) {
      // File rotated — reopen
      fs.closeSync(fileState.fd);
      const newState = tryOpenFile(filePath);
      if (!newState) {
        fileState = null;
        await sleep(pollMs);
        continue;
      }
      fileState = newState;
      process.stderr.write(`[tarsa] tailer: file rotated, reopened ${filePath}\n`);
    } else if (stat.size < fileState.offset) {
      // File truncated — reset offset
      fileState.offset = 0;
      process.stderr.write(`[tarsa] tailer: file truncated, rewound ${filePath}\n`);
    }

    // Read new lines
    const [lines, newOffset] = readNewLines(fileState.fd, fileState.offset);
    if (lines.length > 0) {
      fileState.offset = newOffset;
      lastActivityMs = Date.now();

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          callback(parsed);
        } catch {
          process.stderr.write(`[tarsa] tailer: bad JSON: ${line.slice(0, 80)}\n`);
        }
      }
    } else {
      await sleep(pollMs);
    }
  }

  if (fileState) {
    fs.closeSync(fileState.fd);
  }
}
