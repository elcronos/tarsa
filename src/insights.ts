/**
 * Insights engine — bottleneck detection, cost estimation, parallelism gaps, stuck signals.
 */

import type { Agent, State, ToolCall } from "./models.js";
import { createHash } from "node:crypto";
import { PRICING, CACHE_TTL_MS, detectModel, priceUsd, type ModelKey } from "./shared/pricing.js";

// ── Pricing constants (per million tokens) ────────────────────────────────
// Re-exported for backward compat with existing tests. Canonical source:
// `src/shared/pricing.ts`.
export const SONNET_INPUT = PRICING.sonnet.input;
export const SONNET_OUTPUT = PRICING.sonnet.output;
export const SONNET_CACHE_READ = PRICING.sonnet.cacheRead;
export const SONNET_CACHE_WRITE = PRICING.sonnet.cacheWrite;
export const OPUS_INPUT = PRICING.opus.input;
export const OPUS_OUTPUT = PRICING.opus.output;
export const OPUS_CACHE_READ = PRICING.opus.cacheRead;
export const OPUS_CACHE_WRITE = PRICING.opus.cacheWrite;
export const HAIKU_INPUT = PRICING.haiku.input;
export const HAIKU_OUTPUT = PRICING.haiku.output;
export const HAIKU_CACHE_READ = PRICING.haiku.cacheRead;
export const HAIKU_CACHE_WRITE = PRICING.haiku.cacheWrite;

// ── Bottleneck ────────────────────────────────────────────────────────────

export interface BottleneckResult {
  longestAgent: Agent | null;
  highestErrorAgent: Agent | null;
  longestDurationMs: number;
  highestErrorCount: number;
}

export function bottleneck(state: State): BottleneckResult {
  let longestAgent: Agent | null = null;
  let longestDurationMs = 0;
  let highestErrorAgent: Agent | null = null;
  let highestErrorCount = 0;

  for (const agent of state.agents.values()) {
    const duration = agent.last_seen_ms - agent.first_seen_ms;
    if (duration > longestDurationMs) {
      longestDurationMs = duration;
      longestAgent = agent;
    }
    if (agent.error_count > highestErrorCount) {
      highestErrorCount = agent.error_count;
      highestErrorAgent = agent;
    }
  }

  return { longestAgent, highestErrorAgent, longestDurationMs, highestErrorCount };
}

// ── Cost estimation ───────────────────────────────────────────────────────

export interface AgentCost {
  agentId: string;
  agentName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usd: number;
  model: ModelKey;
}

export interface CostEstimateResult {
  perAgent: AgentCost[];
  totalUsd: number;
}

export interface AgentCostWithSource extends AgentCost {
  source: "measured" | "estimated_chars" | "tool_count_fallback";
}

export interface CostEstimateResultWithSource {
  perAgent: AgentCostWithSource[];
  totalUsd: number;
  source: "measured" | "estimated_chars" | "tool_count_fallback";
}

// ── Shared per-event token fold helper ───────────────────────────────────

interface EventTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: ModelKey;
}

/**
 * Fold token fields from a single event into an accumulator.
 * Shared between costEstimate (live state) and sessionCostBreakdown (historical events).
 */
export function foldEventTokens(
  acc: EventTokens,
  event: { [key: string]: unknown }
): EventTokens {
  const it = event["input_tokens"];
  const ot = event["output_tokens"];
  const cr = event["cache_read"];
  const cw = event["cache_creation"];
  const m = event["model"];
  let { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, model } = acc;
  if (typeof it === "number") inputTokens += it;
  if (typeof ot === "number") outputTokens += ot;
  if (typeof cr === "number") cacheReadTokens += cr;
  if (typeof cw === "number") cacheCreationTokens += cw;
  if (typeof m === "string") {
    const detected = detectModel(m);
    if (detected !== "sonnet") model = detected;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, model };
}

/**
 * Estimate USD cost per agent.
 *
 * When tokensMap is provided (from transcript), uses those as measured values.
 * Otherwise reads token counts from events if present (fields: input_tokens, output_tokens, model).
 */
export function costEstimate(
  state: State,
  tokensMap?: Record<string, { input_tokens: number; output_tokens: number; cache_read: number; cache_creation: number }>
): CostEstimateResultWithSource {
  const perAgent: AgentCostWithSource[] = [];
  let totalUsd = 0;
  const hasMeasured = tokensMap != null;

  for (const agent of state.agents.values()) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let model: ModelKey = "sonnet";
    let source: "measured" | "estimated_chars" | "tool_count_fallback" = "tool_count_fallback";

    if (hasMeasured && tokensMap[agent.id] != null) {
      // Use transcript-measured tokens
      const t = tokensMap[agent.id]!;
      inputTokens = t.input_tokens;
      outputTokens = t.output_tokens;
      cacheReadTokens = t.cache_read;
      cacheCreationTokens = t.cache_creation;
      if (
        inputTokens > 0 ||
        outputTokens > 0 ||
        cacheReadTokens > 0 ||
        cacheCreationTokens > 0
      ) {
        source = "measured";
      }
    }

    if (source === "tool_count_fallback") {
      // Aggregate token data from events belonging to this agent using shared helper
      let acc: EventTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: "sonnet" };
      for (const event of state.events) {
        if (event.agent_id !== agent.id) continue;
        acc = foldEventTokens(acc, event as { [key: string]: unknown });
      }
      inputTokens = acc.inputTokens;
      outputTokens = acc.outputTokens;
      cacheReadTokens = acc.cacheReadTokens;
      cacheCreationTokens = acc.cacheCreationTokens;
      model = acc.model;
    }

    // Char-based fallback: sum chars from tool_calls when no token data found
    if (
      source === "tool_count_fallback" &&
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheReadTokens === 0 &&
      cacheCreationTokens === 0
    ) {
      const calls: ToolCall[] = state.tool_calls.get(agent.id) ?? [];
      let inputChars = 0;
      let outputChars = 0;
      for (const tc of calls) {
        inputChars += JSON.stringify(tc.input).length;
        outputChars += tc.response?.length ?? 0;
      }
      if (inputChars > 0 || outputChars > 0) {
        // tokens ≈ chars / 4
        inputTokens = Math.round(inputChars / 4);
        outputTokens = Math.round(outputChars / 4);
        source = "estimated_chars";
      }
    }

    const usd = priceUsd(
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      model
    );

    totalUsd += usd;
    perAgent.push({
      agentId: agent.id,
      agentName: agent.name,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      usd: Math.round(usd * 1_000_000) / 1_000_000,
      model,
      source,
    });
  }

  const anyMeasured = perAgent.some((a) => a.source === "measured");
  const anyCharEstimated = perAgent.some((a) => a.source === "estimated_chars");

  return {
    perAgent,
    totalUsd: Math.round(totalUsd * 1_000_000) / 1_000_000,
    source: anyMeasured ? "measured" : anyCharEstimated ? "estimated_chars" : "tool_count_fallback",
  };
}

// ── Per-session cost breakdown ────────────────────────────────────────────

export interface SessionCostRow {
  agentId: string;
  agentName: string | null;
  model: ModelKey;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usd: number;
  source: "measured" | "estimated_chars" | "tool_count_fallback";
}

export interface SessionCostResult {
  sessionId: string;
  totalUsd: number;
  coveragePercent: number;
  perAgent: SessionCostRow[];
  perModel: Record<ModelKey, { usd: number; tokens: number }>;
  eventCount: number;
}

/**
 * Pure function: compute per-session cost from a flat event array.
 * Works post-mortem from sqlite rows without needing live State.
 * Uses foldEventTokens — zero duplication with costEstimate.
 */
export function sessionCostBreakdown(
  sessionId: string,
  events: Array<{ [key: string]: unknown }>
): SessionCostResult {
  // Group events by agent_id
  const agentEvents = new Map<string, Array<{ [key: string]: unknown }>>();
  for (const ev of events) {
    const agentId = typeof ev["agent_id"] === "string" ? ev["agent_id"] : "_unknown";
    const arr = agentEvents.get(agentId) ?? [];
    arr.push(ev);
    agentEvents.set(agentId, arr);
  }

  const perAgent: SessionCostRow[] = [];
  const perModel: Record<ModelKey, { usd: number; tokens: number }> = {
    sonnet: { usd: 0, tokens: 0 },
    opus: { usd: 0, tokens: 0 },
    haiku: { usd: 0, tokens: 0 },
  };
  let totalUsd = 0;

  for (const [agentId, agentEvs] of agentEvents) {
    let acc: EventTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: "sonnet" };
    let agentName: string | null = null;

    for (const ev of agentEvs) {
      acc = foldEventTokens(acc, ev);
      if (agentName === null && typeof ev["agent_name"] === "string") {
        agentName = ev["agent_name"];
      }
    }

    const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, model } = acc;
    const hasTokens = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0;
    const source: SessionCostRow["source"] = hasTokens ? "measured" : "tool_count_fallback";

    const usd = priceUsd(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, model);
    const roundedUsd = Math.round(usd * 1_000_000) / 1_000_000;
    totalUsd += usd;

    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
    perModel[model].usd += roundedUsd;
    perModel[model].tokens += totalTokens;

    perAgent.push({
      agentId,
      agentName,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      usd: roundedUsd,
      source,
    });
  }

  const measuredCount = perAgent.filter((a) => a.source === "measured").length;
  const coveragePercent = perAgent.length === 0
    ? 100
    : Math.round((measuredCount / perAgent.length) * 100);

  return {
    sessionId,
    totalUsd: Math.round(totalUsd * 1_000_000) / 1_000_000,
    coveragePercent,
    perAgent,
    perModel,
    eventCount: events.length,
  };
}

/**
 * Share of agents (0-100) whose cost data has source === "measured".
 * Honesty signal: surfaces when USD numbers are estimates vs Anthropic-reported.
 *
 * Returns 100 when perAgent is empty (no data → no dishonesty to flag).
 * Result is rounded to nearest integer percent.
 */
export function pricedCoveragePercent(cost: CostEstimateResultWithSource): number {
  if (cost.perAgent.length === 0) return 100;
  const measured = cost.perAgent.filter((a) => a.source === "measured").length;
  return Math.round((measured / cost.perAgent.length) * 100);
}

// ── Parallelism gaps ──────────────────────────────────────────────────────

export interface ParallelismGap {
  agents: [string, string]; // agent IDs that ran sequentially but had no dependency
  aEndMs: number;
  bStartMs: number;
  overlapOpportunityMs: number;
}

/**
 * Find agents that ran sequentially but share no data dependency
 * (no parent-child edge between them and their time ranges don't overlap).
 *
 * Heuristic: two sibling agents (same parent) where one ended before the
 * other started — they could potentially have been parallelised.
 */
export function parallelismGaps(state: State): ParallelismGap[] {
  const gaps: ParallelismGap[] = [];

  // Group agents by parent
  const byParent = new Map<string, Agent[]>();
  for (const agent of state.agents.values()) {
    if (!agent.parent_id) continue;
    const siblings = byParent.get(agent.parent_id) ?? [];
    siblings.push(agent);
    byParent.set(agent.parent_id, siblings);
  }

  // Build edge set for dependency check
  const edgePairs = new Set<string>(
    state.edges.map((e) => `${e.from_id}|${e.to_id}`)
  );

  for (const siblings of byParent.values()) {
    if (siblings.length < 2) continue;

    // Sort by start time
    const sorted = [...siblings].sort((a, b) => a.first_seen_ms - b.first_seen_ms);

    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;

        // Skip if there's a direct dependency edge between them
        const hasDep =
          edgePairs.has(`${a.id}|${b.id}`) || edgePairs.has(`${b.id}|${a.id}`);
        if (hasDep) continue;

        // Check sequential: a ended before b started
        if (a.last_seen_ms > 0 && b.first_seen_ms > a.last_seen_ms) {
          const gap = b.first_seen_ms - a.last_seen_ms;
          gaps.push({
            agents: [a.id, b.id],
            aEndMs: a.last_seen_ms,
            bStartMs: b.first_seen_ms,
            overlapOpportunityMs: gap,
          });
        }
      }
    }
  }

  // Sort by largest opportunity first
  return gaps.sort((a, b) => b.overlapOpportunityMs - a.overlapOpportunityMs);
}

// ── Stuck signals ─────────────────────────────────────────────────────────

export interface StuckSignal {
  agentId: string;
  agentName: string;
  reason: "repeated_tool" | "consecutive_failures";
  detail: string;
  tool_name?: string;
  count: number;
}

const REPEAT_WINDOW_MS = 60_000; // 1 minute
const REPEAT_THRESHOLD = 3;
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

function hashInput(input: Record<string, unknown>): string {
  return createHash("sha1").update(JSON.stringify(input)).digest("hex").slice(0, 8);
}

/**
 * Detect agents that are stuck:
 *   1. Repeated tool calls: same tool_name + same input hash, N times within window
 *   2. Consecutive failures: N consecutive PostToolUseFailure events
 */
export function stuckSignals(state: State): StuckSignal[] {
  const signals: StuckSignal[] = [];

  for (const agent of state.agents.values()) {
    // Skip already-done agents
    if (agent.status === "done") continue;

    const calls: ToolCall[] = state.tool_calls.get(agent.id) ?? [];

    // --- Repeated tool calls ---
    // Group by (tool_name, input_hash) within window
    const buckets = new Map<string, { count: number; firstMs: number; lastMs: number }>();
    for (const tc of calls) {
      const key = `${tc.tool_name}|${hashInput(tc.input)}`;
      const bucket = buckets.get(key);
      if (!bucket) {
        buckets.set(key, { count: 1, firstMs: tc.started_ms, lastMs: tc.started_ms });
      } else {
        bucket.count++;
        bucket.lastMs = tc.started_ms;
      }
    }
    for (const [key, bucket] of buckets) {
      if (
        bucket.count >= REPEAT_THRESHOLD &&
        bucket.lastMs - bucket.firstMs <= REPEAT_WINDOW_MS
      ) {
        const [toolName] = key.split("|");
        signals.push({
          agentId: agent.id,
          agentName: agent.name,
          reason: "repeated_tool",
          detail: `Tool "${toolName}" called ${bucket.count} times with same input within ${REPEAT_WINDOW_MS / 1000}s`,
          tool_name: toolName,
          count: bucket.count,
        });
      }
    }

    // --- Consecutive failures ---
    // Count trailing consecutive error tool calls
    let consecutiveErrors = 0;
    for (let i = calls.length - 1; i >= 0; i--) {
      const tc = calls[i]!;
      if (tc.status === "error") {
        consecutiveErrors++;
      } else {
        break;
      }
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

// ── Error recovery ────────────────────────────────────────────────────────

export type RecoveryStatus = "retried_succeeded" | "retried_failed" | "no_retry";

export interface ErrorRecoveryEntry {
  agentId: string;
  agentName: string;
  tool_name: string;
  failed_tool_id: string;
  recovery: RecoveryStatus;
  retry_tool_id: string | null;
}

const RETRY_WINDOW_MS = 60_000;

/**
 * Scan tool calls for failed ones, then check if the same agent retried with
 * the same tool_name within 60s. Classify recovery.
 */
export function errorRecovery(state: State): ErrorRecoveryEntry[] {
  const entries: ErrorRecoveryEntry[] = [];

  for (const agent of state.agents.values()) {
    const calls: ToolCall[] = state.tool_calls.get(agent.id) ?? [];

    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i]!;
      if (tc.status !== "error") continue;

      // Look for a retry: same tool_name within RETRY_WINDOW_MS, after the failure
      let recovery: RecoveryStatus = "no_retry";
      let retry_tool_id: string | null = null;

      for (let j = i + 1; j < calls.length; j++) {
        const candidate = calls[j]!;
        if (candidate.started_ms - tc.started_ms > RETRY_WINDOW_MS) break;
        if (candidate.tool_name !== tc.tool_name) continue;
        // Found a retry
        retry_tool_id = candidate.id;
        recovery = candidate.status === "done" ? "retried_succeeded" : "retried_failed";
        break;
      }

      entries.push({
        agentId: agent.id,
        agentName: agent.name,
        tool_name: tc.tool_name,
        failed_tool_id: tc.id,
        recovery,
        retry_tool_id,
      });
    }
  }

  return entries;
}

// ── Agent performance table ───────────────────────────────────────────────

export interface AgentPerfRow {
  id: string;
  name: string;
  type: string | null;
  duration_ms: number;
  tool_count: number;
  errors: number;
  cost_usd: number;
}

/**
 * Build a per-agent performance table using computed cost from costEstimate.
 */
export function agentPerformanceTable(
  state: State,
  cost: CostEstimateResultWithSource
): AgentPerfRow[] {
  const costById = new Map(cost.perAgent.map((a) => [a.agentId, a.usd]));

  return Array.from(state.agents.values()).map((agent) => ({
    id: agent.id,
    name: agent.name,
    type: agent.subagent_type,
    duration_ms: agent.last_seen_ms - agent.first_seen_ms,
    tool_count: agent.tool_count,
    errors: agent.error_count,
    cost_usd: costById.get(agent.id) ?? 0,
  }));
}

// ── Agent type profiles ───────────────────────────────────────────────────

export interface AgentTypeProfile {
  type: string;
  sample_count: number;
  avg_duration_ms: number;
  avg_tool_count: number;
  summary: string;
}

/**
 * Group agents by subagent_type and produce plain-English profiles.
 */
export function agentTypeProfiles(state: State): AgentTypeProfile[] {
  const groups = new Map<string, { durations: number[]; toolCounts: number[] }>();

  for (const agent of state.agents.values()) {
    const type = agent.subagent_type ?? "root";
    const g = groups.get(type) ?? { durations: [], toolCounts: [] };
    g.durations.push(agent.last_seen_ms - agent.first_seen_ms);
    g.toolCounts.push(agent.tool_count);
    groups.set(type, g);
  }

  const profiles: AgentTypeProfile[] = [];

  for (const [type, g] of groups) {
    const n = g.durations.length;
    const avg_duration_ms = Math.round(g.durations.reduce((a, b) => a + b, 0) / n);
    const avg_tool_count = Math.round(g.toolCounts.reduce((a, b) => a + b, 0) / n);

    // Build plain-English ranges
    const minTools = Math.min(...g.toolCounts);
    const maxTools = Math.max(...g.toolCounts);
    const minDurS = (Math.min(...g.durations) / 1000).toFixed(1);
    const maxDurS = (Math.max(...g.durations) / 1000).toFixed(1);

    const toolRange = minTools === maxTools ? `${minTools}` : `${minTools}-${maxTools}`;
    const durRange =
      minDurS === maxDurS ? `${minDurS}s` : `${minDurS}s-${maxDurS}s`;

    const summary =
      `Usually makes ${toolRange} tool call${maxTools !== 1 ? "s" : ""}, ` +
      `takes ${durRange} ` +
      `(${n} sample${n !== 1 ? "s" : ""})`;

    profiles.push({ type, sample_count: n, avg_duration_ms, avg_tool_count, summary });
  }

  return profiles.sort((a, b) => b.sample_count - a.sample_count);
}

// ── Agent type trends (from baselines) ────────────────────────────────────

export interface BaselineRow {
  agent_type: string;
  mean_duration: number;
  mean_tool_count: number;
  mean_cost: number;
  sample_count: number;
  stddev_duration: number;
  stddev_tool_count: number;
  updated_at: number;
  tool_sequence_common?: string;
}

export interface AgentTypeTrend {
  type: string;
  sample_count: number;
  summary: string;
}

/**
 * Produce per-type plain-English summary from stored baselines.
 * Uses mean ± stddev to compute human-readable ranges.
 */
export function agentTypeTrends(baselines: BaselineRow[]): AgentTypeTrend[] {
  return baselines.map((b) => {
    const toolLow = Math.max(0, Math.round(b.mean_tool_count - b.stddev_tool_count));
    const toolHigh = Math.round(b.mean_tool_count + b.stddev_tool_count);
    const durLowS = Math.max(0, (b.mean_duration - b.stddev_duration) / 1000);
    const durHighS = (b.mean_duration + b.stddev_duration) / 1000;

    const toolRange =
      toolLow === toolHigh
        ? `${toolLow}`
        : `${toolLow}-${toolHigh}`;

    const durRange =
      Math.abs(durHighS - durLowS) < 0.05
        ? `${durLowS.toFixed(1)}s`
        : `${durLowS.toFixed(1)}-${durHighS.toFixed(1)}s`;

    const summary =
      `Usually makes ${toolRange} tool call${toolHigh !== 1 ? "s" : ""}, ` +
      `takes ${durRange} based on ${b.sample_count} prior run${b.sample_count !== 1 ? "s" : ""}`;

    return { type: b.agent_type, sample_count: b.sample_count, summary };
  });
}

// ── Budget exceeded detection ─────────────────────────────────────────────

export interface BudgetExceeded {
  session_id: string;
  current: number;
  budget: number;
  kill: boolean;
}

/**
 * For each session with a budget set, compute its cumulative cost; if
 * cost > budget, emit a BudgetExceeded record. Caller is responsible for
 * deduping (only emit on the first crossing).
 *
 * Pass `tokensMap` (Anthropic-reported transcript tokens, incl. cache) so the
 * budget check uses measured cost. Without it, costEstimate falls back to a
 * char/4 heuristic that ignores cache tokens and badly undercounts.
 */
export function detectBudgetExceeded(
  state: State,
  tokensMap?: Record<string, { input_tokens: number; output_tokens: number; cache_read: number; cache_creation: number }>
): BudgetExceeded[] {
  const out: BudgetExceeded[] = [];
  if (state.sessions.size === 0) return out;

  // Compute per-session cost from per-agent cost
  const cost = costEstimate(state, tokensMap);
  const costPerSession = new Map<string, number>();
  for (const a of cost.perAgent) {
    const agent = state.agents.get(a.agentId);
    if (!agent) continue;
    const sid = agent.session_id;
    costPerSession.set(sid, (costPerSession.get(sid) ?? 0) + a.usd);
  }

  for (const [sid, session] of state.sessions) {
    if (typeof session.budget_usd !== "number" || session.budget_usd <= 0) continue;
    const current = costPerSession.get(sid) ?? 0;
    if (current > session.budget_usd) {
      out.push({
        session_id: sid,
        current: Math.round(current * 1_000_000) / 1_000_000,
        budget: session.budget_usd,
        kill: session.kill_on_exceed === true,
      });
    }
  }
  return out;
}

// ── Context window utilization ───────────────────────────────────────────

export interface ContextUsageRow {
  agentId: string;
  agentName: string;
  model: ModelKey;
  tokensInContext: number;
  contextWindow: number;
  fillPercent: number;
  lastCacheWriteMs: number | null;
  cacheExpiresMs: number | null;
}

export interface ContextUsageResult {
  perAgent: ContextUsageRow[];
}

export function contextUsage(
  state: State,
  tokensMap?: Record<string, { input_tokens: number; output_tokens: number; cache_read: number; cache_creation: number }>
): ContextUsageResult {
  const perAgent: ContextUsageRow[] = [];

  for (const agent of state.agents.values()) {
    if (agent.status === "done") continue;

    let tokensInContext = 0;
    let model: ModelKey = "sonnet";
    let lastCacheWriteMs: number | null = null;

    if (tokensMap?.[agent.id] != null) {
      const t = tokensMap[agent.id]!;
      tokensInContext = t.input_tokens + t.cache_read + t.cache_creation;
    }

    for (const event of state.events) {
      if (event.agent_id !== agent.id) continue;
      const m = event["model"];
      if (typeof m === "string") {
        const detected = detectModel(m);
        if (detected !== "sonnet") model = detected;
      }
      const cw = event["cache_creation"];
      if (typeof cw === "number" && cw > 0) {
        if (lastCacheWriteMs === null || event.ts > lastCacheWriteMs) {
          lastCacheWriteMs = event.ts;
        }
      }
      if (tokensMap == null) {
        const it = event["input_tokens"];
        const cr = event["cache_read"];
        const cc = event["cache_creation"];
        if (typeof it === "number") tokensInContext += it;
        if (typeof cr === "number") tokensInContext += cr;
        if (typeof cc === "number") tokensInContext += cc;
      }
    }

    const contextWindow = PRICING[model].contextWindow;
    const fillPercent = Math.round((tokensInContext / contextWindow) * 1000) / 10;
    const cacheExpiresMs = lastCacheWriteMs !== null ? lastCacheWriteMs + CACHE_TTL_MS : null;

    perAgent.push({
      agentId: agent.id,
      agentName: agent.name,
      model,
      tokensInContext,
      contextWindow,
      fillPercent,
      lastCacheWriteMs,
      cacheExpiresMs,
    });
  }

  return { perAgent };
}

// ── Z-score badge ─────────────────────────────────────────────────────────

export type ZScoreBadge = "fast" | "normal" | "slow";

/**
 * Compute z-score of agent duration vs baseline. Returns null if
 * baseline has insufficient samples or zero stddev.
 */
export function zScoreBadge(
  agentDurationMs: number,
  baseline: BaselineRow
): ZScoreBadge | null {
  if (baseline.sample_count < 5 || baseline.stddev_duration === 0) return null;
  const z = (agentDurationMs - baseline.mean_duration) / baseline.stddev_duration;
  if (z < -1) return "fast";
  if (z > 1) return "slow";
  return "normal";
}
