import { ResourceChunk } from '../../mongo/schemas';
import { embedQuery, embedTexts } from '@lib/embeddings';

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

export interface PageScope {
  page_start?: number;
  page_end?: number;
}

/**
 * Narrow a chunk set to a page window.
 *
 * **Falls back to the whole set when the window matches nothing**, which is not
 * laziness: `ResourceChunk.page` is only populated for resources ingested since
 * page-aware extraction, and a PDF whose pages all failed to render has none at
 * all. Returning [] there would silently un-ground every check on an older book.
 * A slightly wider grounding is a much smaller failure than no grounding.
 */
export function scopeToPages<T extends { page?: number }>(chunks: T[], scope?: PageScope): T[] {
  if (!scope || typeof scope.page_start !== 'number') return chunks;
  const start = scope.page_start;
  const end = typeof scope.page_end === 'number' ? scope.page_end : Number.POSITIVE_INFINITY;

  const inWindow = chunks.filter((c) => typeof c.page === 'number' && c.page >= start && c.page <= end);
  return inWindow.length > 0 ? inWindow : chunks;
}

/**
 * Retrieve the passages from `resourceId` most relevant to `query`. Returns [] when
 * the resource was never ingested (no chunks) — callers fall back to ungrounded
 * generation rather than failing.
 *
 * `scope` restricts retrieval to a page window, so a check on the second sitting
 * of a chapter draws only from the pages that sitting covered.
 */
export async function retrieveChunks(
  resourceId: string,
  query: string,
  k = 6,
  scope?: PageScope,
): Promise<RetrievedChunk[]> {
  const all = await ResourceChunk.find(
    { resource_id: resourceId },
    { text: 1, embedding: 1, page: 1, ordinal: 1 },
  ).lean();

  const chunks = scopeToPages(all, scope);
  if (chunks.length === 0) return [];

  const queryEmbedding = await embedQuery(query);
  return rankByCosine(
    chunks.map((c) => ({ text: c.text, embedding: c.embedding, page: c.page, ordinal: c.ordinal })),
    queryEmbedding,
    k,
  );
}

/**
 * `retrieveChunks` for several queries at once, returning one result list per
 * query in the order given.
 *
 * Callers that need passages for several chapters at once (the study planner
 * grounding its weakest chapters, say) would otherwise reload the resource's
 * chunks and pay a separate embedding round-trip per chapter. This loads the
 * chunks once and embeds all the queries in a single batch (`embedTexts` batches
 * up to Gemini's cap), which is the difference between one network call and ten.
 */
export async function retrieveChunksForQueries(
  resourceId: string,
  queries: string[],
  k = 6,
): Promise<RetrievedChunk[][]> {
  if (queries.length === 0) return [];

  const chunks = await ResourceChunk.find(
    { resource_id: resourceId },
    { text: 1, embedding: 1, page: 1, ordinal: 1 },
  ).lean();

  if (chunks.length === 0) return queries.map(() => []);

  const rankable = chunks.map((c) => ({
    text:      c.text,
    embedding: c.embedding,
    page:      c.page,
    ordinal:   c.ordinal,
  }));

  const queryEmbeddings = await embedTexts(queries, 'query');
  return queryEmbeddings.map((embedding) => rankByCosine(rankable, embedding, k));
}

export interface ChapterForPassages {
  id: string;
  title: string;
  page_start: number | null;
  page_end: number | null;
}

/**
 * A few sentences of each chapter's own text, for EVERY chapter of a resource.
 *
 * The study planner used to see chapter titles and nothing else — so it decided
 * what a chapter contained, how hard it was and what had to be read before it
 * from the title alone. This is what it reads instead.
 *
 * **Nearly free, which is the only reason it can cover the whole book.** The
 * resource's chunks are loaded once, and a chapter whose page range was located
 * takes its passages by page — no embedding, no ranking, no network. Only the
 * chapters with no usable range fall through to retrieval, and those go out as a
 * SINGLE batched `embedTexts` call however many there are.
 *
 * Deliberately does NOT use {@link scopeToPages}: its fall back to the whole
 * document when a window matches nothing is right for grounding one check and
 * catastrophic here, where it would quietly hand chapter 3 the entire book. An
 * empty window falls through to retrieval instead, which at least returns
 * something about the right chapter.
 */
export async function chapterPassages(
  resourceId: string,
  chapters: ChapterForPassages[],
  perChapter = 2,
): Promise<Map<string, RetrievedChunk[]>> {
  const passages = new Map<string, RetrievedChunk[]>();
  if (chapters.length === 0) return passages;

  const all = await ResourceChunk.find(
    { resource_id: resourceId },
    { text: 1, embedding: 1, page: 1, ordinal: 1 },
  ).lean();
  if (all.length === 0) return passages;

  const needRetrieval: ChapterForPassages[] = [];

  for (const chapter of chapters) {
    const start = chapter.page_start;
    if (typeof start !== 'number') {
      needRetrieval.push(chapter);
      continue;
    }
    const end = typeof chapter.page_end === 'number' ? chapter.page_end : Number.POSITIVE_INFINITY;

    // The chapter's OPENING pages, in document order — a chapter introduces
    // itself far better than its most cosine-similar passage does.
    const inWindow = all
      .filter((c) => typeof c.page === 'number' && c.page >= start && c.page <= end)
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(0, perChapter);

    if (inWindow.length === 0) {
      needRetrieval.push(chapter);
      continue;
    }
    passages.set(
      chapter.id,
      inWindow.map((c) => ({ text: c.text, page: c.page, ordinal: c.ordinal, score: 1 })),
    );
  }

  if (needRetrieval.length > 0) {
    const rankable = all.map((c) => ({
      text:      c.text,
      embedding: c.embedding,
      page:      c.page,
      ordinal:   c.ordinal,
    }));
    const embeddings = await embedTexts(needRetrieval.map((c) => c.title), 'query');
    embeddings.forEach((embedding, i) => {
      const chapter = needRetrieval[i];
      if (chapter) passages.set(chapter.id, rankByCosine(rankable, embedding, perChapter));
    });
  }

  return passages;
}
