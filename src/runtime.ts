/**
 * Runtime detection utilities.
 * Used to conditionally load bun:sqlite vs better-sqlite3 and other runtime-specific code.
 */

export function isBun(): boolean {
  return typeof (globalThis as Record<string, unknown>)["Bun"] !== "undefined";
}

export function detectRuntime(): "bun" | "node" {
  return isBun() ? "bun" : "node";
}
