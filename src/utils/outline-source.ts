/**
 * Choose which part of a document to hand the outline extractor.
 *
 * **The bug this exists to fix:** outline extraction sent `text.substring(0,
 * 15000)` — the first ~4 pages of a textbook. A student's book with twenty
 * chapters came back with the handful the model could see, which is why "only
 * eight chapters appear". Everything downstream inherits that: the plan can only
 * schedule chapters that exist as `SyllabusNode` rows, and the placement check
 * can only sample from them.
 *
 * Two things make the fix cheap rather than "send the whole book":
 *
 * 1. **A table of contents declares every chapter in a few hundred lines.** It
 *    is near the front, so reading the opening pages IN FULL is the highest-value
 *    spend of the budget.
 * 2. **A chapter title sits at the top of the page it starts on.** So the rest of
 *    the document only needs its *heading zone* — the first couple of hundred
 *    characters of each page — not its body. That turns a 400-page book into
 *    ~100 KB of candidates instead of ~1 MB.
 *
 * Pure and dependency-free so it can be unit-tested without a PDF.
 */

export interface OutlineSourcePage {
  /** 1-based, as `lib/pdf` produces. */
  page: number;
  text: string;
}

/** Characters of prompt to spend. ~15k tokens — well inside every model's window. */
const DEFAULT_BUDGET = 60_000;

/** How much of the budget the opening pages may take before sampling begins. */
const HEAD_SHARE = 0.5;

/** Per-page heading zone: enough for a title and its subtitle, not its body. */
const HEAD_CHARS = 280;

/** Pages that are read in full at the front, budget permitting. */
const MAX_FULL_PAGES = 24;

function label(page: number, body: string): string {
  return `--- page ${page} ---\n${body.trim()}`;
}

/**
 * Build the extractor's input.
 *
 * With no page data (a caller holding only a text blob, or a PDF whose pages all
 * failed to render) this degrades to a plain head slice — the old behaviour, with
 * a budget four times larger.
 */
export function buildOutlineSource(params: {
  text:   string;
  pages?: OutlineSourcePage[];
  budget?: number;
}): string {
  const budget = params.budget ?? DEFAULT_BUDGET;
  const pages = params.pages ?? [];

  if (pages.length === 0) return params.text.slice(0, budget);

  const parts: string[] = [];
  let spent = 0;
  let cursor = 0;

  // ── 1. The front of the book, in full — this is where the contents page is.
  const headBudget = Math.floor(budget * HEAD_SHARE);
  while (cursor < pages.length && cursor < MAX_FULL_PAGES) {
    const page = pages[cursor];
    const block = label(page.page, page.text);
    if (spent + block.length > headBudget) break;
    parts.push(block);
    spent += block.length;
    cursor += 1;
  }

  // A single enormous first page can eat the head budget on its own; take at
  // least one page's heading zone so the sampling pass below has somewhere to
  // start rather than silently producing nothing.
  if (cursor === 0) {
    const first = pages[0];
    parts.push(label(first.page, first.text.slice(0, HEAD_CHARS)));
    spent += HEAD_CHARS;
    cursor = 1;
  }

  // ── 2. Heading zones for the rest, evenly spread.
  const remaining = pages.slice(cursor);
  if (remaining.length > 0) {
    const affordable = Math.max(0, Math.floor((budget - spent) / (HEAD_CHARS + 24)));
    if (affordable > 0) {
      // Sampling is by STRIDE, not by truncation: a book whose heading zones do
      // not all fit must still be covered end to end, or the fix would just move
      // the cliff from chapter 8 to chapter 40.
      const stride = Math.max(1, Math.ceil(remaining.length / affordable));
      for (let i = 0; i < remaining.length; i += stride) {
        const page = remaining[i];
        const zone = page.text.trim().slice(0, HEAD_CHARS);
        if (!zone) continue;
        parts.push(label(page.page, zone));
      }
    }
  }

  return parts.join('\n\n');
}
