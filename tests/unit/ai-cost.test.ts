import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MODEL_PRICING, estimateCostUsd, pricedModels } from '@lib/ai-cost';

describe('estimateCostUsd', () => {
  it('prices a call from the input/output split', () => {
    // 1M in + 1M out on Opus 4.6 at $5 / $25.
    expect(estimateCostUsd('claude-opus-4-6', 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
  });

  it('weights input and output separately', () => {
    // The whole reason the split is stored: same token count, different cost.
    const inputHeavy = estimateCostUsd('claude-opus-4-6', 1_000_000, 0);
    const outputHeavy = estimateCostUsd('claude-opus-4-6', 0, 1_000_000);
    expect(inputHeavy).toBeCloseTo(5, 6);
    expect(outputHeavy).toBeCloseTo(25, 6);
  });

  it('returns null — not 0 — for a model with no known rate', () => {
    // A confident $0.00 for an unpriced model is a false claim about spend.
    // Null is the honest answer and is what gets stored.
    expect(estimateCostUsd('some-future-model', 1000, 1000)).toBeNull();
  });

  it('handles a zero-token call', () => {
    expect(estimateCostUsd('gemini-2.5-flash', 0, 0)).toBe(0);
  });

  it('keeps sub-cent precision', () => {
    // Typical calls are fractions of a cent; rounding to 2dp would store zero
    // for nearly every row and make the whole table useless.
    const cost = estimateCostUsd('gemini-2.5-flash', 1200, 800);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });
});

describe('MODEL_PRICING coverage', () => {
  /**
   * The safeguard that makes this table maintainable: every model string
   * `lib/ai-provider` can return must be priced here. Without it, swapping a
   * model silently logs `cost_usd: null` on every row from then on, and nobody
   * notices until someone asks what the month cost.
   */
  it('covers every model lib/ai-provider can return', () => {
    const providerSource = readFileSync(
      path.join(__dirname, '../../src/lib/ai-provider.ts'),
      'utf8',
    );

    // Model ids as written in the provider's return values, e.g. `model: 'gemini-2.5-flash'`.
    const referenced = new Set(
      [...providerSource.matchAll(/model:\s*'([a-z0-9.\-]+)'/gi)].map((m) => m[1]),
    );

    expect(referenced.size).toBeGreaterThan(0);

    const unpriced = [...referenced].filter((m) => !(m in MODEL_PRICING));
    expect(unpriced).toEqual([]);
  });

  it('stamps every rate with a verification date', () => {
    // Provider rates drift and this table does not update itself; an undated
    // entry is one nobody can judge the staleness of.
    for (const model of pricedModels()) {
      expect(MODEL_PRICING[model].verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('has positive rates on both sides', () => {
    for (const model of pricedModels()) {
      expect(MODEL_PRICING[model].input).toBeGreaterThan(0);
      expect(MODEL_PRICING[model].output).toBeGreaterThan(0);
    }
  });
});
