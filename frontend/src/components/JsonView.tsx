import { useState } from "react";

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
          onClick={() => setOpen((v) => !v)}
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
          onClick={() => setOpen((v) => !v)}
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
    return (
      <span className={C_STR}>
        "{value.replace(/\n/g, "\\n")}"
      </span>
    );
  }
  return (
    <span>
      <span className={C_STR}>
        "{expanded ? value : value.slice(0, 200) + "..."}"
      </span>
      <button
        className="ml-1 text-[10px] text-zinc-500 hover:text-zinc-300 underline"
        onClick={() => setExpanded((v) => !v)}
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
