import { useState, useEffect } from "react";
import type { ModelKey } from "../../../src/shared/pricing.js";
import { fetchSessionCost, type SessionCostResult } from "../utils/sessionCost";
import { formatCost } from "../utils/format";

const MODEL_COLORS: Record<ModelKey, string> = {
  sonnet: "bg-blue-500",
  opus: "bg-violet-500",
  haiku: "bg-emerald-500",
};

function StackedBar({ perModel, totalUsd }: { perModel: SessionCostResult["perModel"]; totalUsd: number }) {
  if (totalUsd === 0) return null;
  const models: ModelKey[] = ["sonnet", "opus", "haiku"];
  return (
    <div className="flex h-1.5 rounded overflow-hidden gap-px mt-1.5">
      {models.map((m) => {
        const pct = (perModel[m].usd / totalUsd) * 100;
        if (pct < 0.5) return null;
        return (
          <div
            key={m}
            title={`${m}: ${formatCost(perModel[m].usd)} · ${perModel[m].tokens.toLocaleString()} tokens`}
            className={`${MODEL_COLORS[m]} opacity-80 hover:opacity-100 transition-opacity`}
            style={{ width: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}

export default function SessionCostCard({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<SessionCostResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setData(null);
    setError(false);
    fetchSessionCost(sessionId)
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [sessionId]);

  if (error || !data) return null;

  if (data.perAgent.length === 0) {
    return (
      <div className="text-[9px] font-mono text-[var(--fg-subtle)] mt-1">
        No cost data yet
      </div>
    );
  }

  const measuredPct = data.coveragePercent;
  const estimatedPct = 100 - measuredPct;
  const coverageLabel = estimatedPct > 0
    ? `${measuredPct}% measured · ${estimatedPct}% estimated`
    : "100% measured";

  return (
    <div className="mt-1.5 space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-mono font-medium text-[var(--fg)]">
          {formatCost(data.totalUsd)}
        </span>
        <span className="text-[9px] font-mono text-[var(--fg-subtle)]">{coverageLabel}</span>
      </div>
      <StackedBar perModel={data.perModel} totalUsd={data.totalUsd} />
    </div>
  );
}
