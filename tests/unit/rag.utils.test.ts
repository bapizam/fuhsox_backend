import { chunkText } from '@lib/chunk';
import { cosine, rankByCosine } from '@lib/retrieval';

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
