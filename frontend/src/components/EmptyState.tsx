import { useState } from "react";

interface EmptyStateProps {
  message?: string;
}

const NO_SESSIONS_MESSAGES = new Set(["No sessions yet"]);

function RichEmptyState() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText("claude").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-sm text-center">
        <h2 className="text-[var(--fg)] text-xl font-semibold">
          No Claude Code sessions yet
        </h2>
        <p className="text-[var(--fg-muted)] text-sm leading-relaxed">
          Hooks are installed. Start a Claude Code session in any project to see
          it appear here in real time.
        </p>
        <div className="flex items-center gap-2 bg-[var(--surface-raised)] rounded px-3 py-2 font-mono text-sm text-[var(--fg)]">
          <span>claude</span>
          <button
            onClick={handleCopy}
            className="ml-2 text-[var(--fg-subtle)] hover:text-[var(--fg)] transition-colors text-xs"
            title="Copy to clipboard"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <span className="text-[var(--fg-subtle)] text-xs">
          Verify hooks at ~/.claude/settings.json
        </span>
      </div>
    </div>
  );
}

export default function EmptyState({ message }: EmptyStateProps) {
  if (!message || NO_SESSIONS_MESSAGES.has(message)) {
    return <RichEmptyState />;
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-2">
        <span className="text-[var(--fg-subtle)] font-mono text-lg select-none">
          *
        </span>
        <span className="text-[var(--fg-subtle)] text-sm font-mono text-center max-w-xs">
          {message}
        </span>
      </div>
    </div>
  );
}
