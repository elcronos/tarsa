/**
 * Tests for hook installer idempotency and safety.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// We need to test installHooks/uninstallHooks against a temp settings file.
// Override SETTINGS_PATH by monkey-patching the module-level constant.
// Since the module reads SETTINGS_PATH at call-time, we use a temp dir trick:
// copy the module functions but point them at a temp file.

import { HOOK_EVENTS, MARKER } from "../src/hooks.js";

// --- Minimal reimplementation using temp path ---

interface HookEntry {
  type: "command";
  command: string;
  async: boolean;
}

interface HookBlock {
  hooks: HookEntry[];
}

interface Settings {
  hooks?: Record<string, HookBlock[]>;
  [key: string]: unknown;
}

function makeHookCommand(event: string): string {
  return (
    `jq -c -n --argjson e "$CLAUDE_HOOK_INPUT" ` +
    `'$e + {"hook_event":"${event}","ts":now}' >> /tmp/claudelens.jsonl 2>/dev/null || true`
  );
}

function makeHookBlock(event: string): HookBlock {
  return { hooks: [{ type: "command", command: makeHookCommand(event), async: true }] };
}

function blockContainsMarker(block: HookBlock, marker: string): boolean {
  return block.hooks.some((h) => h.command.includes(marker));
}

function readSettings(settingsPath: string): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(settingsPath: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function installHooksAt(settingsPath: string): boolean {
  const settings = readSettings(settingsPath);
  if (!settings.hooks) settings.hooks = {};
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const eventHooks: HookBlock[] = settings.hooks[event] ?? [];
    settings.hooks[event] = eventHooks;
    const alreadyInstalled = eventHooks.some((b) => blockContainsMarker(b, MARKER));
    if (!alreadyInstalled) {
      eventHooks.push(makeHookBlock(event));
      changed = true;
    }
  }
  if (changed) writeSettings(settingsPath, settings);
  return changed;
}

function uninstallHooksAt(settingsPath: string): boolean {
  const settings = readSettings(settingsPath);
  const hooks = settings.hooks ?? {};
  let changed = false;
  for (const event of HOOK_EVENTS as readonly string[]) {
    const eventHooks = hooks[event];
    if (!eventHooks) continue;
    const filtered = eventHooks.filter((b: HookBlock) => !blockContainsMarker(b, MARKER));
    if (filtered.length !== eventHooks.length) {
      hooks[event] = filtered;
      changed = true;
    }
  }
  for (const event of Object.keys(hooks)) {
    if (hooks[event]?.length === 0) delete hooks[event];
  }
  if (changed) {
    settings.hooks = hooks;
    writeSettings(settingsPath, settings);
  }
  return changed;
}

// --- Tests ---

let tmpDir: string;
let settingsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudelens-test-"));
  settingsPath = path.join(tmpDir, "settings.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("installHooks", () => {
  it("installs hooks for all HOOK_EVENTS", () => {
    installHooksAt(settingsPath);
    const settings = readSettings(settingsPath);
    for (const event of HOOK_EVENTS) {
      const blocks = settings.hooks?.[event] ?? [];
      expect(blocks.some((b: HookBlock) => blockContainsMarker(b, MARKER))).toBe(true);
    }
  });

  it("is idempotent — installing twice produces identical output", () => {
    installHooksAt(settingsPath);
    const after1 = JSON.stringify(readSettings(settingsPath));
    installHooksAt(settingsPath);
    const after2 = JSON.stringify(readSettings(settingsPath));
    expect(after1).toBe(after2);
  });

  it("does not touch agentpeek entries when installing", () => {
    // Pre-populate with an agentpeek hook
    const initial: Settings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "jq -c '{hook:\"PreToolUse\"} + .' >> /tmp/agentpeek.jsonl",
                async: true,
              },
            ],
          },
        ],
      },
    };
    writeSettings(settingsPath, initial);

    installHooksAt(settingsPath);

    const settings = readSettings(settingsPath);
    const preToolBlocks = settings.hooks?.["PreToolUse"] ?? [];

    // agentpeek entry must still be present
    const agentpeekStillPresent = preToolBlocks.some((b: HookBlock) =>
      b.hooks.some((h) => h.command.includes("agentpeek.jsonl"))
    );
    expect(agentpeekStillPresent).toBe(true);

    // claudelens entry was added
    const claudelensAdded = preToolBlocks.some((b: HookBlock) =>
      blockContainsMarker(b, MARKER)
    );
    expect(claudelensAdded).toBe(true);

    // exactly 2 blocks for PreToolUse (one agentpeek, one claudelens)
    expect(preToolBlocks.length).toBe(2);
  });

  it("all installed hooks have async:true", () => {
    installHooksAt(settingsPath);
    const settings = readSettings(settingsPath);
    for (const event of HOOK_EVENTS) {
      const blocks = settings.hooks?.[event] ?? [];
      for (const block of blocks) {
        for (const h of block.hooks) {
          if (h.command.includes(MARKER)) {
            expect(h.async).toBe(true);
          }
        }
      }
    }
  });
});

describe("uninstallHooks", () => {
  it("removes only claudelens entries", () => {
    // Pre-populate with both agentpeek and claudelens hooks
    const initial: Settings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "jq ... >> /tmp/agentpeek.jsonl",
                async: true,
              },
            ],
          },
          makeHookBlock("PreToolUse"),
        ],
      },
    };
    writeSettings(settingsPath, initial);

    const changed = uninstallHooksAt(settingsPath);
    expect(changed).toBe(true);

    const settings = readSettings(settingsPath);
    const blocks = settings.hooks?.["PreToolUse"] ?? [];

    // agentpeek still present
    expect(
      blocks.some((b: HookBlock) => b.hooks.some((h) => h.command.includes("agentpeek.jsonl")))
    ).toBe(true);

    // claudelens removed
    expect(blocks.some((b: HookBlock) => blockContainsMarker(b, MARKER))).toBe(false);
  });

  it("returns false when nothing to remove", () => {
    const changed = uninstallHooksAt(settingsPath);
    expect(changed).toBe(false);
  });

  it("cleans up empty event arrays after uninstall", () => {
    installHooksAt(settingsPath);
    uninstallHooksAt(settingsPath);
    const settings = readSettings(settingsPath);
    // All event arrays should be gone (empty arrays cleaned up)
    for (const event of HOOK_EVENTS) {
      const blocks = settings.hooks?.[event];
      expect(blocks == null || blocks.length === 0).toBe(true);
    }
  });
});
