import { chunkPages } from '@lib/chunk';
import { headingKey, locateChapterPages } from '@utils/page-ranges';

describe('headingKey', () => {
  it('collapses case, punctuation and spacing', () => {
    expect(headingKey('Chapter 3 — Enzyme Kinetics!')).toBe('chapter 3 enzyme kinetics');
    expect(headingKey('  THE   CARDIAC  cycle ')).toBe('the cardiac cycle');
  });

  it('is empty for a title with nothing comparable in it', () => {
    expect(headingKey('—— ***')).toBe('');
  });
});

describe('locateChapterPages', () => {
  const pages = [
    { page: 1, text: 'Title page' },
    { page: 2, text: 'Contents\nChapter One Basics\nChapter Two Kinetics\nChapter Three Endgame' },
    { page: 3, text: 'Chapter One Basics\nSome opening material.' },
    { page: 4, text: 'More basics continue here.' },
    { page: 5, text: 'Chapter Two Kinetics\nRate laws.' },
    { page: 6, text: 'Still kinetics.' },
    { page: 7, text: 'Chapter Three Endgame\nFinal remarks.' },
  ];
  const chapters = [
    { id: 'c1', title: 'Chapter One Basics', ordinal: 0 },
    { id: 'c2', title: 'Chapter Two Kinetics', ordinal: 1 },
    { id: 'c3', title: 'Chapter Three Endgame', ordinal: 2 },
  ];

  it('skips the table of contents and finds the real chapter openings', () => {
    const ranges = locateChapterPages(chapters, pages, 8);
    // Every chapter is listed on page 2; only the first may legitimately match
    // there, and the forward-only cursor is what stops the rest collapsing onto it.
    expect(ranges.get('c2')).toEqual({ page_start: 5, page_end: 6 });
    expect(ranges.get('c3')).toEqual({ page_start: 7, page_end: 8 });
  });

  it('runs the last chapter to the end of the document', () => {
    expect(locateChapterPages(chapters, pages, 12).get('c3')?.page_end).toBe(12);
  });

  it('falls back to the highest page number when no page count is given', () => {
    expect(locateChapterPages(chapters, pages, 0).get('c3')?.page_end).toBe(7);
  });

  it('omits chapters whose title never appears rather than guessing', () => {
    const withGhost = [...chapters, { id: 'c4', title: 'Chapter Four Ghost', ordinal: 3 }];
    const ranges = locateChapterPages(withGhost, pages, 8);
    expect(ranges.has('c4')).toBe(false);
    // The located chapters are unaffected by the missing one.
    expect(ranges.get('c3')).toEqual({ page_start: 7, page_end: 8 });
  });

  it('spans a missing chapter instead of leaving a hole in the ranges', () => {
    const ranges = locateChapterPages(
      [
        { id: 'c1', title: 'Chapter One Basics', ordinal: 0 },
        { id: 'ghost', title: 'Nowhere To Be Found', ordinal: 1 },
        { id: 'c3', title: 'Chapter Three Endgame', ordinal: 2 },
      ],
      pages,
      8,
    );
    expect(ranges.get('c1')?.page_end).toBe(6);
  });

  it('never inverts a range when two chapters open on the same page', () => {
    const sharedPage = [
      { page: 1, text: 'Chapter One Basics\nbrief\nChapter Two Kinetics\nalso brief' },
    ];
    const ranges = locateChapterPages(chapters.slice(0, 2), sharedPage, 1);
    const first = ranges.get('c1');
    expect(first).toBeDefined();
    expect(first!.page_end).toBeGreaterThanOrEqual(first!.page_start);
  });

  it('returns nothing for empty input', () => {
    expect(locateChapterPages([], pages, 8).size).toBe(0);
    expect(locateChapterPages(chapters, [], 8).size).toBe(0);
  });
});

describe('chunkPages', () => {
  it('tags each chunk with the page its content starts on', () => {
    const chunks = chunkPages(
      [
        { page: 4, text: 'The cardiac cycle describes one complete heartbeat sequence.' },
        { page: 5, text: 'Preload is the stretch on the ventricle before contraction.' },
      ],
      { targetTokens: 12 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.page).toBe(4);
    expect(chunks[chunks.length - 1]?.page).toBe(5);
  });

  it('packs across a page break rather than cutting at it', () => {
    // Both pages fit inside one budget, so they belong in a single chunk — page
    // boundaries must not force a split or retrieval quality drops.
    const chunks = chunkPages([
      { page: 2, text: 'Enzymes lower activation energy.' },
      { page: 3, text: 'They are not consumed by the reaction they catalyse.' },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.page).toBe(2);
    expect(chunks[0]?.text).toContain('activation energy');
    expect(chunks[0]?.text).toContain('not consumed');
  });

  it('numbers chunks sequentially from zero', () => {
    const long = Array.from({ length: 6 }, (_, i) => ({
      page: i + 1,
      text: `Page ${i + 1}. ${'Sustained prose about metabolism and its regulation. '.repeat(8)}`,
    }));
    const chunks = chunkPages(long, { targetTokens: 40 });
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('ignores blank pages without shifting the pages that follow', () => {
    const chunks = chunkPages([
      { page: 1, text: '   ' },
      { page: 2, text: '' },
      { page: 3, text: 'Glycolysis converts glucose into pyruvate over ten steps.' },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.page).toBe(3);
  });

  it('returns nothing when every page is empty', () => {
    expect(chunkPages([{ page: 1, text: '  ' }])).toEqual([]);
    expect(chunkPages([])).toEqual([]);
  });

  it('keeps a document too short for the noise filter rather than dropping it', () => {
    const chunks = chunkPages([{ page: 9, text: 'Brief.' }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.page).toBe(9);
    expect(chunks[0]?.text).toBe('Brief.');
  });
});
