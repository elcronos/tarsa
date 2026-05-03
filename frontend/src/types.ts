/**
 * Frontend type definitions.
 *
 * Reducer types (Agent, Event, State, etc.) are sourced from the shared
 * canonical module at ../../src/shared/models.ts to eliminate the
 * previous manual duplication. Frontend-only types (BaselineRow,
 * CostSource) remain here.
 */

export * from "../../src/shared/models.js";

// ── Baseline types (mirroring src/db.ts BaselineRow) ─────────────────────

export interface BaselineRow {
  agent_type: string;
  mean_duration: number;
  mean_tool_count: number;
  mean_cost: number;
  sample_count: number;
  stddev_duration: number;
  stddev_tool_count: number;
  updated_at: number;
  tool_sequence_common: string | null;
}

// ── Cost source type (mirroring src/insights.ts) ──────────────────────────

export type CostSource = "measured" | "estimated_chars" | "tool_count_fallback";
