import { useState, useMemo, useEffect, useCallback } from "react";
import type { State, Agent, BaselineRow, CostSource, Iteration } from "../types";
import { formatDuration, formatCost } from "../utils/format";
import StuckBadge from "./StuckBadge";
import EmptyState from "./EmptyState";
import { getCsrfToken } from "../hooks/useAgentState";
import { authHeaders } from "../utils/auth";

const BUDGET_LS_PREFIX = "tarsa.budget.";

function loadBudgetLS(sessionId: string): { budget_usd: number; kill_on_exceed: boolean } | null {
  try {
    const raw = localStorage.getItem(BUDGET_LS_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { budget_usd?: number; kill_on_exceed?: boolean };
    return {
      budget_usd: typeof parsed.budget_usd === "number" ? parsed.budget_usd : 0,
      kill_on_exceed: parsed.kill_on_exceed === true,
    };
  } catch {
    return null;
  }
}

function saveBudgetLS(sessionId: string, budget_usd: number, kill_on_exceed: boolean) {
  try {
    localStorage.setItem(
      BUDGET_LS_PREFIX + sessionId,
      JSON.stringify({ budget_usd, kill_on_exceed })
    );
  } catch {
    // ignore
  }
}

interface InsightsViewProps {
  state: State;
}

// ── Types mirroring server insights.ts ───────────────────────────────────────

interface StuckSignal {
  agentId: string;
  agentName: string;
  reason: "repeated_tool" | "consecutive_failures";
  detail: string;
  tool_name?: string;
  count: number;
}

interface ErrorRecoveryEntry {
  agentId: string;
  agentName: string;
  tool_name: string;
  failed_tool_id: string;
  recovery: "retried_succeeded" | "retried_failed" | "no_retry";
  retry_tool_id: string | null;
}

interface AgentPerfRow {
  id: string;
  name: string;
  type: string | null;
  duration_ms: number;
  tool_count: number;
  errors: number;
  cost_usd: number;
}

interface AgentTypeProfile {
  type: string;
  sample_count: number;
  avg_duration_ms: number;
  avg_tool_count: number;
  summary: string;
}

interface InsightsData {
  bottleneck: {
    longestAgentId: string | null;
    longestAgentName: string | null;
    longestDurationMs: number;
    highestErrorAgentId: string | null;
    highestErrorAgentName: string | null;
    highestErrorCount: number;
  };
  costEstimate: {
    perAgent: Array<{
      agentId: string;
      agentName: string;
      inputTokens: number;
      outputTokens: number;
      usd: number;
      model: string;
      source?: CostSource;
    }>;
    totalUsd: number;
    source?: CostSource;
  };
  pricedCoveragePct?: number;
  parallelismGaps: Array<{
    agents: [string, string];
    aEndMs: number;
    bStartMs: number;
    overlapOpportunityMs: number;
  }>;
  stuckSignals: StuckSignal[];
  errorRecovery?: ErrorRecoveryEntry[];
  agentPerformance?: AgentPerfRow[];
  agentTypeProfiles?: AgentTypeProfile[];
}

// ── Client-side stuck detection (mirrors server heuristic) ───────────────────

const REPEAT_THRESHOLD = 3;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

function detectStuck(state: State): StuckSignal[] {
  const signals: StuckSignal[] = [];

  for (const agent of state.agents.values()) {
    if (agent.status === "done") continue;
    const calls = state.tool_calls.get(agent.id) ?? [];

    // Repeated tool + same input
    const buckets = new Map<string, { count: number; firstMs: number; lastMs: number }>();
    for (const tc of calls) {
      const key = `${tc.tool_name}|${JSON.stringify(tc.input).slice(0, 200)}`;
      const b = buckets.get(key);
      if (!b) buckets.set(key, { count: 1, firstMs: tc.started_ms, lastMs: tc.started_ms });
      else { b.count++; b.lastMs = tc.started_ms; }
    }
    for (const [key, b] of buckets) {
      if (b.count >= REPEAT_THRESHOLD && b.lastMs - b.firstMs <= 60_000) {
        const [toolName] = key.split("|");
        signals.push({
          agentId: agent.id,
          agentName: agent.name,
          reason: "repeated_tool",
          detail: `"${toolName}" called ${b.count}× with same input`,
          tool_name: toolName,
          count: b.count,
        });
      }
    }

    // Consecutive failures
    let consecutiveErrors = 0;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]?.status === "error") consecutiveErrors++;
      else break;
    }
    if (consecutiveErrors >= CONSECUTIVE_FAILURE_THRESHOLD) {
      signals.push({
        agentId: agent.id,
        agentName: agent.name,
        reason: "consecutive_failures",
        detail: `${consecutiveErrors} consecutive tool failures`,
        count: consecutiveErrors,
      });
    }
  }

  return signals;
}

// ── Stuck agent card with root cause hint ────────────────────────────────────

function stuckHint(sig: StuckSignal, state: State): string {
  const calls = state.tool_calls.get(sig.agentId) ?? [];
  if (calls.length === 0) return "no tool activity";
  const last = calls[calls.length - 1];
  if (!last) return "no tool activity";
  if (last.status === "error") return `last tool errored: ${last.tool_name}`;
  if (last.status === "running") return `waiting on: ${last.tool_name}`;
  return `last tool: ${last.tool_name}`;
}

function StuckAgentCard({ sig, state }: { sig: StuckSignal; state: State }) {
  const [expanded, setExpanded] = useState(false);
  const hint = stuckHint(sig, state);

  return (
    <div className="rounded border border-amber-500/30 bg-amber-500/10">
      <div
        className="flex items-start gap-2 px-3 py-2 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <StuckBadge reason={sig.detail} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-mono text-amber-300 font-medium">
            {sig.agentName}
          </div>
          <div className="text-[10px] font-mono text-amber-400/80 mt-0.5">
            {sig.detail}
          </div>
        </div>
        <span className="text-[9px] font-mono text-amber-400/60 shrink-0 mt-0.5 select-none">
          {expanded ? "▲" : "▼"}
        </span>
      </div>
      {expanded && (
        <div className="px-3 pb-2 border-t border-amber-500/20">
          <div className="text-[9px] font-mono text-amber-300/70 pt-1.5">
            hint: {hint}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cost stacked bar ─────────────────────────────────────────────────────────

const BAR_COLORS = [
  "#3b82f6", "#10b981", "#a78bfa", "#f97316", "#f59e0b",
  "#ec4899", "#06b6d4", "#84cc16", "#ef4444", "#8b5cf6",
];

function costSourceLabel(source: CostSource): string {
  if (source === "measured") return "from transcript";
  if (source === "estimated_chars") return "estimated from chars (4 chars/token)";
  return "estimated from tool count";
}

function CostBar({
  perAgent,
  totalUsd,
  source,
  coveragePct,
}: {
  perAgent: Array<{ agentId: string; agentName: string; usd: number }>;
  totalUsd: number;
  source?: CostSource;
  coveragePct?: number;
}) {
  // Hide USD entirely when all sources are tool_count_fallback and no tokens.
  // Acceptance: show "—" in that case.
  const allFallbackNoTokens =
    source === "tool_count_fallback" && totalUsd === 0;

  if (allFallbackNoTokens) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)]">—</div>
    );
  }

  if (totalUsd === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)]">
        No cost data available (token counts not in events)
      </div>
    );
  }

  const showCoverageBadge =
    typeof coveragePct === "number" && coveragePct < 100;

  return (
    <div className="space-y-2">
      {source && (
        <div className="flex items-center gap-1.5 mb-1">
          <span
            className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
              source === "measured"
                ? "bg-green-500/15 text-green-400"
                : source === "estimated_chars"
                  ? "bg-blue-500/15 text-blue-400"
                  : "bg-[var(--surface-raised)] text-[var(--fg-subtle)]"
            }`}
          >
            {source}
          </span>
          <span className="text-[9px] font-mono text-[var(--fg-subtle)]">
            {costSourceLabel(source)}
          </span>
          {showCoverageBadge && (
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 cursor-help"
              title="Anthropic API-reported tokens (transcript-measured) vs estimated. Higher = more honest."
            >
              ~est ({coveragePct}% measured)
            </span>
          )}
        </div>
      )}
      <div className="h-4 w-full flex rounded overflow-hidden">
        {perAgent.map((a, i) => {
          const pct = totalUsd > 0 ? (a.usd / totalUsd) * 100 : 0;
          if (pct < 0.5) return null;
          return (
            <div
              key={a.agentId}
              style={{ width: `${pct}%`, backgroundColor: BAR_COLORS[i % BAR_COLORS.length] }}
              title={`${a.agentName}: ${formatCost(a.usd)}`}
            />
          );
        })}
      </div>
      <div className="space-y-1">
        {perAgent.map((a, i) => (
          <div key={a.agentId} className="flex items-center gap-2">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: BAR_COLORS[i % BAR_COLORS.length] }}
            />
            <span className="text-[10px] font-mono text-[var(--fg-muted)] flex-1 truncate">
              {a.agentName}
            </span>
            <span className="text-[10px] font-mono text-[var(--fg-subtle)]">
              {formatCost(a.usd)}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-[var(--border)] pt-1 mt-1">
          <span className="text-[10px] font-mono text-[var(--fg-subtle)]">total</span>
          <span className="text-[10px] font-mono text-[var(--fg)]">{formatCost(totalUsd)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Agent performance table ───────────────────────────────────────────────────

type SortKey = "name" | "duration" | "tools" | "cost" | "errors";

function zScoreBadge(
  durationMs: number,
  baseline: BaselineRow
): "fast" | "normal" | "slow" | null {
  if (baseline.sample_count < 5 || baseline.stddev_duration === 0) return null;
  const z = (durationMs - baseline.mean_duration) / baseline.stddev_duration;
  if (z < -1) return "fast";
  if (z > 1) return "slow";
  return "normal";
}

function ZBadge({ badge }: { badge: "fast" | "normal" | "slow" }) {
  const styles: Record<string, string> = {
    fast: "bg-green-500/15 text-green-400",
    normal: "bg-[var(--surface-raised)] text-[var(--fg-subtle)]",
    slow: "bg-red-500/15 text-red-400",
  };
  return (
    <span className={`text-[8px] font-mono px-1 py-0.5 rounded ml-1 ${styles[badge]}`}>
      {badge}
    </span>
  );
}

function AgentTable({
  agents,
  costMap,
  baselinesMap,
}: {
  agents: Agent[];
  costMap: Map<string, number>;
  baselinesMap: Map<string, BaselineRow>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("duration");
  const [sortAsc, setSortAsc] = useState(false);

  const sorted = useMemo(() => {
    return [...agents].sort((a, b) => {
      let v = 0;
      if (sortKey === "name") v = a.name.localeCompare(b.name);
      else if (sortKey === "duration") {
        const da = a.last_seen_ms - a.first_seen_ms;
        const db = b.last_seen_ms - b.first_seen_ms;
        v = da - db;
      } else if (sortKey === "tools") v = a.tool_count - b.tool_count;
      else if (sortKey === "cost") v = (costMap.get(a.id) ?? 0) - (costMap.get(b.id) ?? 0);
      else if (sortKey === "errors") v = a.error_count - b.error_count;
      return sortAsc ? v : -v;
    });
  }, [agents, sortKey, sortAsc, costMap]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  };

  const col = (key: SortKey, label: string, align = "text-left") => (
    <th
      className={`pb-1 text-[10px] font-mono text-[var(--fg-subtle)] cursor-pointer hover:text-[var(--fg)] select-none ${align}`}
      onClick={() => handleSort(key)}
    >
      {label}
      {sortKey === key && <span className="ml-0.5">{sortAsc ? "↑" : "↓"}</span>}
    </th>
  );

  if (sorted.length === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)]">No agents to display.</div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] font-mono">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {col("name", "agent")}
            {col("duration", "duration", "text-right")}
            {col("tools", "tools", "text-right")}
            {col("cost", "cost", "text-right")}
            {col("errors", "errors", "text-right")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((agent) => {
            const duration = agent.last_seen_ms - agent.first_seen_ms;
            const cost = costMap.get(agent.id) ?? 0;
            const baseline = agent.subagent_type ? baselinesMap.get(agent.subagent_type) : undefined;
            const badge = baseline ? zScoreBadge(duration, baseline) : null;
            return (
              <tr key={agent.id} className="border-b border-[var(--border)] hover:bg-[var(--surface-raised)]">
                <td className="py-1 pr-2 text-[var(--fg-muted)] truncate max-w-[120px]">
                  {agent.name}
                </td>
                <td className="py-1 text-right text-[var(--fg-subtle)]">
                  <span>{formatDuration(duration)}</span>
                  {badge && badge !== "normal" && <ZBadge badge={badge} />}
                </td>
                <td className="py-1 text-right text-[var(--fg-subtle)]">
                  {agent.tool_count}
                </td>
                <td className="py-1 text-right text-[var(--fg-subtle)]">
                  {cost > 0 ? formatCost(cost) : "–"}
                </td>
                <td className={`py-1 text-right ${agent.error_count > 0 ? "text-red-400" : "text-[var(--fg-subtle)]"}`}>
                  {agent.error_count}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Agent type trends card ────────────────────────────────────────────────────

// TODO: range computation here duplicates src/insights.ts::agentTypeTrends.
// Extract to a shared package once the monorepo workspace is set up.
function AgentTypeTrendsCard({ baselines }: { baselines: BaselineRow[] }) {
  if (baselines.length === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)]">
        No baseline data yet — trends appear after sessions complete.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {baselines.map((b) => {
        const toolLow = Math.max(0, Math.round(b.mean_tool_count - b.stddev_tool_count));
        const toolHigh = Math.round(b.mean_tool_count + b.stddev_tool_count);
        const durLowS = Math.max(0, (b.mean_duration - b.stddev_duration) / 1000);
        const durHighS = (b.mean_duration + b.stddev_duration) / 1000;
        const toolRange = toolLow === toolHigh ? `${toolLow}` : `${toolLow}-${toolHigh}`;
        const durRange =
          Math.abs(durHighS - durLowS) < 0.05
            ? `${durLowS.toFixed(1)}s`
            : `${durLowS.toFixed(1)}-${durHighS.toFixed(1)}s`;
        const summary =
          `Usually makes ${toolRange} tool call${toolHigh !== 1 ? "s" : ""}, takes ${durRange}`;

        return (
          <div key={b.agent_type} className="rounded bg-[var(--bg)] p-2">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] font-mono text-[var(--fg)] font-medium">{b.agent_type}</span>
              <span className="text-[9px] font-mono text-[var(--fg-subtle)]">
                {b.sample_count} run{b.sample_count !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="text-[10px] font-mono text-[var(--fg-muted)]">{summary}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Error recovery card ───────────────────────────────────────────────────────

function RecoveryBadge({ recovery }: { recovery: ErrorRecoveryEntry["recovery"] }) {
  if (recovery === "retried_succeeded") {
    return (
      <span className="text-[9px] font-mono px-1 rounded bg-green-500/15 text-green-400">
        ↻ recovered
      </span>
    );
  }
  if (recovery === "retried_failed") {
    return (
      <span className="text-[9px] font-mono px-1 rounded bg-red-500/15 text-red-400">
        ↻ retry failed
      </span>
    );
  }
  return (
    <span className="text-[9px] font-mono px-1 rounded bg-[var(--surface-raised)] text-[var(--fg-subtle)]">
      no retry
    </span>
  );
}

function ErrorRecoveryCard({ entries }: { entries: ErrorRecoveryEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)]">
        No tool failures detected.
      </div>
    );
  }

  return (
    <div className="space-y-1 max-h-48 overflow-y-auto">
      {entries.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className="text-[10px] font-mono text-[var(--fg-muted)] truncate flex-1">
            <span className="text-[var(--fg-subtle)]">{entry.agentName}</span>
            {" · "}
            {entry.tool_name}
          </span>
          <RecoveryBadge recovery={entry.recovery} />
        </div>
      ))}
    </div>
  );
}

// ── Agent type profiles card ──────────────────────────────────────────────────

function AgentTypeProfilesCard({ profiles }: { profiles: AgentTypeProfile[] }) {
  if (profiles.length === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)]">
        No agent type data yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {profiles.map((p) => (
        <div key={p.type} className="rounded bg-[var(--bg)] p-2">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-[10px] font-mono text-[var(--fg)] font-medium">{p.type}</span>
            <span className="text-[9px] font-mono text-[var(--fg-subtle)]">
              {p.sample_count} sample{p.sample_count !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="text-[10px] font-mono text-[var(--fg-muted)]">{p.summary}</div>
        </div>
      ))}
    </div>
  );
}

// ── Budget card ──────────────────────────────────────────────────────────────

function BudgetCard({
  sessionId,
  initialBudget,
  initialKill,
}: {
  sessionId: string | undefined;
  initialBudget: number;
  initialKill: boolean;
}) {
  const [budget, setBudget] = useState<number>(initialBudget);
  const [kill, setKill] = useState<boolean>(initialKill);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setBudget(initialBudget);
    setKill(initialKill);
  }, [initialBudget, initialKill, sessionId]);

  const handleSave = useCallback(async () => {
    if (!sessionId) {
      setStatus("no session selected");
      return;
    }
    saveBudgetLS(sessionId, budget, kill);
    const token = getCsrfToken();
    if (!token) {
      setStatus("saved locally (no CSRF token yet)");
      return;
    }
    try {
      const res = await fetch("/api/budget", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tarsa-CSRF": token,
          ...authHeaders(),
        },
        body: JSON.stringify({
          session_id: sessionId,
          usd: budget,
          kill_on_exceed: kill,
        }),
      });
      if (res.ok) {
        setStatus("saved");
      } else {
        setStatus(`save failed (${res.status})`);
      }
    } catch (e) {
      setStatus(`save failed: ${String(e)}`);
    }
  }, [sessionId, budget, kill]);

  return (
    <div className="space-y-2">
      <label className="block text-[10px] font-mono text-[var(--fg-muted)]">
        Session budget ($)
        <input
          type="number"
          min={0}
          step={0.01}
          value={budget}
          onChange={(e) => setBudget(parseFloat(e.target.value) || 0)}
          className="ml-2 w-24 px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] text-[10px] font-mono"
        />
      </label>
      <label className="flex items-center gap-2 text-[10px] font-mono text-[var(--fg-muted)]">
        <input
          type="checkbox"
          checked={kill}
          onChange={(e) => setKill(e.target.checked)}
        />
        Stop on exceed (alert only)
      </label>
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          className="px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-raised)] text-[10px] font-mono text-[var(--fg)] hover:bg-[var(--accent)]/10"
        >
          Save
        </button>
        {status && (
          <span className="text-[9px] font-mono text-[var(--fg-subtle)]">{status}</span>
        )}
      </div>
    </div>
  );
}

// ── Iteration spark-line ─────────────────────────────────────────────────────

function IterationSparkline({
  iterations,
  budget,
  cumulativeAtIter,
}: {
  iterations: Iteration[];
  budget: number;
  cumulativeAtIter: number[];
}) {
  if (iterations.length === 0 || cumulativeAtIter.length === 0) {
    return (
      <div className="text-[10px] font-mono text-[var(--fg-subtle)]">
        No iterations detected
      </div>
    );
  }

  const W = 280;
  const H = 60;
  const PAD = 4;
  const maxY = Math.max(budget * 1.25, ...cumulativeAtIter, 0.000001);
  const stepX = cumulativeAtIter.length > 1 ? (W - 2 * PAD) / (cumulativeAtIter.length - 1) : 0;

  const points = cumulativeAtIter
    .map((v, i) => `${PAD + i * stepX},${H - PAD - (v / maxY) * (H - 2 * PAD)}`)
    .join(" ");

  const finalCost = cumulativeAtIter[cumulativeAtIter.length - 1] ?? 0;
  const ratio = budget > 0 ? finalCost / budget : 0;
  const lineColor = ratio > 1 ? "#ef4444" : ratio > 0.75 ? "#f59e0b" : "#10b981";
  const thresholdY = budget > 0 ? H - PAD - (budget / maxY) * (H - 2 * PAD) : -1;

  return (
    <div>
      <svg width={W} height={H} className="overflow-visible">
        {budget > 0 && thresholdY >= 0 && (
          <line
            x1={PAD}
            y1={thresholdY}
            x2={W - PAD}
            y2={thresholdY}
            stroke="#ef4444"
            strokeWidth={1}
            strokeDasharray="3 2"
          />
        )}
        <polyline
          points={points}
          fill="none"
          stroke={lineColor}
          strokeWidth={1.5}
        />
      </svg>
      <div className="text-[9px] font-mono text-[var(--fg-subtle)] mt-1">
        cum: {formatCost(finalCost)} / budget: {formatCost(budget)} ({iterations.length} iter)
      </div>
    </div>
  );
}

// ── Ralph iterations summary card ────────────────────────────────────────────

function RalphIterationsCard({ state }: { state: State }) {
  const entries = useMemo(() => {
    const out: Array<{ sessionId: string; iters: Iteration[] }> = [];
    for (const [sid, iters] of state.iterations.entries()) {
      if (iters.length === 0) continue;
      const sorted = [...iters].sort((a, b) => a.n - b.n);
      out.push({ sessionId: sid, iters: sorted });
    }
    return out;
  }, [state.iterations]);

  if (entries.length === 0) return null;

  return (
    <div className="space-y-3">
      {entries.map(({ sessionId, iters }) => {
        const session = state.sessions.get(sessionId);
        const sessName = session?.name ?? sessionId.slice(0, 8);
        return (
          <div key={sessionId}>
            <div className="text-[10px] font-mono text-[var(--fg-muted)] mb-1">
              Session: {sessName}
            </div>
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--fg-subtle)]">
                  <th className="pb-1 text-left">iter</th>
                  <th className="pb-1 text-right">tools</th>
                  <th className="pb-1 text-right">duration</th>
                  <th className="pb-1 text-right">conf</th>
                </tr>
              </thead>
              <tbody>
                {iters.map((it) => {
                  const dur = (it.ended_at ?? Date.now()) - it.started_at;
                  return (
                    <tr key={it.n} className="border-b border-[var(--border)]/50">
                      <td className="py-0.5 text-[var(--fg-muted)]">#{it.n}</td>
                      <td className="py-0.5 text-right text-[var(--fg-subtle)]">{it.tool_count}</td>
                      <td className="py-0.5 text-right text-[var(--fg-subtle)]">{formatDuration(dur)}</td>
                      <td className="py-0.5 text-right text-[var(--fg-subtle)]">
                        {Math.round(it.confidence * 100)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function InsightsView({ state }: InsightsViewProps) {
  const [serverInsights, setServerInsights] = useState<InsightsData | null>(null);
  const [baselines, setBaselines] = useState<BaselineRow[]>([]);

  // Try to load from server, fall back to client-side computation
  useEffect(() => {
    const sessionId = Array.from(state.sessions.keys())[0];
    const url = sessionId ? `/api/insights?session=${sessionId}` : "/api/insights";
    fetch(url)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: InsightsData) => setServerInsights(data))
      .catch(() => setServerInsights(null));
  }, [state.sessions]);

  // Fetch baselines for trend cards and z-score badges
  useEffect(() => {
    fetch("/api/baselines")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: BaselineRow[]) => setBaselines(data))
      .catch(() => setBaselines([]));
  }, [state.sessions]);

  // Client-side derived data
  const stuckSignals = useMemo(() => detectStuck(state), [state]);

  const agents = useMemo(() => Array.from(state.agents.values()), [state.agents]);

  const { costPerAgent, totalUsd, costMap, costSource, coveragePct } = useMemo(() => {
    const perAgent: Array<{ agentId: string; agentName: string; usd: number }> = [];
    const costMap = new Map<string, number>();
    let totalUsd = 0;
    let costSource: CostSource = "tool_count_fallback";
    let coveragePct: number | undefined;

    if (serverInsights) {
      let measuredCount = 0;
      let total = 0;
      for (const a of serverInsights.costEstimate.perAgent) {
        perAgent.push({ agentId: a.agentId, agentName: a.agentName, usd: a.usd });
        costMap.set(a.agentId, a.usd);
        totalUsd += a.usd;
        total++;
        if (a.source === "measured") measuredCount++;
      }
      totalUsd = serverInsights.costEstimate.totalUsd;
      if (serverInsights.costEstimate.source) costSource = serverInsights.costEstimate.source;
      coveragePct =
        typeof serverInsights.pricedCoveragePct === "number"
          ? serverInsights.pricedCoveragePct
          : total > 0
            ? Math.round((measuredCount / total) * 100)
            : 100;
    } else {
      // Client-side estimate from events
      for (const agent of state.agents.values()) {
        let input = 0, output = 0;
        for (const e of state.events) {
          if (e.agent_id !== agent.id) continue;
          if (typeof e["input_tokens"] === "number") input += e["input_tokens"] as number;
          if (typeof e["output_tokens"] === "number") output += e["output_tokens"] as number;
        }
        const usd = (input / 1_000_000) * 3 + (output / 1_000_000) * 15;
        perAgent.push({ agentId: agent.id, agentName: agent.name, usd });
        costMap.set(agent.id, usd);
        totalUsd += usd;
      }
    }
    return { costPerAgent: perAgent, totalUsd, costMap, costSource, coveragePct };
  }, [serverInsights, state]);

  const baselinesMap = useMemo(
    () => new Map(baselines.map((b) => [b.agent_type, b])),
    [baselines]
  );

  const bottleneck = useMemo(() => {
    if (serverInsights) return serverInsights.bottleneck;
    let longestAgent: Agent | null = null;
    let longestDurationMs = 0;
    for (const agent of state.agents.values()) {
      const d = agent.last_seen_ms - agent.first_seen_ms;
      if (d > longestDurationMs) { longestDurationMs = d; longestAgent = agent; }
    }
    return {
      longestAgentId: longestAgent?.id ?? null,
      longestAgentName: longestAgent?.name ?? null,
      longestDurationMs,
      highestErrorAgentId: null,
      highestErrorAgentName: null,
      highestErrorCount: 0,
    };
  }, [serverInsights, state]);

  const gaps = serverInsights?.parallelismGaps ?? [];
  const signals = serverInsights?.stuckSignals ?? stuckSignals;
  const errorRecoveryEntries = serverInsights?.errorRecovery ?? [];
  const agentTypeProfiles = serverInsights?.agentTypeProfiles ?? [];

  // Selected session for budget card + iteration sparkline
  const selectedSessionId = useMemo(() => {
    return Array.from(state.sessions.keys())[0];
  }, [state.sessions]);
  const selectedSession = selectedSessionId ? state.sessions.get(selectedSessionId) : undefined;

  // Initial budget — server value if present, else localStorage fallback, else 0
  const lsBudget = selectedSessionId ? loadBudgetLS(selectedSessionId) : null;
  const initialBudget =
    selectedSession?.budget_usd ?? lsBudget?.budget_usd ?? 0;
  const initialKill =
    selectedSession?.kill_on_exceed ?? lsBudget?.kill_on_exceed ?? false;

  // Cumulative cost per iteration boundary for selected session
  const { iterations, cumulativeAtIter } = useMemo(() => {
    const iters = selectedSessionId
      ? [...(state.iterations.get(selectedSessionId) ?? [])].sort((a, b) => a.n - b.n)
      : [];
    if (!selectedSessionId || iters.length === 0) {
      return { iterations: iters, cumulativeAtIter: [] };
    }
    // Build per-event cost approximation: input_tokens * 3/1M + output_tokens * 15/1M
    const sessAgentIds = new Set(
      Array.from(state.agents.values())
        .filter((a) => a.session_id === selectedSessionId)
        .map((a) => a.id)
    );
    let cum = 0;
    const out: number[] = [];
    let evIdx = 0;
    const sessEvents = state.events
      .filter(
        (e) =>
          e.session_id === selectedSessionId &&
          (e.agent_id == null || sessAgentIds.has(e.agent_id))
      )
      .sort((a, b) => a.ts - b.ts);
    for (const it of iters) {
      const cutoff = it.ended_at ?? Date.now();
      while (evIdx < sessEvents.length && sessEvents[evIdx]!.ts <= cutoff) {
        const e = sessEvents[evIdx]!;
        const it_in = typeof e["input_tokens"] === "number" ? (e["input_tokens"] as number) : 0;
        const it_out = typeof e["output_tokens"] === "number" ? (e["output_tokens"] as number) : 0;
        cum += (it_in / 1_000_000) * 3 + (it_out / 1_000_000) * 15;
        evIdx++;
      }
      out.push(cum);
    }
    return { iterations: iters, cumulativeAtIter: out };
  }, [selectedSessionId, state]);

  if (agents.length === 0) {
    return <EmptyState message="No insights yet — needs at least one completed session" />;
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Budget card */}
      <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-3">
          Budget
        </div>
        <BudgetCard
          sessionId={selectedSessionId}
          initialBudget={initialBudget}
          initialKill={initialKill}
        />
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <div className="text-[9px] font-mono text-[var(--fg-subtle)] mb-1">
            Cumulative cost per iteration
          </div>
          <IterationSparkline
            iterations={iterations}
            budget={initialBudget}
            cumulativeAtIter={cumulativeAtIter}
          />
        </div>
      </section>

      {/* Ralph iterations summary (only when iterations detected) */}
      {state.iterations.size > 0 && (
        <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
            Ralph Iterations
          </div>
          <RalphIterationsCard state={state} />
        </section>
      )}

      {/* Stuck alerts */}
      {signals.length > 0 && (
        <div className="space-y-2">
          {signals.map((sig, i) => (
            <StuckAgentCard key={i} sig={sig} state={state} />
          ))}
        </div>
      )}

      {/* Cost breakdown */}
      <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-3">
          Cost Breakdown
        </div>
        <CostBar
          perAgent={costPerAgent}
          totalUsd={totalUsd}
          source={costSource}
          coveragePct={coveragePct}
        />
      </section>

      {/* Bottleneck */}
      {bottleneck.longestAgentName && (
        <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
            Bottleneck
          </div>
          <div className="text-xs font-mono text-[var(--fg)]">
            {bottleneck.longestAgentName}
          </div>
          <div className="text-[10px] font-mono text-[var(--fg-muted)] mt-0.5">
            Longest agent · {formatDuration(bottleneck.longestDurationMs)}
          </div>
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] mt-1">
            Recommendation: consider splitting or parallelising this agent&apos;s work.
          </div>
        </section>
      )}

      {/* Parallelism gaps */}
      {gaps.length > 0 && (
        <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
            Parallelism Opportunities ({gaps.length})
          </div>
          <div className="space-y-1.5">
            {gaps.slice(0, 5).map((gap, i) => {
              const a = state.agents.get(gap.agents[0]);
              const b = state.agents.get(gap.agents[1]);
              return (
                <div key={i} className="text-[10px] font-mono text-[var(--fg-muted)]">
                  <span className="text-[var(--fg)]">{a?.name ?? gap.agents[0]}</span>
                  {" → "}
                  <span className="text-[var(--fg)]">{b?.name ?? gap.agents[1]}</span>
                  <span className="text-[var(--fg-subtle)] ml-1">
                    ({formatDuration(gap.overlapOpportunityMs)} gap)
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Error recovery */}
      <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
          Error Recovery
        </div>
        <ErrorRecoveryCard entries={errorRecoveryEntries} />
      </section>

      {/* Agent type profiles (from current session) */}
      {agentTypeProfiles.length > 0 && (
        <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
            Agent Type Profiles
          </div>
          <AgentTypeProfilesCard profiles={agentTypeProfiles} />
        </section>
      )}

      {/* Agent type trends (from historical baselines) */}
      <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-2">
          Agent Type Trends
        </div>
        <AgentTypeTrendsCard baselines={baselines} />
      </section>

      {/* Agent performance table */}
      <section className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider mb-3">
          Agent Performance
        </div>
        <AgentTable agents={agents} costMap={costMap} baselinesMap={baselinesMap} />
      </section>
    </div>
  );
}
