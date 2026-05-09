import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import type { Event, ToolCall, State, AgentStatus } from "../types";
import { formatTime, formatDuration } from "../utils/format";
import IOPair from "./IOPair";
import EmptyState from "./EmptyState";
import StatusFilter, { type StatusFilterSet } from "./StatusFilter";
import { summarizeTool } from "../utils/toolSummary";
import { isOrphanStub } from "../utils/orphan";

interface ReplayViewProps {
  events: Event[];
  toolCalls: Map<string, ToolCall[]>;
  selectedEventId?: string | null;
  /** Event id to flash-highlight briefly (e.g. when navigated to from search). */
  flashEventId?: string | null;
  onSelectEvent?: (id: string | null) => void;
  onSelectAgent?: (id: string | null) => void;
  state?: State;
  statusFilter?: StatusFilterSet;
  onStatusFilterChange?: (next: StatusFilterSet) => void;
}

// ── Color coding by event type ───────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  PreToolUse: "#3b82f6",
  PostToolUse: "#10b981",
  PostToolUseFailure: "#ef4444",
  SubagentStart: "#a78bfa",
  SubagentStop: "#71717a",
  Stop: "#f97316",
};

function eventColor(kind: string): string {
  return EVENT_COLORS[kind] ?? "#52525b";
}

// ── Status icon ──────────────────────────────────────────────────────────────

function StatusIcon({ kind }: { kind: string }) {
  if (kind === "PreToolUse") {
    return (
      <span className="inline-block w-3 h-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
    );
  }
  if (kind === "PostToolUse") {
    return <span className="text-emerald-400 text-xs leading-none">✓</span>;
  }
  if (kind === "PostToolUseFailure") {
    return <span className="text-red-400 text-xs leading-none">✗</span>;
  }
  if (kind === "SubagentStart") {
    return <span className="text-violet-400 text-xs leading-none">↳</span>;
  }
  if (kind === "SubagentStop") {
    return <span className="text-[var(--fg-subtle)] text-xs leading-none">□</span>;
  }
  return <span className="text-[var(--fg-subtle)] text-xs leading-none">·</span>;
}

// ── Retry detection ──────────────────────────────────────────────────────────

function buildRetrySet(events: Event[]): Set<string> {
  // Count (agent_id, tool_name, input_hash) occurrences
  const counts = new Map<string, number>();
  const retries = new Set<string>();
  for (const e of events) {
    if (e.hook_event !== "PreToolUse") continue;
    const key = `${e.agent_id ?? ""}|${e.tool_name ?? ""}|${JSON.stringify(e.tool_input ?? {}).slice(0, 200)}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > 1 && e.id) retries.add(e.id);
  }
  return retries;
}

// ── Event row ────────────────────────────────────────────────────────────────

function EventRow({
  event,
  isSelected,
  isFlashing,
  isRetry,
  agentName,
  onClick,
  scrollRef,
  forceExpanded,
}: {
  event: Event;
  isSelected: boolean;
  isFlashing: boolean;
  isRetry: boolean;
  agentName: string;
  onClick: () => void;
  scrollRef?: (el: HTMLDivElement | null) => void;
  forceExpanded: boolean;
}) {
  const kind = String(event.hook_event ?? "");
  const color = eventColor(kind);
  const toolName = event.tool_name ? String(event.tool_name) : null;
  const toolSummary = toolName ? summarizeTool(toolName, event.tool_input ?? {}) : null;

  const showDetail = isSelected || forceExpanded;

  const hasInput = event.tool_input && Object.keys(event.tool_input).length > 0;
  const hasOutput = Boolean(event.tool_response);
  const hasSomething = hasInput || hasOutput;

  return (
    <div
      ref={scrollRef}
      className={`border-b border-[var(--border)] cursor-pointer transition-colors ${
        isSelected
          ? "bg-[var(--surface-raised)] ring-1 ring-inset ring-[var(--accent)]"
          : "hover:bg-[var(--surface-raised)]/50"
      } ${isFlashing ? "tarsa-flash" : ""}`}
      onClick={onClick}
    >
      {/* Collapsed row */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        {/* Timestamp */}
        <span className="text-[10px] font-mono text-[var(--fg-subtle)] shrink-0 w-20">
          {formatTime(event.ts)}
        </span>

        {/* Status icon */}
        <span className="shrink-0 w-4 flex items-center justify-center">
          <StatusIcon kind={kind} />
        </span>

        {/* Agent name */}
        <span className="text-[10px] font-mono text-[var(--fg-muted)] truncate w-28 shrink-0">
          {agentName}
        </span>

        {/* Event type chip */}
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0"
          style={{ backgroundColor: `${color}18`, color }}
        >
          {kind}
        </span>

        {/* Tool name + plain-language summary */}
        {toolName && (
          <span className="text-[10px] font-mono text-[var(--fg)] truncate flex-1" title={toolSummary ?? toolName}>
            {toolSummary ?? toolName}
          </span>
        )}

        {/* Retry badge */}
        {isRetry && (
          <span className="text-[10px] font-mono text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded shrink-0">
            ↻ retry
          </span>
        )}
      </div>

      {/* Expanded detail */}
      {showDetail && hasSomething && (
        <div className="px-3 pb-3 border-t border-[var(--border)]">
          <IOPair
            input={hasInput ? event.tool_input : undefined}
            output={hasOutput ? event.tool_response : null}
          />
        </div>
      )}
      {showDetail && !hasSomething && (
        <div className="px-3 pb-3 border-t border-[var(--border)]">
          <IOPair input={event} output={null} />
        </div>
      )}
    </div>
  );
}

// ── Filter bar ───────────────────────────────────────────────────────────────

const EVENT_TYPES: Array<{ kind: string; label: string }> = [
  { kind: "PreToolUse", label: "Pre" },
  { kind: "PostToolUse", label: "Post" },
  { kind: "PostToolUseFailure", label: "Error" },
  { kind: "SubagentStart", label: "Start" },
  { kind: "SubagentStop", label: "Stop" },
];

interface Filters {
  agentId: string;
  toolName: string;
  enabledTypes: Set<string>;
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ReplayView({
  events,
  toolCalls: _toolCalls,
  selectedEventId,
  flashEventId,
  onSelectEvent,
  onSelectAgent,
  state,
  statusFilter,
  onStatusFilterChange,
}: ReplayViewProps) {
  const [filters, setFilters] = useState<Filters>({
    agentId: "",
    toolName: "",
    enabledTypes: new Set(EVENT_TYPES.map((t) => t.kind)),
  });
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const [showAllIO, setShowAllIO] = useState(false);
  const selectedId = selectedEventId !== undefined ? selectedEventId : internalSelected;
  const selectedRef = useRef<HTMLDivElement | null>(null);

  // ── Follow mode ─────────────────────────────────────────────────────────────
  const FOLLOW_KEY = "tarsa.replay-follow";
  const [follow, setFollow] = useState<boolean>(() => {
    try { return localStorage.getItem(FOLLOW_KEY) === "true"; } catch { return false; }
  });
  const listRef = useRef<HTMLDivElement | null>(null);
  // Track whether user is scrolling up (to auto-pause follow)
  const lastScrollTop = useRef<number>(0);

  const toggleFollow = useCallback(() => {
    setFollow((prev) => {
      const next = !prev;
      try { localStorage.setItem(FOLLOW_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Detect scroll-up → disable follow
  const handleListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const st = el.scrollTop;
    if (st < lastScrollTop.current) {
      // Scrolled up — pause follow
      setFollow(false);
      try { localStorage.setItem(FOLLOW_KEY, "false"); } catch { /* ignore */ }
    }
    lastScrollTop.current = st;
  }, []);

  // Auto-expand + scroll to the most recent event on mount and on data updates
  useEffect(() => {
    if (events.length === 0) return;
    const lastId = events[events.length - 1]!.id;
    setInternalSelected((prev) => {
      // Only auto-select if nothing is externally selected and the last event changed
      if (selectedEventId !== undefined && selectedEventId !== null) return prev;
      return lastId;
    });
  // Re-run whenever the last event changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length > 0 ? events[events.length - 1]!.id : null]);

  // Collect agent names from events
  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      if (e.agent_id && !map.has(e.agent_id)) {
        map.set(e.agent_id, e.agent_type ?? e.agent_id.slice(0, 12));
      }
    }
    return map;
  }, [events]);

  const retrySet = useMemo(() => buildRetrySet(events), [events]);

  // Compute agent status counts (orphan stubs excluded) for StatusFilter chips
  const statusCounts = useMemo(() => {
    const counts: Partial<Record<AgentStatus, number>> = {};
    if (state) {
      const nowMs = Date.now();
      for (const a of state.agents.values()) {
        if (isOrphanStub(a, nowMs)) continue;
        counts[a.status] = (counts[a.status] ?? 0) + 1;
      }
    }
    return counts;
  }, [state]);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      const kind = String(e.hook_event ?? "");
      if (!filters.enabledTypes.has(kind)) return false;
      if (filters.agentId && e.agent_id !== filters.agentId) return false;
      if (filters.toolName) {
        const tn = String(e.tool_name ?? "").toLowerCase();
        if (!tn.includes(filters.toolName.toLowerCase())) return false;
      }
      // Filter by agent status if statusFilter provided
      if (statusFilter && e.agent_id && state) {
        const agent = state.agents.get(e.agent_id);
        if (agent && !statusFilter.has(agent.status)) return false;
      }
      return true;
    });
  }, [events, filters, statusFilter, state]);

  // Auto-scroll to bottom when follow is ON and filtered list changes
  useLayoutEffect(() => {
    if (!follow) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTop.current = el.scrollTop;
  }, [follow, filtered.length]);

  const handleSelect = useCallback(
    (id: string, agentId?: string) => {
      const next = selectedId === id ? null : id;
      if (onSelectEvent) {
        onSelectEvent(next);
      } else {
        setInternalSelected(next);
      }
      // Also highlight the agent in DetailPanel when an event row is clicked
      if (onSelectAgent && agentId) {
        onSelectAgent(agentId);
      }
    },
    [selectedId, onSelectEvent, onSelectAgent]
  );

  const toggleType = useCallback((kind: string) => {
    setFilters((f) => {
      const next = new Set(f.enabledTypes);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return { ...f, enabledTypes: next };
    });
  }, []);

  // Scroll selected event into view
  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selectedId]);

  // Keyboard navigation: ArrowLeft/ArrowRight step through filtered events
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (filtered.length === 0) return;
      e.preventDefault();
      const currentIdx = filtered.findIndex((ev) => ev.id === selectedId);
      let nextIdx: number;
      if (e.key === "ArrowRight") {
        nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, filtered.length - 1);
      } else {
        nextIdx = currentIdx < 0 ? filtered.length - 1 : Math.max(currentIdx - 1, 0);
      }
      const nextEvent = filtered[nextIdx];
      if (!nextEvent) return;
      if (onSelectEvent) {
        onSelectEvent(nextEvent.id);
      } else {
        setInternalSelected(nextEvent.id);
      }
      if (onSelectAgent && nextEvent.agent_id) {
        onSelectAgent(nextEvent.agent_id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filtered, selectedId, onSelectEvent, onSelectAgent]);

  // Unique agent options for dropdown
  const agentOptions = useMemo(() => Array.from(agentNames.entries()), [agentNames]);

  if (events.length === 0) {
    return <EmptyState message="No events yet — start a Claude Code session to see replay" />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex-wrap shrink-0">
        {/* Agent filter */}
        <select
          value={filters.agentId}
          onChange={(e) => setFilters((f) => ({ ...f, agentId: e.target.value }))}
          className="text-[10px] font-mono bg-[var(--surface-raised)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--fg-muted)] min-w-0"
        >
          <option value="">All agents</option>
          {agentOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>

        {/* Tool name filter */}
        <input
          type="text"
          placeholder="tool name…"
          value={filters.toolName}
          onChange={(e) => setFilters((f) => ({ ...f, toolName: e.target.value }))}
          className="text-[10px] font-mono bg-[var(--surface-raised)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--fg-muted)] w-28 min-w-0"
        />

        {/* Event type chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {EVENT_TYPES.map(({ kind, label }) => {
            const on = filters.enabledTypes.has(kind);
            const color = eventColor(kind);
            return (
              <button
                key={kind}
                onClick={() => toggleType(kind)}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded transition-opacity"
                style={{
                  backgroundColor: on ? `${color}22` : "transparent",
                  color: on ? color : "var(--fg-subtle)",
                  border: `1px solid ${on ? `${color}44` : "var(--border)"}`,
                  opacity: on ? 1 : 0.5,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {statusFilter && onStatusFilterChange && (
            <StatusFilter
              enabled={statusFilter}
              onChange={onStatusFilterChange}
              counts={statusCounts}
            />
          )}
          <button
            onClick={() => setShowAllIO((v) => !v)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
              showAllIO
                ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
            }`}
          >
            {showAllIO ? "Hide all I/O" : "Show all I/O"}
          </button>
          <button
            onClick={toggleFollow}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
              follow
                ? "border-emerald-500/50 text-emerald-400 bg-emerald-500/10"
                : "border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
            }`}
            title={follow ? "Following — click to pause" : "Follow new events"}
          >
            {follow ? "⏸ Following" : "▶ Follow"}
          </button>
          <span className="text-[10px] font-mono text-[var(--fg-subtle)]">
            {filtered.length}/{events.length}
          </span>
        </div>
      </div>

      {/* Event list */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
        onScroll={handleListScroll}
      >
        {filtered.map((e) => (
          <EventRow
            key={e.id}
            event={e}
            isSelected={e.id === selectedId}
            isFlashing={flashEventId != null && e.id === flashEventId}
            isRetry={retrySet.has(e.id)}
            agentName={agentNames.get(e.agent_id ?? "") ?? e.agent_id?.slice(0, 12) ?? "unknown"}
            onClick={() => handleSelect(e.id, e.agent_id)}
            scrollRef={e.id === selectedId ? (el) => { selectedRef.current = el; } : undefined}
            forceExpanded={showAllIO}
          />
        ))}
      </div>
    </div>
  );
}
