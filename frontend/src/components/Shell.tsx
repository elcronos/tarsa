import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import type { Session, Agent, Event, ToolCall } from "../types";
import { formatDuration } from "../utils/format";
import { useNow } from "../hooks/useNow";
import { projectName, projectColor } from "../utils/project";
import DetailPanel from "./DetailPanel";

interface ShellProps {
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  onDismissSession: (id: string) => void;
  selectedAgent: Agent | null;
  onClearAgent: () => void;
  events: Event[];
  toolCalls: Map<string, ToolCall[]>;
  /** All agents grouped by session_id — used for idle/active label */
  agentsBySession?: Map<string, Agent[]>;
  /** Active project filter — only sessions in this project are shown */
  projectFilter?: string | null;
  children: ReactNode;
}

function SessionItem({
  session,
  isSelected,
  onClick,
  onDismiss,
  agents,
  now,
}: {
  session: Session;
  isSelected: boolean;
  onClick: () => void;
  onDismiss: (e: React.MouseEvent) => void;
  agents: Agent[];
  now: number;
}) {
  const [hovered, setHovered] = useState(false);
  const name = session.name ?? `Session ${session.id.slice(0, 8)}`;
  const isActive = session.status === "active";
  const duration = session.ended_at
    ? formatDuration(session.ended_at - session.started_at)
    : formatDuration(now - session.started_at);

  // Compute idle/active label
  const hasActiveAgent = agents.some((a) => a.status === "active");
  let activityLabel: string;
  if (hasActiveAgent) {
    activityLabel = "active";
  } else if (agents.length > 0) {
    const maxLastSeen = Math.max(...agents.map((a) => a.last_seen_ms));
    activityLabel = `idle ${formatDuration(now - maxLastSeen)}`;
  } else {
    activityLabel = "idle";
  }

  return (
    <div
      className="relative group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onClick}
        className={`
          w-full text-left px-3 py-2 rounded transition-colors group border-l-2
          ${
            isSelected
              ? "bg-[var(--surface-raised)] text-[var(--fg)] border-l-[var(--accent)]"
              : "text-[var(--fg-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--fg)] border-l-transparent"
          }
        `}
      >
        <div className="flex items-center gap-1.5 pr-4">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-emerald-400 animate-pulse" : "bg-[var(--fg-subtle)]"}`}
          />
          <span className="truncate text-xs font-mono">{name}</span>
        </div>
        <div className="mt-0.5 pl-3 text-[10px] text-[var(--fg-subtle)] font-mono">
          {duration}
        </div>
        <div className="mt-0.5 pl-3 text-[10px] font-mono">
          <span
            className={
              hasActiveAgent
                ? "text-emerald-400"
                : "text-[var(--fg-subtle)]"
            }
          >
            {activityLabel}
          </span>
        </div>
      </button>

      {/* Hover-X dismiss button */}
      {hovered && (
        <button
          onClick={onDismiss}
          className="absolute top-1.5 right-1.5 w-4 h-4 flex items-center justify-center rounded text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:bg-[var(--surface)] transition-colors text-xs leading-none"
          aria-label={`Dismiss session ${name}`}
          title="Dismiss session"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── Project group header ──────────────────────────────────────────────────────

const COLLAPSED_KEY = "tarsa.project-collapsed";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveCollapsed(s: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(s)));
  } catch {
    // ignore
  }
}

function ProjectGroup({
  name,
  sessions,
  selectedSessionId,
  onSelectSession,
  onDismissSession,
  agentsBySession,
  now,
}: {
  name: string;
  sessions: Session[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onDismissSession: (id: string) => void;
  agentsBySession?: Map<string, Agent[]>;
  now: number;
}) {
  const color = projectColor(name);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed().has(name));

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      const set = loadCollapsed();
      if (next) set.add(name);
      else set.delete(name);
      saveCollapsed(set);
      return next;
    });
  };

  return (
    <div className="mt-1">
      <button
        onClick={toggleCollapse}
        className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-mono hover:bg-[var(--surface-raised)] rounded transition-colors"
        style={{ color }}
      >
        <span className="shrink-0">{collapsed ? "▶" : "▼"}</span>
        <span className="truncate flex-1 text-left">{name}</span>
        <span className="shrink-0 text-[var(--fg-subtle)]">{sessions.length}</span>
      </button>
      {!collapsed && (
        <div className="space-y-0.5">
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isSelected={s.id === selectedSessionId}
              onClick={() => onSelectSession(s.id)}
              onDismiss={(e) => {
                e.stopPropagation();
                onDismissSession(s.id);
              }}
              agents={agentsBySession?.get(s.id) ?? []}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

export default function Shell({
  sessions,
  selectedSessionId,
  onSelectSession,
  onDismissSession,
  selectedAgent,
  onClearAgent,
  events,
  toolCalls,
  agentsBySession,
  projectFilter,
  children,
}: ShellProps) {
  const now = useNow(5_000);
  const agentToolCalls = selectedAgent
    ? (toolCalls.get(selectedAgent.id) ?? [])
    : [];

  const SHOW_STALE_KEY = "tarsa.showStale";
  const [showStale, setShowStale] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_STALE_KEY) === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(SHOW_STALE_KEY, String(showStale)); } catch {}
  }, [showStale]);

  // Sort sessions by started_at descending
  const allSorted = [...sessions].sort((a, b) => b.started_at - a.started_at);

  // A session is "live" only if at least one of its agents is currently
  // running. Idle/awaiting/done sessions are stale background noise from
  // prior Claude Code runs in the same cwd.
  const isLive = (s: { id: string }): boolean => {
    const sa = agentsBySession?.get(s.id) ?? [];
    if (sa.length === 0) return true;
    return sa.some((a) => a.status === "active");
  };

  const liveSessions = allSorted.filter(isLive);
  const staleSessions = allSorted.filter((s) => !isLive(s));
  const sortedSessions = showStale ? allSorted : liveSessions;

  // Apply project filter
  const filteredSessions = projectFilter
    ? sortedSessions.filter((s) => projectName(s.cwd) === projectFilter)
    : sortedSessions;

  // Group sessions by project name
  const projectGroups = new Map<string, Session[]>();
  for (const s of filteredSessions) {
    const name = projectName(s.cwd);
    const arr = projectGroups.get(name) ?? [];
    arr.push(s);
    projectGroups.set(name, arr);
  }
  // Sort group names: Unknown last, rest alphabetically
  const groupNames = Array.from(projectGroups.keys()).sort((a, b) => {
    if (a === "Unknown") return 1;
    if (b === "Unknown") return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left sidebar */}
      <div className="w-48 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
          <span className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-widest">
            Sessions
          </span>
          {staleSessions.length > 0 && (
            <button
              onClick={() => setShowStale((v) => !v)}
              className="text-[9px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg)] underline"
              title={showStale ? "Hide stale sessions" : "Show stale sessions"}
            >
              {showStale ? `hide stale (${staleSessions.length})` : `+${staleSessions.length} stale`}
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
          {/* All sessions entry */}
          <button
            onClick={() => onSelectSession(null)}
            className={`
              w-full text-left px-3 py-2 rounded transition-colors border-l-2
              ${
                selectedSessionId === null
                  ? "bg-[var(--surface-raised)] text-[var(--fg)] border-l-[var(--accent)]"
                  : "text-[var(--fg-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--fg)] border-l-transparent"
              }
            `}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-mono">All sessions</span>
            </div>
          </button>

          {filteredSessions.length === 0 ? (
            <div className="px-3 py-4 text-[10px] text-[var(--fg-subtle)] font-mono">
              No sessions yet
            </div>
          ) : (
            groupNames.map((name) => (
              <ProjectGroup
                key={name}
                name={name}
                sessions={projectGroups.get(name)!}
                selectedSessionId={selectedSessionId}
                onSelectSession={onSelectSession}
                onDismissSession={onDismissSession}
                agentsBySession={agentsBySession}
                now={now}
              />
            ))
          )}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">{children}</div>

      {/* Right detail panel */}
      {selectedAgent && (
        <DetailPanel
          agent={selectedAgent}
          events={events}
          toolCalls={agentToolCalls}
          onClose={onClearAgent}
        />
      )}
    </div>
  );
}
