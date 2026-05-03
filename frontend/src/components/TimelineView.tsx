import { useRef, useState, useMemo, useCallback } from "react";
import type { Agent, State, AgentStatus } from "../types";
import { formatDuration } from "../utils/format";
import EmptyState from "./EmptyState";
import StatusFilter, { type StatusFilterSet } from "./StatusFilter";

interface TimelineViewProps {
  state: State;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  statusFilter: StatusFilterSet;
  onStatusFilterChange: (next: StatusFilterSet) => void;
}

export interface AgentRow {
  agent: Agent;
  depth: number;
  startMs: number;
  endMs: number;
  /** Visual row index in the SVG (parallel agents share same rowIndex) */
  rowIndex: number;
  /** Left padding in pixels from depth-based indentation */
  leftPadding: number;
}

export function buildRows(state: State): AgentRow[] {
  const agents = Array.from(state.agents.values());
  if (agents.length === 0) return [];

  // Build depth map via BFS from roots
  const depthMap = new Map<string, number>();
  const childrenMap = new Map<string, string[]>();
  for (const a of agents) {
    childrenMap.set(a.id, a.children);
  }

  const roots = agents.filter((a) => a.parent_id === null);
  const queue: [string, number][] = roots.map((r) => [r.id, 0]);
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const [id, depth] = item;
    depthMap.set(id, depth);
    const children = childrenMap.get(id) ?? [];
    for (const c of children) {
      queue.push([c, depth + 1]);
    }
  }

  const now = Date.now();

  // Sort by (depth ASC, started_ms ASC)
  const sorted = [...agents].sort((a, b) => {
    const da = depthMap.get(a.id) ?? 0;
    const db = depthMap.get(b.id) ?? 0;
    if (da !== db) return da - db;
    return a.first_seen_ms - b.first_seen_ms;
  });

  // Assign row indices: group siblings (same parent_id)
  // Sequential siblings can share row; parallel siblings get distinct visual rows
  const rowIndexMap = new Map<string, number>();
  let nextRow = 0;

  // Process agents in sorted order, tracking "last end time" per sibling group row
  // Each parent gets its own row-space allocation
  const parentRowState = new Map<string, { usedRows: Array<number> }>();

  for (const agent of sorted) {
    const depth = depthMap.get(agent.id) ?? 0;
    const endMs = agent.status === "active" ? now : agent.last_seen_ms;
    const parentId = agent.parent_id ?? "__root__";

    if (!parentRowState.has(parentId)) {
      parentRowState.set(parentId, { usedRows: [] });
    }
    const ps = parentRowState.get(parentId)!;

    // Find a row in this sibling group where this agent fits (no overlap)
    // We track row assignments per sibling group
    const siblingGroupKey = `${parentId}:${depth}`;
    if (!parentRowState.has(siblingGroupKey)) {
      parentRowState.set(siblingGroupKey, { usedRows: [] });
    }
    const groupState = parentRowState.get(siblingGroupKey)!;
    void ps; // used above for initialization

    // Each "slot" in usedRows stores the end time of the last agent placed there
    let placedInRow = -1;
    const slotEndTimes: number[] = (groupState.usedRows as unknown as number[]);

    for (let slot = 0; slot < slotEndTimes.length; slot++) {
      const slotEnd = slotEndTimes[slot]!;
      if (agent.first_seen_ms >= slotEnd) {
        // Sequential — fits in this slot (same row as previous)
        slotEndTimes[slot] = endMs;
        // Find the actual row index that was assigned to this slot
        placedInRow = slot;
        break;
      }
    }

    if (placedInRow === -1) {
      // Parallel — needs a new row
      slotEndTimes.push(endMs);
      placedInRow = slotEndTimes.length - 1;
      nextRow++;
    }

    // Map slot to actual SVG row index: use a stable row per slot in sibling group
    const siblingRowBase = `${siblingGroupKey}:slot:${placedInRow}`;
    if (!rowIndexMap.has(siblingRowBase)) {
      rowIndexMap.set(siblingRowBase, nextRow - (placedInRow === slotEndTimes.length - 1 ? 0 : 0));
    }

    rowIndexMap.set(agent.id, rowIndexMap.get(siblingRowBase) ?? nextRow);
  }

  // Re-assign row indices compactly: walk sorted agents and assign sequential row index
  // while grouping parallel siblings together on the same visual row offset
  const compactRowMap = new Map<string, number>();
  let currentRow = 0;

  // Group by parent + depth
  const siblingGroups = new Map<string, Agent[]>();
  for (const agent of sorted) {
    const depth = depthMap.get(agent.id) ?? 0;
    const key = `${agent.parent_id ?? "__root__"}:${depth}`;
    const g = siblingGroups.get(key) ?? [];
    g.push(agent);
    siblingGroups.set(key, g);
  }

  // Process groups in the order first agent appears
  const processedGroups = new Set<string>();
  for (const agent of sorted) {
    const depth = depthMap.get(agent.id) ?? 0;
    const key = `${agent.parent_id ?? "__root__"}:${depth}`;
    if (processedGroups.has(key)) continue;
    processedGroups.add(key);

    const siblings = siblingGroups.get(key) ?? [];

    // Assign rows within this sibling group
    // Track slots: each slot has an endMs
    const slots: Array<{ endMs: number; row: number }> = [];

    for (const sibling of siblings) {
      const sibEnd = sibling.status === "active" ? now : sibling.last_seen_ms;

      let placed = false;
      for (const slot of slots) {
        if (sibling.first_seen_ms >= slot.endMs) {
          // Sequential — reuse this slot's row
          compactRowMap.set(sibling.id, slot.row);
          slot.endMs = sibEnd;
          placed = true;
          break;
        }
      }

      if (!placed) {
        // Parallel — new row
        compactRowMap.set(sibling.id, currentRow);
        slots.push({ endMs: sibEnd, row: currentRow });
        currentRow++;
      }
    }
  }

  return sorted.map((agent) => ({
    agent,
    depth: depthMap.get(agent.id) ?? 0,
    startMs: agent.first_seen_ms,
    endMs: agent.status === "active" ? now : agent.last_seen_ms,
    rowIndex: compactRowMap.get(agent.id) ?? 0,
    leftPadding: (depthMap.get(agent.id) ?? 0) * 16,
  }));
}

function autoScaleUnit(durationMs: number): { unit: string; divisor: number } {
  if (durationMs < 10_000) return { unit: "ms", divisor: 1 };
  if (durationMs < 600_000) return { unit: "s", divisor: 1000 };
  if (durationMs < 36_000_000) return { unit: "min", divisor: 60_000 };
  return { unit: "hr", divisor: 3_600_000 };
}

const BAR_HEIGHT = 24;
const ROW_PADDING = 8;
const ROW_HEIGHT = BAR_HEIGHT + ROW_PADDING;
const LABEL_WIDTH = 160;
const AXIS_HEIGHT = 28;
const TICK_COUNT = 6;

const STATUS_COLORS: Record<string, string> = {
  active: "#3b82f6",
  awaiting: "#fbbf24",
  done: "#10b981",
  error: "#ef4444",
  stuck: "#f59e0b",
};

export default function TimelineView({
  state,
  selectedAgentId,
  onSelectAgent,
  statusFilter,
  onStatusFilterChange,
}: TimelineViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    agent: Agent;
    durationMs: number;
  } | null>(null);

  const allRows = useMemo(() => buildRows(state), [state]);

  // Counts from full row list (pre-filter) for StatusFilter chips
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<AgentStatus, number>> = {};
    for (const r of allRows) {
      counts[r.agent.status] = (counts[r.agent.status] ?? 0) + 1;
    }
    return counts;
  }, [allRows]);

  const rows = useMemo(
    () => allRows.filter((r) => statusFilter.has(r.agent.status)),
    [allRows, statusFilter]
  );

  const { minTs, maxTs, totalMs } = useMemo(() => {
    if (rows.length === 0) return { minTs: 0, maxTs: 0, totalMs: 0 };
    const minTs = Math.min(...rows.map((r) => r.startMs));
    const maxTs = Math.max(...rows.map((r) => r.endMs));
    return { minTs, maxTs, totalMs: maxTs - minTs || 1 };
  }, [rows]);

  const { unit, divisor } = autoScaleUnit(totalMs);

  // Total unique rows = max rowIndex + 1
  const totalRows = useMemo(
    () => (rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.rowIndex)) + 1),
    [rows]
  );

  const svgHeight = totalRows * ROW_HEIGHT + AXIS_HEIGHT + 8;

  const barColor = useCallback((agent: Agent): string => {
    const isStuck =
      agent.status === "active" &&
      Date.now() - agent.first_seen_ms > 120_000 &&
      Date.now() - agent.last_seen_ms < 30_000;
    if (isStuck) return STATUS_COLORS["stuck"]!;
    if (agent.status === "active") return STATUS_COLORS["active"]!;
    if (agent.status === "awaiting") return STATUS_COLORS["awaiting"]!;
    if (agent.status === "done") return STATUS_COLORS["done"]!;
    return STATUS_COLORS["error"]!;
  }, []);

  const handleBarClick = useCallback(
    (agentId: string) => {
      onSelectAgent(agentId === selectedAgentId ? null : agentId);
    },
    [selectedAgentId, onSelectAgent]
  );

  if (rows.length === 0) {
    return <EmptyState message="No agents yet — start a Claude Code session" />;
  }

  const toX = (tsMs: number, svgW: number): number =>
    LABEL_WIDTH + ((tsMs - minTs) / totalMs) * (svgW - LABEL_WIDTH - 8);

  const chartWidth = 800;

  return (
    <div ref={containerRef} className="h-full w-full overflow-auto p-4 relative">
      {/* Legend + StatusFilter */}
      <div className="flex items-center gap-4 mb-3 flex-wrap">
        {(["active", "done", "error", "stuck"] as const).map((s) => (
          <div key={s} className="flex items-center gap-1">
            <span
              className="w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ backgroundColor: STATUS_COLORS[s] }}
            />
            <span className="text-[9px] font-mono text-[var(--fg-subtle)] capitalize">{s}</span>
          </div>
        ))}
        <div className="ml-auto">
          <StatusFilter
            enabled={statusFilter}
            onChange={onStatusFilterChange}
            counts={statusCounts}
          />
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none rounded border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-xs font-mono text-[var(--fg)] shadow-lg"
          style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}
        >
          <div className="font-medium text-[var(--fg)]">{tooltip.agent.name}</div>
          <div className="text-[var(--fg-muted)] mt-0.5">
            {formatDuration(tooltip.durationMs)} · {tooltip.agent.tool_count} calls
          </div>
          {tooltip.agent.error_count > 0 && (
            <div className="text-red-400 mt-0.5">{tooltip.agent.error_count} errors</div>
          )}
        </div>
      )}

      <svg
        ref={svgRef}
        width="100%"
        height={svgHeight}
        viewBox={`0 0 ${chartWidth} ${svgHeight}`}
        preserveAspectRatio="xMinYMin meet"
        className="overflow-visible"
      >
        {/* Time axis at top */}
        <g>
          <line
            x1={LABEL_WIDTH}
            y1={AXIS_HEIGHT - 4}
            x2={chartWidth - 8}
            y2={AXIS_HEIGHT - 4}
            stroke="#27272a"
            strokeWidth={1}
          />
          {Array.from({ length: TICK_COUNT }, (_, i) => {
            const fraction = i / (TICK_COUNT - 1);
            const x = LABEL_WIDTH + fraction * (chartWidth - LABEL_WIDTH - 8);
            const tMs = fraction * totalMs;
            const label =
              unit === "ms"
                ? `${Math.round(tMs)}ms`
                : unit === "s"
                  ? `${(tMs / divisor).toFixed(1)}s`
                  : unit === "min"
                    ? `${(tMs / divisor).toFixed(1)}m`
                    : `${(tMs / divisor).toFixed(1)}h`;
            return (
              <g key={i}>
                <line x1={x} y1={AXIS_HEIGHT - 4} x2={x} y2={AXIS_HEIGHT} stroke="#27272a" strokeWidth={1} />
                <text
                  x={x}
                  y={12}
                  textAnchor="middle"
                  fontSize={9}
                  fontFamily="var(--font-mono)"
                  fill="#52525b"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>

        {/* Agent rows — positioned by rowIndex, not array index */}
        {rows.map((row) => {
          const y = AXIS_HEIGHT + row.rowIndex * ROW_HEIGHT + 4;
          const durationMs = row.endMs - row.startMs;
          const x1 = toX(row.startMs, chartWidth);
          const rawX2 = toX(row.endMs, chartWidth);
          const minBarW = 4;
          const barW = Math.max(rawX2 - x1, minBarW);
          const isSelected = row.agent.id === selectedAgentId;
          const color = barColor(row.agent);

          return (
            <g key={row.agent.id}>
              {/* Label with depth-based left padding */}
              <text
                x={4 + row.leftPadding}
                y={y + BAR_HEIGHT / 2 + 4}
                fontSize={10}
                fontFamily="var(--font-mono)"
                fill={isSelected ? "#fafafa" : "#a1a1aa"}
                className="cursor-pointer select-none"
                onClick={() => handleBarClick(row.agent.id)}
              >
                {row.agent.name.slice(0, Math.max(8, 18 - row.depth * 2))}
              </text>

              {/* Bar background track — only render once per unique rowIndex
                  (multiple agents can share a row for sequential placement) */}
              <rect
                x={LABEL_WIDTH}
                y={y + 2}
                width={chartWidth - LABEL_WIDTH - 8}
                height={BAR_HEIGHT - 4}
                fill="#111113"
                rx={2}
              />

              {/* Bar positioned at its actual time offset */}
              <rect
                x={x1}
                y={y + 2}
                width={barW}
                height={BAR_HEIGHT - 4}
                fill={color}
                fillOpacity={isSelected ? 1 : 0.75}
                rx={2}
                className="cursor-pointer"
                stroke={isSelected ? "#fff" : "none"}
                strokeWidth={isSelected ? 1 : 0}
                strokeOpacity={0.4}
                style={
                  row.agent.status === "active"
                    ? { animation: "pulse-active 2s ease-in-out infinite" }
                    : undefined
                }
                onClick={() => handleBarClick(row.agent.id)}
                onMouseEnter={(e) => {
                  const rect = (e.target as SVGRectElement).getBoundingClientRect();
                  setTooltip({
                    x: rect.left,
                    y: rect.top,
                    agent: row.agent,
                    durationMs,
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
              />

              {/* Inline duration label if bar is wide enough */}
              {barW > 40 && (
                <text
                  x={x1 + 4}
                  y={y + BAR_HEIGHT / 2 + 4}
                  fontSize={9}
                  fontFamily="var(--font-mono)"
                  fill="#fff"
                  fillOpacity={0.8}
                  pointerEvents="none"
                >
                  {formatDuration(durationMs)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
