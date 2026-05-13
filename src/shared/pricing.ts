/**
 * Shared Anthropic model pricing (per million tokens, USD).
 *
 * Single source of truth used by backend (`src/insights.ts`) and frontend
 * (`frontend/src/utils/cost.ts`). Includes cache_read and cache_write rates
 * since cache tokens dominate real-world cost.
 */

export type ModelKey = "sonnet" | "opus" | "haiku";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICING: Record<ModelKey, ModelPricing> = {
  // Claude Sonnet 4.5
  sonnet: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  // Claude Opus 4.7
  opus: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  // Claude Haiku 4.5
  haiku: { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
};

/**
 * Detect model family from a model identifier string.
 * Order matters: check haiku before opus before sonnet (sonnet is default).
 */
export function detectModel(model: string | null | undefined): ModelKey {
  if (!model) return "sonnet";
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("opus")) return "opus";
  return "sonnet";
}

/**
 * USD cost for token usage. Cache tokens use cacheRead / cacheWrite rates.
 */
export function priceUsd(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  model: ModelKey
): number {
  const p = PRICING[model];
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output +
    (cacheReadTokens / 1_000_000) * p.cacheRead +
    (cacheCreationTokens / 1_000_000) * p.cacheWrite
  );
}
