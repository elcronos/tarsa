import { useCallback, useMemo, useRef, useState } from "react";
import EmptyState from "./EmptyState";
import { isTeamWorker } from "../utils/team";
import { useNow } from "../hooks/useNow";
import { formatDuration } from "../utils/format";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Panel,
  type Node,
  type Edge as RFEdge,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from "reactflow";
import dagre from "dagre";
import "reactflow/dist/style.css";
import type { State, AgentStatus } from "../types";
import AgentNode, { type AgentNodeData } from "./AgentNode";
import { isOrphanStub } from "../utils/orphan";
import { useEffect } from "react";
import StatusFilter, { type StatusFilterSet } from "./StatusFilter";

const LEGEND_STORAGE_KEY = "tarsa.legendOpen";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;

function getLayoutedElements(
  nodes: Node[],
  edges: RFEdge[],
  _direction: "LR" | "TB" = "LR"
): { nodes: Node[]; edges: RFEdge[] } {
  void _direction;
  // Custom layout: depth-based columns with grid-wrap for wide sibling groups.
  // Avoids dagre's tendency to stack many siblings into one tall column.
  const COL_X = NODE_WIDTH + 80; // horizontal gap between depth ranks
  const ROW_Y = NODE_HEIGHT + 24; // vertical gap between rows in a bucket
  const BUCKET_GAP_X = NODE_WIDTH + 40; // spacing between sub-columns in a bucket
  const MAX_PER_BUCKET_COL = 6; // wrap to a new sub-column after this many siblings

  // Build depth map via BFS from edges
  const childMap = new Map<string, string[]>();
  const parentMap = new Map<string, string>();
  for (const e of edges) {
    const arr = childMap.get(e.source) ?? [];
    arr.push(e.target);
    childMap.set(e.source, arr);
    parentMap.set(e.target, e.source);
  }
  const allIds = new Set(nodes.map((n) => n.id));
  const roots = nodes.filter((n) => !parentMap.has(n.id) || !allIds.has(parentMap.get(n.id)!));
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    depth.set(r.id, 0);
    queue.push(r.id);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const c of childMap.get(id) ?? []) {
      if (!depth.has(c)) {
        depth.set(c, d + 1);
        queue.push(c);
      }
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  // Group nodes by (parent_id, depth). Each group is a sibling bucket.
  const buckets = new Map<string, Node[]>();
  for (const n of nodes) {
    const p = parentMap.get(n.id) ?? "__root__";
    const d = depth.get(n.id) ?? 0;
    const k = `${p}:${d}`;
    const arr = buckets.get(k) ?? [];
    arr.push(n);
    buckets.set(k, arr);
  }

  // Layout each bucket as a grid (MAX_PER_BUCKET_COL rows, then wrap to new sub-column).
  // Track horizontal extent per depth so deeper buckets don't overlap shallower ones.
  const positions = new Map<string, { x: number; y: number }>();
  const maxXAtDepth = new Map<number, number>();

  // Process by depth order so parent bucket positions are known first.
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => {
    const da = parseInt(a.split(":").pop() ?? "0", 10);
    const db = parseInt(b.split(":").pop() ?? "0", 10);
    return da - db;
  });

  for (const key of sortedKeys) {
    const bucket = buckets.get(key)!;
    const d = depth.get(bucket[0]!.id) ?? 0;
    const baseX = d * COL_X;
    const cols = Math.ceil(bucket.length / MAX_PER_BUCKET_COL);
    // Anchor Y: align bucket near its parent's Y if known, else 0.
    const parentId = parentMap.get(bucket[0]!.id);
    const parentPos = parentId ? positions.get(parentId) : undefined;
    const anchorY = parentPos?.y ?? 0;
    bucket.forEach((n, i) => {
      const subCol = Math.floor(i / MAX_PER_BUCKET_COL);
      const subRow = i % MAX_PER_BUCKET_COL;
      const x = baseX + subCol * BUCKET_GAP_X;
      // Center the bucket vertically around the parent
      const rowsInThisCol = Math.min(MAX_PER_BUCKET_COL, bucket.length - subCol * MAX_PER_BUCKET_COL);
      const y = anchorY + (subRow - (rowsInThisCol - 1) / 2) * ROW_Y;
      positions.set(n.id, { x, y });
    });
    // Reserve horizontal range used by this bucket so deeper depths shift right.
    const usedRight = baseX + (cols - 1) * BUCKET_GAP_X + NODE_WIDTH;
    const prev = maxXAtDepth.get(d) ?? 0;
    if (usedRight > prev) maxXAtDepth.set(d, usedRight);
  }

  // Push deeper buckets right when shallower buckets used multiple sub-columns.
  // Walk depths ascending and shift positions to ensure no horizontal overlap.
  const orderedDepths = Array.from(maxXAtDepth.keys()).sort((a, b) => a - b);
  let cumulative = 0;
  for (const d of orderedDepths) {
    if (d === 0) {
      cumulative = (maxXAtDepth.get(0) ?? 0) + 60;
      continue;
    }
    // Move all nodes at this depth to start at `cumulative`
    const nodesAtDepth = nodes.filter((n) => depth.get(n.id) === d);
    if (nodesAtDepth.length === 0) continue;
    const minX = Math.min(...nodesAtDepth.map((n) => positions.get(n.id)?.x ?? 0));
    const shift = cumulative - minX;
    if (shift !== 0) {
      for (const n of nodesAtDepth) {
        const p = positions.get(n.id);
        if (p) positions.set(n.id, { x: p.x + shift, y: p.y });
      }
    }
    const widthAtDepth = (maxXAtDepth.get(d) ?? 0);
    cumulative += (widthAtDepth - d * COL_X) + 60 + COL_X;
  }

  const layoutedNodes = nodes.map((node) => {
    const p = positions.get(node.id) ?? { x: 0, y: 0 };
    return {
      ...node,
      position: { x: p.x, y: p.y },
    };
  });

  return { nodes: layoutedNodes, edges };
}

const nodeTypes = { agentNode: AgentNode };

interface TopologyInnerProps {
  state: State;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  statusFilter: StatusFilterSet;
  onStatusFilterChange: (next: StatusFilterSet) => void;
}

function TopologyInner({ state, selectedAgentId, onSelectAgent, statusFilter, onStatusFilterChange }: TopologyInnerProps) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Legend open/closed state, persisted in localStorage
  const [legendOpen, setLegendOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LEGEND_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toggleLegend = useCallback(() => {
    setLegendOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(LEGEND_STORAGE_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Edge hover state for label visibility
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  // Live tooltip for active nodes
  const now = useNow(1000);
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    setHoveredAgentId(node.id);
  }, []);

  const onNodeMouseLeave = useCallback(() => {
    setHoveredAgentId(null);
  }, []);

  // Compute tooltip content for the hovered node
  const tooltipContent = useMemo(() => {
    if (!hoveredAgentId) return null;
    const agent = state.agents.get(hoveredAgentId);
    if (!agent || agent.status !== "active") return null;
    // Find most-recent open ToolCall (no ended_at)
    const agentToolCalls = state.tool_calls.get(hoveredAgentId) ?? [];
    const openCall = agentToolCalls
      .filter((tc) => tc.ended_ms === null)
      .sort((a, b) => b.started_ms - a.started_ms)[0];
    if (!openCall) return null;
    const elapsed = formatDuration(now - openCall.started_ms);
    return `${openCall.tool_name} · running for ${elapsed}`;
  }, [hoveredAgentId, state.agents, state.tool_calls, now]);

  // Counts from full (pre-filter) agent list for the StatusFilter chips
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<AgentStatus, number>> = {};
    for (const a of state.agents.values()) {
      counts[a.status] = (counts[a.status] ?? 0) + 1;
    }
    return counts;
  }, [state.agents]);

  const derived = useMemo(() => {
    const now = Date.now();
    const visibleAgents = Array.from(state.agents.values()).filter(
      (a) => !isOrphanStub(a, now) && statusFilter.has(a.status)
    );
    const rawNodes: Node<AgentNodeData>[] = visibleAgents.map(
      (agent) => {
        const now = Date.now();
        const durationMs =
          agent.status === "active"
            ? now - agent.first_seen_ms
            : agent.last_seen_ms - agent.first_seen_ms;

        // Heuristic stuck detection: active for >2min with recent last_seen
        const isStuck =
          agent.status === "active" &&
          now - agent.first_seen_ms > 120_000 &&
          now - agent.last_seen_ms < 30_000;

        return {
          id: agent.id,
          type: "agentNode",
          position: { x: 0, y: 0 },
          data: {
            agent,
            isSelected: agent.id === selectedAgentId,
            isStuck,
            durationMs,
          },
        };
      }
    );

    const visibleIds = new Set(visibleAgents.map((a) => a.id));
    // Edge color by relationship type:
    //   main-spawn   — root session calling a direct subagent (cyan)
    //   nested       — subagent spawning a deeper subagent (purple)
    //   team-peer    — sibling coordination within a team (orange)
    const classify = (fromId: string, toId: string): "main" | "nested" | "team" => {
      const from = state.agents.get(fromId);
      const to = state.agents.get(toId);
      if (!from) return "main";
      if (from.parent_id === null) return "main";
      if ((from && isTeamWorker(from)) || (to && isTeamWorker(to))) return "team";
      return "nested";
    };
    const edgeColors: Record<"main" | "nested" | "team", string> = {
      main: "#22d3ee",
      nested: "#a78bfa",
      team: "#fb923c",
    };
    const rawEdges: RFEdge[] = state.edges
      .filter((e) => visibleIds.has(e.from_id) && visibleIds.has(e.to_id))
      .map((e) => {
        const kind = classify(e.from_id, e.to_id);
        const target = state.agents.get(e.to_id);
        const isRunning = target?.status === "active";
        const isError = target?.status === "error";
        const edgeId = `${e.from_id}->${e.to_id}`;
        const isHovered = hoveredEdgeId === edgeId;

        // Edge color: active=teal, error=amber, complete=faded border
        const color = isRunning
          ? "#14b8a6"
          : isError
            ? "#f59e0b"
            : "var(--border)";
        const opacity = isRunning ? 0.85 : isError ? 0.7 : 0.45;
        // Label color must stay readable even when edge is dim/faded.
        const labelColor = isRunning
          ? "#5eead4"
          : isError
            ? "#fbbf24"
            : "#e4e4e7";

        return {
          id: edgeId,
          source: e.from_id,
          target: e.to_id,
          label: isHovered ? e.label : undefined,
          animated: false,
          zIndex: isHovered ? 1000 : 0,
          className: isRunning ? "edge-running" : undefined,
          style: {
            stroke: color,
            strokeWidth: isRunning ? 1.5 : 1,
            opacity,
            strokeDasharray: isRunning ? "6 4" : undefined,
          },
          labelStyle: { fill: labelColor, fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 500 },
          labelBgStyle: { fill: "#1a1a1f", fillOpacity: 0.95, stroke: labelColor, strokeOpacity: 0.4, strokeWidth: 0.5 },
          labelBgPadding: [6, 4],
          labelBgBorderRadius: 4,
          labelShowBg: true,
        };
      });

    return getLayoutedElements(rawNodes, rawEdges, "LR");
  }, [state.agents, state.edges, selectedAgentId, statusFilter, hoveredEdgeId]);

  // Track whether the user has manually zoomed/panned. Only auto-fit on the
  // very first time nodes appear; after that the user controls the viewport.
  const hasInitialFit = useRef(false);
  useEffect(() => {
    setNodes(derived.nodes);
    setEdges(derived.edges);
    if (!hasInitialFit.current && derived.nodes.length > 0) {
      hasInitialFit.current = true;
      setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
    }
  }, [derived, setNodes, setEdges, fitView]);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectAgent(node.id === selectedAgentId ? null : node.id);
    },
    [selectedAgentId, onSelectAgent]
  );

  const onPaneClick = useCallback(() => {
    onSelectAgent(null);
  }, [onSelectAgent]);

  const onEdgeMouseEnter = useCallback((_: React.MouseEvent, edge: RFEdge) => {
    setHoveredEdgeId(edge.id);
  }, []);

  const onEdgeMouseLeave = useCallback(() => {
    setHoveredEdgeId(null);
  }, []);

  if (state.agents.size === 0) {
    return <EmptyState message="No agents yet — start a Claude Code session" />;
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      onEdgeMouseEnter={onEdgeMouseEnter}
      onEdgeMouseLeave={onEdgeMouseLeave}
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} color="#27272a" gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        nodeColor={(n) => {
          const d = n.data as AgentNodeData | undefined;
          if (!d) return "#27272a";
          if (d.isStuck) return "#f59e0b";
          if (d.agent.status === "active") return "#3b82f6";
          if (d.agent.status === "done") return "#10b981";
          return "#ef4444";
        }}
        maskColor="rgba(9,9,11,0.7)"
      />
      {/* Live tooltip for active node hover */}
      {tooltipContent && (
        <Panel position="top-left" className="!m-2 pointer-events-none">
          <div className="rounded border border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur px-2.5 py-1.5 text-[11px] font-mono text-emerald-400 shadow-lg">
            {tooltipContent}
          </div>
        </Panel>
      )}
      {/* Collapsible legend — bottom-right */}
      <Panel position="bottom-right" className="!m-4">
        <div className="flex flex-col items-end gap-1">
          {legendOpen && (
            <div
              className="rounded border border-[var(--border)] bg-[var(--surface)] shadow-lg p-3 text-[11px] font-mono text-[var(--fg-muted)]"
              style={{ width: 220 }}
            >
              <div className="text-[var(--fg)] font-semibold mb-2 text-[11px]">Legend</div>
              {/* Edge colors */}
              <div className="text-[var(--fg-muted)] uppercase tracking-wide text-[9px] mb-1">Edges</div>
              <div className="flex flex-col gap-1 mb-2">
                <span className="flex items-center gap-2">
                  <span className="inline-block w-5 h-px bg-[#22d3ee]" />
                  <span>root → subagent</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block w-5 h-px bg-[#a78bfa]" />
                  <span>nested</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block w-5 h-px bg-[#fb923c]" />
                  <span>team worker</span>
                </span>
              </div>
              {/* Node status */}
              <div className="text-[var(--fg-muted)] uppercase tracking-wide text-[9px] mb-1">Node status</div>
              <div className="flex flex-col gap-1 mb-2">
                <span className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>running</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                  <span>complete</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
                  <span>stuck</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                  <span>error</span>
                </span>
              </div>
              {/* Team badge */}
              <div className="text-[var(--fg-muted)] uppercase tracking-wide text-[9px] mb-1">Badges</div>
              <span className="flex items-center gap-2">
                <span className="rounded px-1 py-0.5 text-[9px] font-semibold bg-orange-500/20 text-orange-300 border border-orange-500/30">team</span>
                <span>worker / team node</span>
              </span>
            </div>
          )}
          <button
            onClick={toggleLegend}
            className="rounded-full w-7 h-7 flex items-center justify-center border border-[var(--border)] bg-[var(--surface-raised)] text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors text-[13px] font-semibold shadow"
            title={legendOpen ? "Hide legend" : "Show legend"}
          >
            {legendOpen ? "×" : "?"}
          </button>
        </div>
      </Panel>
      <Panel position="top-right" className="!m-2">
        <div className="rounded border border-[var(--border)] bg-[var(--surface)]/90 backdrop-blur px-2 py-1.5">
          <StatusFilter
            enabled={statusFilter}
            onChange={onStatusFilterChange}
            counts={statusCounts}
          />
        </div>
      </Panel>
    </ReactFlow>
  );
}

interface TopologyViewProps {
  state: State;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  statusFilter: StatusFilterSet;
  onStatusFilterChange: (next: StatusFilterSet) => void;
}

export default function TopologyView(props: TopologyViewProps) {
  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <TopologyInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
