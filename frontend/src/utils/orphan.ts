import type { Agent } from "../types";

const ORPHAN_AGE_MS = 30_000;

/**
 * True if this is a stub agent created from an Agent-tool PreToolUse that
 * never received a matching SubagentStart event. Such stubs have no tool
 * calls, no children, and become stale after 30s — hide them from views.
 */
export function isOrphanStub(agent: Agent, nowMs = Date.now()): boolean {
  if (agent.parent_id === null) return false;
  if (agent.tool_count > 0) return false;
  if (agent.children.length > 0) return false;
  return nowMs - agent.first_seen_ms > ORPHAN_AGE_MS;
}
