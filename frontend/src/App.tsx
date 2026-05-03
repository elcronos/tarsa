import { useState, useEffect, useCallback, useRef } from "react";
import { useAgentState } from "./hooks/useAgentState";
import { useTimeTravel } from "./hooks/useTimeTravel";
import { useSearch } from "./hooks/useSearch";
import TopBar from "./components/TopBar";
import Shell from "./components/Shell";
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
import { loadDismissed, addDismissed, removeDismissed } from "./utils/session_storage";
import type { Session, AgentStatus } from "./types";
import { ALL_STATUSES, type StatusFilterSet } from "./components/StatusFilter";

export default function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState("topology");
  const [searchOpen, setSearchOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => loadDismissed());
  const [statusFilter, setStatusFilter] = useState<StatusFilterSet>(() => ALL_STATUSES);

  const handleStatusFilterChange = useCallback((next: StatusFilterSet) => {
    setStatusFilter(next);
  }, []);

  // Always subscribe to full unfiltered state so Global view can show all
  // sessions. Per-view filtering happens client-side via `displayState`.
  const { state, events, status, reconnect, lastError, reconnectAttempts } =
    useAgentState(undefined);

  const { scrubT, isScrubbing, setScrubT, clearScrub, traveledState } =
    useTimeTravel(events);

  const { query, setQuery, results } = useSearch();

  // The state to render (time-traveled or live)
  const baseState = isScrubbing && traveledState ? traveledState : state;
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
      />

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
            {activeView === "global" && (
              <GlobalView
                state={baseState}
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
