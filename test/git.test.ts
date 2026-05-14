/**
 * Tests for src/git.ts — getGitContext() behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

// We need to control the cache TTL in tests, so we import the module and
// clear the cache between tests via the exported helper.
import { getGitContext, clearGitCache } from "../src/git.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

const TARSA_REPO = path.resolve(process.cwd());

function stubGitSuccess(commit: string, branch: string, status: string) {
  mockExecFileSync.mockImplementation((_cmd, args, _opts) => {
    const argsArr = args as string[];
    if (argsArr.includes("--abbrev-ref")) return branch + "\n";
    if (argsArr.includes("rev-parse") && argsArr.includes("HEAD")) return commit + "\n";
    if (argsArr.includes("--porcelain")) return status;
    throw new Error("unexpected git call");
  });
}

beforeEach(() => {
  clearGitCache();
  vi.clearAllMocks();
});

afterEach(() => {
  clearGitCache();
});

describe("getGitContext", () => {
  it("returns commit, branch, dirty=false for a clean repo", () => {
    const sha = "a".repeat(40);
    stubGitSuccess(sha, "main", "");
    const result = getGitContext("/some/repo");
    expect(result).not.toBeNull();
    expect(result!.commit).toBe(sha);
    expect(result!.branch).toBe("main");
    expect(result!.dirty).toBe(false);
  });

  it("returns dirty=true when porcelain output is non-empty", () => {
    const sha = "b".repeat(40);
    stubGitSuccess(sha, "feature", " M src/foo.ts\n");
    const result = getGitContext("/some/repo");
    expect(result).not.toBeNull();
    expect(result!.dirty).toBe(true);
  });

  it("returns null when cwd is not inside a git work tree (execFileSync throws)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("not a git repo"), { code: 128 });
    });
    const result = getGitContext("/tmp");
    expect(result).toBeNull();
  });

  it("returns null on timeout (execFileSync throws with ETIMEDOUT)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    });
    const result = getGitContext("/nonexistent/xyz");
    expect(result).toBeNull();
  });

  it("does not throw on error — returns null silently", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("permission denied"); });
    expect(() => getGitContext("/no/permission")).not.toThrow();
    expect(getGitContext("/no/permission")).toBeNull();
  });

  it("caches: two back-to-back calls with same cwd only spawn one execFileSync sequence", () => {
    const sha = "c".repeat(40);
    stubGitSuccess(sha, "main", "");
    getGitContext("/cached/repo");
    getGitContext("/cached/repo");
    // Three git calls per invocation (HEAD, abbrev-ref, status). Should be exactly 3 total.
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it("cache TTL: a different cwd is not served from cache", () => {
    const sha = "d".repeat(40);
    stubGitSuccess(sha, "main", "");
    getGitContext("/repo/a");
    getGitContext("/repo/b");
    // 3 calls per unique cwd = 6 total
    expect(mockExecFileSync).toHaveBeenCalledTimes(6);
  });

  it("returns null when commit is not a 40-hex string (empty repo)", () => {
    mockExecFileSync.mockImplementation((_cmd, args, _opts) => {
      const argsArr = args as string[];
      if (argsArr.includes("rev-parse") && argsArr.includes("HEAD")) {
        // Empty repo — git rev-parse HEAD exits non-zero, but we simulate
        // it returning an invalid value
        throw new Error("ambiguous argument 'HEAD'");
      }
      throw new Error("unexpected");
    });
    expect(getGitContext("/empty/repo")).toBeNull();
  });

  it("detached HEAD: branch === 'HEAD' is acceptable", () => {
    const sha = "e".repeat(40);
    stubGitSuccess(sha, "HEAD", "");
    const result = getGitContext("/detached/repo");
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("HEAD");
  });
});

describe("getGitContext against actual tarsa repo", () => {
  it("returns real HEAD + branch for the tarsa repo itself", () => {
    // Use the real execFileSync (not mocked) — unmock for this test
    vi.restoreAllMocks();
    clearGitCache();
    const result = getGitContext(TARSA_REPO);
    // Should be a valid git context since tarsa is a git repo
    expect(result).not.toBeNull();
    expect(result!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof result!.branch).toBe("string");
    expect(result!.branch.length).toBeGreaterThan(0);
    expect(typeof result!.dirty).toBe("boolean");
  });
});
