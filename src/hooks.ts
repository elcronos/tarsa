/**
 * Install / uninstall Tarsa hooks in ~/.claude/settings.json.
 *
 * Hook structure mirrors agentpeek's proven shape:
 *   settings.hooks[event] = [{ hooks: [{ type, command, async }] }, ...]
 *
 * Idempotent: skips entries whose command already contains MARKER.
 * Safe: never touches entries containing "agentpeek.jsonl".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Substring uniquely identifying a Tarsa hook command. Must match the
// command produced by makeHookCommand below; agentpeek and other tools must
// not produce a command containing this exact substring.
export const MARKER = "tarsa --append-event";
export const JSONL_PATH = path.join(os.homedir(), ".tarsa", "events.jsonl");
export const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "UserPromptSubmit",
] as const;

type HookEvent = (typeof HOOK_EVENTS)[number];

interface HookEntry {
  type: "command";
  command: string;
  async: boolean;
}

interface HookBlock {
  hooks: HookEntry[];
}

interface HooksSettings {
  hooks?: Record<string, HookBlock[]>;
  [key: string]: unknown;
}

function makeHookCommand(event: string): string {
  // Delegate write to `tarsa --append-event` so a single fs.writeSync call
  // performs the append. Inline jq + shell `>>` interleaves under load when
  // payloads exceed PIPE_BUF (~4KB on macOS), corrupting JSONL.
  return `tarsa --append-event ${event} 2>/dev/null || true`;
}

function makeHookBlock(event: string): HookBlock {
  return {
    hooks: [
      {
        type: "command",
        command: makeHookCommand(event),
        async: true,
      },
    ],
  };
}

function readSettings(): HooksSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    return JSON.parse(raw) as HooksSettings;
  } catch {
    return {};
  }
}

function writeSettings(settings: HooksSettings): void {
  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, SETTINGS_PATH);
}

function blockContainsMarker(block: HookBlock, marker: string): boolean {
  return block.hooks.some((h) => h.command.includes(marker));
}

/**
 * Install Tarsa hooks into ~/.claude/settings.json.
 * Idempotent — running twice produces identical output.
 * Never modifies entries that contain "agentpeek.jsonl".
 * Returns true if any changes were written.
 */
// Note: TOCTOU on settings.json — single-user CLI tool, low practical risk.
export function installHooks(): boolean {
  const settings = readSettings();
  if (!settings.hooks) {
    settings.hooks = {};
  }
  let changed = false;

  for (const event of HOOK_EVENTS) {
    const eventHooks: HookBlock[] = settings.hooks[event] ?? [];
    settings.hooks[event] = eventHooks;

    const alreadyInstalled = eventHooks.some((block) =>
      blockContainsMarker(block, MARKER)
    );

    if (!alreadyInstalled) {
      eventHooks.push(makeHookBlock(event));
      changed = true;
    }
  }

  if (changed) {
    writeSettings(settings);
  }
  return changed;
}

/**
 * Remove Tarsa hooks from ~/.claude/settings.json.
 * Only removes entries whose command contains "tarsa.jsonl".
 * Returns true if any changes were written.
 */
export function uninstallHooks(): boolean {
  const settings = readSettings();
  const hooks = settings.hooks ?? {};
  let changed = false;

  for (const event of HOOK_EVENTS as readonly HookEvent[]) {
    const eventHooks = hooks[event];
    if (!eventHooks) continue;

    const filtered = eventHooks.filter(
      (block) => !blockContainsMarker(block, MARKER)
    );

    if (filtered.length !== eventHooks.length) {
      hooks[event] = filtered;
      changed = true;
    }
  }

  // Clean up empty event arrays
  for (const event of Object.keys(hooks)) {
    if (hooks[event]?.length === 0) {
      delete hooks[event];
    }
  }

  if (changed) {
    settings.hooks = hooks;
    writeSettings(settings);
  }
  return changed;
}

/**
 * Additively patch the user's settings.json with any HOOK_EVENTS missing a
 * Tarsa entry. Identical to installHooks() — kept as an explicit name
 * for the --upgrade-hooks CLI path so users understand it modifies an
 * existing install rather than performing a fresh install.
 *
 * Returns the list of event names that were added (empty when nothing
 * changed). Never duplicates entries; never removes existing user entries.
 */
export function upgradeHooks(): string[] {
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};
  const added: string[] = [];

  for (const event of HOOK_EVENTS) {
    const eventHooks: HookBlock[] = settings.hooks[event] ?? [];
    settings.hooks[event] = eventHooks;
    const alreadyInstalled = eventHooks.some((b) => blockContainsMarker(b, MARKER));
    if (!alreadyInstalled) {
      eventHooks.push(makeHookBlock(event));
      added.push(event);
    }
  }

  if (added.length > 0) writeSettings(settings);
  return added;
}

/**
 * Returns true if all HOOK_EVENTS have at least one Tarsa entry installed.
 */
export function hooksInstalled(): boolean {
  const settings = readSettings();
  const hooks = settings.hooks ?? {};

  return HOOK_EVENTS.every((event) => {
    const eventHooks = hooks[event] ?? [];
    return eventHooks.some((block) => blockContainsMarker(block, MARKER));
  });
}
