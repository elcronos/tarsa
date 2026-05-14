import { useEffect } from "react";

/**
 * Bind a global keyboard shortcut.
 *
 * `combo` syntax (case-insensitive, order-insensitive for modifiers):
 *   - "mod+k"   → Cmd+K on mac, Ctrl+K elsewhere
 *   - "ctrl+k"  → Ctrl+K everywhere
 *   - "meta+k"  → Cmd/Meta+K
 *   - "shift+mod+f" → Cmd+Shift+F / Ctrl+Shift+F
 *   - "esc"     → Escape (no modifiers)
 *
 * Fires preventDefault before invoking handler. The handler is re-bound when
 * `deps` change — callers should pass a stable handler or include their own
 * deps.
 */
export function useHotkey(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  deps: ReadonlyArray<unknown> = [],
): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const parsed = parseCombo(combo);
    const listener = (e: KeyboardEvent) => {
      if (!matches(e, parsed)) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
    // deps intentionally spread — let caller decide invalidation cadence.
  }, [combo, ...deps]);
}

interface ParsedCombo {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** "mod" → meta on mac, ctrl elsewhere. Treated as (meta || ctrl). */
  mod: boolean;
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const out: ParsedCombo = {
    key: "",
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    mod: false,
  };
  for (const p of parts) {
    if (p === "ctrl" || p === "control") out.ctrl = true;
    else if (p === "meta" || p === "cmd" || p === "command") out.meta = true;
    else if (p === "alt" || p === "option") out.alt = true;
    else if (p === "shift") out.shift = true;
    else if (p === "mod") out.mod = true;
    else out.key = normalizeKey(p);
  }
  return out;
}

function normalizeKey(k: string): string {
  if (k === "esc") return "escape";
  if (k === "space") return " ";
  return k;
}

function matches(e: KeyboardEvent, c: ParsedCombo): boolean {
  if (e.key.toLowerCase() !== c.key) return false;
  if (c.shift && !e.shiftKey) return false;
  if (!c.shift && e.shiftKey && c.key.length === 1) {
    // Allow shift only when explicitly requested for single-char keys.
    return false;
  }
  if (c.alt !== e.altKey) return false;
  if (c.mod) {
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else {
    if (c.ctrl !== e.ctrlKey) return false;
    if (c.meta !== e.metaKey) return false;
  }
  return true;
}
