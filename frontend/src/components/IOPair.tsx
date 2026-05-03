import { useState, useCallback } from "react";
import JsonView, { tryParseJson } from "./JsonView";

interface IOPairProps {
  input?: unknown;
  output?: unknown;
  truncateAt?: number;
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // Fallback for environments without clipboard API
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="text-[9px] font-mono px-1 py-0.5 rounded border border-[var(--border)] text-[var(--fg-subtle)] hover:text-[var(--fg)] hover:border-[var(--fg-subtle)] transition-colors shrink-0"
      title="Copy to clipboard"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

// ── Code block with truncation ────────────────────────────────────────────────

function CodeBlock({
  label,
  text,
  truncateAt,
}: {
  label: string;
  text: string;
  truncateAt: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const isTruncated = text.length > truncateAt;
  const display = isTruncated && !showAll ? text.slice(0, truncateAt) + "…" : text;

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center justify-between gap-1 mb-0.5">
        <span className="text-[9px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider">
          {label}
        </span>
        <CopyButton text={text} />
      </div>
      <pre className="text-[10px] font-mono text-[var(--fg-muted)] bg-[var(--bg)] rounded p-2 whitespace-pre-wrap break-words max-h-64 overflow-y-auto overflow-x-auto leading-relaxed select-text">
        {display}
      </pre>
      {isTruncated && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] font-mono text-[var(--accent)] hover:underline text-left mt-0.5"
        >
          {showAll ? "show less" : `show more (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

// ── JsonOrPre — pick JsonView for objects, CodeBlock for plain text ───────────

function JsonOrPre({
  label,
  value,
  truncateAt,
}: {
  label: string;
  value: unknown;
  truncateAt: number;
}) {
  // If value is already an object/array, render directly
  if (value !== null && typeof value === "object") {
    const copyText = JSON.stringify(value, null, 2);
    return (
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span className="text-[9px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider">
            {label}
          </span>
          <CopyButton text={copyText} />
        </div>
        <div className="rounded bg-[var(--bg)] p-2 max-h-64 overflow-auto">
          <JsonView value={value} />
        </div>
      </div>
    );
  }

  // Convert to string
  const text = typeof value === "string" ? value : String(value);

  // Try to parse as JSON
  const parsed = tryParseJson(text);
  if (parsed !== null && typeof parsed === "object") {
    return (
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span className="text-[9px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider">
            {label}
          </span>
          <CopyButton text={text} />
        </div>
        <div className="rounded bg-[var(--bg)] p-2 max-h-64 overflow-auto">
          <JsonView value={parsed} />
        </div>
      </div>
    );
  }

  // Plain text fallback
  return <CodeBlock label={label} text={text} truncateAt={truncateAt} />;
}

// ── IOPair ────────────────────────────────────────────────────────────────────

export default function IOPair({ input, output, truncateAt = 5000 }: IOPairProps) {
  const hasInput = input !== undefined && input !== null;
  const hasOutput = output !== undefined && output !== null;

  if (!hasInput && !hasOutput) return null;

  const both = hasInput && hasOutput;

  return (
    <div
      className={`mt-2 gap-3 ${
        both ? "grid grid-cols-1 lg:grid-cols-2" : "flex flex-col"
      }`}
    >
      {hasInput && (
        <JsonOrPre label="input" value={input} truncateAt={truncateAt} />
      )}
      {hasOutput && (
        <JsonOrPre label="output" value={output} truncateAt={truncateAt} />
      )}
    </div>
  );
}
