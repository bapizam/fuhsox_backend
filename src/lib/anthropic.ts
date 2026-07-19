import Anthropic from '@anthropic-ai/sdk';
import { env } from '@config/env';

const globalForAnthropic = globalThis as unknown as { anthropic?: Anthropic };

export const anthropic: Anthropic =
  globalForAnthropic.anthropic ??
  new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: 3,
    timeout: 120 * 1000, // 2 minutes
  });

if (env.NODE_ENV !== 'production') {
  globalForAnthropic.anthropic = anthropic;
}

export default anthropic;
