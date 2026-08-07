import { acceptPrerequisites, chapterRank } from '@utils/chapter-order';

const BOOK = ['c1', 'c2', 'c3', 'c4', 'c5'];

/** The chapters in the order the rank says to read them. */
const ordering = (rank: Map<string, number>) =>
  [...rank.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);

const edge = (from: string, to: string, strength = 0.8) => ({ from, to, strength });

describe('chapterRank', () => {
  it('is the book’s own order when nothing is known', () => {
    // The degrade path: a book whose derivation failed, or was never paid for,
    // must behave exactly as it did before the graph existed.
    expect(ordering(chapterRank(BOOK))).toEqual(BOOK);
    expect(ordering(chapterRank(BOOK, []))).toEqual(BOOK);
  });

  it('pulls a prerequisite forward to just before what needs it', () => {
    // The case ordinal alone cannot see: foundations printed late.
    expect(ordering(chapterRank(BOOK, [edge('c4', 'c2')]))).toEqual([
      'c1', 'c4', 'c2', 'c3', 'c5',
    ]);
  });

  it('does not scatter the rest of the book to satisfy one dependency', () => {
    // Kahn's algorithm would place every UNBLOCKED chapter first, so a review
    // chapter printed at the back and needed by three early ones would push all
    // three behind everything else. Going and fetching it, then carrying on, is
    // what a person would do.
    expect(
      ordering(chapterRank(BOOK, [edge('c5', 'c2'), edge('c5', 'c3'), edge('c5', 'c4')])),
    ).toEqual(['c1', 'c5', 'c2', 'c3', 'c4']);
  });

  it('leaves chapters the graph says nothing about exactly where they were', () => {
    expect(ordering(chapterRank(BOOK, [edge('c3', 'c1')]))).toEqual([
      'c3', 'c1', 'c2', 'c4', 'c5',
    ]);
  });

  it('follows a chain of prerequisites all the way down', () => {
    expect(ordering(chapterRank(BOOK, [edge('c3', 'c1'), edge('c5', 'c3')]))).toEqual([
      'c5', 'c3', 'c1', 'c2', 'c4',
    ]);
  });

  it('is stable regardless of the order the edges arrive in', () => {
    const a = ordering(chapterRank(BOOK, [edge('c4', 'c1'), edge('c5', 'c1')]));
    const b = ordering(chapterRank(BOOK, [edge('c5', 'c1'), edge('c4', 'c1')]));
    expect(a).toEqual(b);
  });

  it('ignores edges naming a chapter that is not in the book', () => {
    expect(ordering(chapterRank(BOOK, [edge('ghost', 'c2'), edge('c2', 'ghost')]))).toEqual(BOOK);
  });

  it('still places every chapter when a cycle gets in', () => {
    // acceptPrerequisites should make this impossible; the guard is here because
    // this map decides what a student reads and must never lose a chapter.
    const rank = chapterRank(BOOK, [edge('c1', 'c2'), edge('c2', 'c1')]);
    expect(ordering(rank).sort()).toEqual([...BOOK].sort());
    expect(rank.size).toBe(BOOK.length);
  });

  it('handles a book with one chapter, and with none', () => {
    expect(ordering(chapterRank(['only']))).toEqual(['only']);
    expect(ordering(chapterRank([]))).toEqual([]);
  });
});

describe('acceptPrerequisites', () => {
  it('keeps well-formed edges in the order proposed', () => {
    const kept = acceptPrerequisites([edge('c1', 'c2'), edge('c2', 'c3')], BOOK);
    expect(kept.map((e) => `${e.from}->${e.to}`)).toEqual(['c1->c2', 'c2->c3']);
  });

  it('drops edges naming a chapter outside the book', () => {
    // The same allow-list rule the plan validator enforces: a model cannot
    // invent a chapter, nor point at one belonging to another resource.
    expect(acceptPrerequisites([edge('c1', 'nope'), edge('nope', 'c1')], BOOK)).toEqual([]);
  });

  it('drops self-edges', () => {
    expect(acceptPrerequisites([edge('c1', 'c1')], BOOK)).toEqual([]);
  });

  it('drops exact duplicates', () => {
    expect(acceptPrerequisites([edge('c1', 'c2'), edge('c1', 'c2')], BOOK)).toHaveLength(1);
  });

  it('refuses the edge that would close a cycle, and keeps the one before it', () => {
    // Two chapters that genuinely reinforce each other is the ordinary way a
    // model produces a cycle. The first claim wins; the reverse is dropped.
    const kept = acceptPrerequisites([edge('c1', 'c2'), edge('c2', 'c1')], BOOK);
    expect(kept.map((e) => `${e.from}->${e.to}`)).toEqual(['c1->c2']);
  });

  it('refuses a cycle closed indirectly', () => {
    const kept = acceptPrerequisites(
      [edge('c1', 'c2'), edge('c2', 'c3'), edge('c3', 'c1')],
      BOOK,
    );
    expect(kept.map((e) => `${e.from}->${e.to}`)).toEqual(['c1->c2', 'c2->c3']);
  });

  it('caps a response that lists every pair it can think of', () => {
    // A dense graph is not structure — it constrains the order so tightly the
    // plan stops being schedulable.
    const everyPair = BOOK.flatMap((from) => BOOK.map((to) => edge(from, to)));
    expect(acceptPrerequisites(everyPair, BOOK).length).toBeLessThanOrEqual(BOOK.length * 3);
  });

  it('clamps a nonsense strength rather than dropping the edge', () => {
    const kept = acceptPrerequisites(
      [
        { from: 'c1', to: 'c2', strength: 9 },
        { from: 'c2', to: 'c3', strength: -1 },
        { from: 'c3', to: 'c4' },
      ],
      BOOK,
    );
    expect(kept.map((e) => e.strength)).toEqual([1, 0, 0.5]);
  });

  it('accepts nothing from an empty proposal or an empty book', () => {
    expect(acceptPrerequisites([], BOOK)).toEqual([]);
    expect(acceptPrerequisites([edge('c1', 'c2')], [])).toEqual([]);
  });
});
