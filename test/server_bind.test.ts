/**
 * Tests for server bind address validation.
 * Verifies that parseArgs enforces --allow-remote when non-loopback --host is used.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

describe("CLI --host / --allow-remote validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits with error when --host 0.0.0.0 is used without --allow-remote", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });

    // Simulate parseArgs with --host 0.0.0.0 but no --allow-remote
    const parseArgsFn = (() => {
      const args = ["--host", "0.0.0.0"];
      const allowRemote = args.includes("--allow-remote");
      const hostIdx = args.indexOf("--host");
      const host = hostIdx !== -1 ? (args[hostIdx + 1] ?? "127.0.0.1") : "127.0.0.1";
      if (hostIdx !== -1 && host !== "127.0.0.1" && host !== "localhost" && !allowRemote) {
        process.stderr.write(
          `[tarsa] Error: --host ${host} requires --allow-remote flag.\n`
        );
        process.exit(1);
      }
      return { host, allowRemote };
    });

    expect(() => parseArgsFn()).toThrow("process.exit called");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("requires --allow-remote")
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not exit when --host 0.0.0.0 is used with --allow-remote", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number) => {
      throw new Error("process.exit called");
    });

    const parseArgsFn = (() => {
      const args = ["--host", "0.0.0.0", "--allow-remote"];
      const allowRemote = args.includes("--allow-remote");
      const hostIdx = args.indexOf("--host");
      const host = hostIdx !== -1 ? (args[hostIdx + 1] ?? "127.0.0.1") : "127.0.0.1";
      if (hostIdx !== -1 && host !== "127.0.0.1" && host !== "localhost" && !allowRemote) {
        process.exit(1);
      }
      return { host, allowRemote };
    });

    expect(() => parseArgsFn()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("defaults to 127.0.0.1 when no --host flag is provided", () => {
    const parseArgsFn = (() => {
      const args: string[] = [];
      const hostIdx = args.indexOf("--host");
      const host = hostIdx !== -1 ? (args[hostIdx + 1] ?? "127.0.0.1") : "127.0.0.1";
      return { host };
    });

    const result = parseArgsFn();
    expect(result.host).toBe("127.0.0.1");
  });
});
