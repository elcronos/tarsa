import type { AgentStatus } from "../types";

export type StatusFilterSet = Set<AgentStatus>;

const ORDER: AgentStatus[] = ["active", "awaiting", "done", "error"];
const LABEL: Record<AgentStatus, string> = {
  active: "running",
  awaiting: "awaiting",
  done: "complete",
  error: "error",
};
const COLOR: Record<AgentStatus, string> = {
  active: "text-blue-400 bg-blue-500/10 border-blue-500/30",
  awaiting: "text-amber-400 bg-amber-400/10 border-amber-400/30",
  done: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
  error: "text-red-400 bg-red-500/10 border-red-500/30",
};

export const ALL_STATUSES: StatusFilterSet = new Set(ORDER);

export default function StatusFilter({
  enabled,
  onChange,
  counts,
}: {
  enabled: StatusFilterSet;
  onChange: (next: StatusFilterSet) => void;
  counts?: Partial<Record<AgentStatus, number>>;
}) {
  const toggle = (s: AgentStatus) => {
    const next = new Set(enabled);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    if (next.size === 0) {
      onChange(new Set(ORDER));
    } else {
      onChange(next);
    }
  };

  return (
    <div className="flex items-center gap-1 text-[10px] font-mono">
      {ORDER.map((s) => {
        const on = enabled.has(s);
        const count = counts?.[s];
        return (
          <button
            key={s}
            onClick={() => toggle(s)}
            className={`px-1.5 py-0.5 rounded border transition ${
              on
                ? COLOR[s]
                : "text-[var(--fg-subtle)] border-[var(--border)] bg-transparent opacity-50"
            }`}
            title={on ? `Hide ${LABEL[s]}` : `Show ${LABEL[s]}`}
          >
            {LABEL[s]}
            {count !== undefined && <span className="ml-1 opacity-70">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
