import { useEffect, useMemo, useRef, useState } from "react";

export interface CommandItem {
  /** Stable unique id within the palette session. */
  id: string;
  /** Visible label, used as primary search target. */
  label: string;
  /** Short kind tag rendered on the left (e.g. "tab", "session", "agent"). */
  kind: string;
  /** Optional secondary text (session id, status, …). Also searchable. */
  hint?: string;
  /** Invoked on Enter / click. Palette closes automatically afterwards. */
  action: () => void;
}

interface Props {
  items: CommandItem[];
  onClose: () => void;
  placeholder?: string;
}

/**
 * Lightweight built-in command palette. No external `cmdk` / `kbar` dep.
 *
 * Search uses a simple ranked subsequence match against `label` + `hint`,
 * with a small bonus when the query is a prefix or a whole-word hit. Empty
 * query shows the full item list grouped visually via the `kind` tag.
 */
export default function CommandPalette({ items, onClose, placeholder }: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => rank(items, query), [items, query]);

  // Clamp cursor when filter shrinks.
  useEffect(() => {
    setCursor((c) => {
      if (filtered.length === 0) return 0;
      return Math.min(c, filtered.length - 1);
    });
  }, [filtered.length]);

  // Reset cursor when query changes (top match becomes intent).
  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Scroll the selected row into view as the user arrow-keys.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const run = (item: CommandItem) => {
    item.action();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (filtered.length === 0 ? 0 : (c + 1) % filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (filtered.length === 0 ? 0 : (c - 1 + filtered.length) % filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[cursor];
      if (item) run(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Home") {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setCursor(Math.max(0, filtered.length - 1));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div
        className="relative z-10 w-full max-w-xl rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "min(70vh, 540px)" }}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border)] shrink-0">
          <span className="text-[var(--fg-subtle)] text-xs font-mono">⌘K</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder ?? "Jump to tab, session, agent…"}
            className="flex-1 bg-transparent text-sm font-mono text-[var(--fg)] placeholder:text-[var(--fg-subtle)] outline-none min-w-0"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-[var(--fg-subtle)] hover:text-[var(--fg)] text-xs shrink-0"
              aria-label="Clear query"
            >
              ✕
            </button>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm font-mono text-[var(--fg-subtle)]">
              {query.trim() ? `No matches for "${query}"` : "No commands available"}
            </div>
          ) : (
            filtered.map((item, idx) => {
              const active = idx === cursor;
              return (
                <button
                  key={item.id}
                  data-idx={idx}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => run(item)}
                  className={
                    "w-full text-left px-3 py-2 border-b border-[var(--border)] flex items-center gap-2 transition-colors " +
                    (active ? "bg-[var(--surface-raised)]" : "hover:bg-[var(--surface-raised)]")
                  }
                >
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 bg-[var(--border)] text-[var(--fg-subtle)] uppercase tracking-wider">
                    {item.kind}
                  </span>
                  <span className="text-xs font-mono text-[var(--fg)] truncate flex-1 min-w-0">
                    {item.label}
                  </span>
                  {item.hint && (
                    <span className="text-[10px] font-mono text-[var(--fg-subtle)] truncate max-w-[40%] shrink-0">
                      {item.hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-[var(--border)] flex items-center justify-between text-[10px] font-mono text-[var(--fg-subtle)] shrink-0">
          <span>{filtered.length} of {items.length}</span>
          <span>↑↓ navigate · ↵ run · esc close</span>
        </div>
      </div>
    </div>
  );
}

// ── Ranking ──────────────────────────────────────────────────────────────

interface Scored {
  item: CommandItem;
  score: number;
}

/** Rank items by fuzzy match of `query` against `label` + `hint`. */
function rank(items: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const out: Scored[] = [];
  for (const item of items) {
    const label = item.label.toLowerCase();
    const hint = (item.hint ?? "").toLowerCase();
    const lScore = score(label, q);
    const hScore = score(hint, q);
    const best = Math.max(lScore, hScore * 0.7);
    if (best > 0) out.push({ item, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((s) => s.item);
}

/**
 * Score a haystack against a needle. 0 = no match. Higher = better.
 *
 * Heuristics:
 *  - exact substring: +50 (plus +30 if at start, +20 if word-boundary)
 *  - subsequence match: +1 per matched char, +2 if adjacent run
 *  - shorter haystack wins ties slightly (favor session id chips over noise)
 */
function score(hay: string, needle: string): number {
  if (!hay || !needle) return 0;
  // Exact substring.
  const idx = hay.indexOf(needle);
  if (idx >= 0) {
    let s = 50;
    if (idx === 0) s += 30;
    else if (hay[idx - 1] === " " || hay[idx - 1] === "-" || hay[idx - 1] === "_" || hay[idx - 1] === "/") s += 20;
    s += Math.max(0, 10 - Math.floor(hay.length / 8));
    return s;
  }
  // Subsequence match.
  let hi = 0;
  let s = 0;
  let lastHitAt = -2;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni]!;
    let found = -1;
    while (hi < hay.length) {
      if (hay[hi] === ch) {
        found = hi;
        hi++;
        break;
      }
      hi++;
    }
    if (found < 0) return 0;
    s += 1;
    if (found === lastHitAt + 1) s += 2;
    lastHitAt = found;
  }
  return s;
}
