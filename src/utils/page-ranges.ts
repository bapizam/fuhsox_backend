/**
 * Locate a resource's chapters within its pages, so a study plan can say
 * "read pp. 34–51" instead of "read Chapter 3".
 *
 * Pure — no I/O, no AI — so it is unit-tested directly. This deliberately costs
 * nothing: `SyllabusNode.page_start`/`page_end` have existed since the adaptive
 * engine landed and were never populated, and a second AI pass to guess page
 * numbers would be both expensive and less reliable than finding the heading in
 * the text we already extracted.
 */

export interface PageOfText {
  /** 1-based. */
  page: number;
  text: string;
}

export interface ChapterHeading {
  id: string;
  title: string;
  ordinal: number;
}

export interface PageRange {
  page_start: number;
  page_end: number;
}

/** Comparable form of a heading: case, punctuation and spacing all collapsed. */
export function headingKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Map each chapter to the page range it covers.
 *
 * Two rules do the work. Each chapter is matched scanning FORWARD from the
 * previous one, and among the candidate pages it prefers one where **it is the
 * only chapter named** — because a table of contents names them all, comes
 * before all of them, and would otherwise capture the entire book onto page 2.
 * Where no exclusive page exists (two short chapters genuinely sharing a page)
 * it falls back to the first match.
 *
 * A chapter's range ends one page before the next chapter that was actually
 * found, and the final chapter runs to `pageCount`.
 *
 * Chapters whose title cannot be located are simply absent from the result: a
 * missing range makes the plan fall back to chapter-only wording, which is far
 * better than citing a page that is wrong.
 */
export function locateChapterPages(
  chapters: ChapterHeading[],
  pages: PageOfText[],
  pageCount: number,
): Map<string, PageRange> {
  const ranges = new Map<string, PageRange>();
  if (chapters.length === 0 || pages.length === 0) return ranges;

  const ordered = [...chapters].sort((a, b) => a.ordinal - b.ordinal);
  const keyed = pages.map((p) => ({ page: p.page, key: headingKey(p.text) }));

  const titleKeys = ordered.map((c) => headingKey(c.title)).filter(Boolean);
  const titlesOnPage = keyed.map((p) => titleKeys.filter((k) => p.key.includes(k)).length);

  const starts = new Map<string, number>();
  let cursor = 0;
  for (const chapter of ordered) {
    const key = headingKey(chapter.title);
    if (!key) continue;

    const candidate = (page: { key: string }, i: number) => i >= cursor && page.key.includes(key);
    let hit = keyed.findIndex((p, i) => candidate(p, i) && titlesOnPage[i] === 1);
    if (hit === -1) hit = keyed.findIndex(candidate);
    if (hit === -1) continue;

    starts.set(chapter.id, keyed[hit].page);
    cursor = hit;
  }
  if (starts.size === 0) return ranges;

  const lastPage = pageCount > 0 ? pageCount : (pages[pages.length - 1]?.page ?? 0);

  ordered.forEach((chapter, i) => {
    const start = starts.get(chapter.id);
    if (start === undefined) return;

    let end = lastPage;
    for (let j = i + 1; j < ordered.length; j += 1) {
      const nextStart = starts.get(ordered[j].id);
      if (nextStart !== undefined) {
        // Never let a range invert when two chapters open on the same page.
        end = Math.max(start, nextStart - 1);
        break;
      }
    }

    ranges.set(chapter.id, { page_start: start, page_end: end });
  });

  return ranges;
}
