/**
 * ProjectTerminal — embedded cc-web iframe rooted at a Tarsa-managed project's
 * cwd. Replaces the main view (Topology/Replay/etc) when a project is selected
 * in the sidebar. Pre-binds the cc-web session for the cwd on mount so vultuk
 * auto-attaches to it.
 */

import { useEffect, useRef, useState } from "react";

interface ProjectTerminalProps {
  cwd: string;
  name: string;
}

interface TerminalInfo {
  enabled: boolean;
  port: number;
  token: string;
}

export default function ProjectTerminal({ cwd, name }: ProjectTerminalProps) {
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Fetch cc-web port + token once on mount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/terminal/info")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: TerminalInfo) => { if (!cancelled) setInfo(data); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, []);

  // Track which cwds we've already created cc-web sessions for during this
  // page load. Without this, every click on the sidebar entry would POST
  // ensure-session again and vultuk would spawn a duplicate tab for the
  // same workingDir.
  const ensuredRef = useRef<Set<string>>(new Set());

  // Whenever the selected project changes, ensure cc-web has a session for
  // its cwd so vultuk auto-attaches when the iframe (re)loads. No-op if
  // we've already ensured this cwd.
  useEffect(() => {
    if (!info?.enabled) return;
    if (ensuredRef.current.has(cwd)) {
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    fetch("/api/terminal/ensure-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, name }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.error ?? `HTTP ${r.status}`)))))
      .then(() => {
        if (cancelled) return;
        ensuredRef.current.add(cwd);
        setReady(true);
      })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [cwd, name, info?.enabled]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-red-400">
        Terminal unavailable: {error}
      </div>
    );
  }
  if (!info || !ready) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-[var(--fg-subtle)]">
        Loading terminal…
      </div>
    );
  }
  if (!info.enabled) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-[var(--fg-subtle)]">
        Embedded terminal disabled (TARSA_TERMINAL=0).
      </div>
    );
  }

  const url = `http://localhost:${info.port}/?token=${encodeURIComponent(info.token)}`;
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--accent)] shrink-0">
            project terminal
          </span>
          <span className="text-[11px] font-mono text-[var(--fg)] truncate">{name}</span>
          <span className="text-[10px] font-mono text-[var(--fg-subtle)] truncate" title={cwd}>
            · {cwd}
          </span>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] font-mono text-[var(--accent)] hover:underline shrink-0"
        >
          open in new tab ↗
        </a>
      </div>
      <iframe
        title="Project terminal"
        // Re-mount the iframe per cwd so vultuk re-initializes against the
        // pre-created session for the new project.
        key={cwd}
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-clipboard-write"
        referrerPolicy="no-referrer"
        className="flex-1 w-full bg-black"
      />
    </div>
  );
}
