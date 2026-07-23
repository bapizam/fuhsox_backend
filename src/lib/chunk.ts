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

/** Trailing `maxChars` of `text`, cut back to a word boundary so overlap reads cleanly. */
function tailOverlap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tail = text.slice(text.length - maxChars);
  const firstSpace = tail.indexOf(' ');
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const targetChars = (options.targetTokens ?? 600) * CHARS_PER_TOKEN;
  const overlapChars = (options.overlapTokens ?? 80) * CHARS_PER_TOKEN;
  const minChars = options.minChars ?? 40;

  // Normalise whitespace and split into paragraphs (blank-line separated); fall
  // back to single-newline splits when the source has no blank lines.
  const normalised = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!normalised) return [];

  const paragraphs = (normalised.includes('\n\n')
    ? normalised.split(/\n{2,}/)
    : normalised.split(/\n+/)
  )
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: TextChunk[] = [];
  let buffer = '';

  const flush = () => {
    const body = buffer.trim();
    if (body.length >= minChars) chunks.push({ text: body, ordinal: chunks.length });
    buffer = '';
  };

  for (const para of paragraphs) {
    // A single paragraph larger than the budget is hard-split by sentence.
    if (para.length > targetChars) {
      flush();
      const sentences = para.match(/[^.!?]+[.!?]+|\S+$/g) ?? [para];
      let sentenceBuf = '';
      for (const sentence of sentences) {
        if (sentenceBuf.length + sentence.length > targetChars && sentenceBuf) {
          chunks.push({ text: sentenceBuf.trim(), ordinal: chunks.length });
          sentenceBuf = `${tailOverlap(sentenceBuf, overlapChars)} `;
        }
        sentenceBuf += sentence;
      }
      if (sentenceBuf.trim().length >= minChars) {
        chunks.push({ text: sentenceBuf.trim(), ordinal: chunks.length });
      }
      continue;
    }

    if (buffer.length + para.length > targetChars && buffer) {
      const carry = tailOverlap(buffer, overlapChars);
      flush();
      buffer = carry ? `${carry} ${para}` : para;
    } else {
      buffer = buffer ? `${buffer}\n${para}` : para;
    }
  }
  flush();

  // If the whole document is shorter than `minChars`, the noise filter would drop
  // everything — keep it as a single chunk rather than losing real (if brief)
  // content. Only genuine noise BETWEEN larger chunks gets dropped.
  if (chunks.length === 0) return [{ text: normalised, ordinal: 0 }];

  // Re-number in case the sentence-split path pushed out of sequence.
  return chunks.map((c, i) => ({ text: c.text, ordinal: i }));
}
