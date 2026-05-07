/**
 * Returns a human-readable relative time string like "5m ago", "2h ago", "just now".
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diffMs = now - ts;
  if (diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Returns a relative time string from a timestamp (ms or ISO string).
 * Examples: "2m ago", "4h ago", "yesterday", "3d ago".
 */
export function formatRelative(ts: number | string): string {
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  const diff = Date.now() - t;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Returns an ISO 8601 string for the given timestamp (ms or ISO string).
 * Useful as a `title` attribute to show absolute time on hover.
 */
export function absoluteISO(ts: number | string): string {
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  return new Date(t).toISOString();
}
