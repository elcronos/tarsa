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
import GlobalView from "./components/GlobalView";
import SessionHistory from "./components/SessionHistory";
import TeamView from "./components/TeamView";
import { isTeamWorker } from "./utils/team";
import { loadDismissed, addDismissed, removeDismissed } from "./utils/session_storage";
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
  const [activeView, setActiveView] = useState("topology");
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => loadDismissed());
  const [statusFilter, setStatusFilter] = useState<StatusFilterSet>(() => ALL_STATUSES);
  const [projectFilter, setProjectFilter] = useState<string | null>(() => loadProjectFilter());

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
    : baseState;

  const displayEvents = selectedSessionId
    ? events.filter((e) => e.session_id === selectedSessionId)
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
    setActiveView(view);
  };

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
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") {
        if (searchOpen) {
          setSearchOpen(false);
        } else if (selectedAgentId !== null) {
          // ESC closes DetailPanel (US-015)
          setSelectedAgentId(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen, selectedAgentId]);

  const handleSearchResult = useCallback((eventId: string) => {
    setSearchOpen(false);
    setSelectedEventId(eventId);
    setActiveView("replay");
  }, []);

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
        lastError={lastError}
        reconnectAttempts={reconnectAttempts}
        projectNames={projectNames}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        showTeamTab={showTeamTab}
        selectedSessionId={selectedSessionId}
        sessionBudgetUsd={sessionBudgetUsd}
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
      >
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {activeView === "topology" && (
              <TopologyView
                state={displayState}
                selectedAgentId={selectedAgentId}
                onSelectAgent={handleSelectAgent}
                statusFilter={statusFilter}
                onStatusFilterChange={handleStatusFilterChange}
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
                state={projectFilteredBaseState}
                onSelectAgent={handleSelectAgent}
                statusFilter={statusFilter}
                onStatusFilterChange={handleStatusFilterChange}
                selectedAgentId={selectedAgentId}
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
        </div>
      </Shell>
      </ErrorBoundary>

      {/* Search palette overlay */}
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
