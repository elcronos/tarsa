/**
 * Cost estimation using Anthropic pricing (Sonnet 4 / Opus 4).
 * Prices per million tokens (MTok).
 */

const PRICING = {
  "claude-sonnet-4": { input: 3.0, output: 15.0 },
  "claude-opus-4": { input: 15.0, output: 75.0 },
  "claude-haiku": { input: 0.8, output: 4.0 },
  default: { input: 3.0, output: 15.0 },
} as const;

type ModelKey = keyof typeof PRICING;

function getPrice(model: string): { input: number; output: number } {
  for (const key of Object.keys(PRICING) as ModelKey[]) {
    if (key !== "default" && model.toLowerCase().includes(key)) {
      return PRICING[key];
    }
  }
  return PRICING.default;
}

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model = "claude-sonnet-4"
): number {
  const price = getPrice(model);
  return (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output;
}
