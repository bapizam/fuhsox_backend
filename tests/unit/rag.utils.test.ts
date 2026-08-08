import { chunkText } from '@lib/chunk';
import {
  LEGACY_SIGNATURE,
  cosine,
  matchesSignature,
  rankByCosine,
  scopeToPages,
  usableChunks,
  type SignedChunk,
} from '@lib/retrieval';

describe('chunkText', () => {
  it('returns nothing for empty/whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const chunks = chunkText('The heart has four chambers.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ordinal).toBe(0);
    expect(chunks[0].text).toContain('four chambers');
  });

  it('splits long text into multiple sequentially-numbered chunks', () => {
    const para = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about physiology.`).join(' ');
    const chunks = chunkText(para, { targetTokens: 40, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('drops noise fragments below minChars', () => {
    const chunks = chunkText('7\n\nThe cardiac cycle describes one complete heartbeat sequence.', {
      minChars: 20,
    });
    // The lone "7" (a page number) is dropped; the real paragraph survives.
    expect(chunks.every((c) => c.text.length >= 20)).toBe(true);
    expect(chunks.some((c) => c.text.includes('cardiac cycle'))).toBe(true);
  });

  it('packs multiple small paragraphs together rather than one-per-chunk', () => {
    const text = 'Alpha para one.\n\nBeta para two.\n\nGamma para three.';
    const chunks = chunkText(text, { targetTokens: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Alpha');
    expect(chunks[0].text).toContain('Gamma');
  });
});

describe('cosine', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosine([1, 0, 0], [2, 0, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is 0 against a zero vector (no NaN)', () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('is negative for opposing vectors', () => {
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
  });
});

describe('rankByCosine', () => {
  const chunks = [
    { text: 'far', embedding: [0, 1], page: 3, ordinal: 2 },
    { text: 'near', embedding: [1, 0.1], page: 1, ordinal: 0 },
    { text: 'mid', embedding: [0.7, 0.7], page: 2, ordinal: 1 },
  ];

  it('returns the most similar chunks first', () => {
    const ranked = rankByCosine(chunks, [1, 0], 3);
    expect(ranked[0].text).toBe('near');
    expect(ranked[2].text).toBe('far');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('respects k', () => {
    expect(rankByCosine(chunks, [1, 0], 2)).toHaveLength(2);
  });

  it('carries page + ordinal through for citation', () => {
    const top = rankByCosine(chunks, [1, 0], 1)[0];
    expect(top.page).toBe(1);
    expect(top.ordinal).toBe(0);
  });
});

describe('scopeToPages', () => {
  const chunks = [
    { text: 'a', page: 40 },
    { text: 'b', page: 55 },
    { text: 'c', page: 60 },
    { text: 'd', page: 90 },
  ];

  it('keeps only the chunks inside the window', () => {
    expect(scopeToPages(chunks, { page_start: 53, page_end: 66 }).map((c) => c.text)).toEqual(['b', 'c']);
  });

  it('runs to the end of the book when the window has no end', () => {
    expect(scopeToPages(chunks, { page_start: 60 }).map((c) => c.text)).toEqual(['c', 'd']);
  });

  it('returns everything when there is no window', () => {
    expect(scopeToPages(chunks)).toHaveLength(4);
    expect(scopeToPages(chunks, {})).toHaveLength(4);
  });

  it('falls back to the whole set rather than grounding on nothing', () => {
    // `page` is only populated for resources ingested since page-aware
    // extraction. Returning [] for an older book would silently un-ground every
    // check on it — a much bigger failure than a slightly wide window.
    const unpaged: { text: string; page?: number }[] = [{ text: 'a' }, { text: 'b' }];
    expect(scopeToPages(unpaged, { page_start: 10, page_end: 20 })).toHaveLength(2);
    // Same when the pages exist but none land in the window.
    expect(scopeToPages(chunks, { page_start: 500, page_end: 600 })).toHaveLength(4);
  });
});

describe('matchesSignature', () => {
  const legacy = LEGACY_SIGNATURE;
  const newer = { model: 'text-embedding-005', dim: 1024 };

  it('matches a stamped chunk against the same model + dim', () => {
    expect(matchesSignature({ embedding_model: newer.model, embedding_dim: newer.dim }, newer)).toBe(true);
  });

  it('rejects a stamped chunk from a different model', () => {
    expect(matchesSignature({ embedding_model: legacy.model, embedding_dim: legacy.dim }, newer)).toBe(false);
  });

  it('rejects a same-model chunk whose dimensionality changed', () => {
    // A model revision that keeps its name but changes width would otherwise
    // slip through and produce cosine scores over ragged vectors.
    expect(matchesSignature({ embedding_model: newer.model, embedding_dim: 768 }, newer)).toBe(false);
  });

  it('treats an unstamped chunk as the legacy embedding', () => {
    // Chunks written before provenance tracking really were produced by
    // LEGACY_SIGNATURE, so they stay usable while that is still current...
    expect(matchesSignature({}, legacy)).toBe(true);
    expect(matchesSignature({ embedding_model: null, embedding_dim: null }, legacy)).toBe(true);
  });

  it('stops trusting unstamped chunks the moment the model changes', () => {
    // ...and become unusable the day it is not, with no backfill needed first.
    // This is the whole point: the legacy fallback closes itself.
    expect(matchesSignature({}, newer)).toBe(false);
  });
});

describe('usableChunks', () => {
  const current = LEGACY_SIGNATURE;

  it('keeps only the comparable chunks', () => {
    const stored = [
      { text: 'legacy-unstamped' },
      { text: 'legacy-stamped', embedding_model: current.model, embedding_dim: current.dim },
      { text: 'foreign', embedding_model: 'text-embedding-005', embedding_dim: 1024 },
    ];
    expect(usableChunks(stored, current).map((c) => c.text)).toEqual([
      'legacy-unstamped',
      'legacy-stamped',
    ]);
  });

  it('returns [] rather than ranking a wholly mismatched set', () => {
    // [] is the same shape as "never ingested", which every caller already
    // handles by falling back to ungrounded generation. Ranking mismatched
    // vectors would instead produce confident nonsense.
    const stored = [{ text: 'foreign', embedding_model: 'text-embedding-005', embedding_dim: 1024 }];
    expect(usableChunks(stored, current)).toEqual([]);
  });

  it('leaves an all-comparable set untouched', () => {
    // Annotated because `SignedChunk` is all-optional: a literal carrying none
    // of its fields has no overlap, and TS's weak-type check rejects it.
    const stored: (SignedChunk & { text: string })[] = [{ text: 'a' }, { text: 'b' }];
    expect(usableChunks(stored, current)).toHaveLength(2);
  });
});
