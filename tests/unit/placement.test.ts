import { sampleChapterIndices } from '@services/placement.service';

describe('sampleChapterIndices', () => {
  it('takes every chapter when the book is smaller than the sample', () => {
    expect(sampleChapterIndices(4, 10)).toEqual([0, 1, 2, 3]);
    expect(sampleChapterIndices(10, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('always covers both ends of the book', () => {
    // A placement drawn only from the opening chapters says nothing about where
    // the student's knowledge actually stops.
    const picked = sampleChapterIndices(40, 10);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(39);
  });

  it('spreads the sample evenly rather than clustering', () => {
    const picked = sampleChapterIndices(40, 10);
    const gaps = picked.slice(1).map((v, i) => v - picked[i]);
    // Even spacing over 40/10 means every gap is the same or within one.
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('never exceeds the requested count', () => {
    expect(sampleChapterIndices(400, 10).length).toBeLessThanOrEqual(10);
    expect(sampleChapterIndices(11, 10).length).toBeLessThanOrEqual(10);
  });

  it('returns strictly increasing, in-range, unique indices', () => {
    for (const total of [1, 2, 3, 7, 11, 23, 100]) {
      const picked = sampleChapterIndices(total, 10);
      expect(new Set(picked).size).toBe(picked.length);
      expect(picked).toEqual([...picked].sort((a, b) => a - b));
      expect(picked.every((i) => i >= 0 && i < total)).toBe(true);
    }
  });

  it('handles a single-chapter resource', () => {
    expect(sampleChapterIndices(1, 10)).toEqual([0]);
    expect(sampleChapterIndices(5, 1)).toEqual([0]);
  });

  it('is empty for nothing to sample', () => {
    expect(sampleChapterIndices(0, 10)).toEqual([]);
    expect(sampleChapterIndices(10, 0)).toEqual([]);
  });
});
