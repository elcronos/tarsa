/**
 * Tests for the JSONL tailer: line delivery, truncation, rotation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tailJsonl } from "../src/tailer.js";

let tmpDir: string;
let tmpFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsa-tailer-"));
  tmpFile = path.join(tmpDir, "test.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLine(filePath: string, obj: Record<string, unknown>): void {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

describe("tailJsonl", () => {
  it("delivers lines written after tailer starts", async () => {
    const received: Record<string, unknown>[] = [];
    const controller = new AbortController();

    // Create the file first (so tailer opens at EOF)
    fs.writeFileSync(tmpFile, "", "utf8");

    const tailPromise = tailJsonl((e) => received.push(e), tmpFile, controller.signal);

    // Give tailer time to open the file
    await waitMs(150);

    appendLine(tmpFile, { event: "A", ts: 1 });
    appendLine(tmpFile, { event: "B", ts: 2 });

    // Wait for delivery
    await waitMs(300);

    controller.abort();
    await tailPromise.catch(() => null);

    expect(received.length).toBe(2);
    expect(received[0]?.["event"]).toBe("A");
    expect(received[1]?.["event"]).toBe("B");
  });

  it("handles file not existing at start — waits and delivers once created", async () => {
    const received: Record<string, unknown>[] = [];
    const controller = new AbortController();

    // Start tailer BEFORE file exists
    const tailPromise = tailJsonl((e) => received.push(e), tmpFile, controller.signal);

    await waitMs(200);

    // Create file and append a line
    fs.writeFileSync(tmpFile, JSON.stringify({ event: "late" }) + "\n", "utf8");

    await waitMs(300);

    controller.abort();
    await tailPromise.catch(() => null);

    // Tailer reads from offset 0, so it should see the line written at creation
    expect(received.length).toBe(1);
    expect(received[0]?.["event"]).toBe("late");
  });

  it("handles truncation — rewinds to 0 and continues reading", async () => {
    const received: Record<string, unknown>[] = [];
    const controller = new AbortController();

    fs.writeFileSync(tmpFile, "", "utf8");
    const tailPromise = tailJsonl((e) => received.push(e), tmpFile, controller.signal);

    await waitMs(150);

    // Write line, let tailer consume it
    appendLine(tmpFile, { event: "before-truncate" });
    await waitMs(200);

    // Truncate
    fs.writeFileSync(tmpFile, "", "utf8");
    await waitMs(200);

    // Write new line after truncate
    appendLine(tmpFile, { event: "after-truncate" });
    await waitMs(300);

    controller.abort();
    await tailPromise.catch(() => null);

    const events = received.map((r) => r["event"]);
    expect(events).toContain("before-truncate");
    expect(events).toContain("after-truncate");
  });

  it("skips malformed JSON lines silently", async () => {
    const received: Record<string, unknown>[] = [];
    const controller = new AbortController();

    fs.writeFileSync(tmpFile, "", "utf8");
    const tailPromise = tailJsonl((e) => received.push(e), tmpFile, controller.signal);

    await waitMs(150);

    fs.appendFileSync(tmpFile, "not valid json\n", "utf8");
    appendLine(tmpFile, { event: "valid" });

    await waitMs(300);

    controller.abort();
    await tailPromise.catch(() => null);

    // Only the valid JSON line should be received
    expect(received.length).toBe(1);
    expect(received[0]?.["event"]).toBe("valid");
  });

  it("handles file rotation (inode change) — reopens and continues", async () => {
    const received: Record<string, unknown>[] = [];
    const controller = new AbortController();

    fs.writeFileSync(tmpFile, "", "utf8");
    const tailPromise = tailJsonl((e) => received.push(e), tmpFile, controller.signal);

    await waitMs(150);

    // Rotate: unlink + create new file
    fs.unlinkSync(tmpFile);
    fs.writeFileSync(tmpFile, "", "utf8");

    await waitMs(300);

    // Write to new file
    appendLine(tmpFile, { event: "after-rotation" });

    await waitMs(300);

    controller.abort();
    await tailPromise.catch(() => null);

    const events = received.map((r) => r["event"]);
    expect(events).toContain("after-rotation");
  });
});
