import { classify, isCapacityFailure } from '@lib/ai-failure';

/**
 * The message strings below are copied verbatim from production logs on
 * 2026-07-22, when the Gemini free-tier daily quota was exhausted. The classifier
 * parses third-party message formats, so these act as the regression guard: if a
 * provider changes its wording, these fail rather than the classifier silently
 * degrading to "unknown error" and disabling both retry and failover.
 */

const GEMINI_DAILY_QUOTA =
  '[GoogleGenerativeAI Error]: Error fetching from ' +
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: ' +
  '[429 Too Many Requests] You exceeded your current quota, please check your plan and billing details. ' +
  '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
  'limit: 20, model: gemini-2.5-flash\nPlease retry in 26.302831326s. ' +
  '[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{' +
  '"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",' +
  '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]';

const GEMINI_OVERLOADED =
  '[GoogleGenerativeAI Error]: Error fetching from ' +
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: ' +
  '[503 Service Unavailable] The model is overloaded. Please try again later.';

describe('classify', () => {
  it('reads the status out of a Gemini message prefix', () => {
    expect(classify(new Error(GEMINI_DAILY_QUOTA)).status).toBe(429);
    expect(classify(new Error(GEMINI_OVERLOADED)).status).toBe(503);
  });

  it('flags the daily quota so retry is skipped in favour of failover', () => {
    expect(classify(new Error(GEMINI_DAILY_QUOTA)).dailyQuota).toBe(true);
  });

  it('does not flag a per-minute quota as the daily cap', () => {
    const perMinute = GEMINI_DAILY_QUOTA.replace(
      'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
      'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
    );
    expect(classify(new Error(perMinute)).dailyQuota).toBe(false);
  });

  it('extracts RetryInfo as milliseconds, rounding up', () => {
    expect(classify(new Error(GEMINI_DAILY_QUOTA)).retryAfterMs).toBe(26303);
  });

  it('handles a sub-second RetryInfo', () => {
    // Seen in the logs as "Please retry in 785.028911ms." — no seconds value, so
    // there is nothing to honour and backoff falls back to the retry curve.
    expect(classify(new Error('Please retry in 785.028911ms.')).retryAfterMs).toBeUndefined();
  });

  it('prefers the Anthropic SDK typed status over message parsing', () => {
    const err = Object.assign(new Error('Overloaded'), { status: 529 });
    expect(classify(err).status).toBe(529);
  });

  it('returns an undefined status for our own errors', () => {
    // These must stay unclassified so they propagate as a 500 rather than being
    // mislabelled as an upstream capacity problem.
    const ours = classify(new Error('Claude returned unexpected response format'));
    expect(ours.status).toBeUndefined();
    expect(isCapacityFailure(ours)).toBe(false);
  });

  it('tolerates a non-Error throw', () => {
    expect(classify('boom').status).toBeUndefined();
  });
});

describe('isCapacityFailure', () => {
  it('treats 429 and 5xx as capacity problems worth failing over', () => {
    expect(isCapacityFailure(classify(new Error(GEMINI_DAILY_QUOTA)))).toBe(true);
    expect(isCapacityFailure(classify(new Error(GEMINI_OVERLOADED)))).toBe(true);
  });

  it('does not fail over on a 400 — a bad prompt fails the same way on both providers', () => {
    expect(isCapacityFailure({ status: 400, retryAfterMs: undefined, dailyQuota: false })).toBe(false);
  });
});
