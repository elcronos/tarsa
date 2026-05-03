/**
 * SessionHistory — popover listing dismissed sessions with restore button.
 * Triggered by clock icon in TopBar.
 */

import { useEffect, useRef } from "react";
import type { Session } from "../types";

interface SessionHistoryProps {
  dismissedSessions: Session[];
  onRestore: (sessionId: string) => void;
  onClose: () => void;
}

export default function SessionHistory({
  dismissedSessions,
  onRestore,
  onClose,
}: SessionHistoryProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-10 right-2 z-50 w-64 rounded border border-[var(--border)] bg-[var(--surface-raised)] shadow-lg"
    >
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-[10px] font-mono text-[var(--fg-subtle)] uppercase tracking-widest">
          Session History
        </span>
        <button
          onClick={onClose}
          className="text-[var(--fg-subtle)] hover:text-[var(--fg)] text-sm"
          aria-label="Close history"
        >
          ×
        </button>
      </div>

      <div className="max-h-64 overflow-y-auto">
        {dismissedSessions.length === 0 ? (
          <div className="px-3 py-4 text-[10px] font-mono text-[var(--fg-subtle)]">
            No dismissed sessions
          </div>
        ) : (
          dismissedSessions.map((s) => {
            const name = s.name ?? `Session ${s.id.slice(0, 8)}`;
            return (
              <div
                key={s.id}
                className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] last:border-b-0"
              >
                <span className="text-[10px] font-mono text-[var(--fg-muted)] truncate flex-1 mr-2">
                  {name}
                </span>
                <button
                  onClick={() => onRestore(s.id)}
                  className="text-[10px] font-mono text-[var(--accent)] hover:underline shrink-0"
                >
                  restore
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
