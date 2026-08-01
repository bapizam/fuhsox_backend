import { buildOutlineSource } from '@utils/outline-source';

/** A page whose top line is a chapter heading and whose body is filler. */
function chapterPage(page: number, heading: string, bodyChars = 1800) {
  return { page, text: `${heading}\n${'body text. '.repeat(Math.ceil(bodyChars / 10))}` };
}

describe('buildOutlineSource', () => {
  it('falls back to a head slice when there is no page data', () => {
    const text = 'x'.repeat(100_000);
    const out = buildOutlineSource({ text, budget: 500 });
    expect(out).toHaveLength(500);
  });

  it('reads the opening pages in full — that is where the contents page is', () => {
    const pages = [
      { page: 1, text: 'Title page' },
      { page: 2, text: 'Contents\nChapter 1 Cells\nChapter 2 Enzymes\nChapter 3 Membranes' },
      ...Array.from({ length: 40 }, (_, i) => chapterPage(i + 3, `Chapter ${i + 1}`)),
    ];

    const out = buildOutlineSource({ text: '', pages, budget: 20_000 });
    expect(out).toContain('Chapter 1 Cells');
    expect(out).toContain('Chapter 3 Membranes');
  });

  it('reaches the LAST chapter of a long book — the bug was stopping early', () => {
    // 300 pages, a chapter heading every tenth page. The old 15k-char head slice
    // saw about four of these; every later chapter simply never existed.
    const pages = Array.from({ length: 300 }, (_, i) =>
      chapterPage(i + 1, i % 10 === 0 ? `Chapter ${i / 10 + 1} Heading` : 'continued'),
    );

    const out = buildOutlineSource({ text: '', pages });

    expect(out).toContain('Chapter 1 Heading');
    expect(out).toContain('Chapter 30 Heading');
  });

  it('stays inside its budget', () => {
    const pages = Array.from({ length: 500 }, (_, i) => chapterPage(i + 1, `Chapter ${i}`, 4000));
    const budget = 30_000;
    const out = buildOutlineSource({ text: '', pages, budget });
    // Page labels add a little per block; allow a small overhead, not a multiple.
    expect(out.length).toBeLessThan(budget * 1.2);
  });

  it('samples by stride rather than truncating, so coverage stays end to end', () => {
    const pages = Array.from({ length: 200 }, (_, i) => ({
      page: i + 1,
      text: `marker-${i + 1} and then some body text that is not a heading.`,
    }));

    // A budget that cannot afford 200 heading zones must still reach page 200.
    const out = buildOutlineSource({ text: '', pages, budget: 8_000 });
    expect(out).toContain('marker-1');
    expect(out).toMatch(/marker-19[0-9]|marker-200/);
  });

  it('survives a single page that would eat the whole head budget', () => {
    const pages = [
      { page: 1, text: 'Chapter Zero\n' + 'x'.repeat(200_000) },
      { page: 2, text: 'Chapter One\nbody' },
    ];
    const out = buildOutlineSource({ text: '', pages, budget: 5_000 });
    expect(out).toContain('Chapter Zero');
    expect(out).toContain('Chapter One');
  });
});
