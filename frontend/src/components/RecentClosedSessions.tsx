import { useState, useEffect, useCallback, useRef } from "react";
import type { Session } from "../types";
import { relativeTime } from "../utils/relativeTime";
import { authHeaders } from "../utils/auth";

function formatDuration(startedAt: number, endedAt: number): string {
  const ms = endedAt - startedAt;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

interface Props {
  onSelectSession: (id: string) => void;
  onClose: () => void;
}

export default function RecentClosedSessions({ onSelectSession, onClose }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchSessions = useCallback(() => {
    fetch("/api/sessions?status=closed&limit=50", { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: Session[]) => {
        setSessions(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 30_000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  const now = Date.now();

  return (
    <div
      ref={containerRef}
      className="absolute top-11 right-3 z-50 w-[420px] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--fg-subtle)]">
          recently closed
        </span>
        <button
          onClick={onClose}
          className="text-[var(--fg-subtle)] hover:text-[var(--fg)] text-sm px-1"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-4 text-[11px] font-mono text-[var(--fg-subtle)]">
            Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-4 text-[11px] font-mono text-[var(--fg-subtle)]">
            No closed sessions yet
          </div>
        ) : (
          sessions.map((s) => {
            const label = s.name ?? s.id.slice(0, 8);
            const cwdBase = s.cwd ? s.cwd.split("/").pop() ?? s.cwd : null;
            const duration =
              s.ended_at != null ? formatDuration(s.started_at, s.ended_at) : null;
            const ago = s.ended_at != null ? relativeTime(s.ended_at, now) : null;

            return (
              <button
                key={s.id}
                onClick={() => { onSelectSession(s.id); onClose(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] font-mono hover:bg-[var(--surface-raised)] transition-colors border-b border-[var(--border)] last:border-b-0"
              >
                <span className="text-[var(--fg)] truncate max-w-[120px]">{label}</span>
                {cwdBase && (
                  <>
                    <span className="text-[var(--fg-subtle)]">·</span>
                    <span className="text-[var(--fg-muted)] truncate max-w-[100px]">{cwdBase}</span>
                  </>
                )}
                {duration && (
                  <>
                    <span className="text-[var(--fg-subtle)]">·</span>
                    <span className="text-[var(--fg-subtle)]">{duration}</span>
                  </>
                )}
                {ago && (
                  <>
                    <span className="text-[var(--fg-subtle)]">·</span>
                    <span className="text-[var(--fg-subtle)]">{ago}</span>
                  </>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
