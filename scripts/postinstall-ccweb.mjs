#!/usr/bin/env node
/**
 * Ensure the vendored cc-web's runtime dependencies are resolvable.
 *
 * cc-web is a workspace in the dev monorepo, so a root `npm install` hoists
 * its deps to the root `node_modules` automatically. But when tarsa is consumed
 * as a published package (`npx tarsa`, `npm i -g tarsa`), the `workspaces` field
 * is ignored and cc-web's deps (commander, express, ws, node-pty, …) are never
 * installed. This postinstall closes that gap.
 *
 * Idempotent: the guard uses real Node resolution from cc-web's location, so it
 * correctly sees both hoisted (dev) and locally-installed (published) deps and
 * skips when they already resolve.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Recursion guard: `npm install` inside vendor/cc-web can re-trigger root
// lifecycle scripts in some npm versions. Bail if we're already nested.
if (process.env.TARSA_CCWEB_POSTINSTALL === "1") process.exit(0);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ccWeb = join(root, "vendor", "cc-web");
const ccWebPkg = join(ccWeb, "package.json");

if (!existsSync(ccWebPkg)) {
  // cc-web not vendored in this install — terminal feature simply stays off.
  process.exit(0);
}

// Resolve "commander" the way cc-web's own `require` would: this walks
// vendor/cc-web/node_modules AND every parent node_modules (incl. hoisted root).
const ccWebRequire = createRequire(ccWebPkg);
try {
  ccWebRequire.resolve("commander");
  // Already satisfied — dev hoist or a prior postinstall run.
  process.exit(0);
} catch {
  // Not resolvable — fall through and install.
}

console.log("[tarsa] installing vendored cc-web dependencies…");
try {
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: ccWeb,
    stdio: "inherit",
    env: { ...process.env, TARSA_CCWEB_POSTINSTALL: "1" },
  });
} catch {
  // Don't fail the whole tarsa install — the embedded terminal is optional.
  // tarsa detects the missing supervisor and disables the Terminal tab.
  console.warn("[tarsa] cc-web dependency install failed — embedded terminal will be disabled.");
}
