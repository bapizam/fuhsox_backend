import { env } from '@config/env';
import logger from '@lib/logger';
import { classify, isCapacityFailure } from '@lib/ai-failure';
import { incrWithExpiry, getEndOfDayTTL, getTodayWAT } from '@lib/redis';
import { REDIS_KEYS } from '@config/constants';
import { AppError } from '@typings/models';
import type { Socket } from 'socket.io';

export interface AIMessage {
  role:    'user' | 'assistant';
  content: string;
}

export interface AICompletionParams {
  system:     string;
  messages:   AIMessage[];
  max_tokens: number;
}

export interface AICompletionResult {
  text:          string;
  input_tokens:  number;
  output_tokens: number;
  provider:      'claude' | 'gemini';
  model:         string;
}

// ─── Retry & Failover ─────────────────────────────────────────────────────────

type Provider = 'claude' | 'gemini';

function hasCredentials(provider: Provider): boolean {
  // ANTHROPIC_API_KEY is required by the env schema, so Claude is always usable.
  return provider === 'claude' ? true : Boolean(env.GEMINI_API_KEY);
}

/**
 * Claim one unit of today's project-wide failover budget.
 *
 * Increments first and compares after, rather than reading then incrementing:
 * two concurrent requests reading the same under-limit count would both pass a
 * read-first check and both spend. Over-counting is the safe direction here.
 *
 * A claim is consumed even if the failover call then fails. Compensating for
 * that would need a rollback path on every error branch, and erring toward
 * under-spending is the right bias for a cost ceiling.
 */
async function claimFailoverBudget(): Promise<boolean> {
  if (env.AI_FALLBACK_DAILY_LIMIT === 0) return false;

  try {
    const used = await incrWithExpiry(
      REDIS_KEYS.AI_FALLBACK_DAILY(getTodayWAT()),
      getEndOfDayTTL(),
    );
    return used <= env.AI_FALLBACK_DAILY_LIMIT;
  } catch (err) {
    // Fail open, matching how the per-user limit treats a Redis miss. Redis is
    // already load-bearing for sessions and queues, so a hard failure here means
    // the app is degraded anyway — refusing AI would not be the useful response.
    logger.warn({ err }, 'Failover budget check failed, allowing failover');
    return true;
  }
}

const MAX_ATTEMPTS   = 3;
const MAX_BACKOFF_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry transient failures with exponential backoff.
 *
 * Deliberately does NOT retry a daily-quota 429, nor one whose RetryInfo exceeds
 * `MAX_BACKOFF_MS` — holding an HTTP request open for a 46-second window just
 * trades a fast error for a slow one, and the caller times out either way. Both
 * cases fall through to the failover path in `callAI`, which is the useful
 * response to "this provider is out of capacity".
 *
 * `canRetry` lets the caller veto a retry on state the classifier cannot see —
 * the streaming path uses it to stop once tokens have reached the client, since
 * re-running the call would emit a second answer on top of the first.
 */
async function withRetry<T>(
  provider: Provider,
  fn: () => Promise<T>,
  canRetry: () => boolean = () => true,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const failure = classify(err);
      const backoff = failure.retryAfterMs ?? 2 ** (attempt - 1) * 500;

      const worthRetrying =
        canRetry() &&
        isCapacityFailure(failure) &&
        !failure.dailyQuota &&
        backoff <= MAX_BACKOFF_MS &&
        attempt < MAX_ATTEMPTS;

      if (!worthRetrying) throw err;

      logger.warn(
        { provider, attempt, backoffMs: backoff, status: failure.status },
        'AI call failed, retrying',
      );
      await sleep(backoff);
    }
  }
}

/**
 * Map a provider failure onto an `AppError` so the client gets an actionable
 * status instead of a blanket 500. A quota 429 surfacing as 500 is actively
 * misleading — the frontend cannot tell "back off" from "the server is broken".
 *
 * Errors with no recognizable HTTP status are ours, not the provider's (a
 * malformed response, an empty message list), so they propagate untouched and
 * still become a 500.
 */
function toAppError(err: unknown, provider: Provider): unknown {
  const f = classify(err);
  if (f.status === undefined) return err;

  if (f.status === 429) {
    return new AppError(
      429,
      f.dailyQuota ? 'AI_QUOTA_EXHAUSTED' : 'AI_RATE_LIMITED',
      f.dailyQuota
        ? 'The daily AI request quota is exhausted. AI features resume when it resets.'
        : 'AI is handling too many requests right now. Please try again shortly.',
      f.retryAfterMs ? { retry_after_ms: f.retryAfterMs } : undefined,
    );
  }

  if (f.status >= 500) {
    return new AppError(503, 'AI_UNAVAILABLE', 'The AI service is temporarily unavailable.');
  }

  return new AppError(502, 'AI_ERROR', `The AI provider (${provider}) rejected the request.`);
}

function invoke(provider: Provider, params: AICompletionParams): Promise<AICompletionResult> {
  return provider === 'claude' ? callClaude(params) : callGemini(params);
}

async function callClaude(params: AICompletionParams): Promise<AICompletionResult> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client    = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: params.max_tokens,
    system:     params.system,
    messages:   params.messages,
  });

  const content = response.content[0];
  if (content?.type !== 'text') {
    throw new Error('Claude returned unexpected response format');
  }

  return {
    text:          content.text,
    input_tokens:  response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    provider:      'claude',
    model:         'claude-opus-4-6',
  };
}

async function callGemini(params: AICompletionParams): Promise<AICompletionResult> {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to your .env file. ' +
      'Get a free key at https://aistudio.google.com',
    );
  }

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: params.system,
  });

  // Split messages into history (all except last) + current prompt
  const history = params.messages.slice(0, -1).map((m) => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const lastMessage = params.messages[params.messages.length - 1];
  if (!lastMessage) throw new Error('No messages provided to callGemini');

  const chat   = model.startChat({ history });
  const result = await chat.sendMessage(lastMessage.content);
  const text   = result.response.text();
  const usage  = result.response.usageMetadata;

  return {
    text,
    input_tokens:  usage?.promptTokenCount     ?? 0,
    output_tokens: usage?.candidatesTokenCount ?? 0,
    provider:      'gemini',
    model:         'gemini-2.5-flash',
  };
}

async function streamGemini(
  params: AICompletionParams,
  onToken: (token: string) => void,
): Promise<{ text: string; input_tokens: number; output_tokens: number }> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

  const model = genAI.getGenerativeModel({
    model:             'gemini-2.5-flash',
    systemInstruction: params.system,
  });

  const lastMessage = params.messages[params.messages.length - 1];
  if (!lastMessage) throw new Error('No messages provided');

  const result = await model.generateContentStream(lastMessage.content);

  let fullText = '';
  for await (const chunk of result.stream) {
    const token = chunk.text();
    if (token) {
      fullText += token;
      onToken(token);
    }
  }

  const finalResponse = await result.response;
  const usage         = finalResponse.usageMetadata;

  return {
    text:          fullText,
    input_tokens:  usage?.promptTokenCount     ?? 0,
    output_tokens: usage?.candidatesTokenCount ?? 0,
  };
}

async function streamClaude(
  params: AICompletionParams,
  onToken: (token: string) => void,
): Promise<{ text: string; input_tokens: number; output_tokens: number }> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client    = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const stream = client.messages.stream({
    model:      'claude-opus-4-6',
    max_tokens: params.max_tokens,
    system:     params.system,
    messages:   params.messages,
  });

  let fullText = '';
  for await (const chunk of stream) {
    if (
      chunk.type === 'content_block_delta' &&
      chunk.delta.type === 'text_delta'
    ) {
      const token = chunk.delta.text;
      fullText   += token;
      onToken(token);
    }
  }

  const finalMessage = await stream.finalMessage();
  return {
    text:          fullText,
    input_tokens:  finalMessage.usage.input_tokens,
    output_tokens: finalMessage.usage.output_tokens,
  };
}

export async function callAI(params: AICompletionParams): Promise<AICompletionResult> {
  const primary = env.AI_PROVIDER ?? 'gemini';
  const backup: Provider = primary === 'claude' ? 'gemini' : 'claude';
  logger.debug({ provider: primary }, 'AI completion request');

  try {
    return await withRetry(primary, () => invoke(primary, params));
  } catch (err) {
    const failure = classify(err);

    // Fail over only on capacity problems. A malformed prompt fails identically on
    // both providers, so retrying it elsewhere doubles the latency and the bill for
    // the same error.
    if (!isCapacityFailure(failure) || !hasCredentials(backup)) {
      throw toAppError(err, primary);
    }

    if (!(await claimFailoverBudget())) {
      // Surface the ORIGINAL provider error, not a budget error: from the caller's
      // side the AI is unavailable for exactly the reason it was before failover
      // existed, and the 429 it already maps to carries the right retry semantics.
      logger.error(
        { primary, backup, limit: env.AI_FALLBACK_DAILY_LIMIT },
        'Daily failover budget exhausted, not failing over',
      );
      throw toAppError(err, primary);
    }

    logger.warn(
      { primary, backup, status: failure.status, dailyQuota: failure.dailyQuota },
      'AI provider out of capacity, failing over',
    );

    try {
      return await withRetry(backup, () => invoke(backup, params));
    } catch (backupErr) {
      throw toAppError(backupErr, backup);
    }
  }
}

export async function streamFeedback(
  socket: Socket,
  params: AICompletionParams & {
    session_id:  string;
    question_id: string;
  },
): Promise<{ text: string; input_tokens: number; output_tokens: number; provider: string; model: string }> {
  const primary = env.AI_PROVIDER ?? 'gemini';
  const backup: Provider = primary === 'claude' ? 'gemini' : 'claude';

  let streamed = false;

  const onToken = (token: string) => {
    streamed = true;
    socket.emit('quiz:answer_feedback', {
      token,
      session_id:  params.session_id,
      question_id: params.question_id,
      is_done:     false,
    });
  };

  const invokeStream = (provider: Provider) =>
    provider === 'claude'
      ? streamClaude(params, onToken)
      : streamGemini(params, onToken);

  let served = primary;
  let result: { text: string; input_tokens: number; output_tokens: number };

  // Once tokens are on the wire the client has half an answer rendered, so both
  // retry and failover must stop there — re-running the call would splice a second
  // reply onto the first. `() => !streamed` enforces that for retries; the `streamed`
  // check below enforces it for the provider switch.
  const stillSilent = () => !streamed;

  try {
    result = await withRetry(primary, () => invokeStream(primary), stillSilent);
  } catch (err) {
    if (streamed || !isCapacityFailure(classify(err)) || !hasCredentials(backup)) {
      throw toAppError(err, primary);
    }

    if (!(await claimFailoverBudget())) {
      logger.error(
        { primary, backup, limit: env.AI_FALLBACK_DAILY_LIMIT },
        'Daily failover budget exhausted, not failing over',
      );
      throw toAppError(err, primary);
    }

    logger.warn({ primary, backup }, 'AI stream provider out of capacity, failing over');
    served = backup;

    try {
      result = await withRetry(backup, () => invokeStream(backup), stillSilent);
    } catch (backupErr) {
      throw toAppError(backupErr, backup);
    }
  }

  socket.emit('quiz:answer_feedback', {
    token:       '',
    session_id:  params.session_id,
    question_id: params.question_id,
    is_done:     true,
  });

  return {
    ...result,
    provider: served,
    model: served === 'claude' ? 'claude-opus-4-6' : 'gemini-2.5-flash',
  };
}

export function getActiveProvider(): 'claude' | 'gemini' {
  return env.AI_PROVIDER ?? 'gemini';
}