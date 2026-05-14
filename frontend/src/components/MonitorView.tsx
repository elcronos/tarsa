import { useEffect, useRef, useState } from "react";
import type { Agent, Event } from "../types";
import { formatDuration, formatCost } from "../utils/format";
import { useTickEverySecond } from "../hooks/useTickEverySecond";
import ContextWindowCard, { type ContextUsageRow } from "./ContextWindowCard";

export interface InsightsPayload {
  costEstimate?: {
    perAgent: Array<{ agentId: string; usd: number; source?: string }>;
    source?: string;
  };
  contextUsage?: { perAgent: ContextUsageRow[] };
}

interface Props {
  agent: Agent;
  events: Event[];
  insights: InsightsPayload;
  onExit: () => void;
}

const STATUS_LABELS: Record<Agent["status"], string> = {
  active: "running",
  awaiting: "awaiting",
  done: "done",
  error: "error",
};

const STATUS_COLORS: Record<Agent["status"], string> = {
  active: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  awaiting: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  done: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  error: "bg-red-500/20 text-red-300 border-red-500/40",
};

function formatEventSummary(ev: Event): string {
  if (ev.tool_name) return `${ev.hook_event} · ${ev.tool_name}`;
  return ev.hook_event;
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function MonitorView({ agent, events, insights, onExit }: Props): JSX.Element {
  const now = useTickEverySecond();
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top (newest) when events change
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [events.length]);

  // Done-for-10s banner
  const [doneAt] = useState<number | null>(() =>
    agent.status === "done" ? (agent.ended_at ?? agent.last_seen_ms) : null
  );
  const showFinishedBanner = doneAt !== null && now - doneAt > 10_000;

  const agentEvents = events.filter((e) => e.agent_id === agent.id);
  const last20 = agentEvents.slice(-20).reverse();

  // Token counts from events
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const e of agentEvents) {
    if (typeof e["input_tokens"] === "number") inputTokens += e["input_tokens"] as number;
    if (typeof e["output_tokens"] === "number") outputTokens += e["output_tokens"] as number;
    if (typeof e["cache_read"] === "number") cacheRead += e["cache_read"] as number;
    if (typeof e["cache_creation"] === "number") cacheWrite += e["cache_creation"] as number;
  }

  // Cost from insights
  const costRow = insights.costEstimate?.perAgent.find((r) => r.agentId === agent.id);
  const costUsd = costRow?.usd ?? 0;
  const costSource = costRow?.source ?? insights.costEstimate?.source;

  // Context fill from insights
  const ctxRow = insights.contextUsage?.perAgent.find((r) => r.agentId === agent.id);
  const ctxRows: ContextUsageRow[] = ctxRow ? [ctxRow] : [];

  // Fallback fill% when 006 row not available
  const fallbackFill = ctxRow == null
    ? Math.min(100, Math.round((inputTokens / 200_000) * 1000) / 10)
    : null;

  // Current activity: latest in-flight tool call
  const lastEvent = last20[0];
  const isInFlight = lastEvent?.hook_event === "PreToolUse";

  const elapsed = now - agent.first_seen_ms;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--bg)] font-mono">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)]">
        <span className="text-sm font-mono text-[var(--fg)] truncate flex-1 min-w-0">
          {agent.name}
        </span>
        {agent.subagent_type && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[var(--border)] text-[var(--fg-subtle)] shrink-0">
            {agent.subagent_type}
          </span>
        )}
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${STATUS_COLORS[agent.status]}`}>
          {STATUS_LABELS[agent.status]}
        </span>
        <span className="text-[10px] font-mono text-[var(--fg-subtle)] shrink-0">
          {formatDuration(elapsed)}
        </span>
        <button
          onClick={onExit}
          className="shrink-0 px-2 py-0.5 rounded border border-[var(--border)] text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:border-[var(--fg-subtle)] transition-colors"
          aria-label="Exit monitor"
        >
          exit
        </button>
      </div>

      {/* Finished banner */}
      {showFinishedBanner && (
        <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/30 text-[11px] font-mono text-emerald-300">
          <span>Agent finished</span>
          <button
            onClick={onExit}
            className="px-2 py-0.5 rounded border border-emerald-500/40 hover:bg-emerald-500/20 transition-colors"
          >
            exit monitor
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="tokens in/out">
            <span>{(inputTokens / 1000).toFixed(0)}k</span>
            <span className="text-[var(--fg-subtle)]"> / </span>
            <span>{(outputTokens / 1000).toFixed(0)}k</span>
          </StatCard>
          <StatCard label="cache read/write">
            <span>{(cacheRead / 1000).toFixed(0)}k</span>
            <span className="text-[var(--fg-subtle)]"> / </span>
            <span>{(cacheWrite / 1000).toFixed(0)}k</span>
          </StatCard>
          <StatCard label="cost">
            <span>{costUsd > 0 ? formatCost(costUsd) : "—"}</span>
            {costSource && costSource !== "tool_count_fallback" && (
              <span className={`ml-1 text-[9px] ${costSource === "measured" ? "text-green-400" : "text-amber-400"}`}>
                {costSource === "measured" ? "measured" : "est"}
              </span>
            )}
          </StatCard>
          <StatCard label="context fill">
            {ctxRow ? (
              <span>{ctxRow.fillPercent.toFixed(1)}%</span>
            ) : (
              <span>{fallbackFill?.toFixed(1) ?? "0.0"}%</span>
            )}
          </StatCard>
        </div>

        {/* Context window card (from task 006) */}
        {ctxRows.length > 0 && (
          <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-3">
              Context Window
            </div>
            <ContextWindowCard rows={ctxRows} />
          </section>
        )}

        {/* Current activity */}
        <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
            Current Activity
          </div>
          {isInFlight && lastEvent ? (
            <div className="flex items-start gap-2">
              <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              <div className="min-w-0">
                <div className="text-xs font-mono text-[var(--fg)]">{lastEvent.tool_name ?? "tool"}</div>
                {lastEvent.tool_input && (
                  <div className="text-[10px] font-mono text-[var(--fg-subtle)] mt-0.5 truncate max-w-full">
                    {JSON.stringify(lastEvent.tool_input).slice(0, 200)}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-[10px] font-mono text-[var(--fg-subtle)]">idle</div>
          )}
        </section>

        {/* Recent events */}
        <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
            Recent Events ({last20.length})
          </div>
          <div ref={listRef} className="space-y-0.5 max-h-64 overflow-y-auto">
            {last20.length === 0 ? (
              <div className="text-[10px] font-mono text-[var(--fg-subtle)]">No events yet</div>
            ) : (
              last20.map((ev) => (
                <div key={ev.id} className="flex items-center gap-2 py-0.5 border-b border-[var(--border)]/40 last:border-0">
                  <span className="text-[9px] font-mono text-[var(--fg-subtle)] shrink-0 w-20">
                    {formatTs(ev.ts)}
                  </span>
                  <span className="text-[10px] font-mono text-[var(--fg-muted)] truncate flex-1 min-w-0">
                    {formatEventSummary(ev)}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-2.5">
      <div className="text-[9px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-1.5">{label}</div>
      <div className="text-xs font-mono text-[var(--fg)]">{children}</div>
    </div>
  );
}
