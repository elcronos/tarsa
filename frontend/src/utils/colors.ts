import type { AgentStatus } from "../types";

/** Status colors matching the Linear/Vercel palette */
export const STATUS_COLORS: Record<AgentStatus, string> = {
  active: "#3b82f6",
  awaiting: "#fbbf24",
  done: "#10b981",
  error: "#ef4444",
};

/** Stuck/warning color */
export const STUCK_COLOR = "#f59e0b";

/** Returns the hex color for an agent status */
export function statusColor(status: AgentStatus | string): string {
  return STATUS_COLORS[status as AgentStatus] ?? "#52525b";
}

/** Type badge color by subagent_type keyword */
export function typeColor(subagentType: string | null): string {
  if (!subagentType) return "#52525b";
  const t = subagentType.toLowerCase();
  if (t.includes("executor")) return "#a78bfa";
  if (t.includes("planner") || t.includes("architect")) return "#60a5fa";
  if (t.includes("review") || t.includes("critic")) return "#f97316";
  if (t.includes("research") || t.includes("search")) return "#34d399";
  if (t.includes("writer") || t.includes("doc")) return "#fb7185";
  return "#71717a";
}
