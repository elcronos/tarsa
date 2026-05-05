import { useMemo, useState } from "react";
import type { State, Session, Agent } from "../types";
import { formatDuration, formatTime } from "../utils/format";
import { typeColor, STATUS_COLORS } from "../utils/colors";
import { useNow } from "../hooks/useNow";
import EmptyState from "./EmptyState";
import { isOrphanStub } from "../utils/orphan";
import StatusFilter, { type StatusFilterSet } from "./StatusFilter";
import { isTeamWorker, teamRoleName } from "../utils/team";

interface GlobalViewProps {
  state: State;
  onSelectAgent: (id: string | null) => void;
  statusFilter: StatusFilterSet;
  onStatusFilterChange: (next: StatusFilterSet) => void;
  selectedAgentId?: string | null;
}

// ── Layout constants ────────────────────────────────────────────────────────
const NODE_W = 110;
const NODE_H = 50;
const COL_GAP = 56; // horizontal gap between depth columns
const ROW_GAP = 12; // vertical gap between nodes in same column
const PAD_X = 12;
const PAD_Y = 10;
const MAX_VISIBLE = 10;

// ── StatusPill ──────────────────────────────────────────────────────────────
function StatusPill({ status }: { status: "active" | "complete" }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-mono text-emerald-400">
        <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
        active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-zinc-500/10 border border-zinc-500/20 text-[10px] font-mono text-zinc-400">
      <span className="w-1 h-1 rounded-full bg-zinc-400" />
      ended
    </span>
  );
}

// ── ActivityLabel ───────────────────────────────────────────────────────────
function ActivityLabel({ agents, now }: { agents: Agent[]; now: number }) {
  const hasActive = agents.some((a) => a.status === "active");
  if (hasActive) {
    return (
      <span className="text-[10px] font-mono text-emerald-400">active</span>
    );
  }
  if (agents.length === 0) {
    return <span className="text-[10px] font-mono text-[var(--fg-subtle)]">idle</span>;
  }
  const maxLastSeen = Math.max(...agents.map((a) => a.last_seen_ms));
  const delta = now - maxLastSeen;
  return (
    <span className="text-[10px] font-mono text-[var(--fg-subtle)]">
      idle {formatDuration(delta)}
    </span>
  );
}

// ── Layout computation ──────────────────────────────────────────────────────
interface LayoutNode {
  agent: Agent;
  x: number;
  y: number;
}

function computeLayout(agents: Agent[]): {
  nodes: LayoutNode[];
  svgWidth: number;
  svgHeight: number;
} {
  if (agents.length === 0) return { nodes: [], svgWidth: 0, svgHeight: 0 };

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  // Compute depth for each agent via parent_id chain
  const depthMap = new Map<string, number>();
  function getDepth(id: string): number {
    if (depthMap.has(id)) return depthMap.get(id)!;
    const agent = agentMap.get(id);
    if (!agent || agent.parent_id === null || !agentMap.has(agent.parent_id)) {
      depthMap.set(id, 0);
      return 0;
    }
    const d = getDepth(agent.parent_id) + 1;
    depthMap.set(id, d);
    return d;
  }
  for (const a of agents) getDepth(a.id);

  // Group by (parent_id, depth) — each bucket is a sibling group that may wrap.
  const MAX_PER_BUCKET_COL = 6;
  const SUB_COL_GAP = NODE_W + 12; // tighter horizontal spacing within a bucket
  const buckets = new Map<string, Agent[]>();
  for (const a of agents) {
    const p = a.parent_id ?? "__root__";
    const d = depthMap.get(a.id) ?? 0;
    const key = `${p}:${d}`;
    const arr = buckets.get(key) ?? [];
    arr.push(a);
    buckets.set(key, arr);
  }

  // Compute width consumed by each depth (max sub-columns of any bucket at that depth).
  const widthAtDepth = new Map<number, number>();
  for (const [key, bucket] of buckets) {
    const d = parseInt(key.split(":").pop() ?? "0", 10);
    const subCols = Math.ceil(bucket.length / MAX_PER_BUCKET_COL);
    const cur = widthAtDepth.get(d) ?? 0;
    if (subCols > cur) widthAtDepth.set(d, subCols);
  }

  // Cumulative X offset per depth.
  const xAtDepth = new Map<number, number>();
  const sortedDepths = Array.from(widthAtDepth.keys()).sort((a, b) => a - b);
  let cursor = PAD_X;
  for (const d of sortedDepths) {
    xAtDepth.set(d, cursor);
    const sc = widthAtDepth.get(d) ?? 1;
    cursor += sc * SUB_COL_GAP + COL_GAP;
  }

  const nodes: LayoutNode[] = [];
  let maxBottom = 0;

  for (const [key, bucket] of buckets) {
    const d = parseInt(key.split(":").pop() ?? "0", 10);
    const baseX = xAtDepth.get(d) ?? PAD_X;
    bucket.forEach((agent, i) => {
      const subCol = Math.floor(i / MAX_PER_BUCKET_COL);
      const subRow = i % MAX_PER_BUCKET_COL;
      const x = baseX + subCol * SUB_COL_GAP;
      const y = PAD_Y + subRow * (NODE_H + ROW_GAP);
      nodes.push({ agent, x, y });
      if (y + NODE_H > maxBottom) maxBottom = y + NODE_H;
    });
  }

  const svgWidth = cursor + PAD_X;
  const svgHeight = maxBottom + PAD_Y;

  return { nodes, svgWidth, svgHeight };
}

// ── MiniDagNode (SVG foreignObject) ────────────────────────────────────────
function MiniDagNode({
  node,
  onSelect,
  isSelected,
  now,
}: {
  node: LayoutNode;
  onSelect: () => void;
  isSelected: boolean;
  now: number;
}) {
  const { agent, x, y } = node;
  const color = typeColor(agent.subagent_type);
  const isActive = agent.status === "active";
  const isStuck =
    isActive &&
    now - agent.first_seen_ms > 120_000 &&
    now - agent.last_seen_ms < 30_000;
  const statusColor =
    isStuck
      ? "#f59e0b"
      : isActive
        ? STATUS_COLORS.active
        : agent.status === "done"
          ? STATUS_COLORS.done
          : agent.status === "error"
            ? STATUS_COLORS.error
            : STATUS_COLORS.awaiting;

  const primaryLabel =
    agent.description && agent.description !== agent.subagent_type
      ? agent.description
      : agent.name;
  const typeLabel =
    agent.subagent_type ?? (agent.parent_id === null ? "root" : "agent");
  const showTypePill = typeLabel !== primaryLabel;

  const borderColor = isSelected
    ? "#a78bfa"
    : isStuck
      ? "#f59e0b"
      : isActive
        ? "var(--accent)"
        : "var(--border)";

  return (
    <foreignObject x={x} y={y} width={NODE_W} height={NODE_H}>
      <div
        // @ts-expect-error xmlns is valid on foreignObject children
        xmlns="http://www.w3.org/1999/xhtml"
        style={{
          width: NODE_W,
          height: NODE_H,
          border: `${isSelected || isActive ? 2 : 1}px solid ${borderColor}`,
          borderRadius: 6,
          background: isSelected
            ? "rgba(167,139,250,0.1)"
            : isActive
              ? "rgba(59,130,246,0.08)"
              : "var(--surface-raised)",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "4px 6px",
          boxSizing: "border-box",
          overflow: "hidden",
          boxShadow: isSelected
            ? "0 0 0 2px rgba(167,139,250,0.25)"
            : isActive
              ? "0 0 8px rgba(59,130,246,0.5)"
              : undefined,
          animation: isActive && !isSelected ? "active-pulse 2s infinite" : undefined,
        }}
        onClick={onSelect}
        title={agent.description || agent.name}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 3, overflow: "hidden" }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: statusColor,
              flexShrink: 0,
              ...(isActive ? { animation: "pulse 1.5s infinite" } : {}),
            }}
          />
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "monospace",
              color: "#fafafa",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {primaryLabel}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 3, flexWrap: "wrap" }}>
          {showTypePill && (
            <span
              style={{
                padding: "1px 4px",
                borderRadius: 3,
                fontSize: 9,
                fontFamily: "monospace",
                background: `${color}22`,
                color,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                display: "inline-block",
                maxWidth: "100%",
              }}
            >
              {typeLabel}
            </span>
          )}
          {isTeamWorker(agent) && (
            <span
              style={{
                padding: "1px 4px",
                borderRadius: 3,
                fontSize: 9,
                fontFamily: "monospace",
                background: "#fb923c22",
                color: "#fb923c",
                whiteSpace: "nowrap",
                display: "inline-block",
              }}
            >
              team{teamRoleName(agent) ? ` · ${teamRoleName(agent)}` : ""}
            </span>
          )}
        </div>
      </div>
    </foreignObject>
  );
}

// ── MiniDag SVG ─────────────────────────────────────────────────────────────
function MiniDag({
  agents,
  onSelectAgent,
  selectedAgentId,
  now,
}: {
  agents: Agent[];
  onSelectAgent: (id: string | null) => void;
  selectedAgentId?: string | null;
  now: number;
}) {
  const { nodes, svgWidth, svgHeight } = useMemo(
    () => computeLayout(agents),
    [agents]
  );

  if (nodes.length === 0) {
    return (
      <span className="text-[10px] text-[var(--fg-subtle)] font-mono">
        No agents
      </span>
    );
  }

  // Build edge pairs: parent → children, only if both are in layout
  const nodeMap = new Map(nodes.map((n) => [n.agent.id, n]));
  const edges: Array<{ from: LayoutNode; to: LayoutNode; isActive: boolean }> = [];
  for (const n of nodes) {
    if (n.agent.parent_id && nodeMap.has(n.agent.parent_id)) {
      const parent = nodeMap.get(n.agent.parent_id)!;
      edges.push({
        from: parent,
        to: n,
        isActive: n.agent.status === "active",
      });
    }
  }

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      style={{ overflow: "visible", display: "block" }}
    >
      {/* Edges */}
      {edges.map((e, i) => {
        const x1 = e.from.x + NODE_W;
        const y1 = e.from.y + NODE_H / 2;
        const x2 = e.to.x;
        const y2 = e.to.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={e.isActive ? "#3b82f6" : "#3f3f46"}
            strokeWidth={1.5}
            strokeDasharray={e.isActive ? "4 3" : undefined}
            style={
              e.isActive
                ? {
                    strokeDashoffset: 0,
                    animation: "dash-flow 1s linear infinite",
                  }
                : undefined
            }
          />
        );
      })}

      {/* Nodes */}
      {nodes.map((n) => (
        <MiniDagNode
          key={n.agent.id}
          node={n}
          onSelect={() => onSelectAgent(n.agent.id)}
          isSelected={n.agent.id === selectedAgentId}
          now={now}
        />
      ))}
    </svg>
  );
}

// ── SessionCard ─────────────────────────────────────────────────────────────
function SessionCard({
  session,
  agents,
  onSelectAgent,
  now,
  defaultExpanded,
  selectedAgentId,
}: {
  session: Session;
  agents: Agent[];
  onSelectAgent: (id: string | null) => void;
  now: number;
  defaultExpanded: boolean;
  selectedAgentId?: string | null;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const name = session.name ?? `Session ${session.id.slice(0, 8)}`;
  const duration = session.ended_at
    ? formatDuration(session.ended_at - session.started_at)
    : formatDuration(now - session.started_at);
  const activeCount = agents.filter((a) => a.status === "active").length;

  const visibleAgents = agents.slice(0, MAX_VISIBLE);
  const hiddenCount = agents.length - visibleAgents.length;

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--surface)]">
      {/* Card header — click to toggle expansion */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 bg-[var(--surface-raised)] cursor-pointer select-none hover:bg-[var(--surface-raised)]/80 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Expand chevron */}
        <span className="text-[var(--fg-subtle)] text-[10px] font-mono shrink-0 w-3">
          {expanded ? "▾" : "▸"}
        </span>
        <StatusPill status={session.status} />
        <span className="font-mono text-xs text-[var(--fg)] font-medium truncate flex-1">
          {name}
        </span>
        <div className="flex items-center gap-3 shrink-0 text-[10px] font-mono text-[var(--fg-subtle)]">
          <span>
            {agents.length} agents
            {activeCount > 0 ? ` · ${activeCount} active` : ""}
          </span>
          <ActivityLabel agents={agents} now={now} />
          <span>{duration}</span>
          <span>{formatTime(session.started_at)}</span>
        </div>
      </div>

      {/* Mini DAG area — only shown when expanded */}
      {expanded && (
        <div
          className="p-3 overflow-x-auto border-t border-[var(--border)]"
          style={{ maxHeight: 300 }}
        >
          <MiniDag
            agents={visibleAgents}
            onSelectAgent={onSelectAgent}
            selectedAgentId={selectedAgentId}
            now={now}
          />
          {hiddenCount > 0 && (
            <span className="mt-2 inline-block text-[10px] font-mono text-[var(--fg-subtle)]">
              + {hiddenCount} more agents
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── GlobalView ───────────────────────────────────────────────────────────────
export default function GlobalView({ state, onSelectAgent, statusFilter, onStatusFilterChange, selectedAgentId }: GlobalViewProps) {
  const [showStale, setShowStale] = useState(false);
  const now = useNow(5_000);

  const sessions = Array.from(state.sessions.values()).sort(
    (a, b) => b.started_at - a.started_at
  );

  if (sessions.length === 0) {
    return <EmptyState message="No sessions yet" />;
  }

  // Compute counts from full agent list (pre-filter) for StatusFilter chips
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<import("../types").AgentStatus, number>> = {};
    for (const a of state.agents.values()) {
      counts[a.status] = (counts[a.status] ?? 0) + 1;
    }
    return counts;
  }, [state.agents]);

  // Per-session agent list (orphan stubs excluded)
  const sessionAgents = (sid: string) =>
    Array.from(state.agents.values()).filter(
      (a) => a.session_id === sid && !isOrphanStub(a, now)
    );

  const liveSessions = sessions.filter((s) => {
    const sa = sessionAgents(s.id);
    return sa.length > 0 && sa.some((a) => a.status === "active");
  });
  const staleSessions = sessions.filter((s) => {
    const sa = sessionAgents(s.id);
    return sa.length > 0 && !sa.some((a) => a.status === "active");
  });

  const visibleSessions = showStale ? [...liveSessions, ...staleSessions] : liveSessions;

  if (visibleSessions.length === 0 && staleSessions.length === 0) {
    return <EmptyState message="No sessions yet" />;
  }

  // First 2 active sessions are expanded by default
  let activeExpanded = 0;

  return (
    <>
      {/* Animated dash-flow keyframes for active edges */}
      <style>{`
        @keyframes dash-flow {
          to { stroke-dashoffset: -14; }
        }
      `}</style>
      <div className="h-full flex flex-col overflow-hidden">
        {/* Status filter bar */}
        <div className="px-4 pt-3 pb-2 shrink-0 flex items-center gap-2">
          <StatusFilter
            enabled={statusFilter}
            onChange={onStatusFilterChange}
            counts={statusCounts}
          />
          {staleSessions.length > 0 && (
            <button
              onClick={() => setShowStale((v) => !v)}
              className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:border-[var(--fg-subtle)]"
              title={showStale ? "Hide stale sessions" : "Show stale sessions"}
            >
              {showStale ? `hide stale (${staleSessions.length})` : `+${staleSessions.length} stale`}
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
          {visibleSessions.map((session) => {
            const agents = Array.from(state.agents.values()).filter(
              (a) => a.session_id === session.id && !isOrphanStub(a, now) && statusFilter.has(a.status)
            );
            const isActive = session.status === "active";
            let defaultExpanded = false;
            if (isActive && activeExpanded < 2) {
              defaultExpanded = true;
              activeExpanded++;
            }
            return (
              <SessionCard
                key={session.id}
                session={session}
                agents={agents}
                onSelectAgent={onSelectAgent}
                now={now}
                defaultExpanded={defaultExpanded}
                selectedAgentId={selectedAgentId}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}
