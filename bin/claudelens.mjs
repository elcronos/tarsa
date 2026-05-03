#!/usr/bin/env node
/**
 * ClaudeLens entry shim.
 *
 * On Bun: imports src/cli.ts directly (Bun natively runs TypeScript).
 * On Node: uses tsx/esm loader to transpile TypeScript on the fly.
 *
 * This file must be plain .mjs so both runtimes can execute it without
 * requiring any compilation step.
 */

const isBun = typeof globalThis.Bun !== "undefined";

if (isBun) {
  // Bun runs TypeScript natively — direct import works.
  await import("../src/cli.ts");
} else {
  // Node: register tsx ESM loader then import the TypeScript entry point.
  // tsx registers itself as a module hook when imported before the target.
  const { register } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const __dirname = new URL(".", import.meta.url).pathname;

  try {
    // tsx >= 4.x exposes an ESM hook at tsx/esm
    register("tsx/esm", pathToFileURL(__dirname));
    await import("../src/cli.ts");
  } catch {
    // Fallback: try tsx directly (older versions)
    await import("../src/cli.ts");
  }
}
