/**
 * What an AI call cost, in USD.
 *
 * `AIUsageLog` has always recorded `tokens_used`, which answers "how much did we
 * use" but not "what did it cost" — and those diverge by more than an order of
 * magnitude across the models this service can pick. A Gemini token and a Claude
 * Opus token are both a token; they are not both a price.
 *
 * Deliberately returns `null` for a model it has no rate for, rather than 0. A
 * zero cost is a claim, and a wrong claim about spend is worse than an admitted
 * gap — the same fail-closed reasoning as `utils/gradability`.
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  input:  number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /**
   * When this rate was last checked against the provider's published pricing.
   *
   * ⚠ Provider rates change and this table does not update itself. Treat a stale
   * `verified` date as a reason to re-check before trusting a cost report — the
   * numbers here are for attribution and trend, not for invoicing.
   */
  verified: string;
}

/**
 * Rates for every model `lib/ai-provider` can return.
 *
 * Kept as a plain table rather than pulled from an API because it is read on
 * every AI call and must never add latency or a failure mode to the request
 * path. `tests/unit/ai-cost.test.ts` asserts this covers every model the
 * provider can emit, so swapping a model without pricing it fails the build
 * rather than silently logging null costs forever.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // Anthropic list price for Claude Opus 4.6.
  'claude-opus-4-6':  { input: 5.00, output: 25.00, verified: '2026-08-08' },
  // Google list price for Gemini 2.5 Flash. VERIFY before using these figures
  // for anything that matters — this is the default provider, so it carries
  // most of the spend.
  'gemini-2.5-flash': { input: 0.30, output: 2.50,  verified: '2026-08-08' },
};

/** The models this table knows a rate for. */
export function pricedModels(): string[] {
  return Object.keys(MODEL_PRICING);
}

/**
 * Cost of one completion in USD, or `null` when the model has no known rate.
 *
 * Null is a real answer meaning "we don't know", and callers store it as null
 * rather than coercing it — a spend dashboard that shows a confident $0.00 for
 * an unpriced model is worse than one that shows a gap.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;

  const cost =
    (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;

  // Sub-cent calls are the norm here, so round to a precision that survives
  // them; summing rounded rows is close enough for attribution.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
