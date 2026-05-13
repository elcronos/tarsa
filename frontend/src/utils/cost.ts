/**
 * Frontend cost estimation. Re-exports the shared pricing module so backend
 * and frontend stay in sync. Canonical source: `src/shared/pricing.ts`.
 */

export {
  PRICING,
  detectModel,
  priceUsd,
  type ModelKey,
  type ModelPricing,
} from "../../../src/shared/pricing";
import { detectModel, priceUsd } from "../../../src/shared/pricing";

/**
 * Backward-compatible helper: USD for plain input/output token counts.
 * Use `priceUsd` directly when cache tokens matter.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model = "claude-sonnet-4",
  cacheReadTokens = 0,
  cacheCreationTokens = 0
): number {
  return priceUsd(
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    detectModel(model)
  );
}
