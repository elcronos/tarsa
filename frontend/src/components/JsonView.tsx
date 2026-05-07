import { useState } from "react";

// ── File path linking (Goal 9) ────────────────────────────────────────────────

const FILE_PATH_RE = /\/[\w./_-]+\.(ts|tsx|js|jsx|md|json|py|go|rs|css|html|sh|yaml|yml|toml|svg)\b/g;

/** Render a string with embedded absolute file paths as VS Code links */
export function renderWithFilePaths(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const path = match[0];
    parts.push(
      <a
        key={match.index}
        href={`vscode://file${path}`}
        title="Open in VS Code"
        className="text-blue-400 hover:text-blue-300 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {path}
      </a>
    );
    last = match.index + path.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? text : <>{parts}</>;
}

/** Tries to parse content as JSON. Returns null if not JSON. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^[\[{"]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

const C_KEY = "text-violet-300";
const C_STR = "text-emerald-300";
const C_NUM = "text-amber-300";
const C_BOOL = "text-cyan-300";
const C_NULL = "text-zinc-500";
const C_PUNC = "text-zinc-500";

function Node({ value, depth }: { value: unknown; depth: number }): React.ReactElement {
  const [open, setOpen] = useState(depth < 2);

  if (value === null) return <span className={C_NULL}>null</span>;
  if (typeof value === "string") {
    const isLong = value.length > 200;
    return <ExpandableString value={value} isLong={isLong} />;
  }
  if (typeof value === "number") return <span className={C_NUM}>{value}</span>;
  if (typeof value === "boolean") return <span className={C_BOOL}>{String(value)}</span>;

  if (Array.isArray(value)) {
    const empty = value.length === 0;
    return (
      <span>
        <button
          className={`${C_PUNC} hover:text-zinc-300 cursor-pointer`}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          {empty ? "[]" : open ? "[" : `[ ... ${value.length} ]`}
        </button>
        {!empty && open && (
          <div className="ml-3 border-l border-zinc-800 pl-2">
            {value.map((v, i) => (
              <div key={i} className="font-mono text-[11px] leading-relaxed">
                <Node value={v} depth={depth + 1} />
                {i < value.length - 1 && <span className={C_PUNC}>,</span>}
              </div>
            ))}
          </div>
        )}
        {!empty && open && <span className={C_PUNC}>]</span>}
      </span>
    );
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const empty = keys.length === 0;
    return (
      <span>
        <button
          className={`${C_PUNC} hover:text-zinc-300 cursor-pointer`}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          {empty ? "{}" : open ? "{" : `{ ... ${keys.length} keys }`}
        </button>
        {!empty && open && (
          <div className="ml-3 border-l border-zinc-800 pl-2">
            {keys.map((k, i) => (
              <div key={k} className="font-mono text-[11px] leading-relaxed">
                <span className={C_KEY}>"{k}"</span>
                <span className={C_PUNC}>: </span>
                <Node value={obj[k]} depth={depth + 1} />
                {i < keys.length - 1 && <span className={C_PUNC}>,</span>}
              </div>
            ))}
          </div>
        )}
        {!empty && open && <span className={C_PUNC}>{"}"}</span>}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}

function ExpandableString({ value, isLong }: { value: string; isLong: boolean }) {
  const [expanded, setExpanded] = useState(!isLong);
  if (!isLong) {
    // Render with file path links; show escape sequences only for single-line short strings
    const hasNewline = value.includes("\n");
    const display = hasNewline ? value : value.replace(/\n/g, "\\n");
    return (
      <span className={C_STR}>
        "{renderWithFilePaths(display)}"
      </span>
    );
  }
  const displayValue = expanded ? value : value.slice(0, 200) + "...";
  return (
    <span>
      <span className={C_STR}>
        "{renderWithFilePaths(displayValue)}"
      </span>
      <button
        className="ml-1 text-[10px] text-zinc-500 hover:text-zinc-300 underline"
        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
      >
        {expanded ? "less" : `+${value.length - 200} chars`}
      </button>
    </span>
  );
}

export default function JsonView({ value }: { value: unknown }) {
  return (
    <div className="font-mono text-[11px] text-zinc-300 leading-relaxed">
      <Node value={value} depth={0} />
    </div>
  );
}
