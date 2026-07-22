/**
 * Classification of upstream AI provider failures.
 *
 * Lives apart from `ai-provider.ts` because it is pure string parsing with no
 * dependency on `@config/env` — which reads `process.env` at import time and
 * calls `process.exit(1)` when a variable is missing. Keeping the classifier
 * env-free is what makes it unit-testable without standing up a full environment.
 */

/**
 * Normalized view of a provider failure.
 *
 * Both SDKs throw opaque `Error`s for capacity problems, so the only way to tell
 * "retry in 3s" from "you are out of quota until tomorrow" is to read the payload.
 * Getting that wrong is costly in both directions: retrying a daily-quota 429
 * spends the very allowance it is waiting on, while failing fast on a per-minute
 * 429 drops a request that would have succeeded seconds later.
 */
export interface UpstreamFailure {
  status:       number | undefined;
  retryAfterMs: number | undefined;
  /** Daily cap. No amount of in-process backoff clears this one. */
  dailyQuota:   boolean;
}

export function classify(err: unknown): UpstreamFailure {
  const message = err instanceof Error ? err.message : String(err);

  // The Anthropic SDK exposes `status`; the Gemini SDK only embeds it in the
  // message, as a `[429 Too Many Requests]` prefix.
  const typed = (err as { status?: unknown } | null)?.status;
  const status =
    typeof typed === 'number' ? typed : Number(/\[(\d{3})\s/.exec(message)?.[1]) || undefined;

  // Google's RetryInfo, rendered into the message as "Please retry in 26.3028s."
  const retry = /retry in ([\d.]+)\s*s/i.exec(message);

  return {
    status,
    retryAfterMs: retry ? Math.ceil(Number(retry[1]) * 1000) : undefined,
    // quotaId is `GenerateRequestsPerDayPerProjectPerModel-FreeTier` for the daily
    // cap and `...PerMinute...` for the short window. Substring match rather than
    // equality — Google revises these identifiers.
    dailyQuota: /PerDay/i.test(message),
  };
}

/** A capacity problem: the request was fine, the provider just couldn't serve it. */
export function isCapacityFailure(f: UpstreamFailure): boolean {
  return f.status === 429 || (f.status !== undefined && f.status >= 500);
}
