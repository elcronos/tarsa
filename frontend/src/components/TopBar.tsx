import type { ConnectionStatus } from "../hooks/useAgentState";

interface Tab {
  id: string;
  label: string;
  stub?: boolean;
}

const TABS: Tab[] = [
  { id: "topology", label: "Topology" },
  { id: "global", label: "Global" },
  { id: "timeline", label: "Timeline" },
  { id: "replay", label: "Replay" },
  { id: "insights", label: "Insights" },
  { id: "compare", label: "Compare" },
];

interface TopBarProps {
  activeView: string;
  onViewChange: (view: string) => void;
  status: ConnectionStatus;
  onReconnect: () => void;
  onSearchOpen?: () => void;
  onHistoryOpen?: () => void;
  lastError?: string | null;
  reconnectAttempts?: number;
}

function StatusPill({
  status,
  onReconnect,
  lastError,
  reconnectAttempts,
}: {
  status: ConnectionStatus;
  onReconnect: () => void;
  lastError?: string | null;
  reconnectAttempts?: number;
}) {
  if (status === "live") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-mono text-emerald-400">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        live
      </span>
    );
  }
  if (status === "connecting") {
    const attempts = reconnectAttempts ?? 0;
    const label = attempts > 0 ? `reconnecting (attempt ${attempts})` : "connecting";
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-[10px] font-mono text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        {label}
      </span>
    );
  }
  const errorLabel = lastError ? `error: ${lastError}` : "error · reconnect";
  return (
    <button
      onClick={onReconnect}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20 text-[10px] font-mono text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
      {errorLabel}
    </button>
  );
}

export default function TopBar({ activeView, onViewChange, status, onReconnect, onSearchOpen, onHistoryOpen, lastError, reconnectAttempts }: TopBarProps) {
  return (
    <div className="flex items-center h-10 px-3 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 gap-4">
      {/* Brand */}
      <span className="font-mono text-xs font-semibold text-[var(--accent)] tracking-tight shrink-0">
        claudelens
      </span>

      <div className="w-px h-4 bg-[var(--border)] shrink-0" />

      {/* View tabs */}
      <nav className="flex items-center gap-0.5 flex-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onViewChange(tab.id)}
            className={`
              px-2.5 py-1 rounded text-xs font-mono transition-colors relative
              ${
                activeView === tab.id
                  ? "bg-[var(--surface-raised)] text-[var(--fg)]"
                  : "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-raised)]"
              }
            `}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Right side */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Session history clock icon */}
        <button
          onClick={onHistoryOpen}
          className="hidden sm:flex items-center justify-center w-6 h-6 rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg-muted)] transition-colors cursor-pointer"
          title="Session history"
          aria-label="Session history"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </button>

        {/* Cmd-K search */}
        <button
          onClick={onSearchOpen}
          className="hidden sm:flex items-center gap-1.5 px-2 py-0.5 rounded border border-[var(--border)] text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg-muted)] transition-colors cursor-pointer"
          title="Search (⌘K)"
        >
          <span>⌘K</span>
        </button>

        <StatusPill status={status} onReconnect={onReconnect} lastError={lastError} reconnectAttempts={reconnectAttempts} />
      </div>
    </div>
  );
}
