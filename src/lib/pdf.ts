import { GetObjectCommand } from '@aws-sdk/client-s3';
import pdfParse from 'pdf-parse';
import { s3Client, extractKeyFromUrl, STORAGE_BUCKET } from '@lib/s3';
import logger from '@lib/logger';

/**
 * PDF fetch + text extraction, shared by the admin question-parsing worker and
 * the adaptive learning engine's syllabus extraction. Both previously needed
 * this; only the worker had it, as private functions with the storage URL shape
 * inlined.
 */

/** Download an object stored by `lib/s3` back into memory. */
export async function downloadFromStorage(fileUrl: string): Promise<Buffer> {
  const key = extractKeyFromUrl(fileUrl);
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: STORAGE_BUCKET, Key: key }),
  );

  if (!response.Body) throw new Error('Empty storage response body');

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export interface PdfPage {
  /** 1-based, matching what a student sees in a PDF reader. */
  page: number;
  text: string;
}

export interface ExtractedPdf {
  /** Every page joined, byte-for-byte what `pdf-parse` returns on its own. */
  text: string;
  pages: PdfPage[];
  pageCount: number;
}

/** The subset of pdf.js's page object that `pagerender` receives. */
interface PdfTextItem {
  str: string;
  transform: number[];
}
interface PdfPageData {
  getTextContent(options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items: PdfTextItem[] }>;
}

/**
 * `pdf-parse`'s own default page renderer, reimplemented.
 *
 * It is not exported by the package, and we have to supply a `pagerender` to see
 * page boundaries at all — so this mirrors the original exactly (including the
 * `!lastY` guard, which also treats y=0 as "same line") to keep the extracted
 * text identical to what syllabus extraction has always been parsing.
 */
async function renderPage(pageData: PdfPageData): Promise<string> {
  const content = await pageData.getTextContent({
    normalizeWhitespace:     false,
    disableCombineTextItems: false,
  });

  let lastY: number | undefined;
  let text = '';
  for (const item of content.items) {
    const y = item.transform[5];
    text += lastY === y || !lastY ? item.str : `\n${item.str}`;
    lastY = y;
  }
  return text;
}

/**
 * Extract text from a PDF buffer, **per page**.
 *
 * Page numbers are what make a reading plan able to say "pp. 34–51" instead of
 * "Chapter 3", and they are what `ResourceChunk.page` (and in turn
 * `AIQuestion.source_page`) have always declared but never carried — the old
 * implementation returned `data.text`, one flat string with the boundaries
 * already thrown away.
 *
 * Returns empty rather than throwing when the PDF has no text layer (a scanned
 * photo of a page is the common case) — callers decide whether that is fatal,
 * since the learning engine can fall back to a manually typed outline while the
 * question parser cannot.
 */
export async function extractPdfText(buffer: Buffer): Promise<ExtractedPdf> {
  const pages: PdfPage[] = [];

  try {
    const data = await pdfParse(buffer, {
      // Called once per page, in order. `pdf-parse` swallows a throwing renderer
      // and substitutes '' for that page, which would leave no entry here and
      // silently shift every later page number — so failures push a blank page
      // instead, keeping `pages[i].page` aligned with the real document.
      pagerender: async (pageData) => {
        const pageNumber = pages.length + 1;
        try {
          const text = await renderPage(pageData as PdfPageData);
          pages.push({ page: pageNumber, text });
          return text;
        } catch (err) {
          logger.warn({ err, page: pageNumber }, 'PDF page render failed');
          pages.push({ page: pageNumber, text: '' });
          return '';
        }
      },
    });

    return { text: data.text, pages, pageCount: data.numpages };
  } catch (err) {
    logger.warn({ err }, 'PDF text extraction failed');
    return { text: '', pages: [], pageCount: 0 };
  }
}
