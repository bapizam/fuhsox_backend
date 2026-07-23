import { env } from '@config/env';
import { AppError } from '@typings/models';
import logger from '@lib/logger';

/**
 * Text embeddings for RAG grounding (adaptive engine reformation, Phase 1).
 *
 * Gemini's `text-embedding-004` (768-dim), via the `@google/generative-ai` SDK that
 * is ALREADY a dependency and the default completion provider — so grounding needs
 * no new AI vendor. Anthropic has no embeddings API, so this path is Gemini-only
 * and requires `GEMINI_API_KEY`; the caller decides what to do when it's absent
 * (ingestion degrades, it never crashes a request).
 *
 * Kept apart from `ai-provider.ts` (completions + failover) because embeddings have
 * a different shape, model, and provider constraint. Sibling module, same style.
 */

const EMBEDDING_MODEL = 'text-embedding-004';

/** Gemini caps a batch at 100 requests; we chunk our inputs to fit. */
const MAX_BATCH = 100;

/** How the text will be used — Gemini optimises the vector per task. */
export type EmbeddingTask = 'document' | 'query';

/** True when embeddings are usable — callers gate ingestion on this. */
export function embeddingsAvailable(): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

/**
 * Embed many texts, preserving input order. Documents (chunks) and queries
 * (objective statements) should pass the matching `task` so the vectors live in
 * comparable spaces.
 */
export async function embedTexts(
  texts: string[],
  task: EmbeddingTask = 'document',
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!env.GEMINI_API_KEY) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Embeddings are not configured (GEMINI_API_KEY unset)');
  }

  const { GoogleGenerativeAI, TaskType } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const taskType = task === 'query' ? TaskType.RETRIEVAL_QUERY : TaskType.RETRIEVAL_DOCUMENT;

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    try {
      const { embeddings } = await model.batchEmbedContents({
        requests: batch.map((text) => ({
          content: { role: 'user', parts: [{ text }] },
          taskType,
        })),
      });
      for (const e of embeddings) out.push(e.values);
    } catch (err) {
      logger.error({ err, batchStart: i }, 'Embedding batch failed');
      throw new AppError(502, 'AI_ERROR', 'Could not embed the study material. Try again.');
    }
  }

  return out;
}

/** Embed a single query string (objective statement, chapter title). */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text], 'query');
  if (!vector) throw new AppError(502, 'AI_ERROR', 'Could not embed the query');
  return vector;
}
