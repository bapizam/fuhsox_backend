import { ResourceChunk } from '../../mongo/schemas';
import { embedQuery } from '@lib/embeddings';

/**
 * Retrieval for RAG grounding (reformation Phase 1).
 *
 * Retrieval is always scoped to ONE resource (the student's textbook/notes), whose
 * chunk count is in the hundreds — so ranking by cosine in Node is sub-millisecond
 * and needs no vector database. `cosine`/`rankByCosine` are pure and unit-tested;
 * `retrieveChunks` is the DB-backed wrapper.
 */

/** Cosine similarity of two equal-length vectors. Returns 0 for a zero vector. */
export function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankableChunk {
  text: string;
  embedding: number[];
  page?: number;
  ordinal: number;
}

export interface RetrievedChunk {
  text: string;
  page?: number;
  ordinal: number;
  score: number;
}

/** Top-`k` chunks by cosine to `queryEmbedding`, most similar first. Pure. */
export function rankByCosine<T extends RankableChunk>(
  chunks: T[],
  queryEmbedding: number[],
  k: number,
): RetrievedChunk[] {
  return chunks
    .map((c) => ({ text: c.text, page: c.page, ordinal: c.ordinal, score: cosine(c.embedding, queryEmbedding) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}

/**
 * Retrieve the passages from `resourceId` most relevant to `query`. Returns [] when
 * the resource was never ingested (no chunks) — callers fall back to ungrounded
 * generation rather than failing.
 */
export async function retrieveChunks(
  resourceId: string,
  query: string,
  k = 6,
): Promise<RetrievedChunk[]> {
  const chunks = await ResourceChunk.find(
    { resource_id: resourceId },
    { text: 1, embedding: 1, page: 1, ordinal: 1 },
  ).lean();

  if (chunks.length === 0) return [];

  const queryEmbedding = await embedQuery(query);
  return rankByCosine(
    chunks.map((c) => ({ text: c.text, embedding: c.embedding, page: c.page, ordinal: c.ordinal })),
    queryEmbedding,
    k,
  );
}
