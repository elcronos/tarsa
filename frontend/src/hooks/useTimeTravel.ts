import { useState, useMemo, useCallback, useRef } from "react";
import type { Event, State } from "../types";
import { applyEvent, emptyState } from "../replay";

export interface UseTimeTravelResult {
  scrubT: number | null;
  isScrubbing: boolean;
  setScrubT: (t: number) => void;
  clearScrub: () => void;
  traveledState: State | null;
}

// Binary-search for the cutoff index: first event with ts > t
function upperBoundIndex(events: readonly Event[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid]?.ts ?? 0) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Simple LRU cache keyed by cutoff index
const CACHE_SIZE = 20;

interface CacheEntry {
  index: number;
  state: State;
}

export function useTimeTravel(events: readonly Event[]): UseTimeTravelResult {
  const [scrubT, setScrubTState] = useState<number | null>(null);
  const cacheRef = useRef<CacheEntry[]>([]);
  // Track last debounce timer for large event sets
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedT, setDebouncedT] = useState<number | null>(null);

  // Memoize a sorted copy — binary search and replay require ascending ts order
  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => a.ts - b.ts),
    [events]
  );

  const setScrubT = useCallback(
    (t: number) => {
      setScrubTState(t);
      if (sortedEvents.length > 500) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => setDebouncedT(t), 32);
      } else {
        setDebouncedT(t);
      }
    },
    [sortedEvents.length]
  );

  const clearScrub = useCallback(() => {
    setScrubTState(null);
    setDebouncedT(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const activeT = sortedEvents.length > 500 ? debouncedT : scrubT;

  const traveledState = useMemo((): State | null => {
    if (activeT === null) return null;
    if (sortedEvents.length === 0) return emptyState();

    const cutoff = upperBoundIndex(sortedEvents, activeT);

    // Check cache
    const cache = cacheRef.current;
    const cached = cache.find((e) => e.index === cutoff);
    if (cached) return cached.state;

    // Build from closest cached ancestor
    let startIndex = 0;
    let startState: State = emptyState();

    // Find best cached predecessor
    for (const entry of cache) {
      if (entry.index <= cutoff && entry.index > startIndex) {
        startIndex = entry.index;
        startState = entry.state;
      }
    }

    // Replay from startIndex to cutoff
    let s = startState;
    for (let i = startIndex; i < cutoff; i++) {
      const e = sortedEvents[i];
      if (e) s = applyEvent(s, e);
    }

    // Store in cache (evict oldest if full)
    if (cache.length >= CACHE_SIZE) cache.shift();
    cache.push({ index: cutoff, state: s });

    return s;
  }, [activeT, sortedEvents]);

  return {
    scrubT,
    isScrubbing: scrubT !== null,
    setScrubT,
    clearScrub,
    traveledState,
  };
}
