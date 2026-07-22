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

/**
 * Extract text from a PDF buffer. Returns '' rather than throwing when the PDF
 * has no text layer (a scanned photo of a page is the common case) — callers
 * decide whether that is fatal, since the learning engine can fall back to a
 * manually typed outline while the question parser cannot.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    logger.warn({ err }, 'PDF text extraction failed');
    return '';
  }
}
