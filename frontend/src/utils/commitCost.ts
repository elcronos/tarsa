import type { ModelKey } from "../../../src/shared/pricing.js";
import type { SessionCostRow } from "./sessionCost";

export interface CommitCostResult {
  sha: string;
  totalUsd: number;
  coveragePercent: number;
  perAgent: SessionCostRow[];
  perModel: Record<ModelKey, { usd: number; tokens: number }>;
  eventCount: number;
}

export async function fetchCommitCost(sha: string): Promise<CommitCostResult> {
  const r = await fetch(`/api/commits/${encodeURIComponent(sha)}/cost`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<CommitCostResult>;
}
