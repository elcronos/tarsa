/**
 * Pure event reducer — re-exports from shared/replay-core.ts.
 *
 * The reducer logic now lives in ../../src/shared/replay-core.ts and is
 * shared verbatim with the server (src/replay.ts). Vite resolves the
 * relative path; tsc with bundler moduleResolution does the same.
 */
export * from "../../src/shared/replay-core.js";
