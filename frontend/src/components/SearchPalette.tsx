import { useEffect, useRef } from "react";
import type { SearchResult } from "../hooks/useSearch";
import { formatTime } from "../utils/format";

interface SearchPaletteProps {
  query: string;
  onQueryChange: (q: string) => void;
  results: SearchResult[];
  onSelectResult: (result: SearchResult) => void;
  onClose: () => void;
}

const EVENT_COLORS: Record<string, string> = {
  PreToolUse: "#3b82f6",
  PostToolUse: "#10b981",
  PostToolUseFailure: "#ef4444",
  SubagentStart: "#a78bfa",
  SubagentStop: "#71717a",
};

export default function SearchPalette({
  query,
  onQueryChange,
  results,
  onSelectResult,
  onClose,
}: SearchPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Palette */}
      <div className="relative z-10 w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden">
        {/* Input */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border)]">
          <span className="text-[var(--fg-subtle)] text-sm">⌘K</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search events, tools, agents…"
            className="flex-1 bg-transparent text-sm font-mono text-[var(--fg)] placeholder:text-[var(--fg-subtle)] outline-none"
          />
          {query && (
            <button
              onClick={() => onQueryChange("")}
              className="text-[var(--fg-subtle)] hover:text-[var(--fg)] text-xs"
            >
              ✕
            </button>
          )}
        </div>

        {/* Results */}
        <div className="max-h-96 overflow-y-auto">
          {results.length === 0 && query.trim() && (
            <div className="px-4 py-6 text-center text-sm font-mono text-[var(--fg-subtle)]">
              No results for "{query}"
            </div>
          )}
          {results.length === 0 && !query.trim() && (
            <div className="px-4 py-6 text-center text-sm font-mono text-[var(--fg-subtle)]">
              Type to search events, tools, agents…
            </div>
          )}
          {results.map((r) => {
            const kind = String(r.event.hook_event ?? "");
            const color = EVENT_COLORS[kind] ?? "#52525b";
            return (
              <button
                key={r.event.id}
                onClick={() => onSelectResult(r)}
                className="w-full text-left px-4 py-2.5 border-b border-[var(--border)] hover:bg-[var(--surface-raised)] transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0"
                    style={{ backgroundColor: `${color}22`, color }}
                  >
                    {kind}
                  </span>
                  {r.event.tool_name && (
                    <span className="text-xs font-mono text-[var(--fg)] truncate flex-1">
                      {r.event.tool_name}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-[var(--fg-subtle)] shrink-0">
                    {formatTime(r.event.ts)}
                  </span>
                </div>
                {r.snippet && (
                  <div className="mt-0.5 text-[10px] font-mono text-[var(--fg-muted)] truncate">
                    {r.snippet}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-[var(--border)] flex items-center justify-between">
          <span className="text-[10px] font-mono text-[var(--fg-subtle)]">
            {results.length > 0 ? `${results.length} results` : ""}
          </span>
          <span className="text-[10px] font-mono text-[var(--fg-subtle)]">esc to close</span>
        </div>
      </div>
    </div>
  );
}
