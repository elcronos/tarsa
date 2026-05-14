import { useState, useEffect, useCallback, useRef } from "react";
import { useAgentState } from "./hooks/useAgentState";
import { useTimeTravel } from "./hooks/useTimeTravel";
import { useSearch } from "./hooks/useSearch";
import TopBar, { loadProjectFilter } from "./components/TopBar";
import Shell from "./components/Shell";
import { projectName } from "./utils/project";
import ErrorBoundary from "./components/ErrorBoundary";
import TopologyView from "./components/TopologyView";
import TimelineView from "./components/TimelineView";
import ReplayView from "./components/ReplayView";
import InsightsView from "./components/InsightsView";
import TimeTravelScrubber from "./components/TimeTravelScrubber";
import SessionDiffView from "./components/SessionDiffView";
import SearchPalette from "./components/SearchPalette";
import CommandPalette, { type CommandItem } from "./components/CommandPalette";
import { useHotkey } from "./hooks/useHotkey";
import GlobalView from "./components/GlobalView";
import SessionHistory from "./components/SessionHistory";
import RecentClosedSessions from "./components/RecentClosedSessions";
import TeamView from "./components/TeamView";
import MonitorView, { type InsightsPayload } from "./components/MonitorView";
import { isTeamWorker } from "./utils/team";
import { loadDismissed, addDismissed, removeDismissed } from "./utils/session_storage";
import { loadProjects, addProject, removeProject, type Project } from "./utils/projects";
import ProjectTerminal from "./components/ProjectTerminal";
import type { Session, AgentStatus } from "./types";
import { ALL_STATUSES, type StatusFilterSet } from "./components/StatusFilter";

function readSessionFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("session");
  } catch {
    return null;
  }
}

export default function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => readSessionFromUrl());
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState("global");
  const [prevView, setPrevView] = useState("global");
  const [monitorAgentId, setMonitorAgentId] = useState<string | null>(null);
  const [monitorInsights, setMonitorInsights] = useState<InsightsPayload>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => loadDismissed());
  const [statusFilter, setStatusFilter] = useState<StatusFilterSet>(() => ALL_STATUSES);
  const [projectFilter, setProjectFilter] = useState<string | null>(() => loadProjectFilter());
  // Tarsa-managed projects (cwds opened via the `+ terminal` flow). Persisted
  // in localStorage so the sidebar entry survives reloads.
  const [projects, setProjects] = useState<Project[]>(() => loadProjects());
  const [selectedProjectCwd, setSelectedProjectCwd] = useState<string | null>(null);
  // When true, the bottom dock shows vultuk's folder picker instead of an
  // existing project terminal. Once the user picks a folder, vultuk posts
  // back via postMessage and we promote it to a real project.
  const [pendingFolderPicker, setPendingFolderPicker] = useState(false);
  // Cached cc-web info — reused for both project terminals and the inline
  // folder picker so we don't refetch on every dock open.
  const [terminalInfo, setTerminalInfo] = useState<{ enabled: boolean; port: number; token: string } | null>(null);
  useEffect(() => {
    if (terminalInfo) return;
    fetch("/api/terminal/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setTerminalInfo(data))
      .catch(() => null);
  }, [terminalInfo]);
  const handleSelectProject = useCallback((cwd: string | null) => {
    setSelectedProjectCwd(cwd);
    // Project + session are independent: project drives the docked terminal,
    // session drives the topology view. Don't clear one when the other
    // changes — they coexist side-by-side.
  }, []);
  const handleRemoveProject = useCallback((cwd: string) => {
    setProjects((prev) => removeProject(prev, cwd));
    setSelectedProjectCwd((cur) => (cur === cwd ? null : cur));
  }, []);

  // Listen for vultuk session-created postMessage. Fires when the user
  // picks a folder in the inline picker (or in the right-panel agent
  // terminal). Promotes the folder to a Tarsa project, drops the picker,
  // and selects the new project so the dock seamlessly shows its terminal.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as { type?: string; cwd?: string; name?: string };
      if (!data || data.type !== "tarsa:session-created" || !data.cwd) return;
      const project = {
        cwd: data.cwd,
        name: data.name ?? data.cwd.split("/").pop() ?? "project",
      };
      setProjects((prev) => addProject(prev, project));
      setSelectedProjectCwd(project.cwd);
      setPendingFolderPicker(false);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleNewTerminal = useCallback(() => {
    setPendingFolderPicker(true);
    // Show the dock immediately by clearing any project so the picker
    // (rather than an existing terminal) renders.
    setSelectedProjectCwd(null);
  }, []);

  const handleStatusFilterChange = useCallback((next: StatusFilterSet) => {
    setStatusFilter(next);
  }, []);

  // Always subscribe to full unfiltered state so Global view can show all
  // sessions. Per-view filtering happens client-side via `displayState`.
  const {
    state,
    events,
    status,
    reconnect,
    lastError,
    reconnectAttempts,
    budgetExceeded,
    dismissBudgetExceeded,
  } = useAgentState(undefined);

  const { scrubT, isScrubbing, setScrubT, clearScrub, traveledState } =
    useTimeTravel(events);

  const { query, setQuery, results } = useSearch();

  // The state to render (time-traveled or live)
  const baseState = isScrubbing && traveledState ? traveledState : state;

  // Project-filtered base state for GlobalView
  const projectFilteredBaseState = projectFilter
    ? (() => {
        const filteredSessionIds = new Set(
          Array.from(baseState.sessions.values())
            .filter((s) => projectName(s.cwd) === projectFilter)
            .map((s) => s.id)
        );
        return {
          ...baseState,
          sessions: new Map(
            Array.from(baseState.sessions.entries()).filter(([, s]) =>
              filteredSessionIds.has(s.id)
            )
          ),
          agents: new Map(
            Array.from(baseState.agents.entries()).filter(([, a]) =>
              filteredSessionIds.has(a.session_id)
            )
          ),
          tool_calls: new Map(
            Array.from(baseState.tool_calls.entries()).filter(([id]) => {
              const a = baseState.agents.get(id);
              return a ? filteredSessionIds.has(a.session_id) : false;
            })
          ),
          events: baseState.events.filter((e) => filteredSessionIds.has(e.session_id)),
        };
      })()
    : baseState;
  // Trim to sessions whose most-recent activity falls inside a recency
  // window (active OR last_seen within 8h). Used both for the cross-session
  // Global view and as the fallback "all visible" scope when no session is
  // selected.
  const ALL_SESSIONS_RECENCY_MS = 8 * 60 * 60 * 1000; // 8h
  const recentSessionIds = (() => {
    if (selectedSessionId) return null; // single session — no extra trim
    const cutoff = Date.now() - ALL_SESSIONS_RECENCY_MS;
    const ids = new Set<string>();
    // last_seen per session = max(agent.last_seen_ms) ?? session.started_at.
    const perSession = new Map<string, number>();
    for (const a of baseState.agents.values()) {
      const cur = perSession.get(a.session_id) ?? 0;
      if (a.last_seen_ms > cur) perSession.set(a.session_id, a.last_seen_ms);
    }
    for (const s of baseState.sessions.values()) {
      const last = perSession.get(s.id) ?? s.ended_at ?? s.started_at;
      if (last >= cutoff || s.status === "active") ids.add(s.id);
    }
    return ids;
  })();

  // Global tab uses the full project-filtered state. GlobalView itself
  // splits live vs. stale and exposes a toggle, so trimming here would
  // de-sync the cross-session view from the sidebar's session list.
  const globalViewState = projectFilteredBaseState;

  const displayState = selectedSessionId
    ? {
        ...baseState,
        agents: new Map(
          Array.from(baseState.agents.entries()).filter(
            ([, a]) => a.session_id === selectedSessionId,
          ),
        ),
        tool_calls: new Map(
          Array.from(baseState.tool_calls.entries()).filter(([id]) => {
            const a = baseState.agents.get(id);
            return a ? a.session_id === selectedSessionId : false;
          }),
        ),
        events: baseState.events.filter((e) => e.session_id === selectedSessionId),
      }
    : recentSessionIds
      ? {
          ...baseState,
          sessions: new Map(
            Array.from(baseState.sessions.entries()).filter(([id]) => recentSessionIds.has(id)),
          ),
          agents: new Map(
            Array.from(baseState.agents.entries()).filter(
              ([, a]) => recentSessionIds.has(a.session_id),
            ),
          ),
          tool_calls: new Map(
            Array.from(baseState.tool_calls.entries()).filter(([id]) => {
              const a = baseState.agents.get(id);
              return a ? recentSessionIds.has(a.session_id) : false;
            }),
          ),
          events: baseState.events.filter((e) => recentSessionIds.has(e.session_id)),
        }
      : baseState;

  const displayEvents = selectedSessionId
    ? events.filter((e) => e.session_id === selectedSessionId)
    : recentSessionIds
      ? events.filter((e) => recentSessionIds.has(e.session_id))
      : events;

  const allSessions = Array.from(state.sessions.values()) as Session[];
  // Sessions shown in sidebar (exclude dismissed)
  const visibleSessions = allSessions.filter((s) => !dismissedIds.has(s.id));

  // Unique sorted project names derived from visible sessions
  const projectNames = Array.from(
    new Set(visibleSessions.map((s) => projectName(s.cwd)))
  ).sort((a, b) => {
    if (a === "Unknown") return 1;
    if (b === "Unknown") return -1;
    return a.localeCompare(b);
  });

  // Agents grouped by session_id — used for idle/active label in Shell sidebar
  const agentsBySession = new Map<string, import("./types").Agent[]>();
  for (const agent of state.agents.values()) {
    const list = agentsBySession.get(agent.session_id) ?? [];
    list.push(agent);
    agentsBySession.set(agent.session_id, list);
  }
  // Dismissed sessions for the history popover
  const dismissedSessions = allSessions.filter((s) => dismissedIds.has(s.id));

  // Auto-select first active session ONCE, on initial mount when sessions
  // arrive. Don't re-fire when the user explicitly selects "All sessions"
  // (selectedSessionId === null) — that would defeat the choice.
  const hasAutoSelected = useRef(false);
  useEffect(() => {
    if (hasAutoSelected.current) return;
    if (selectedSessionId !== null) {
      hasAutoSelected.current = true;
      return;
    }
    if (visibleSessions.length === 0) return;
    const active = visibleSessions.find((s) => s.status === "active");
    const fallback = visibleSessions[visibleSessions.length - 1];
    const pick = active ?? fallback;
    if (pick) {
      hasAutoSelected.current = true;
      setSelectedSessionId(pick.id);
    }
  }, [selectedSessionId, visibleSessions]);

  // Sync selectedSessionId into the browser URL (feature 13)
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedSessionId) {
      url.searchParams.set("session", selectedSessionId);
    } else {
      url.searchParams.delete("session");
    }
    window.history.replaceState(null, "", url.toString());
  }, [selectedSessionId]);

  // Team tab visibility: show iff at least one team worker exists in displayState
  const showTeamTab = Array.from(displayState.agents.values()).some(isTeamWorker);

  // Budget for the selected session — server value if present, else localStorage fallback
  const sessionBudgetUsd = (() => {
    if (!selectedSessionId) return undefined;
    const session = state.sessions.get(selectedSessionId);
    if (typeof session?.budget_usd === "number" && session.budget_usd > 0) {
      return session.budget_usd;
    }
    try {
      const raw = localStorage.getItem(`tarsa.budget.${selectedSessionId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { budget_usd?: number };
        if (typeof parsed.budget_usd === "number" && parsed.budget_usd > 0) {
          return parsed.budget_usd;
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  })();

  // Look up in displayState first (filtered view); fall back to baseState
  // so DetailPanel works when an agent is selected from a different session
  // than the active session (e.g. clicking nodes in the Global view).
  const selectedAgent = selectedAgentId
    ? (displayState.agents.get(selectedAgentId) ??
       baseState.agents.get(selectedAgentId) ??
       null)
    : null;

  const handleSelectSession = (id: string | null) => {
    setSelectedSessionId(id);
    setSelectedAgentId(null);
    if (id === null) {
      setActiveView("global");
    }
  };

  const handleSelectAgent = (id: string | null) => {
    setSelectedAgentId(id);
  };

  const handleViewChange = (view: string) => {
    if (view !== "monitor") setPrevView(activeView);
    setActiveView(view);
  };

  const handleEnterMonitor = useCallback((agentId: string) => {
    setMonitorAgentId(agentId);
    setPrevView(activeView);
    setActiveView("monitor");
    const sessionId = Array.from(displayState.agents.values()).find((a) => a.id === agentId)?.session_id;
    const url = sessionId ? `/api/insights?session=${sessionId}` : "/api/insights";
    fetch(url)
      .then((r) => r.ok ? r.json() as Promise<InsightsPayload> : Promise.reject())
      .then((data) => setMonitorInsights(data))
      .catch(() => setMonitorInsights({}));
  }, [activeView, displayState.agents]);

  const handleExitMonitor = useCallback(() => {
    setActiveView(prevView);
    setMonitorAgentId(null);
  }, [prevView]);

  const handleDismissSession = useCallback((sessionId: string) => {
    setDismissedIds((prev) => addDismissed(prev, sessionId));
    // If dismissed session was selected, clear selection
    if (selectedSessionId === sessionId) {
      setSelectedSessionId(null);
      setSelectedAgentId(null);
    }
  }, [selectedSessionId]);

  const handleRestoreSession = useCallback((sessionId: string) => {
    setDismissedIds((prev) => removeDismissed(prev, sessionId));
  }, []);

  // Keyboard shortcuts
  // Cmd/Ctrl+K → command palette (jump-to nav). Event search remains
  // reachable via the topbar search button and Cmd/Ctrl+Shift+F.
  useHotkey("mod+k", () => {
    setCommandOpen((v) => !v);
    setSearchOpen(false);
  }, []);
  useHotkey("shift+mod+f", () => {
    setSearchOpen((v) => !v);
    setCommandOpen(false);
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (commandOpen) {
          setCommandOpen(false);
        } else if (searchOpen) {
          setSearchOpen(false);
        } else if (activeView === "monitor") {
          handleExitMonitor();
        } else if (selectedAgentId !== null) {
          // ESC closes DetailPanel (US-015)
          setSelectedAgentId(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen, commandOpen, selectedAgentId, activeView, handleExitMonitor]);

  const [flashEventId, setFlashEventId] = useState<string | null>(null);
  const handleSearchResult = useCallback(
    (result: { event: { id: string; session_id?: string; agent_id?: string } }) => {
      const ev = result.event;
      setSearchOpen(false);
      // Switch to the session that owns the event so it's actually in view.
      if (ev.session_id) setSelectedSessionId(ev.session_id);
      // Reset filters that could hide the event.
      setStatusFilter(ALL_STATUSES);
      setSelectedEventId(ev.id);
      if (ev.agent_id) setSelectedAgentId(ev.agent_id);
      setActiveView("replay");
      setFlashEventId(ev.id);
    },
    []
  );

  // Auto-clear flash highlight after a couple seconds.
  useEffect(() => {
    if (!flashEventId) return;
    const t = setTimeout(() => setFlashEventId(null), 2400);
    return () => clearTimeout(t);
  }, [flashEventId]);

  // Build command palette items: tabs + sessions + agents + actions.
  // Kept inline rather than memoised — list is short and `state` ref changes
  // each render anyway, so memo would seldom hit.
  const commandItems: CommandItem[] = (() => {
    const items: CommandItem[] = [];
    const tabs: Array<{ id: string; label: string }> = [
      { id: "topology", label: "Topology" },
      { id: "global", label: "Global" },
      { id: "timeline", label: "Timeline" },
      { id: "replay", label: "Replay" },
      { id: "insights", label: "Insights" },
    ];
    if (showTeamTab) tabs.push({ id: "team", label: "Team" });
    for (const t of tabs) {
      items.push({
        id: `tab:${t.id}`,
        kind: "tab",
        label: `Go to ${t.label}`,
        hint: activeView === t.id ? "current" : undefined,
        action: () => handleViewChange(t.id),
      });
    }
    // Project terminals
    for (const p of projects) {
      items.push({
        id: `proj:${p.cwd}`,
        kind: "terminal",
        label: `Terminal · ${p.name}`,
        hint: p.cwd,
        action: () => handleSelectProject(p.cwd),
      });
    }
    items.push({
      id: "action:new-terminal",
      kind: "action",
      label: "New terminal…",
      action: () => handleNewTerminal(),
    });
    items.push({
      id: "action:all-sessions",
      kind: "action",
      label: "Show all sessions",
      action: () => handleSelectSession(null),
    });
    items.push({
      id: "action:event-search",
      kind: "action",
      label: "Search events…",
      hint: "⇧⌘F",
      action: () => setSearchOpen(true),
    });
    items.push({
      id: "action:history",
      kind: "action",
      label: "Toggle session history",
      action: () => setHistoryOpen((v) => !v),
    });
    if (projectFilter) {
      items.push({
        id: "action:clear-project-filter",
        kind: "action",
        label: `Clear project filter (${projectFilter})`,
        action: () => {
          try { localStorage.removeItem("tarsa.project-filter"); } catch { /* ignore */ }
          setProjectFilter(null);
        },
      });
    }
    // Sessions (jump-to)
    for (const s of visibleSessions) {
      const label = s.name ?? s.id;
      items.push({
        id: `sess:${s.id}`,
        kind: "session",
        label: `Jump to ${label}`,
        hint: `${s.status} · ${s.id.slice(0, 8)}`,
        action: () => handleSelectSession(s.id),
      });
    }
    // Agents — limit to current display scope to keep list short
    for (const a of displayState.agents.values()) {
      const label = a.name || a.id;
      items.push({
        id: `agent:${a.id}`,
        kind: "agent",
        label: `Select ${label}`,
        hint: `${a.status} · ${a.id.slice(0, 8)}`,
        action: () => {
          if (a.session_id && a.session_id !== selectedSessionId) {
            setSelectedSessionId(a.session_id);
          }
          handleSelectAgent(a.id);
        },
      });
    }
    return items;
  })();

  // Time range for scrubber
  const sessionStart = displayEvents.length > 0 ? displayEvents[0]!.ts : Date.now();
  const sessionEnd =
    displayEvents.length > 0 ? displayEvents[displayEvents.length - 1]!.ts : Date.now();

  return (
    <div className="h-screen flex flex-col bg-[var(--bg)] text-[var(--fg)] overflow-hidden">
      <TopBar
        activeView={activeView}
        onViewChange={handleViewChange}
        status={status}
        onReconnect={reconnect}
        onSearchOpen={() => setSearchOpen(true)}
        onHistoryOpen={() => setHistoryOpen((v) => !v)}
        onArchiveOpen={() => setArchiveOpen((v) => !v)}
        lastError={lastError}
        reconnectAttempts={reconnectAttempts}
        projectNames={projectNames}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        showTeamTab={showTeamTab}
        selectedSessionId={selectedSessionId}
        selectedAgentId={selectedAgentId}
        sessionBudgetUsd={sessionBudgetUsd}
        onNewTerminal={handleNewTerminal}
        onEnterMonitor={handleEnterMonitor}
      />

      {/* Budget exceeded banner */}
      {budgetExceeded && (
        <div className="flex items-center justify-between px-3 py-2 bg-red-500/15 border-b border-red-500/40 text-xs font-mono text-red-300">
          <span>
            ⚠ Budget exceeded for{" "}
            {state.sessions.get(budgetExceeded.session_id)?.name ??
              budgetExceeded.session_id}
            : ${budgetExceeded.current.toFixed(4)} of ${budgetExceeded.budget.toFixed(2)}
            {budgetExceeded.kill ? " (kill flag set)" : ""}
          </span>
          <button
            onClick={dismissBudgetExceeded}
            className="ml-2 px-2 py-0.5 rounded border border-red-400/40 text-red-300 hover:bg-red-500/20"
          >
            dismiss
          </button>
        </div>
      )}

      {/* Session history popover */}
      {historyOpen && (
        <SessionHistory
          dismissedSessions={dismissedSessions}
          onRestore={handleRestoreSession}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {/* Recently closed sessions popover */}
      {archiveOpen && (
        <RecentClosedSessions
          onSelectSession={(id) => { handleSelectSession(id); }}
          onClose={() => setArchiveOpen(false)}
        />
      )}

      <ErrorBoundary>
      <Shell
        sessions={visibleSessions}
        selectedSessionId={selectedSessionId}
        onSelectSession={handleSelectSession}
        onDismissSession={handleDismissSession}
        selectedAgent={selectedAgent}
        onClearAgent={() => setSelectedAgentId(null)}
        events={displayEvents}
        toolCalls={displayState.tool_calls}
        agentsBySession={agentsBySession}
        projectFilter={projectFilter}
        onClearProjectFilter={() => {
          try { localStorage.removeItem("tarsa.project-filter"); } catch { /* ignore */ }
          setProjectFilter(null);
        }}
        projects={projects}
        selectedProjectCwd={selectedProjectCwd}
        onSelectProject={handleSelectProject}
        onRemoveProject={handleRemoveProject}
        hideAgentTerminalTab={!!selectedProjectCwd}
      >
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="flex-1 overflow-hidden">
            {activeView === "topology" && (
              <TopologyView
                state={displayState}
                selectedAgentId={selectedAgentId}
                onSelectAgent={handleSelectAgent}
                statusFilter={statusFilter}
                onStatusFilterChange={handleStatusFilterChange}
                onMonitor={handleEnterMonitor}
              />
            )}
            {activeView === "timeline" && (
              <TimelineView
                state={displayState}
                selectedAgentId={selectedAgentId}
                onSelectAgent={handleSelectAgent}
                statusFilter={statusFilter}
                onStatusFilterChange={handleStatusFilterChange}
              />
            )}
            {activeView === "replay" && (
              <ReplayView
                events={displayEvents}
                toolCalls={displayState.tool_calls}
                selectedEventId={selectedEventId}
                flashEventId={flashEventId}
                onSelectEvent={setSelectedEventId}
                onSelectAgent={handleSelectAgent}
                state={displayState}
                statusFilter={statusFilter}
                onStatusFilterChange={handleStatusFilterChange}
              />
            )}
            {activeView === "insights" && (
              <InsightsView state={displayState} />
            )}
            {activeView === "monitor" && monitorAgentId && (() => {
              const monAgent = displayState.agents.get(monitorAgentId) ?? baseState.agents.get(monitorAgentId);
              if (!monAgent) { handleExitMonitor(); return null; }
              return (
                <MonitorView
                  agent={monAgent}
                  events={displayEvents}
                  insights={monitorInsights}
                  onExit={handleExitMonitor}
                />
              );
            })()}
            {activeView === "compare" && (
              <SessionDiffView />
            )}
            {activeView === "team" && showTeamTab && selectedSessionId && (
              <TeamView
                state={displayState}
                selectedAgentId={selectedAgentId}
                onSelectAgent={handleSelectAgent}
              />
            )}
            {activeView === "global" && (
              <GlobalView
                state={globalViewState}
                onSelectAgent={handleSelectAgent}
                statusFilter={statusFilter}
                onStatusFilterChange={handleStatusFilterChange}
                selectedAgentId={selectedAgentId}
                selectedSessionId={selectedSessionId}
                onSelectSession={handleSelectSession}
              />
            )}
          </div>

          {/* Time-travel scrubber — visible when timeline/topology active */}
          {(activeView === "topology" || activeView === "timeline") && events.length > 1 && (
            <TimeTravelScrubber
              minTs={sessionStart}
              maxTs={sessionEnd}
              scrubT={scrubT}
              onChange={setScrubT}
              onClear={clearScrub}
            />
          )}
          </div>{/* /views column */}

          {/* Bottom dock — same surface for both modes:
              - Project selected: ProjectTerminal for that cwd.
              - Folder picker pending: vultuk's folder browser inline. After
                the user picks, postMessage promotes it to a project and the
                dock content swaps to the live terminal in the same place. */}
          {(selectedProjectCwd || pendingFolderPicker) && (
            <div
              className="shrink-0 border-t border-[var(--border)] flex flex-col overflow-hidden"
              // Picker UI needs more vertical room to show its action buttons
              // (Cancel / Select This Folder) — vultuk's modal is fixed-height
              // and clips below ~520px. The live terminal is fine at 45%.
              style={{ height: pendingFolderPicker && !selectedProjectCwd ? "min(640px, 70vh)" : "45%" }}
            >
              {selectedProjectCwd ? (() => {
                const proj = projects.find((p) => p.cwd === selectedProjectCwd);
                return proj ? <ProjectTerminal cwd={proj.cwd} name={proj.name} /> : null;
              })() : (
                <FolderPickerDock
                  info={terminalInfo}
                  onClose={() => setPendingFolderPicker(false)}
                />
              )}
            </div>
          )}
        </div>{/* /flex-col main */}
      </Shell>
      </ErrorBoundary>

      {/* Command palette — jump-to nav (Cmd/Ctrl+K) */}
      {commandOpen && (
        <CommandPalette
          items={commandItems}
          onClose={() => setCommandOpen(false)}
        />
      )}

      {/* Search palette overlay — event search (Cmd/Ctrl+Shift+F) */}
      {searchOpen && (
        <SearchPalette
          query={query}
          onQueryChange={setQuery}
          results={results}
          onSelectResult={handleSearchResult}
          onClose={() => setSearchOpen(false)}
        />
      )}

    </div>
  );
}

/**
 * FolderPickerDock — renders vultuk's folder browser inline in the bottom
 * dock when the user clicks `+ terminal`. Same physical surface as the
 * live project terminal, so the user never sees a popup/modal layer.
 * vultuk posts back via `tarsa:session-created`; App handles that and
 * swaps the dock content to a live ProjectTerminal in place.
 */
function FolderPickerDock({
  info,
  onClose,
}: {
  info: { enabled: boolean; port: number; token: string } | null;
  onClose: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]">
        <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--accent)]">
          new terminal · pick or create a folder
        </span>
        <button
          onClick={onClose}
          className="text-[var(--fg-subtle)] hover:text-[var(--fg)] text-sm px-2"
          aria-label="Close picker"
        >
          ×
        </button>
      </div>
      {info?.enabled && info.token && info.port ? (
        <iframe
          title="Folder picker"
          src={`http://localhost:${info.port}/?token=${encodeURIComponent(info.token)}&action=newproject`}
          sandbox="allow-scripts allow-same-origin allow-forms"
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
          className="flex-1 w-full bg-black"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-[var(--fg-subtle)]">
          Loading picker…
        </div>
      )}
    </>
  );
}
