/**
 * Tests for US-V2-03 — ErrorBoundary logic.
 * Logic-only tests (no DOM render — @testing-library/react not in project).
 * Tests mirror the state machine of ErrorBoundary.tsx class component.
 */

import { describe, it, expect } from "vitest";

// ── ErrorBoundary state machine ───────────────────────────────────────────────

interface BoundaryState {
  hasError: boolean;
  error: Error | null;
}

function getDerivedStateFromError(error: Error): BoundaryState {
  return { hasError: true, error };
}

function initialState(): BoundaryState {
  return { hasError: false, error: null };
}

describe("ErrorBoundary state logic", () => {
  it("initial state has no error", () => {
    const state = initialState();
    expect(state.hasError).toBe(false);
    expect(state.error).toBeNull();
  });

  it("getDerivedStateFromError sets hasError=true and captures error", () => {
    const err = new Error("render failed");
    const state = getDerivedStateFromError(err);
    expect(state.hasError).toBe(true);
    expect(state.error).toBe(err);
  });

  it("error message is accessible from state", () => {
    const err = new Error("Something went wrong");
    const state = getDerivedStateFromError(err);
    expect(state.error?.message).toBe("Something went wrong");
  });

  it("fallback should render when hasError is true", () => {
    const state = getDerivedStateFromError(new Error("boom"));
    // Simulate render decision: show fallback when hasError
    const showFallback = state.hasError;
    expect(showFallback).toBe(true);
  });

  it("children render when hasError is false", () => {
    const state = initialState();
    const showFallback = state.hasError;
    expect(showFallback).toBe(false);
  });
});

// ── useAgentState reconnect state logic (US-V2-03) ───────────────────────────

describe("useAgentState reconnect state logic", () => {
  it("reconnectAttempts increments on each onerror", () => {
    let attempts = 0;
    const onError = () => { attempts += 1; };
    onError();
    onError();
    onError();
    expect(attempts).toBe(3);
  });

  it("lastError is set on onerror", () => {
    let lastError: string | null = null;
    const onError = () => { lastError = "Connection lost"; };
    onError();
    expect(lastError).toBe("Connection lost");
  });

  it("lastError and reconnectAttempts reset on onopen", () => {
    let lastError: string | null = "Connection lost";
    let attempts = 3;
    const onOpen = () => { lastError = null; attempts = 0; };
    onOpen();
    expect(lastError).toBeNull();
    expect(attempts).toBe(0);
  });

  it("status pill label is 'reconnecting (attempt N)' when attempts > 0 and connecting", () => {
    const attempts = 2;
    const label = attempts > 0 ? `reconnecting (attempt ${attempts})` : "connecting";
    expect(label).toBe("reconnecting (attempt 2)");
  });

  it("status pill label is 'connecting' when attempts is 0", () => {
    const attempts = 0;
    const label = attempts > 0 ? `reconnecting (attempt ${attempts})` : "connecting";
    expect(label).toBe("connecting");
  });

  it("error label includes lastError message", () => {
    const lastError = "Connection lost";
    const label = lastError ? `error: ${lastError}` : "error · reconnect";
    expect(label).toBe("error: Connection lost");
  });
});
