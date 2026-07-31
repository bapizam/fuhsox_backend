/**
 * Split extracted document text into overlapping chunks for embedding + retrieval
 * (adaptive engine reformation, Phase 1). Pure — no I/O, no AI — so it is
 * unit-tested directly.
 *
 * Strategy: pack whole paragraphs up to a soft size budget, and carry a small tail
 * overlap into the next chunk so a concept split across a boundary is still
 * retrievable from at least one chunk. Paragraph-first (rather than fixed windows)
 * keeps chunks semantically coherent, which matters more for grounding quality than
 * exact size.
 *
 * Size is measured in CHARACTERS with a ~4-chars-per-token rule of thumb, since we
 * have no tokenizer here and the budget only needs to be approximate.
 */

const CHARS_PER_TOKEN = 4;

export interface ChunkOptions {
  /** Soft upper bound per chunk. */
  targetTokens?: number;
  /** Tail of the previous chunk repeated at the head of the next. */
  overlapTokens?: number;
  /** Chunks shorter than this (in chars) are dropped as noise (page numbers etc.). */
  minChars?: number;
}

export interface TextChunk {
  text: string;
  ordinal: number;
}

export interface PageText {
  /** 1-based. */
  page: number;
  text: string;
}

export interface PagedChunk extends TextChunk {
  /** The page this chunk starts on. */
  page: number;
}

/** Trailing `maxChars` of `text`, cut back to a word boundary so overlap reads cleanly. */
function tailOverlap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = text.slice(text.length - maxChars);
  const firstSpace = tail.indexOf(' ');
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

/** A paragraph plus the page it came from. */
interface AnnotatedParagraph {
  text: string;
  page: number;
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Paragraphs of one normalised block — blank-line separated, falling back to
 * single-newline splits when the source has no blank lines.
 */
function splitParagraphs(normalised: string): string[] {
  return (normalised.includes('\n\n') ? normalised.split(/\n{2,}/) : normalised.split(/\n+/))
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Pack paragraphs up to the size budget, carrying a tail overlap across chunk
 * boundaries. Shared by `chunkText` and `chunkPages` so page-aware chunking
 * cannot drift from the plain kind.
 *
 * Each chunk is attributed to the page of the paragraph whose content *starts*
 * it. Where a chunk opens with an overlap tail carried from the previous page,
 * the new paragraph's page still wins — the overlap is a repeat, and the page a
 * reader should turn to is where the fresh material begins.
 */
function packParagraphs(
  paragraphs: AnnotatedParagraph[],
  targetChars: number,
  overlapChars: number,
  minChars: number,
): PagedChunk[] {
  const chunks: PagedChunk[] = [];
  let buffer = '';
  let bufferPage = paragraphs[0]?.page ?? 1;

  const push = (text: string, page: number) => chunks.push({ text, ordinal: chunks.length, page });

  const flush = () => {
    const body = buffer.trim();
    if (body.length >= minChars) push(body, bufferPage);
    buffer = '';
  };

  for (const para of paragraphs) {
    // A single paragraph larger than the budget is hard-split by sentence.
    if (para.text.length > targetChars) {
      flush();
      const sentences = para.text.match(/[^.!?]+[.!?]+|\S+$/g) ?? [para.text];
      let sentenceBuf = '';
      for (const sentence of sentences) {
        if (sentenceBuf.length + sentence.length > targetChars && sentenceBuf) {
          push(sentenceBuf.trim(), para.page);
          sentenceBuf = `${tailOverlap(sentenceBuf, overlapChars)} `;
        }
        sentenceBuf += sentence;
      }
      if (sentenceBuf.trim().length >= minChars) push(sentenceBuf.trim(), para.page);
      bufferPage = para.page;
      continue;
    }

    if (buffer.length + para.text.length > targetChars && buffer) {
      const carry = tailOverlap(buffer, overlapChars);
      flush();
      buffer = carry ? `${carry} ${para.text}` : para.text;
      bufferPage = para.page;
    } else {
      if (!buffer) bufferPage = para.page;
      buffer = buffer ? `${buffer}\n${para.text}` : para.text;
    }
  }
  flush();

  // Re-number in case the sentence-split path pushed out of sequence.
  return chunks.map((c, i) => ({ ...c, ordinal: i }));
}

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const normalised = normalise(text);
  if (!normalised) return [];

  const paragraphs = splitParagraphs(normalised).map((p) => ({ text: p, page: 1 }));
  const chunks = packParagraphs(
    paragraphs,
    (options.targetTokens ?? 600) * CHARS_PER_TOKEN,
    (options.overlapTokens ?? 80) * CHARS_PER_TOKEN,
    options.minChars ?? 40,
  );

  // If the whole document is shorter than `minChars`, the noise filter would drop
  // everything — keep it as a single chunk rather than losing real (if brief)
  // content. Only genuine noise BETWEEN larger chunks gets dropped.
  if (chunks.length === 0) return [{ text: normalised, ordinal: 0 }];

  return chunks.map(({ text: body, ordinal }) => ({ text: body, ordinal }));
}

/**
 * Chunk a document that still knows its page boundaries.
 *
 * Paragraphs are packed ACROSS pages exactly as `chunkText` packs them, so
 * retrieval quality is unchanged — the only addition is that every chunk records
 * the page it starts on. That page is what lets a plan task say "read pp. 34–51"
 * and what `ResourceChunk.page` has always been declared to hold.
 */
export function chunkPages(pages: PageText[], options: ChunkOptions = {}): PagedChunk[] {
  const normalisedPages = pages
    .map((p) => ({ page: p.page, text: normalise(p.text) }))
    .filter((p) => p.text.length > 0);
  if (normalisedPages.length === 0) return [];

  const paragraphs: AnnotatedParagraph[] = [];
  for (const page of normalisedPages) {
    for (const para of splitParagraphs(page.text)) {
      paragraphs.push({ text: para, page: page.page });
    }
  }

  const chunks = packParagraphs(
    paragraphs,
    (options.targetTokens ?? 600) * CHARS_PER_TOKEN,
    (options.overlapTokens ?? 80) * CHARS_PER_TOKEN,
    options.minChars ?? 40,
  );

  // Same noise-filter rescue as `chunkText`: a document too short to survive the
  // minimum is kept whole rather than dropped.
  if (chunks.length === 0) {
    const first = normalisedPages[0];
    return [
      { text: normalisedPages.map((p) => p.text).join('\n\n'), ordinal: 0, page: first?.page ?? 1 },
    ];
  }

  return chunks;
}
