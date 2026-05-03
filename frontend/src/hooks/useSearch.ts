import { useState, useEffect, useRef, useCallback } from "react";
import type { Event } from "../types";

export interface SearchResult {
  event: Event;
  score: number;
  snippet: string;
}

export interface UseSearchResult {
  query: string;
  setQuery: (q: string) => void;
  results: SearchResult[];
  isLoading: boolean;
}

const DEBOUNCE_MS = 200;

export function useSearch(): UseSearchResult {
  const [query, setQueryState] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!query.trim()) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    timerRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();

      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&limit=50`,
          { signal: abortRef.current.signal }
        );
        if (!res.ok) {
          setResults([]);
          return;
        }
        const data = (await res.json()) as { results: SearchResult[] };
        setResults(data.results ?? []);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  return { query, setQuery, results, isLoading };
}
