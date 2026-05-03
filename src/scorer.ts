/**
 * Anomaly scoring — z-score based health scores against historical baselines.
 */

import type { Agent } from "./models.js";
import type { BaselineRow } from "./db.js";

export type HealthColor = "green" | "yellow" | "red";
export type Confidence = "calibrating" | "low" | "confident";

export interface AgentScore {
  healthScore: number;
  health: HealthColor;
  confidence: Confidence;
  anomalies: string[];
  toolZ: number;
  durationZ: number;
  baselineN: number;
}

/**
 * Compute z-score with a floored stddev to prevent division by zero.
 * Safe floor: max(stddev, mean * 0.2, 1.0)
 */
export function zScore(value: number, mean: number, stddev: number): number {
  const safeStd = Math.max(stddev, mean * 0.2, 1.0);
  return (value - mean) / safeStd;
}

/**
 * Score an agent against its baseline.
 *
 * Returns null if:
 *   - no baseline provided
 *   - sample_count < 2 (not enough data to score)
 *
 * Returns AgentScore with confidence="calibrating" if sample_count < 5.
 */
export function scoreAgent(
  agent: Agent,
  baseline: BaselineRow | null
): AgentScore | null {
  if (!baseline || baseline.sample_count < 2) {
    return null;
  }

  const durationMs = agent.last_seen_ms - agent.first_seen_ms;
  const errorRate = agent.error_count / Math.max(agent.tool_count, 1);

  const toolZ = zScore(agent.tool_count, baseline.mean_tool_count, baseline.stddev_tool_count);
  const durationZ = zScore(durationMs, baseline.mean_duration, baseline.stddev_duration);

  // Error deviation — only penalize above-mean errors
  const errorDeviation = Math.max(0, errorRate - 0.1);

  // Composite anomaly score
  let raw = Math.abs(toolZ) * 0.3 + Math.abs(durationZ) * 0.3 + errorDeviation * 5 * 0.4;

  // Completion penalty: still active beyond 2x expected duration
  if (agent.status !== "done" && durationMs > baseline.mean_duration * 2) {
    raw += 0.5;
  }

  // Collect human-readable anomaly strings
  const anomalies: string[] = [];
  if (Math.abs(toolZ) > 2) {
    const dir = toolZ > 0 ? "more" : "fewer";
    anomalies.push(`Tool count ${dir} than baseline (z=${toolZ.toFixed(1)})`);
  }
  if (Math.abs(durationZ) > 2) {
    const dir = durationZ > 0 ? "slower" : "faster";
    anomalies.push(`Duration ${dir} than baseline (z=${durationZ.toFixed(1)})`);
  }
  if (errorDeviation > 0.2) {
    anomalies.push(`High error rate (${(errorRate * 100).toFixed(0)}%)`);
  }

  // Health classification
  let health: HealthColor;
  if (raw < 1.0) {
    health = "green";
  } else if (raw < 2.0) {
    health = "yellow";
  } else {
    health = "red";
  }

  // Confidence level
  let confidence: Confidence;
  if (baseline.sample_count < 5) {
    confidence = "calibrating";
  } else {
    confidence = "confident";
  }

  return {
    healthScore: Math.round(raw * 100) / 100,
    health,
    confidence,
    anomalies,
    toolZ: Math.round(toolZ * 100) / 100,
    durationZ: Math.round(durationZ * 100) / 100,
    baselineN: baseline.sample_count,
  };
}
