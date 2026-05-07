import { memo } from "react";
import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";
import type { Agent } from "../types";
import { formatDuration } from "../utils/format";
import { formatRelative, absoluteISO } from "../utils/relativeTime";
import { typeColor } from "../utils/colors";
import { useNow } from "../hooks/useNow";
import { isTeamWorker, teamRoleName } from "../utils/team";

export interface AgentNodeData {
  agent: Agent;
  isSelected: boolean;
  isStuck: boolean;
  durationMs: number | null;
}

function AgentNode({ data }: NodeProps<AgentNodeData>) {
  const { agent, isSelected, isStuck, durationMs } = data;
  const now = useNow();

  const statusDot =
    agent.status === "active"
      ? "bg-blue-500"
      : agent.status === "awaiting"
        ? "bg-amber-400"
        : agent.status === "done"
          ? "bg-emerald-500"
          : "bg-red-500";

  const statusLabel: Record<typeof agent.status, string> = {
    active: "running",
    awaiting: "awaiting input",
    done: "complete",
    error: "error",
  };

  const isActive = agent.status === "active" && !isStuck;

  const borderColor = isStuck
    ? "border-amber-500"
    : isActive
      ? "border-[var(--accent)]"
      : isSelected
        ? "border-violet-400"
        : "border-[var(--border)]";

  const badgeColor = typeColor(agent.subagent_type);
  // Type badge label: subagent_type or fallback to role
  const typeLabel = agent.subagent_type ?? (agent.parent_id === null ? "root" : "agent");
  // Primary label: prefer description when it differs meaningfully from subagent_type
  const primaryLabel =
    agent.description && agent.description !== agent.subagent_type
      ? agent.description
      : agent.name;

  return (
    <div
      className={`
        agent-node-frame
        ${isActive ? "agent-node-active-accent" : ""}
        relative min-w-[160px] max-w-[220px] rounded-md border bg-[var(--surface-raised)]
        px-3 py-2 text-[var(--fg)] shadow-sm transition-all
        ${borderColor}
        ${isStuck ? "stuck-pulse" : isActive ? "active-pulse" : ""}
        ${isSelected ? "ring-1 ring-violet-400/40" : ""}
      `}
    >
      <Handle type="target" position={Position.Left} className="!bg-[var(--border)] !w-2 !h-2" />
      <Handle type="source" position={Position.Right} className="!bg-[var(--border)] !w-2 !h-2" />

      {/* Header row — primary label (description or name) */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot}`} />
        <span
          className="truncate font-mono text-xs font-medium text-[var(--fg)] leading-none"
          title={primaryLabel}
        >
          {primaryLabel}
        </span>
      </div>

      {/* Type badge (small, monospace pill) + team badge + duration + error/stuck */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {typeLabel !== primaryLabel && (
          <span
            className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono leading-none"
            style={{ backgroundColor: `${badgeColor}22`, color: badgeColor }}
          >
            {typeLabel}
          </span>
        )}

        {/* Team badge — shown only for OMC team workers */}
        {isTeamWorker(agent) && (
          <span
            className="inline-block px-1.5 py-0.5 rounded font-mono leading-none"
            style={{ backgroundColor: "#fb923c22", color: "#fb923c", fontSize: 9 }}
          >
            team{teamRoleName(agent) ? ` · ${teamRoleName(agent)}` : ""}
          </span>
        )}

        {/* Status label — when stuck, replace running pill with stuck pill */}
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono leading-none ${
            isStuck
              ? "bg-amber-500/15 text-amber-400"
              : agent.status === "active"
                ? "bg-blue-500/15 text-blue-400"
                : agent.status === "awaiting"
                  ? "bg-amber-400/15 text-amber-400"
                  : agent.status === "done"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-red-500/15 text-red-400"
          }`}
        >
          {isStuck ? "stuck" : statusLabel[agent.status]}
        </span>

        {/* Duration */}
        {durationMs !== null && (
          <span className="text-[10px] text-[var(--fg-subtle)] font-mono">
            {formatDuration(durationMs)}
          </span>
        )}

        {/* Idle / finished label */}
        {(agent.status === "awaiting" || agent.status === "done" || agent.status === "error") && (
          <span
            className="text-[10px] text-[var(--fg-subtle)] font-mono"
            title={absoluteISO(agent.ended_at ?? agent.last_seen_ms)}
          >
            {agent.status === "awaiting" ? "idle " : "ended "}
            {formatRelative(agent.ended_at ?? agent.last_seen_ms)}
          </span>
        )}

        {/* Error count */}
        {agent.error_count > 0 && (
          <span className="ml-auto text-[10px] text-red-400 font-mono">
            {agent.error_count}err
          </span>
        )}

      </div>

      {/* Tool count */}
      <div className="mt-1 text-[10px] text-[var(--fg-subtle)] font-mono">
        {agent.tool_count} calls
      </div>
    </div>
  );
}

export default memo(AgentNode);
