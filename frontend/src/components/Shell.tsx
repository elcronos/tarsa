import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import type { Session, Agent, Event, ToolCall } from "../types";
import { formatDuration } from "../utils/format";
import { relativeTime } from "../utils/relativeTime";
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
  /** Clear the active project filter (used by sidebar "+N hidden" hint). */
  onClearProjectFilter?: () => void;
  /** Tarsa-managed projects (cwds opened via the `+ terminal` flow). */
  projects?: Array<{ cwd: string; name: string }>;
  selectedProjectCwd?: string | null;
  onSelectProject?: (cwd: string | null) => void;
  onRemoveProject?: (cwd: string) => void;
  /** Hide the agent-scoped Terminal tab in the right DetailPanel. Set when
   *  a project terminal is already docked in the main area so the user
   *  doesn't see two terminals competing for screen space. */
  hideAgentTerminalTab?: boolean;
  children: ReactNode;
}

function SessionItem({
  session,
  isSelected,
  onClick,
  onDismiss,
  agents,
  now,
  showIdSuffix = false,
}: {
  session: Session;
  isSelected: boolean;
  onClick: () => void;
  onDismiss: (e: React.MouseEvent) => void;
  agents: Agent[];
  now: number;
  showIdSuffix?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  // Prefer first user prompt as the label so sessions sharing a cwd basename
  // are still distinguishable. Fall back to cwd basename, then session id.
  const fallback = session.name ?? `Session ${session.id.slice(0, 8)}`;
  const baseName = session.title ?? fallback;
  const name = showIdSuffix && !session.title
    ? `${baseName} #${session.id.slice(0, 4)}`
    : baseName;
  const isActive = session.status === "active";
  const duration = session.ended_at
    ? formatDuration(session.ended_at - session.started_at)
    : formatDuration(now - session.started_at);

  // Compute idle/active label
  const hasActiveAgent = agents.some((a) => a.status === "active");
  const lastUpdated = agents.length > 0
    ? Math.max(...agents.map((a) => a.last_seen_ms), session.ended_at ?? 0, session.started_at)
    : (session.ended_at ?? session.started_at);
  let activityLabel: string;
  if (hasActiveAgent) {
    activityLabel = "active";
  } else if (agents.length > 0) {
    activityLabel = `idle ${formatDuration(now - lastUpdated)}`;
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
        <div className="mt-0.5 pl-3 text-[10px] font-mono flex items-center gap-1.5">
          <span
            className={
              hasActiveAgent
                ? "text-emerald-400"
                : "text-[var(--fg-subtle)]"
            }
          >
            {activityLabel}
          </span>
          <span
            className="text-[var(--fg-subtle)]"
            title={`Last updated ${new Date(lastUpdated).toLocaleString()}`}
          >
            · {relativeTime(lastUpdated, now)}
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
              // When multiple sessions in the same project share the same
              // basename label (e.g. all run from the repo root), append a
              // short id suffix so the user can tell them apart.
              showIdSuffix={sessions.length > 1}
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
  onClearProjectFilter,
  projects = [],
  selectedProjectCwd = null,
  onSelectProject,
  onRemoveProject,
  hideAgentTerminalTab = false,
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
  // Most-recent activity per session: max of (any agent's last_seen_ms,
  // session.ended_at, session.started_at). Used both for sort order and the
  // "updated Xm ago" label so the list always reflects current relevance.
  const lastUpdatedFor = (s: Session): number => {
    const ag = agentsBySession?.get(s.id) ?? [];
    let max = s.ended_at ?? s.started_at;
    for (const a of ag) {
      if (a.last_seen_ms > max) max = a.last_seen_ms;
    }
    return max;
  };
  const allSorted = [...sessions].sort(
    (a, b) => lastUpdatedFor(b) - lastUpdatedFor(a)
  );

  // A session is "live" if the backend still marks it active, OR at least
  // one of its agents is currently running. The session-level check keeps
  // the current Claude Code session visible between tool-call bursts when
  // every agent has momentarily flipped to "done".
  const isLive = (s: Session): boolean => {
    if (s.status === "active") return true;
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
  // How many sessions the project filter hides — surfaced as a clickable
  // hint so the user can tell when sessions are missing because of a pinned
  // filter (rather than a bug).
  const hiddenByFilter = projectFilter
    ? sortedSessions.length - filteredSessions.length
    : 0;

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
          {/* Tarsa-managed projects (manually opened folders / new projects) */}
          {projects.length > 0 && (
            <div className="mb-2">
              <div className="px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-[var(--accent)]">
                Projects
              </div>
              {projects.map((p) => {
                const isSel = selectedProjectCwd === p.cwd;
                return (
                  <div key={p.cwd} className="relative group">
                    <button
                      onClick={() => onSelectProject?.(isSel ? null : p.cwd)}
                      className={`
                        w-full text-left px-3 py-2 rounded transition-colors border-l-2
                        ${
                          isSel
                            ? "bg-[var(--surface-raised)] text-[var(--fg)] border-l-[var(--accent)]"
                            : "text-[var(--fg-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--fg)] border-l-transparent"
                        }
                      `}
                    >
                      <div className="flex items-center gap-1.5 pr-4">
                        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--accent)]" />
                        <span className="truncate text-xs font-mono">{p.name}</span>
                      </div>
                      <div className="mt-0.5 pl-3 text-[10px] text-[var(--fg-subtle)] font-mono truncate" title={p.cwd}>
                        {p.cwd.replace(/^\/Users\/[^/]+/, "~")}
                      </div>
                    </button>
                    {onRemoveProject && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onRemoveProject(p.cwd); }}
                        className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-[var(--fg-subtle)] hover:text-red-400 text-xs"
                        title="Remove from sidebar"
                        aria-label="Remove project"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Cross-session overview lives in the Global tab — no sidebar
              entry. Sidebar is per-session navigation only. */}

          {hiddenByFilter > 0 && (
            <button
              onClick={() => onClearProjectFilter?.()}
              className="w-full text-left px-3 py-1.5 mb-1 rounded text-[10px] font-mono text-amber-400/80 hover:text-amber-300 hover:bg-[var(--surface-raised)] border border-amber-500/20"
              title={`Clear project filter "${projectFilter}"`}
            >
              +{hiddenByFilter} hidden by filter · clear
            </button>
          )}

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
          session={sessions.find((s) => s.id === selectedAgent.session_id)}
          events={events}
          toolCalls={agentToolCalls}
          onClose={onClearAgent}
          hideTerminalTab={hideAgentTerminalTab}
        />
      )}
    </div>
  );
}
