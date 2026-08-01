/**
 * Split a chapter's page range into the sittings it will actually be read in.
 *
 * A 40-page chapter is not one evening's work, so the planner splits it across
 * days — and once it does, "verify this chapter" is the wrong check: on the first
 * day it asks about pages the student has not opened yet, and on the last day it
 * asks the same questions for a third time.
 *
 * The model is allowed to say **how many sittings** a chapter takes (`parts`) and
 * **which one this task is** (`part`). It is never allowed to say which pages.
 * Those are computed here from the range the database holds, which is what stops
 * a hallucinated "pp. 340–356" of a 200-page book reaching a student — the same
 * rule `plan-validation` enforces for chapter titles.
 *
 * Pure, so the arithmetic is unit-tested without a plan or a PDF.
 */

/** More sittings than any single chapter plausibly needs. */
export const MAX_PARTS = 8;

export interface PageWindow {
  page_start?: number;
  page_end?: number;
}

/**
 * Window `part` of `parts`, over the inclusive range `[start, end]`.
 *
 * Returns an empty object — not a guess — when the chapter's pages were never
 * located, so the task degrades to chapter-only wording exactly as it does today.
 * The last window always ends on `end`, so integer division can never leave the
 * final pages unassigned.
 */
export function pageWindow(
  start: number | null | undefined,
  end: number | null | undefined,
  part = 1,
  parts = 1,
): PageWindow {
  if (typeof start !== 'number' || !Number.isFinite(start)) return {};

  // A chapter with a start but no end cannot be divided; the whole task simply
  // opens at the start page.
  if (typeof end !== 'number' || !Number.isFinite(end) || end < start) {
    return { page_start: start };
  }

  const total = end - start + 1;
  const safeParts = Math.max(1, Math.min(Math.floor(parts), MAX_PARTS, total));
  const safePart = Math.max(1, Math.min(Math.floor(part), safeParts));

  if (safeParts === 1) return { page_start: start, page_end: end };

  // Ceil so earlier windows carry the remainder and the last one is never the
  // largest — a student left with 18 pages on the final evening before an exam
  // is the failure mode worth avoiding.
  const size = Math.ceil(total / safeParts);
  const windowStart = start + (safePart - 1) * size;
  const windowEnd = safePart === safeParts ? end : Math.min(end, windowStart + size - 1);

  // Ceil division can overshoot for the last window or two (e.g. 10 pages in 4
  // parts is 3+3+3+1, and a 5th would start past the end). Clamp rather than
  // return an inverted range.
  if (windowStart > end) return { page_start: end, page_end: end };

  return { page_start: windowStart, page_end: Math.max(windowStart, windowEnd) };
}

/** "pp. 34–51", "p. 34", or null — the label shared by every surface. */
export function pageLabel(window: PageWindow): string | null {
  if (typeof window.page_start !== 'number') return null;
  if (typeof window.page_end !== 'number' || window.page_end === window.page_start) {
    return `p. ${window.page_start}`;
  }
  return `pp. ${window.page_start}–${window.page_end}`;
}
