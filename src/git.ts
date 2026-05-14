/**
 * Lightweight git context capture for event enrichment.
 *
 * Uses execFileSync (not execSync) to avoid shell parsing of cwd paths
 * with spaces or special characters. Returns null on non-git dirs,
 * timeouts, empty repos, or any other error — never throws.
 *
 * Detached HEAD: branch === "HEAD" (pass-through from git rev-parse --abbrev-ref HEAD).
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

export interface GitContext {
  commit: string;
  branch: string;
  dirty: boolean;
}

interface CacheEntry {
  value: GitContext | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 2000;
const TIMEOUT_MS = 250;

const cache = new Map<string, CacheEntry>();

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    timeout: TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Get git context (commit SHA, branch, dirty flag) for the given working directory.
 * Results are cached per-cwd for 2 seconds to handle high-frequency event bursts.
 * Returns null when cwd is not inside a git repo, git times out, or any error occurs.
 */
export function getGitContext(cwd: string): GitContext | null {
  const resolved = path.resolve(cwd);
  const now = Date.now();

  const cached = cache.get(resolved);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  let value: GitContext | null = null;
  try {
    const commit = runGit(["-C", resolved, "rev-parse", "HEAD"], resolved);
    // Validate: must be a 40-char hex string
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      cache.set(resolved, { value: null, expiresAt: now + CACHE_TTL_MS });
      return null;
    }

    const branch = runGit(["-C", resolved, "rev-parse", "--abbrev-ref", "HEAD"], resolved);
    const statusOutput = runGit(["-C", resolved, "status", "--porcelain"], resolved);
    const dirty = statusOutput.length > 0;

    value = { commit, branch, dirty };
  } catch {
    value = null;
  }

  cache.set(resolved, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Exposed for testing — clears the internal cache. */
export function clearGitCache(): void {
  cache.clear();
}
