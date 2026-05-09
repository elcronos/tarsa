#!/usr/bin/env node
// Restored upstream postinstall: node-pty's prebuilt spawn-helper ships
// without the +x bit on macOS, which causes posix_spawnp to fail at runtime.
// Walk the prebuilds tree and chmod 0755 every spawn-helper we find. Safe to
// run repeatedly; no-ops when permissions are already correct.
const fs = require('fs');
const path = require('path');

const targets = [
  path.resolve(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds'),
  // Also fix the workspace-hoisted copy at the repo root, since npm
  // workspaces can deduplicate node-pty into the parent's node_modules.
  path.resolve(__dirname, '..', '..', '..', 'node_modules', 'node-pty', 'prebuilds'),
];

function fix(dir) {
  if (!fs.existsSync(dir)) return;
  for (const platform of fs.readdirSync(dir)) {
    const helper = path.join(dir, platform, 'spawn-helper');
    if (fs.existsSync(helper)) {
      try {
        fs.chmodSync(helper, 0o755);
      } catch (_) { /* best-effort */ }
    }
  }
}

for (const t of targets) fix(t);
