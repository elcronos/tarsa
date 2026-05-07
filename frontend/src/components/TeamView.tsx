import { useMemo, useRef, useState } from "react";
import type { State, Agent, ToolCall } from "../types";
import { isTeamWorker, teamRoleName, groupAgentsByTeam } from "../utils/team";
import EmptyState from "./EmptyState";

interface TeamViewProps {
  state: State;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
}

const ROW_HEIGHT = 36;
const LABEL_WIDTH = 140;
const AXIS_HEIGHT = 24;
const TOOL_HEIGHT = 12;
const COORD_TOOLS = new Set([
  "SendMessage",
  "TaskCreate",
  "TaskUpdate",
  "send_message",
  "task_create",
  "task_update",
]);

function statusColor(tc: ToolCall): string {
  if (tc.status === "running") return "#06b6d4";
  if (tc.status === "error") return "#ef4444";
  if (COORD_TOOLS.has(tc.tool_name)) return "#f59e0b";
  return "#14b8a6";
}

function findRecipientWorkerId(
  tc: ToolCall,
  workers: Agent[]
): string | null {
  const input = tc.input as Record<string, unknown>;
  const candidates = ["to", "recipient", "worker", "target"];
  for (const k of candidates) {
    const v = input[k];
    if (typeof v !== "string" || !v) continue;
    // Match by id, name, or role
    for (const w of workers) {
      if (w.id === v) return w.id;
      if (w.name === v) return w.id;
      const role = teamRoleName(w);
      if (role && role === v) return w.id;
    }
  }
  return null;
}

export default function TeamView({
  state,
  selectedAgentId,
  onSelectAgent,
}: TeamViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);

  // Group team workers
  const allAgents = useMemo(() => Array.from(state.agents.values()), [state.agents]);
  const teamWorkers = useMemo(() => allAgents.filter(isTeamWorker), [allAgents]);
  const teams = useMemo(() => {
    const grouped = groupAgentsByTeam(teamWorkers);
    // Drop the empty/non-team bucket if present
    grouped.delete("");
    return Array.from(grouped.entries());
  }, [teamWorkers]);

  // Time axis scale across all team workers
  const { minTs, maxTs, totalMs } = useMemo(() => {
    if (teamWorkers.length === 0) return { minTs: 0, maxTs: 0, totalMs: 1 };
    const now = Date.now();
    const min = Math.min(...teamWorkers.map((a) => a.first_seen_ms));
    const max = Math.max(
      ...teamWorkers.map((a) =>
        a.status === "active" ? now : a.last_seen_ms
      )
    );
    return { minTs: min, maxTs: max, totalMs: max - min || 1 };
  }, [teamWorkers]);

  if (teamWorkers.length === 0) {
    return <EmptyState message="No team workers detected in this session" />;
  }

  const chartWidth = 900;
  const toX = (tsMs: number): number =>
    LABEL_WIDTH + ((tsMs - minTs) / totalMs) * (chartWidth - LABEL_WIDTH - 8);

  const LEGEND_ITEMS: Array<{ color: string; label: string; hint: string }> = [
    { color: "#14b8a6", label: "tool · done", hint: "completed tool call" },
    { color: "#06b6d4", label: "tool · running", hint: "in-flight tool call" },
    { color: "#f59e0b", label: "coordination", hint: "SendMessage / TaskCreate / TaskUpdate" },
    { color: "#ef4444", label: "error", hint: "tool returned error" },
  ];

  return (
    <div className="h-full w-full overflow-auto p-4 relative">
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none rounded border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1.5 text-[10px] font-mono text-[var(--fg)] shadow-lg"
          style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Legend */}
      <div className="mb-4 flex items-center gap-4 flex-wrap text-[10px] font-mono text-[var(--fg-muted)]">
        <span className="text-[var(--fg-subtle)] uppercase tracking-wider">legend</span>
        {LEGEND_ITEMS.map((it) => (
          <span key={it.label} className="flex items-center gap-1.5" title={it.hint}>
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ backgroundColor: it.color }}
            />
            <span>{it.label}</span>
          </span>
        ))}
        <span className="flex items-center gap-1.5" title="selected worker indicator">
          <span className="inline-block w-1 h-3 rounded-sm" style={{ backgroundColor: "#14b8a6" }} />
          <span>selected lane</span>
        </span>
      </div>

      {teams.map(([teamKey, workers]) => {
        const totalRows = workers.length;
        const svgHeight = totalRows * ROW_HEIGHT + AXIS_HEIGHT + 8;
        // Build worker → row index map (stable order: first_seen_ms ASC)
        const sortedWorkers = [...workers].sort(
          (a, b) => a.first_seen_ms - b.first_seen_ms
        );
        const rowIndex = new Map<string, number>();
        sortedWorkers.forEach((w, i) => rowIndex.set(w.id, i));

        return (
          <section
            key={teamKey}
            className="mb-6 rounded border border-[var(--border)] bg-[var(--surface)] p-3"
          >
            <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
              Team · {teamKey === "team" ? "(mixed parents)" : teamKey.slice(0, 12)}
              <span className="ml-2 text-[var(--fg-muted)]">
                {workers.length} worker{workers.length !== 1 ? "s" : ""}
              </span>
            </div>
            <svg
              ref={svgRef}
              width="100%"
              height={svgHeight}
              viewBox={`0 0 ${chartWidth} ${svgHeight}`}
              preserveAspectRatio="xMinYMin meet"
            >
              {/* Lane backgrounds + labels */}
              {sortedWorkers.map((w, i) => {
                const y = AXIS_HEIGHT + i * ROW_HEIGHT;
                const rawRole = teamRoleName(w);
                const fullLabel = rawRole ? `worker-${rawRole}` : w.name.slice(0, 18);
                const idShort = w.id.slice(0, 6);
                const isSelected = w.id === selectedAgentId;
                const isAltRow = i % 2 === 1;
                return (
                  <g key={`lane-${w.id}`}>
                    <rect
                      x={LABEL_WIDTH}
                      y={y + 4}
                      width={chartWidth - LABEL_WIDTH - 8}
                      height={ROW_HEIGHT - 8}
                      fill={isAltRow ? "#0f1716" : "#111113"}
                      rx={2}
                    />
                    {isSelected && (
                      <rect
                        x={0}
                        y={y + 4}
                        width={2}
                        height={ROW_HEIGHT - 8}
                        fill="#14b8a6"
                      />
                    )}
                    <text
                      x={6}
                      y={y + ROW_HEIGHT / 2 + 1}
                      fontSize={10}
                      fontFamily="var(--font-mono)"
                      fill={isSelected ? "#fafafa" : "#cfd9d7"}
                      className="cursor-pointer select-none"
                      onClick={() =>
                        onSelectAgent(w.id === selectedAgentId ? null : w.id)
                      }
                    >
                      {fullLabel}
                    </text>
                    <text
                      x={6}
                      y={y + ROW_HEIGHT / 2 + 12}
                      fontSize={8}
                      fontFamily="var(--font-mono)"
                      fill="#5a6f6c"
                      pointerEvents="none"
                    >
                      {idShort}
                    </text>
                  </g>
                );
              })}

              {/* Tool calls per worker */}
              {sortedWorkers.flatMap((w) => {
                const calls = state.tool_calls.get(w.id) ?? [];
                const i = rowIndex.get(w.id) ?? 0;
                const y = AXIS_HEIGHT + i * ROW_HEIGHT;
                return calls.map((tc) => {
                  const x = toX(tc.started_ms);
                  const x2 = toX(tc.ended_ms ?? tc.started_ms + 200);
                  const w2 = Math.max(x2 - x, 3);
                  return (
                    <rect
                      key={`tc-${w.id}-${tc.id}`}
                      x={x}
                      y={y + (ROW_HEIGHT - TOOL_HEIGHT) / 2}
                      width={w2}
                      height={TOOL_HEIGHT}
                      fill={statusColor(tc)}
                      rx={1.5}
                      onMouseEnter={(e) => {
                        const r = (e.target as SVGRectElement).getBoundingClientRect();
                        setTooltip({
                          x: r.left,
                          y: r.top,
                          text: `${tc.tool_name} · ${tc.status}`,
                        });
                      }}
                      onMouseLeave={() => setTooltip(null)}
                    />
                  );
                });
              })}

              {/* Coordination arrows between workers */}
              {sortedWorkers.flatMap((sender) => {
                const calls = state.tool_calls.get(sender.id) ?? [];
                return calls
                  .filter((tc) => COORD_TOOLS.has(tc.tool_name))
                  .map((tc) => {
                    const recipientId = findRecipientWorkerId(tc, sortedWorkers);
                    if (!recipientId || recipientId === sender.id) return null;
                    const senderRow = rowIndex.get(sender.id);
                    const recipRow = rowIndex.get(recipientId);
                    if (senderRow == null || recipRow == null) return null;
                    const x = toX(tc.started_ms);
                    const y1 = AXIS_HEIGHT + senderRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const y2 = AXIS_HEIGHT + recipRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const cx1 = x + 30;
                    const path = `M ${x} ${y1} C ${cx1} ${y1}, ${cx1} ${y2}, ${x + 4} ${y2}`;
                    return (
                      <g key={`arrow-${sender.id}-${tc.id}`}>
                        <path
                          d={path}
                          stroke="#fb923c"
                          strokeWidth={1.2}
                          fill="none"
                          markerEnd="url(#arrow-orange)"
                        />
                      </g>
                    );
                  });
              })}

              <defs>
                <marker
                  id="arrow-orange"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#fb923c" />
                </marker>
              </defs>
            </svg>
          </section>
        );
      })}
    </div>
  );
}
