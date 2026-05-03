import type { Agent } from "../types";

/**
 * Returns true when the agent is an OMC team worker.
 * Team workers are spawned outside the Agent tool and have a subagent_type
 * that starts with "worker-" or contains "team".
 */
export function isTeamWorker(agent: Agent): boolean {
  const t = agent.subagent_type ?? "";
  return t.startsWith("worker-") || t.includes("team");
}

/**
 * Returns the role name for a team worker agent:
 *   worker-refactor  → "refactor"
 *   team-nav         → "nav"
 *   executor         → null (not a team worker)
 */
export function teamRoleName(agent: Agent): string | null {
  const t = agent.subagent_type ?? "";
  if (t.startsWith("worker-")) {
    const role = t.slice("worker-".length);
    return role.length > 0 ? role : null;
  }
  const idx = t.indexOf("team-");
  if (idx !== -1) {
    const role = t.slice(idx + "team-".length);
    return role.length > 0 ? role : null;
  }
  if (t.includes("team")) {
    return null;
  }
  return null;
}

/**
 * Groups agents by team key.
 * - Team workers: grouped under the shared parent_id when all workers share one,
 *   otherwise grouped under the literal key "team".
 * - Non-team agents: grouped under "".
 */
export function groupAgentsByTeam(agents: Agent[]): Map<string, Agent[]> {
  const result = new Map<string, Agent[]>();

  const teamWorkers = agents.filter(isTeamWorker);
  const nonTeam = agents.filter((a) => !isTeamWorker(a));

  // Non-team agents
  for (const a of nonTeam) {
    const arr = result.get("") ?? [];
    arr.push(a);
    result.set("", arr);
  }

  // Team workers: derive a team key
  if (teamWorkers.length > 0) {
    const parentIds = new Set(teamWorkers.map((a) => a.parent_id));
    const teamKey =
      parentIds.size === 1 && parentIds.values().next().value !== null
        ? (parentIds.values().next().value as string)
        : "team";
    const arr = result.get(teamKey) ?? [];
    for (const a of teamWorkers) arr.push(a);
    result.set(teamKey, arr);
  }

  return result;
}
