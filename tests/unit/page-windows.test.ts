import { pageWindow, pageLabel, MAX_PARTS } from '@utils/page-windows';

describe('pageWindow', () => {
  it('returns the whole chapter when it is read in one sitting', () => {
    expect(pageWindow(40, 66, 1, 1)).toEqual({ page_start: 40, page_end: 66 });
  });

  it('splits a chapter into contiguous windows that cover every page', () => {
    const parts = 3;
    const windows = [1, 2, 3].map((p) => pageWindow(40, 66, p, parts));

    expect(windows[0].page_start).toBe(40);
    expect(windows[2].page_end).toBe(66);

    // No gaps and no overlaps between consecutive windows.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].page_start).toBe((windows[i - 1].page_end ?? 0) + 1);
    }
  });

  it('never leaves the last sitting the biggest one', () => {
    // 27 pages over 4 parts: 7+7+7+6, not 6+6+6+9. A student should not meet
    // the largest chunk on the evening before the exam.
    const sizes = [1, 2, 3, 4].map((p) => {
      const w = pageWindow(40, 66, p, 4);
      return (w.page_end ?? 0) - (w.page_start ?? 0) + 1;
    });
    expect(Math.max(...sizes)).toBe(sizes[0]);
    expect(sizes[3]).toBeLessThanOrEqual(sizes[0]);
  });

  it('gives nothing rather than guessing when the chapter has no pages', () => {
    // A title the extractor reworded keeps null pages; the task degrades to
    // chapter-only wording instead of inventing a range.
    expect(pageWindow(null, null, 1, 2)).toEqual({});
    expect(pageWindow(undefined, 66, 1, 1)).toEqual({});
  });

  it('opens at the start page when the chapter has no end', () => {
    expect(pageWindow(40, null, 2, 3)).toEqual({ page_start: 40 });
  });

  it('cannot ask for more sittings than the chapter has pages', () => {
    // 3 pages cannot be 8 sittings. Each part still lands inside the chapter.
    for (let p = 1; p <= 8; p++) {
      const w = pageWindow(10, 12, p, 8);
      expect(w.page_start).toBeGreaterThanOrEqual(10);
      expect(w.page_end).toBeLessThanOrEqual(12);
      expect(w.page_end).toBeGreaterThanOrEqual(w.page_start as number);
    }
  });

  it('clamps a part beyond its total, and a total beyond the cap', () => {
    expect(pageWindow(40, 66, 9, 3)).toEqual(pageWindow(40, 66, 3, 3));
    expect(pageWindow(1, 400, 1, MAX_PARTS + 5)).toEqual(pageWindow(1, 400, 1, MAX_PARTS));
  });

  it('never returns an inverted range', () => {
    for (let parts = 1; parts <= MAX_PARTS; parts++) {
      for (let part = 1; part <= parts; part++) {
        const w = pageWindow(7, 19, part, parts);
        expect(w.page_end).toBeGreaterThanOrEqual(w.page_start as number);
      }
    }
  });
});

describe('pageLabel', () => {
  it('reads naturally for a range, a single page and nothing', () => {
    expect(pageLabel({ page_start: 34, page_end: 51 })).toBe('pp. 34–51');
    expect(pageLabel({ page_start: 34, page_end: 34 })).toBe('p. 34');
    expect(pageLabel({ page_start: 34 })).toBe('p. 34');
    expect(pageLabel({})).toBeNull();
  });
});
