import { useEffect, useState } from "react";

export interface ContextUsageRow {
  agentId: string;
  agentName: string;
  model: string;
  tokensInContext: number;
  contextWindow: number;
  fillPercent: number;
  lastCacheWriteMs: number | null;
  cacheExpiresMs: number | null;
}

interface Props {
  rows: ContextUsageRow[];
}

function fillColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-yellow-400";
  return "bg-green-500";
}

function formatCountdown(expiresMs: number, nowMs: number): string | null {
  const remaining = expiresMs - nowMs;
  if (remaining <= 0) return null;
  const totalSec = Math.ceil(remaining / 1000);
  const mm = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const ss = (totalSec % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function CacheCountdown({ expiresMs }: { expiresMs: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const countdown = formatCountdown(expiresMs, now);
  if (countdown === null) {
    return (
      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
        cache expired
      </span>
    );
  }
  return (
    <span className="text-[9px] font-mono text-[var(--fg-subtle)]">
      cache expires {countdown}
    </span>
  );
}

export default function ContextWindowCard({ rows }: Props): JSX.Element | null {
  if (rows.length === 0) return null;

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const clampedPct = Math.min(100, Math.max(0, row.fillPercent));
        return (
          <div key={row.agentId} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-mono text-[var(--fg)] truncate flex-1 min-w-0">
                {row.agentName}
              </span>
              <span className="text-[9px] font-mono text-[var(--fg-subtle)] shrink-0">
                {row.model}
              </span>
              <span
                className={`text-[9px] font-mono px-1 py-0.5 rounded shrink-0 ${
                  row.fillPercent >= 90
                    ? "bg-red-500/20 text-red-400"
                    : row.fillPercent >= 70
                      ? "bg-yellow-400/20 text-yellow-300"
                      : "bg-green-500/20 text-green-400"
                }`}
              >
                {row.fillPercent.toFixed(1)}%
              </span>
            </div>

            <div className="h-1.5 w-full rounded-full bg-[var(--border)] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${fillColor(row.fillPercent)}`}
                style={{ width: `${clampedPct}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[9px] font-mono text-[var(--fg-subtle)]">
              <span>
                {(row.tokensInContext / 1000).toFixed(0)}k / {(row.contextWindow / 1000).toFixed(0)}k tokens
              </span>
              {row.cacheExpiresMs !== null && (
                <CacheCountdown expiresMs={row.cacheExpiresMs} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
