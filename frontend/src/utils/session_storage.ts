/**
 * Utilities for persisting dismissed session IDs in localStorage.
 * Key: agentscope.dismissed_sessions (JSON array of string IDs)
 */

const STORAGE_KEY = "agentscope.dismissed_sessions";

export function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function saveDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore storage errors (e.g. private browsing quota)
  }
}

export function addDismissed(ids: Set<string>, sessionId: string): Set<string> {
  const next = new Set(ids);
  next.add(sessionId);
  saveDismissed(next);
  return next;
}

export function removeDismissed(ids: Set<string>, sessionId: string): Set<string> {
  const next = new Set(ids);
  next.delete(sessionId);
  saveDismissed(next);
  return next;
}
