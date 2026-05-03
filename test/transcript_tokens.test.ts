/**
 * Tests for readAgentTokens in transcript.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// We need to test readAgentTokens which reads from ~/.claude/projects/...
// We'll create a temp directory structure mimicking Claude Code's layout.

let tempDir: string;
let projectsDir: string;
let projectDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudelens-transcript-test-"));
  projectsDir = path.join(tempDir, ".claude", "projects");
  projectDir = path.join(projectsDir, "-Users-test-project");
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Helper: write a mock transcript file
function writeTranscript(sessionId: string, lines: object[]): string {
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

// We need to patch the homedir so the module finds our temp dir.
// Use dynamic import after patching os.homedir.
async function importWithHome(homeDir: string) {
  // Patch os.homedir for the duration
  const original = os.homedir;
  Object.defineProperty(os, "homedir", { value: () => homeDir, configurable: true });
  try {
    // Force re-evaluation by bypassing module cache via a thin wrapper
    const mod = await import("../src/transcript.js");
    return mod;
  } finally {
    Object.defineProperty(os, "homedir", { value: original, configurable: true });
  }
}

describe("readAgentTokens", () => {
  it("returns zero usage when transcript not found", async () => {
    const mod = await import("../src/transcript.js");
    const result = mod.readAgentTokens("nonexistent-session-id-xyz");
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.cache_read).toBe(0);
    expect(result.cache_creation).toBe(0);
  });

  it("sums usage from assistant messages", async () => {
    const sessionId = "test-session-tokens-001";
    writeTranscript(sessionId, [
      {
        role: "user",
        content: "hello",
      },
      {
        role: "assistant",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
          },
        },
      },
      {
        role: "assistant",
        message: {
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    // Point the module to our temp home directory
    const origHomedir = os.homedir;
    (os as unknown as { homedir: () => string }).homedir = () => tempDir;
    try {
      const mod = await import("../src/transcript.js");
      const result = mod.readAgentTokens(sessionId);
      expect(result.input_tokens).toBe(300);
      expect(result.output_tokens).toBe(130);
      expect(result.cache_read).toBe(30);
      expect(result.cache_creation).toBe(5);
    } finally {
      (os as unknown as { homedir: () => string }).homedir = origHomedir;
    }
  });

  it("filters by agentId when provided", async () => {
    const sessionId = "test-session-tokens-002";
    writeTranscript(sessionId, [
      {
        role: "assistant",
        agentId: "agent-abc",
        message: {
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        role: "assistant",
        agentId: "agent-xyz",
        message: {
          usage: {
            input_tokens: 300,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        role: "assistant",
        // no agentId — belongs to session total but not any specific agent
        message: {
          usage: {
            input_tokens: 50,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ]);

    const origHomedir = os.homedir;
    (os as unknown as { homedir: () => string }).homedir = () => tempDir;
    try {
      const mod = await import("../src/transcript.js");
      // Session total includes all messages
      const total = mod.readAgentTokens(sessionId);
      expect(total.input_tokens).toBe(1350);
      expect(total.output_tokens).toBe(620);

      // Per-agent: only agent-abc entries
      const agentResult = mod.readAgentTokens(sessionId, "agent-abc");
      expect(agentResult.input_tokens).toBe(1000);
      expect(agentResult.output_tokens).toBe(500);

      // Unknown agent returns zeros
      const unknown = mod.readAgentTokens(sessionId, "agent-unknown");
      expect(unknown.input_tokens).toBe(0);
    } finally {
      (os as unknown as { homedir: () => string }).homedir = origHomedir;
    }
  });

  it("rejects sessionId with path traversal characters", async () => {
    const mod = await import("../src/transcript.js");
    const result = mod.readAgentTokens("../etc/passwd");
    expect(result.input_tokens).toBe(0);
  });
});
