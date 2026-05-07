import { useEffect, useState } from "react";
import { useSessionCompare } from "../hooks/useSessionCompare";
import type { Agent, Session } from "../types";
import { formatDuration } from "../utils/format";
import LoadingDots from "./LoadingDots";

// ── Session picker ────────────────────────────────────────────────────────────

function SessionPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: Session[]) => setSessions(data))
      .catch(() => setSessions([]));
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider">
        {label}
      </label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="text-xs font-mono bg-[var(--surface-raised)] border border-[var(--border)] rounded px-2 py-1 text-[var(--fg-muted)]"
      >
        <option value="">Select session…</option>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name ?? `Session ${s.id.slice(0, 8)}`}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Agent tree column ─────────────────────────────────────────────────────────

function AgentTreeColumn({
  agents,
  matchedKeys,
  side,
}: {
  agents: Agent[];
  matchedKeys: Set<string>;
  side: "A" | "B";
}) {
  if (agents.length === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)] px-2">
        No agents
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {agents.map((agent) => {
        const isMatched = matchedKeys.has(agent.id);
        const duration = agent.last_seen_ms - agent.first_seen_ms;
        return (
          <div
            key={agent.id}
            className={`rounded px-2 py-1.5 border text-[10px] font-mono ${
              isMatched
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/5"
                : side === "A"
                  ? "border-red-500/30 bg-red-500/5 text-red-400"
                  : "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
            }`}
          >
            <div className="flex items-center gap-1.5">
              {!isMatched && (
                <span className="shrink-0 font-bold">
                  {side === "A" ? "−" : "+"}
                </span>
              )}
              <span className="truncate text-[var(--fg)]">{agent.name}</span>
              {isMatched && (
                <span className="ml-auto text-[var(--accent)] shrink-0">≈</span>
              )}
            </div>
            <div className="text-[var(--fg-subtle)] mt-0.5">
              {agent.subagent_type ?? "root"} · {formatDuration(duration)} · {agent.tool_count} calls
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SessionDiffView() {
  const {
    sessionA,
    sessionB,
    setSessionA,
    setSessionB,
    snapshotA,
    snapshotB,
    compareResult,
    loading,
  } = useSessionCompare();

  const matchedAIds = new Set(compareResult?.matched.map((m) => m.agentA.id) ?? []);
  const matchedBIds = new Set(compareResult?.matched.map((m) => m.agentB.id) ?? []);
  const allAIds = new Set([
    ...matchedAIds,
    ...(compareResult?.onlyA.map((a) => a.id) ?? []),
  ]);
  const allBIds = new Set([
    ...matchedBIds,
    ...(compareResult?.onlyB.map((a) => a.id) ?? []),
  ]);

  const agentsA = snapshotA?.agents ?? [];
  const agentsB = snapshotB?.agents ?? [];

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Session pickers */}
      <div className="grid grid-cols-2 gap-4">
        <SessionPicker label="Session A (baseline)" value={sessionA} onChange={setSessionA} />
        <SessionPicker label="Session B (compare)" value={sessionB} onChange={setSessionB} />
      </div>

      {loading && <LoadingDots label="comparing sessions" />}

      {/* Aggregate deltas */}
      {compareResult && (
        <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
            Aggregate Deltas (B − A)
          </div>
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                label: "Tool calls",
                v: compareResult.aggregateDeltas.tool_count,
                format: (n: number) => (n > 0 ? `+${n}` : String(n)),
              },
              {
                label: "Duration",
                v: compareResult.aggregateDeltas.duration_ms,
                format: (n: number) =>
                  `${n > 0 ? "+" : ""}${formatDuration(Math.abs(n))}`,
              },
              {
                label: "Matched agents",
                v: compareResult.matched.length,
                format: (n: number) => String(n),
              },
            ].map(({ label, v, format }) => (
              <div key={label} className="text-center">
                <div className="text-[10px] font-mono text-[var(--fg-subtle)]">{label}</div>
                <div
                  className={`text-sm font-mono mt-0.5 ${
                    v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-[var(--fg)]"
                  }`}
                >
                  {format(v)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Side-by-side trees */}
      {(snapshotA || snapshotB) && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
              Session A
              {snapshotA && (
                <span className="ml-2 normal-case">
                  ({agentsA.length} agents)
                </span>
              )}
            </div>
            <AgentTreeColumn
              agents={agentsA}
              matchedKeys={allAIds}
              side="A"
            />
          </div>
          <div>
            <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
              Session B
              {snapshotB && (
                <span className="ml-2 normal-case">
                  ({agentsB.length} agents)
                </span>
              )}
            </div>
            <AgentTreeColumn
              agents={agentsB}
              matchedKeys={allBIds}
              side="B"
            />
          </div>
        </div>
      )}

      {!sessionA && !sessionB && (
        <div className="flex h-48 items-center justify-center text-[var(--fg-subtle)] text-sm font-mono">
          Select two sessions to compare
        </div>
      )}
    </div>
  );
}
