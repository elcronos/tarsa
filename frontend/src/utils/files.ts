/**
 * Utility for extracting files touched from tool calls.
 */

import type { ToolCall } from "../types";

export interface FilesTouched {
  reads: string[];
  writes: string[];
  edits: string[];
}

const READ_TOOLS = new Set(["Read"]);
const WRITE_TOOLS = new Set(["Write"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

function extractPath(input: Record<string, unknown>): string | null {
  const fp = input["file_path"] ?? input["filePath"] ?? input["path"];
  return typeof fp === "string" && fp.length > 0 ? fp : null;
}

/**
 * Scan tool calls and group touched file paths by action.
 * Deduplicates paths within each category.
 * A path that appears in both reads and writes stays in writes (written implies read).
 */
export function extractFilesTouched(toolCalls: ToolCall[]): FilesTouched {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const edits = new Set<string>();

  for (const tc of toolCalls) {
    const fp = extractPath(tc.input);
    if (!fp) continue;

    if (READ_TOOLS.has(tc.tool_name)) {
      reads.add(fp);
    } else if (WRITE_TOOLS.has(tc.tool_name)) {
      writes.add(fp);
    } else if (EDIT_TOOLS.has(tc.tool_name)) {
      edits.add(fp);
    }
  }

  // Remove from reads anything that was also written/edited (avoid duplication)
  for (const fp of writes) reads.delete(fp);
  for (const fp of edits) reads.delete(fp);

  return {
    reads: Array.from(reads),
    writes: Array.from(writes),
    edits: Array.from(edits),
  };
}
