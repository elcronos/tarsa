import { useState, useEffect, useRef, useCallback } from "react";
import type { Event, State, Session, Agent, ToolCall, Edge } from "../types";
import { emptyState, applyEvent } from "../replay";

interface SerializedState {
  sessions: Record<string, Session>;
  agents: Record<string, Agent>;
  edges: Edge[];
  tool_calls: Record<string, ToolCall[]>;
}

function deserializeState(s: SerializedState, events: Event[]): State {
  return {
    sessions: new Map(Object.entries(s.sessions ?? {})),
    agents: new Map(Object.entries(s.agents ?? {})),
    edges: s.edges ?? [],
    tool_calls: new Map(Object.entries(s.tool_calls ?? {})),
    events,
    pending_subagents: new Map(),
  };
}

export type ConnectionStatus = "connecting" | "live" | "error";

export interface UseAgentStateResult {
  events: Event[];
  state: State;
  status: ConnectionStatus;
  reconnect: () => void;
  lastError: string | null;
  reconnectAttempts: number;
}

const BACKOFF_DELAYS = [1000, 2000, 4000, 10000];

function getBackoffDelay(attempt: number): number {
  return BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)] ?? 10000;
}

export function useAgentState(_sessionFilter?: string): UseAgentStateResult {
  void _sessionFilter;
  const [events, setEvents] = useState<Event[]>([]);
  const [state, setState] = useState<State>(emptyState());
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const esRef = useRef<EventSource | null>(null);
  const attemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Close existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    setStatus("connecting");

    const url = "/api/events/stream";
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      attemptsRef.current = 0;
      setReconnectAttempts(0);
      setLastError(null);
      setStatus("live");
    };

    es.onmessage = (ev: MessageEvent<string>) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(ev.data) as
          | { type: "snapshot"; events: Event[]; state?: SerializedState }
          | { type: "event"; event: Event }
          | { type: "disconnect" };

        if (msg.type === "snapshot") {
          const raw = msg.events;
          let derived: State;
          if (msg.state) {
            derived = deserializeState(msg.state, raw);
          } else {
            derived = emptyState();
            for (const e of raw) {
              derived = applyEvent(derived, e);
            }
          }
          setEvents(raw);
          setState(derived);
          setStatus("live");
        } else if (msg.type === "event") {
          const e = msg.event;
          setEvents((prev) => [...prev, e]);
          setState((prev) => applyEvent(prev, e));
        }
        // "disconnect" messages: let onerror handle reconnect
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      if (!mountedRef.current) return;
      es.close();
      esRef.current = null;
      setStatus("error");
      setLastError("Connection lost");

      const delay = getBackoffDelay(attemptsRef.current);
      attemptsRef.current += 1;
      setReconnectAttempts(attemptsRef.current);

      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, delay);
    };
  }, []);

  const reconnect = useCallback(() => {
    attemptsRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    connect();
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [connect]);

  return { events, state, status, reconnect, lastError, reconnectAttempts };
}
