/**
 * Full-text search — in-memory inverted index with recency-biased ranking.
 *
 * Tokenization: lowercase, split on non-alphanumeric, filter empty.
 * Index: Map<token, Set<eventId>>
 * Ranking: sum over query terms of (term freq in doc) * exp(-age_seconds / 3600)
 * Lifecycle: rebuilt via buildIndex() on server start; incremental via indexEvent().
 */

import type { Event } from "./models.js";
import type { Database } from "./db.js";

// ── Index state ───────────────────────────────────────────────────────────────

const eventStore = new Map<string, Event>();
const invertedIndex = new Map<string, Set<string>>(); // token -> Set<eventId>
const termFreq = new Map<string, Map<string, number>>(); // eventId -> Map<token, count>

// ── Tokenisation ──────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function eventText(event: Event): string {
  const parts: string[] = [];
  if (event.tool_name) parts.push(event.tool_name);
  if (event.agent_id) parts.push(event.agent_id);
  if (event.agent_type) parts.push(event.agent_type);
  if (event.hook_event) parts.push(String(event.hook_event));
  if (event.tool_input) parts.push(JSON.stringify(event.tool_input));
  if (event.tool_response) parts.push(String(event.tool_response).slice(0, 2000));
  // Include any prompt/result fields that may be present
  if (typeof event["prompt"] === "string") parts.push(event["prompt"]);
  if (typeof event["result"] === "string") parts.push(event["result"]);
  return parts.join(" ");
}

// ── Index operations ──────────────────────────────────────────────────────────

export function indexEvent(event: Event): void {
  const id = event.id;
  if (!id) return;
  eventStore.set(id, event);

  const text = eventText(event);
  const tokens = tokenize(text);

  // Compute term frequencies for this doc
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  termFreq.set(id, freq);

  // Update inverted index
  for (const t of freq.keys()) {
    let set = invertedIndex.get(t);
    if (!set) { set = new Set(); invertedIndex.set(t, set); }
    set.add(id);
  }
}

export function buildIndex(events: readonly Event[]): void {
  // Clear existing index
  eventStore.clear();
  invertedIndex.clear();
  termFreq.clear();
  for (const e of events) {
    indexEvent(e);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  event: Event;
  score: number;
  snippet: string;
}

function makeSnippet(event: Event, queryTerms: string[]): string {
  const text = eventText(event);
  // Find first occurrence of any query term
  const lower = text.toLowerCase();
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + 120);
      return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    }
  }
  return text.slice(0, 120);
}

/**
 * Seed the search index from persisted database events.
 * Called once on server start so prior-session events are searchable.
 * Returns the number of events indexed.
 */
export function seedFromDatabase(db: Database, limit = 10_000): number {
  const events = db.queryAllEvents(limit);
  for (const e of events) {
    indexEvent(e);
  }
  return events.length;
}

export function searchEvents(query: string, limit = 50): SearchResult[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const now = Date.now();
  const scores = new Map<string, number>();

  for (const term of queryTerms) {
    // Exact match
    const exactSet = invertedIndex.get(term);
    if (exactSet) {
      for (const id of exactSet) {
        const freq = termFreq.get(id)?.get(term) ?? 0;
        const event = eventStore.get(id);
        if (!event) continue;
        const ageSec = (now - event.ts) / 1000;
        const recencyBias = Math.exp(-ageSec / 3600);
        scores.set(id, (scores.get(id) ?? 0) + freq * recencyBias);
      }
    }

    // Prefix match for partial queries
    if (term.length >= 3) {
      for (const [indexedToken, idSet] of invertedIndex) {
        if (indexedToken !== term && indexedToken.startsWith(term)) {
          for (const id of idSet) {
            const freq = termFreq.get(id)?.get(indexedToken) ?? 0;
            const event = eventStore.get(id);
            if (!event) continue;
            const ageSec = (now - event.ts) / 1000;
            const recencyBias = Math.exp(-ageSec / 3600);
            // Half-weight for prefix matches
            scores.set(id, (scores.get(id) ?? 0) + (freq * recencyBias) / 2);
          }
        }
      }
    }
  }

  // Sort by score descending
  const ranked = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  return ranked
    .map(([id, score]) => {
      const event = eventStore.get(id);
      if (!event) return null;
      return {
        event,
        score: Math.round(score * 1000) / 1000,
        snippet: makeSnippet(event, queryTerms),
      };
    })
    .filter((r): r is SearchResult => r !== null);
}
