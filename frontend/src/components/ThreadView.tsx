import { useEffect, useState } from "react";
import { formatTime } from "../utils/format";

export interface TranscriptMessage {
  type: string;
  content: string;
  ts: number;
  role?: string;
}

interface ThreadViewProps {
  sessionId: string;
}

function MessageBubble({ msg }: { msg: TranscriptMessage }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveType = msg.role ?? msg.type;
  const isLong = msg.content.length > 400;
  const display = isLong && !expanded ? msg.content.slice(0, 400) + "…" : msg.content;

  let containerClass = "rounded px-3 py-2 text-[10px] font-mono leading-relaxed ";
  let labelColor = "text-[var(--fg-subtle)]";

  if (effectiveType === "assistant") {
    containerClass += "bg-[var(--surface-raised)] text-[var(--fg)] border border-[var(--border)]";
    labelColor = "text-violet-400";
  } else if (effectiveType === "user") {
    containerClass += "bg-blue-500/10 text-[var(--fg)] border border-blue-500/20";
    labelColor = "text-blue-400";
  } else if (effectiveType === "system") {
    containerClass += "bg-[var(--bg)] text-[var(--fg-subtle)] border border-[var(--border)] opacity-70";
    labelColor = "text-[var(--fg-subtle)]";
  } else if (effectiveType === "tool" || effectiveType === "tool_result") {
    containerClass += "bg-emerald-500/5 text-[var(--fg-muted)] border border-emerald-500/20";
    labelColor = "text-emerald-400";
  } else {
    containerClass += "bg-[var(--surface)] text-[var(--fg-muted)] border border-[var(--border)]";
  }

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-mono ${labelColor}`}>{effectiveType}</span>
        <span className="text-[10px] font-mono text-[var(--fg-subtle)]">{formatTime(msg.ts)}</span>
      </div>
      <div className={containerClass}>
        <pre className="whitespace-pre-wrap break-words">{display}</pre>
        {isLong && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[10px] text-[var(--accent)] hover:underline"
          >
            {expanded ? "collapse" : `expand (${msg.content.length} chars)`}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ThreadView({ sessionId }: ThreadViewProps) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
    fetch(`/api/session/${encodeURIComponent(sessionId)}/thread`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data: { messages: TranscriptMessage[] }) => {
        setMessages(data.messages ?? []);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-[10px] font-mono text-[var(--fg-subtle)]">
        Loading transcript…
      </div>
    );
  }

  if (error || messages.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-[10px] font-mono text-[var(--fg-subtle)]">
        {error ? "Transcript unavailable" : "No transcript messages found"}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 overflow-y-auto max-h-full">
      {messages.map((msg, i) => (
        <MessageBubble key={i} msg={msg} />
      ))}
    </div>
  );
}
