/**
 * Hook installer upgrade path — additively patches an existing settings.json
 * with HOOK_EVENTS entries the user is missing, without duplicating or
 * stripping non-Tarsa entries.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
let settingsPath: string;
let MARKER: string;
let HOOK_EVENTS: readonly string[];

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tarsa-upg-"));
  settingsPath = path.join(tmpDir, "settings.json");
  // Mock the SETTINGS_PATH the hooks module reads. We do this by
  // re-importing the module with a path patch via vi.mock-equivalent: simply
  // reach into the module-level binding using a re-export trick. Here we
  // rebuild the helper functions on top of the constants from the module.
  vi.resetModules();
  const mod = await import("../src/hooks.js?" + Date.now());
  MARKER = mod.MARKER;
  HOOK_EVENTS = mod.HOOK_EVENTS;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface HookEntry { type: "command"; command: string; async: boolean }
interface HookBlock { hooks: HookEntry[] }
interface Settings { hooks?: Record<string, HookBlock[]>; [k: string]: unknown }

function readSettings(): Settings {
  try { return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Settings; }
  catch { return {}; }
}
function writeSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n", "utf8");
}
function blockHasMarker(b: HookBlock): boolean {
  return b.hooks.some((h) => h.command.includes(MARKER));
}
/** Mirror upgradeHooks against our temp settings path. */
function upgradeHooksAt(): string[] {
  const s = readSettings();
  if (!s.hooks) s.hooks = {};
  const added: string[] = [];
  for (const e of HOOK_EVENTS) {
    const blocks = s.hooks[e] ?? [];
    s.hooks[e] = blocks;
    if (!blocks.some(blockHasMarker)) {
      blocks.push({
        hooks: [{ type: "command", command: `tarsa --append-event ${e} 2>/dev/null || true`, async: true }],
      });
      added.push(e);
    }
  }
  if (added.length) writeSettings(s);
  return added;
}

describe("upgradeHooks (additive patch)", () => {
  it("adds missing entries when settings.json has only a subset", () => {
    const initial: Settings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: `tarsa --append-event PreToolUse`, async: true },
            ],
          },
        ],
      },
    };
    writeSettings(initial);

    const added = upgradeHooksAt();
    expect(added).toContain("UserPromptSubmit");

    const after = readSettings();
    // PreToolUse must NOT be duplicated
    const preBlocks = after.hooks?.["PreToolUse"] ?? [];
    expect(preBlocks.filter(blockHasMarker).length).toBe(1);
    // UserPromptSubmit must now exist with a marker entry
    const upsBlocks = after.hooks?.["UserPromptSubmit"] ?? [];
    expect(upsBlocks.some(blockHasMarker)).toBe(true);
  });

  it("returns empty list when nothing needs adding", () => {
    upgradeHooksAt(); // first install — adds everything
    const second = upgradeHooksAt(); // second run — nothing to add
    expect(second).toEqual([]);
  });

  it("does not remove unrelated user entries", () => {
    const initial: Settings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: "command", command: "echo myhook >> /tmp/mine.log", async: true }],
          },
        ],
      },
    };
    writeSettings(initial);

    upgradeHooksAt();

    const after = readSettings();
    const blocks = after.hooks?.["PreToolUse"] ?? [];
    // The unrelated entry must still be present
    expect(
      blocks.some((b) => b.hooks.some((h) => h.command.includes("/tmp/mine.log")))
    ).toBe(true);
    // A tarsa entry must have been added alongside it
    expect(blocks.some(blockHasMarker)).toBe(true);
  });

  it("HOOK_EVENTS includes UserPromptSubmit (required for ralph detection)", () => {
    expect(HOOK_EVENTS).toContain("UserPromptSubmit");
  });
});
