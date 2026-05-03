/** Project name / color utilities for cwd-based grouping. */

const PALETTE = [
  "#06b6d4",
  "#a78bfa",
  "#fb923c",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#60a5fa",
  "#94a3b8",
];

/** Returns the basename of a cwd path (no node:path dependency). */
export function projectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === "") return "Unknown";
  // Normalize trailing slash
  const trimmed = cwd.replace(/\/+$/, "");
  const sep = trimmed.lastIndexOf("/");
  const base = sep >= 0 ? trimmed.slice(sep + 1) : trimmed;
  return base || "Unknown";
}

/** Deterministic color from palette based on simple hash-mod-8. */
export function projectColor(name: string): string {
  if (!name || name === "Unknown") return PALETTE[7]!;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
