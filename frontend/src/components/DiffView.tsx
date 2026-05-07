import { useState } from "react";

// ── LCS-based line diff ───────────────────────────────────────────────────────

type DiffLine =
  | { kind: "context"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "added"; text: string };

/** Compute LCS lengths table */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp;
}

/** Trace back LCS table to produce diff lines */
function diffLines(oldLines: string[], newLines: string[]): DiffLine[] {
  const dp = lcsTable(oldLines, newLines);
  const result: DiffLine[] = [];

  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ kind: "context", text: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ kind: "added", text: newLines[j - 1]! });
      j--;
    } else {
      result.push({ kind: "removed", text: oldLines[i - 1]! });
      i--;
    }
  }

  return result.reverse();
}

// ── Context collapsing ────────────────────────────────────────────────────────

const CONTEXT_LINES = 3;
const LARGE_DIFF_THRESHOLD = 200;

interface DiffViewProps {
  filePath?: string;
  oldString: string;
  newString: string;
}

export default function DiffView({ filePath, oldString, newString }: DiffViewProps) {
  const [showAll, setShowAll] = useState(false);

  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const lines = diffLines(oldLines, newLines);

  const totalLines = lines.length;
  const isLarge = totalLines > LARGE_DIFF_THRESHOLD;

  // Identify which lines are "interesting" (not context) to decide collapsing
  const interesting = new Set<number>();
  lines.forEach((l, i) => {
    if (l.kind !== "context") {
      for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(totalLines - 1, i + CONTEXT_LINES); k++) {
        interesting.add(k);
      }
    }
  });

  const displayLines = isLarge && !showAll
    ? lines.slice(0, LARGE_DIFF_THRESHOLD)
    : lines;

  const removedCount = lines.filter((l) => l.kind === "removed").length;
  const addedCount = lines.filter((l) => l.kind === "added").length;

  return (
    <div className="flex flex-col gap-1 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-[9px] font-mono text-[var(--fg-subtle)] uppercase tracking-wider">diff</span>
        {filePath && (
          <a
            href={`vscode://file${filePath}`}
            className="text-[10px] font-mono text-blue-400 hover:text-blue-300 hover:underline truncate"
            title="Open in VS Code"
            onClick={(e) => e.stopPropagation()}
          >
            {filePath}
          </a>
        )}
        <span className="ml-auto text-[9px] font-mono shrink-0">
          <span className="text-red-400">-{removedCount}</span>
          {" "}
          <span className="text-green-400">+{addedCount}</span>
        </span>
      </div>

      {/* Diff body */}
      <div className="rounded bg-[var(--bg)] overflow-auto max-h-[480px] text-[10px] font-mono leading-relaxed">
        {displayLines.map((line, i) => {
          const isSkipped = isLarge && !showAll && !interesting.has(i);
          if (isSkipped) return null;

          if (line.kind === "removed") {
            return (
              <div key={i} className="flex gap-1 bg-red-500/10 border-l-2 border-red-500/60 px-2 py-px">
                <span className="text-red-400 select-none shrink-0 w-3">-</span>
                <span className="text-red-200 whitespace-pre-wrap break-all">{line.text}</span>
              </div>
            );
          }
          if (line.kind === "added") {
            return (
              <div key={i} className="flex gap-1 bg-green-500/10 border-l-2 border-green-500/60 px-2 py-px">
                <span className="text-green-400 select-none shrink-0 w-3">+</span>
                <span className="text-green-200 whitespace-pre-wrap break-all">{line.text}</span>
              </div>
            );
          }
          return (
            <div key={i} className="flex gap-1 px-2 py-px border-l-2 border-transparent">
              <span className="text-[var(--fg-subtle)] select-none shrink-0 w-3"> </span>
              <span className="text-[var(--fg-subtle)] whitespace-pre-wrap break-all">{line.text}</span>
            </div>
          );
        })}
      </div>

      {isLarge && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] font-mono text-[var(--accent)] hover:underline text-left mt-0.5"
        >
          {showAll ? "show less" : `show all (${totalLines} lines)`}
        </button>
      )}
    </div>
  );
}
