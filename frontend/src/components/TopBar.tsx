import { useState, useEffect, useCallback } from "react";
import type { ConnectionStatus } from "../hooks/useAgentState";
import { authHeaders } from "../utils/auth";
import type { CostSource } from "../types";
import logoUrl from "../assets/logo.svg";

interface Tab {
  id: string;
  label: string;
  stub?: boolean;
}

const BASE_TABS: Tab[] = [
  { id: "topology", label: "Topology" },
  { id: "global", label: "Global" },
  { id: "timeline", label: "Timeline" },
  { id: "replay", label: "Replay" },
  { id: "insights", label: "Insights" },
  // Compare and Team tabs are hidden until they earn their keep —
  // re-enable here when the views are reworked.
];

interface TopBarProps {
  activeView: string;
  onViewChange: (view: string) => void;
  status: ConnectionStatus;
  onReconnect: () => void;
  onSearchOpen?: () => void;
  onHistoryOpen?: () => void;
  onArchiveOpen?: () => void;
  lastError?: string | null;
  reconnectAttempts?: number;
  /** Sorted list of unique project names for the filter chip */
  projectNames?: string[];
  /** Currently active project filter ("" or null = all) */
  projectFilter?: string | null;
  onProjectFilterChange?: (name: string | null) => void;
  /** Whether the Team tab should be shown (true when team workers exist). */
  showTeamTab?: boolean;
  /** Current session cwd to pre-fill the spawn prompt. */
  sessionCwd?: string | null;
  /** Currently selected session id — drives cost chip and stuck badge. */
  selectedSessionId?: string | null;
  /** Currently selected agent id — enables Monitor tab when set. */
  selectedAgentId?: string | null;
  /** Budget for the selected session in USD (0 or undefined = no budget). */
  sessionBudgetUsd?: number;
  /** Called when the user clicks the `+ terminal` button. The parent opens
   *  the bottom-dock folder picker — no modal — so all terminal placements
   *  share a single surface. */
  onNewTerminal?: () => void;
  /** Enter monitor mode for the currently selected agent. */
  onEnterMonitor?: (agentId: string) => void;
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
      <span
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-mono text-emerald-400 live-pill"
        style={{ boxShadow: "0 0 8px rgba(20,184,166,0.4)" }}
      >
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

const PROJECT_FILTER_KEY = "tarsa.project-filter";

export function loadProjectFilter(): string | null {
  try {
    return localStorage.getItem(PROJECT_FILTER_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveProjectFilter(v: string | null) {
  try {
    if (v == null || v === "") {
      localStorage.removeItem(PROJECT_FILTER_KEY);
    } else {
      localStorage.setItem(PROJECT_FILTER_KEY, v);
    }
  } catch {
    // ignore
  }
}

interface InsightsSummary {
  totalUsd: number;
  costSource: CostSource;
  stuckCount: number;
}

export default function TopBar({
  activeView,
  onViewChange,
  status,
  onReconnect,
  onSearchOpen,
  onHistoryOpen,
  lastError,
  reconnectAttempts,
  projectNames,
  projectFilter,
  onProjectFilterChange,
  showTeamTab,
  sessionCwd,
  selectedSessionId,
  selectedAgentId,
  sessionBudgetUsd,
  onNewTerminal,
  onEnterMonitor,
  onArchiveOpen,
}: TopBarProps) {
  // Team tab intentionally suppressed; honor showTeamTab once view is reworked.
  void showTeamTab;
  const TABS: Tab[] = BASE_TABS;
  const [spawnToast, setSpawnToast] = useState<{ msg: string; isError: boolean } | null>(null);
  const [insights, setInsights] = useState<InsightsSummary | null>(null);
  const [copyToast, setCopyToast] = useState(false);

  useEffect(() => {
    if (!selectedSessionId) {
      setInsights(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/insights?session=${selectedSessionId}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: { costEstimate: { totalUsd: number; source?: CostSource }; stuckSignals: unknown[] }) => {
        if (cancelled) return;
        setInsights({
          totalUsd: data.costEstimate.totalUsd,
          costSource: data.costEstimate.source ?? "tool_count_fallback",
          stuckCount: data.stuckSignals.length,
        });
      })
      .catch(() => {
        if (!cancelled) setInsights(null);
      });
    return () => { cancelled = true; };
  }, [selectedSessionId]);

  const handleSpawn = async () => {
    const cwd = sessionCwd ?? prompt("Enter working directory for new Claude session:") ?? "";
    if (!cwd) return;
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ cwd }),
      });
      const data = await res.json() as { session_name?: string; attach_cmd?: string; error?: string };
      if (!res.ok) {
        setSpawnToast({ msg: data.error ?? "Spawn failed", isError: true });
      } else {
        setSpawnToast({ msg: `Session ready: ${data.attach_cmd}`, isError: false });
      }
    } catch (err) {
      setSpawnToast({ msg: String(err), isError: true });
    }
    setTimeout(() => setSpawnToast(null), 6000);
  };

  const handleProjectCycle = () => {
    if (!onProjectFilterChange || !projectNames || projectNames.length === 0) return;
    const all = [null, ...projectNames];
    const idx = all.findIndex((p) => p === (projectFilter ?? null));
    const next = all[(idx + 1) % all.length] ?? null;
    saveProjectFilter(next);
    onProjectFilterChange(next);
  };

  const activeProject = projectFilter ?? null;

  const handleCopyLink = useCallback(() => {
    const url = new URL(window.location.href);
    if (selectedSessionId) {
      url.searchParams.set("session", selectedSessionId);
    }
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopyToast(true);
      setTimeout(() => setCopyToast(false), 2000);
    }).catch(() => {/* ignore */});
  }, [selectedSessionId]);

  const handleExport = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      const res = await fetch(`/api/insights?session=${selectedSessionId}`, { headers: authHeaders() });
      const data: unknown = res.ok ? await res.json() : null;
      const payload = {
        session_id: selectedSessionId,
        exported_at: new Date().toISOString(),
        insights: data,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tarsa-${selectedSessionId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }, [selectedSessionId]);

  return (
    <div className="relative flex items-center h-10 px-3 border-b border-[var(--border)] bg-[var(--surface)] shrink-0 gap-4">
      {/* Brand */}
      <div className="flex items-center gap-1.5 shrink-0">
        <img src={logoUrl} alt="" className="h-5 w-5" />
        <span className="font-mono text-xs font-semibold text-[var(--accent)] tracking-tight">
          tarsa
        </span>
      </div>

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
        <button
          onClick={() => selectedAgentId && onEnterMonitor?.(selectedAgentId)}
          disabled={!selectedAgentId}
          title={selectedAgentId ? "Monitor selected agent" : "Select an agent to enable monitor mode"}
          className={`
            px-2.5 py-1 rounded text-xs font-mono transition-colors relative
            ${
              activeView === "monitor"
                ? "bg-[var(--surface-raised)] text-[var(--fg)]"
                : selectedAgentId
                  ? "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--surface-raised)]"
                  : "text-[var(--fg-subtle)] opacity-40 cursor-not-allowed"
            }
          `}
        >
          Monitor
        </button>
      </nav>

      {/* Right side */}
      <div className="flex items-center gap-2 shrink-0">
        {/* D6 — Stuck badge */}
        {insights && insights.stuckCount > 0 && (
          <button
            onClick={() => onViewChange("insights")}
            className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-[10px] font-mono text-amber-400 hover:bg-amber-500/20 transition-colors cursor-pointer"
            title="Stuck agents detected — click to view Insights"
          >
            <span>⚠</span>
            <span>{insights.stuckCount} stuck</span>
          </button>
        )}

        {/* D4 — Total cost chip with mini bar */}
        {insights && selectedSessionId && (
          <button
            onClick={() => onViewChange("insights")}
            className={`hidden sm:flex items-center gap-1.5 px-2 py-0.5 rounded border border-[var(--border)] text-[10px] font-mono transition-colors cursor-pointer hover:bg-[var(--surface-raised)] ${
              insights.costSource === "measured"
                ? "text-[var(--fg-muted)]"
                : "text-amber-400"
            }`}
            title="Session cost estimate — click to view Insights"
          >
            {/* mini inline bar: 40px wide, 8px tall */}
            {(() => {
              const budget = sessionBudgetUsd ?? 0;
              const fillRatio = budget > 0
                ? Math.min(insights.totalUsd / budget, 1)
                : 1;
              const fillWidth = budget > 0 ? Math.round(fillRatio * 40) : 12;
              return (
                <span
                  className="relative inline-block shrink-0 rounded-sm overflow-hidden"
                  style={{ width: 40, height: 8, background: "var(--border)" }}
                >
                  <span
                    className="absolute left-0 top-0 h-full rounded-sm"
                    style={{
                      width: fillWidth,
                      background: "var(--accent)",
                      opacity: 0.85,
                    }}
                  />
                </span>
              );
            })()}
            <span>
              ${insights.totalUsd.toFixed(2)}{" "}
              <span className="opacity-60">
                ({insights.costSource === "measured" ? "measured" : "est"})
              </span>
            </span>
          </button>
        )}

        {/* D7 — Budget progress bar */}
        {insights && selectedSessionId && sessionBudgetUsd != null && sessionBudgetUsd > 0 && (() => {
          const pct = insights.totalUsd / sessionBudgetUsd;
          const fillPct = Math.min(pct, 1) * 100;
          const color = pct >= 1
            ? "var(--red)"
            : pct >= 0.8
            ? "var(--amber)"
            : "var(--accent)";
          const tooltipLabel = `$${insights.totalUsd.toFixed(2)} / $${sessionBudgetUsd.toFixed(2)} (${Math.round(pct * 100)}%)`;
          return (
            <span
              className="hidden sm:inline-flex items-center shrink-0"
              title={tooltipLabel}
            >
              <span
                className="relative inline-block rounded-sm overflow-hidden"
                style={{ width: 80, height: 3, background: "var(--border)" }}
              >
                <span
                  className="absolute left-0 top-0 h-full rounded-sm transition-all"
                  style={{ width: `${fillPct}%`, background: color }}
                />
              </span>
            </span>
          );
        })()}

        {/* Project filter chip */}
        {projectNames && projectNames.length > 0 && onProjectFilterChange && (
          <button
            onClick={handleProjectCycle}
            className={`hidden sm:flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono transition-colors ${
              activeProject
                ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
                : "border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg-muted)]"
            }`}
            title={activeProject ? `Project: ${activeProject} (click to cycle)` : "All projects (click to filter)"}
          >
            <span>⬡</span>
            <span className="max-w-[80px] truncate">
              {activeProject ?? "all projects"}
            </span>
          </button>
        )}

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

        {/* Archive — recently closed sessions */}
        <button
          onClick={onArchiveOpen}
          className="hidden sm:flex items-center justify-center w-6 h-6 rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg-muted)] transition-colors cursor-pointer"
          title="Recently closed sessions"
          aria-label="Recently closed sessions"
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
            <polyline points="21 8 21 21 3 21 3 8" />
            <rect x="1" y="3" width="22" height="5" />
            <line x1="10" y1="12" x2="14" y2="12" />
          </svg>
        </button>

        {/* D5 — Search input affordance */}
        <button
          onClick={onSearchOpen}
          className="hidden sm:flex items-center justify-between w-48 px-2.5 py-0.5 rounded border border-[var(--border)] text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg-muted)] hover:border-[var(--fg-subtle)] transition-colors cursor-pointer"
          title="Search (⌘K)"
        >
          <span>Search events...</span>
          <span className="opacity-50">⌘K</span>
        </button>

        {/* New Session (spawn tmux) button — hidden until UX is reworked */}
        {false && (
          <button
            onClick={handleSpawn}
            className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border)] text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg-muted)] hover:border-[var(--accent)] transition-colors cursor-pointer"
            title="Spawn new Claude session in tmux"
            aria-label="New session"
          >
            + session
          </button>
        )}

        {/* New Project — create folder + open embedded terminal there */}
        <button
          onClick={() => onNewTerminal?.()}
          className="hidden sm:flex items-center gap-1 px-2 py-0.5 rounded border border-[var(--border)] text-[10px] font-mono text-[var(--fg-subtle)] hover:text-[var(--fg-muted)] hover:border-[var(--accent)] transition-colors cursor-pointer"
          title="Create or open a project folder in an embedded terminal"
          aria-label="New terminal"
        >
          + terminal
        </button>

        {/* D13 — Copy session link */}
        {selectedSessionId && (
          <button
            onClick={handleCopyLink}
            className="hidden sm:flex items-center justify-center w-6 h-6 rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors cursor-pointer"
            title="Copy session link"
            aria-label="Copy session link"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        )}

        {/* D14 — Export session JSON */}
        {selectedSessionId && (
          <button
            onClick={handleExport}
            className="hidden sm:flex items-center justify-center w-6 h-6 rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors cursor-pointer"
            title="Export session to JSON"
            aria-label="Export session JSON"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        )}

        <StatusPill status={status} onReconnect={onReconnect} lastError={lastError} reconnectAttempts={reconnectAttempts} />
      </div>

      {/* Spawn toast */}
      {spawnToast && (
        <div
          className={`absolute top-12 right-3 z-50 px-3 py-2 rounded border text-[11px] font-mono max-w-xs shadow-lg ${
            spawnToast.isError
              ? "bg-red-900/80 border-red-500/40 text-red-300"
              : "bg-emerald-900/80 border-emerald-500/40 text-emerald-300"
          }`}
        >
          {spawnToast.msg}
        </div>
      )}

      {/* Copy link toast */}
      {copyToast && (
        <div className="absolute top-12 right-3 z-50 px-3 py-2 rounded border text-[11px] font-mono shadow-lg bg-[var(--surface-raised)] border-[var(--accent)] text-[var(--accent)]">
          Link copied!
        </div>
      )}

    </div>
  );
}

// ── Folder picker overlay ────────────────────────────────────────────────────
//
// We embed cc-web's existing folder-browser UI (which already supports
// browsing, creating folders, and selecting an arbitrary directory) instead
// of asking the user to type a path. The iframe is loaded with the
// `?action=newproject` flag (TARSA PATCH in vendor/cc-web/src/public/app.js)
// so vultuk skips its session-list and shows the folder picker right away.
// When vultuk creates a session it postMessages back to the parent window
// with {cwd, name}; we add that to Tarsa's projects sidebar.
function FolderPickerOverlay({
  onClose,
  onPicked,
}: {
  onClose: () => void;
  onPicked?: (project: { cwd: string; name: string }) => void;
}) {
  const [info, setInfo] = useState<{ enabled: boolean; port: number; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch cc-web port + token.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/terminal/info")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (!cancelled) setInfo(data); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, []);

  // Listen for vultuk's session-created postMessage.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as { type?: string; cwd?: string; name?: string };
      if (!data || data.type !== "tarsa:session-created" || !data.cwd) return;
      onPicked?.({ cwd: data.cwd, name: data.name ?? data.cwd.split("/").pop() ?? "project" });
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onPicked]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[90vw] h-[85vh] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
          <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--accent)]">
            new project · pick or create a folder
          </span>
          <button
            onClick={onClose}
            className="text-[var(--fg-subtle)] hover:text-[var(--fg)] text-sm px-2"
            aria-label="Close picker"
          >
            ×
          </button>
        </div>
        {error ? (
          <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-red-400">
            {error}
          </div>
        ) : info?.enabled && info.token && info.port ? (
          <iframe
            title="Folder picker"
            src={`http://localhost:${info.port}/?token=${encodeURIComponent(info.token)}&action=newproject`}
            sandbox="allow-scripts allow-same-origin allow-forms"
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            className="flex-1 w-full bg-black"
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-[var(--fg-subtle)]">
            Loading picker…
          </div>
        )}
      </div>
    </div>
  );
}

// ── (legacy) NewProjectModal — kept around for reference only ────────────────
type ProjectMode = "create" | "open";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function NewProjectModal_unused({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (project: { cwd: string; name: string }) => void;
}) {
  const [mode, setMode] = useState<ProjectMode>("create");
  // Create-mode fields
  const [parent, setParent] = useState("~/Desktop");
  const [name, setName] = useState("");
  const [gitInit, setGitInit] = useState(true);
  // Open-mode fields
  const [openPath, setOpenPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureAndHandoff = useCallback(
    async (project: { cwd: string; name: string }) => {
      // Pre-create the cc-web terminal session bound to the cwd so vultuk
      // auto-attaches when the embedded iframe loads.
      await fetch("/api/terminal/ensure-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: project.cwd, name: project.name }),
      }).catch(() => null);
      onCreated?.(project);
      onClose();
    },
    [onCreated, onClose]
  );

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);
      try {
        if (mode === "create") {
          const r = await fetch("/api/project/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent, name, gitInit }),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
          await ensureAndHandoff({ cwd: data.cwd, name: data.name });
        } else {
          const r = await fetch("/api/project/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: openPath }),
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
          await ensureAndHandoff({ cwd: data.cwd, name: data.name });
        }
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      } finally {
        setSubmitting(false);
      }
    },
    [mode, parent, name, gitInit, openPath, ensureAndHandoff]
  );

  const canSubmit =
    mode === "create" ? name.trim().length > 0 : openPath.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-4 space-y-3"
      >
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-mono uppercase tracking-widest text-[var(--fg-subtle)]">
            project
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--fg-subtle)] hover:text-[var(--fg)] text-sm"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-1 text-[10px] font-mono">
          {(["create", "open"] as ProjectMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setError(null); }}
              className={`px-2 py-1 rounded border transition-colors ${
                mode === m
                  ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
              }`}
            >
              {m === "create" ? "create new" : "open existing"}
            </button>
          ))}
        </div>

        {mode === "create" ? (
          <>
            <label className="block">
              <span className="text-[10px] font-mono text-[var(--fg-muted)]">parent directory</span>
              <input
                type="text"
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                placeholder="~/Desktop"
                className="mt-1 w-full px-2 py-1 text-[12px] font-mono rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
                required
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-mono text-[var(--fg-muted)]">name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-new-project"
                pattern="[A-Za-z0-9 _.\-]{1,80}"
                className="mt-1 w-full px-2 py-1 text-[12px] font-mono rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
                autoFocus
                required
              />
            </label>
            <label className="flex items-center gap-2 text-[11px] font-mono text-[var(--fg-muted)]">
              <input
                type="checkbox"
                checked={gitInit}
                onChange={(e) => setGitInit(e.target.checked)}
              />
              git init
            </label>
          </>
        ) : (
          <label className="block">
            <span className="text-[10px] font-mono text-[var(--fg-muted)]">folder path</span>
            <input
              type="text"
              value={openPath}
              onChange={(e) => setOpenPath(e.target.value)}
              placeholder="~/Desktop/my-existing-project"
              className="mt-1 w-full px-2 py-1 text-[12px] font-mono rounded bg-[var(--bg)] border border-[var(--border)] text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
              autoFocus
              required
            />
            <span className="block mt-1 text-[10px] font-mono text-[var(--fg-subtle)]">
              must be inside your home directory
            </span>
          </label>
        )}

        {error && (
          <div className="text-[11px] font-mono text-red-400 px-2 py-1 rounded border border-red-500/30 bg-red-500/10">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-[11px] font-mono rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !canSubmit}
            className="px-3 py-1 text-[11px] font-mono rounded border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-50"
          >
            {submitting
              ? mode === "create" ? "creating…" : "opening…"
              : mode === "create" ? "create + open terminal" : "open + start terminal"}
          </button>
        </div>
      </form>
    </div>
  );
}
