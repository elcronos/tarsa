import { useState, useEffect, useMemo } from "react";
import type { Agent, Event, Session } from "../types";
import { replayToTimestamp } from "../replay";
import { isOrphanStub } from "../utils/orphan";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SessionSnapshot {
  session: Session;
  agents: Agent[];
  events: Event[];
}

export interface MatchedPair {
  key: string;
  agentA: Agent;
  agentB: Agent;
  deltas: {
    tool_count: number;
    duration_ms: number;
    error_count: number;
  };
}

export interface CompareResult {
  matched: MatchedPair[];
  onlyA: Agent[];
  onlyB: Agent[];
  aggregateDeltas: {
    tool_count: number;
    cost_usd: number;
    duration_ms: number;
  };
}

export interface UseSessionCompareResult {
  sessionA: string | null;
  sessionB: string | null;
  setSessionA: (id: string | null) => void;
  setSessionB: (id: string | null) => void;
  snapshotA: SessionSnapshot | null;
  snapshotB: SessionSnapshot | null;
  compareResult: CompareResult | null;
  loading: boolean;
}

// ── Matching tuple: (subagent_type, depth_in_tree, spawn_order_among_siblings) ─

function buildDepthMap(agents: Agent[]): Map<string, number> {
  const depthMap = new Map<string, number>();
  const parentMap = new Map<string, string | null>();
  for (const a of agents) parentMap.set(a.id, a.parent_id);

  for (const a of agents) {
    let depth = 0;
    let current: string | null = a.parent_id;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      depth++;
      current = parentMap.get(current) ?? null;
    }
    depthMap.set(a.id, depth);
  }
  return depthMap;
}

function buildSpawnOrderMap(agents: Agent[]): Map<string, number> {
  // For each agent, spawn order = index among siblings sorted by first_seen_ms
  const byParent = new Map<string | null, Agent[]>();
  for (const a of agents) {
    const list = byParent.get(a.parent_id) ?? [];
    list.push(a);
    byParent.set(a.parent_id, list);
  }

  const spawnOrder = new Map<string, number>();
  for (const siblings of byParent.values()) {
    const sorted = [...siblings].sort((a, b) => a.first_seen_ms - b.first_seen_ms);
    sorted.forEach((a, i) => spawnOrder.set(a.id, i));
  }
  return spawnOrder;
}

export function matchingKey(
  agent: Agent,
  depthMap: Map<string, number>,
  spawnOrderMap: Map<string, number>
): string {
  const type = agent.subagent_type ?? "root";
  const depth = depthMap.get(agent.id) ?? 0;
  const order = spawnOrderMap.get(agent.id) ?? 0;
  return `${type}|d${depth}|o${order}`;
}

function compareSnapshots(a: SessionSnapshot, b: SessionSnapshot): CompareResult {
  const depthA = buildDepthMap(a.agents);
  const depthB = buildDepthMap(b.agents);
  const orderA = buildSpawnOrderMap(a.agents);
  const orderB = buildSpawnOrderMap(b.agents);

  const mapA = new Map<string, Agent>();
  const mapB = new Map<string, Agent>();

  for (const agent of a.agents) mapA.set(matchingKey(agent, depthA, orderA), agent);
  for (const agent of b.agents) mapB.set(matchingKey(agent, depthB, orderB), agent);

  const matched: MatchedPair[] = [];
  const onlyA: Agent[] = [];
  const onlyB: Agent[] = [];

  for (const [key, agentA] of mapA) {
    const agentB = mapB.get(key);
    if (agentB) {
      matched.push({
        key,
        agentA,
        agentB,
        deltas: {
          tool_count: agentB.tool_count - agentA.tool_count,
          duration_ms:
            (agentB.last_seen_ms - agentB.first_seen_ms) -
            (agentA.last_seen_ms - agentA.first_seen_ms),
          error_count: agentB.error_count - agentA.error_count,
        },
      });
    } else {
      onlyA.push(agentA);
    }
  }

  for (const [key, agentB] of mapB) {
    if (!mapA.has(key)) onlyB.push(agentB);
  }

  const totalToolsA = a.agents.reduce((s, ag) => s + ag.tool_count, 0);
  const totalToolsB = b.agents.reduce((s, ag) => s + ag.tool_count, 0);
  const durationA = a.session.ended_at
    ? a.session.ended_at - a.session.started_at
    : 0;
  const durationB = b.session.ended_at
    ? b.session.ended_at - b.session.started_at
    : 0;

  return {
    matched,
    onlyA,
    onlyB,
    aggregateDeltas: {
      tool_count: totalToolsB - totalToolsA,
      cost_usd: 0, // would need token data
      duration_ms: durationB - durationA,
    },
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

async function loadSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { session: Session; events: Event[] };
    const state = replayToTimestamp(data.events);
    const now = Date.now();
    return {
      session: data.session,
      agents: Array.from(state.agents.values()).filter((a) => !isOrphanStub(a, now)),
      events: data.events,
    };
  } catch {
    return null;
  }
}

export function useSessionCompare(): UseSessionCompareResult {
  const [sessionA, setSessionA] = useState<string | null>(null);
  const [sessionB, setSessionB] = useState<string | null>(null);
  const [snapshotA, setSnapshotA] = useState<SessionSnapshot | null>(null);
  const [snapshotB, setSnapshotB] = useState<SessionSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionA) { setSnapshotA(null); return; }
    setLoading(true);
    loadSnapshot(sessionA).then((s) => { setSnapshotA(s); setLoading(false); });
  }, [sessionA]);

  useEffect(() => {
    if (!sessionB) { setSnapshotB(null); return; }
    setLoading(true);
    loadSnapshot(sessionB).then((s) => { setSnapshotB(s); setLoading(false); });
  }, [sessionB]);

  const compareResult = useMemo((): CompareResult | null => {
    if (!snapshotA || !snapshotB) return null;
    return compareSnapshots(snapshotA, snapshotB);
  }, [snapshotA, snapshotB]);

  return {
    sessionA,
    sessionB,
    setSessionA,
    setSessionB,
    snapshotA,
    snapshotB,
    compareResult,
    loading,
  };
}
