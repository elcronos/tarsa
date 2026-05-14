import type { ModelKey } from "../../../src/shared/pricing.js";

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

export async function fetchSessionCost(sessionId: string): Promise<SessionCostResult> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/cost`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<SessionCostResult>;
}
