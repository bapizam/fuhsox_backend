import { Worker, type Job } from 'bullmq';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { s3Client } from '@lib/s3';
import { env } from '@config/env';
import { aiService } from '@services/ai.service';
import prisma from '@config/database';
import type { PDFJob } from '@typings/jobs';
import logger from '@lib/logger';

async function downloadPDFFromS3(fileUrl: string): Promise<Buffer> {
  const key = fileUrl.replace(
    `https://${env.AWS_S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/`,
    '',
  );

  const command = new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: key });
  const response = await s3Client.send(command);

  if (!response.Body) throw new Error('Empty S3 response body');

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  // Use pdfjs-dist or a subprocess for text extraction
  // For production, use AWS Textract or pdf-parse
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
    const data = await pdfParse(buffer);
    return data.text;
  } catch {
    // Fallback: return empty string, AI will handle empty gracefully
    logger.warn('pdf-parse not available; using empty text fallback');
    return '';
  }
}

export function startPDFWorker() {
  const worker = new Worker<PDFJob>(
    'pdf',
    async (job: Job<PDFJob>) => {
      const { job_id, file_url, institution_id, created_by } = job.data;

      logger.info({ jobId: job.id, pdfJobId: job_id }, 'Processing PDF parse job');

      try {
        // 1. Download PDF from S3
        const pdfBuffer = await downloadPDFFromS3(file_url);

        // 2. Extract text
        const extractedText = await extractTextFromPDF(pdfBuffer);

        if (!extractedText.trim()) {
          throw new Error('No text could be extracted from the PDF');
        }

        // 3. Send extracted text to Claude for question parsing
        const questions = await aiService.parseQuestionsFromText(extractedText, institution_id);

        if (questions.length === 0) {
          throw new Error('No questions could be parsed from the PDF');
        }

        // 4. Save as draft questions in PostgreSQL
        await prisma.question.createMany({
          data: questions.map((q) => ({
            institution_id,
            created_by,
            status:         'draft',
            source:         'pdf_upload',
            ai_job_id:      job_id,
            course_code:    'IMPORTED',
            course_name:    'PDF Import',
            faculty:        'Unknown',
            year:           new Date().getFullYear(),
            topic:          'Imported',
            question_text:  q.question_text,
            question_type:  (q.options?.length ? 'mcq' : 'short_answer'),
            options:        q.options ?? Prisma.JsonNull,
            correct_answer: q.correct_answer,
            explanation:    q.explanation ?? null,
            difficulty:     'medium',
          })),
        });

        // 5. Mark job as complete
        await prisma.pDFParseJob.update({
          where: { id: job_id },
          data: {
            status:          'complete',
            questions_found: questions.length,
            completed_at:    new Date(),
          },
        });

        logger.info({ pdfJobId: job_id, count: questions.length }, 'PDF parse complete');

      } catch (err) {
        logger.error({ err, pdfJobId: job_id }, 'PDF parse failed');

        await prisma.pDFParseJob.update({
          where: { id: job_id },
          data: {
            status:        'failed',
            error_message: err instanceof Error ? err.message : 'Unknown error',
          },
        });

        throw err; // Re-throw so BullMQ marks job as failed
      }
    },
    {
      connection:  { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' },
      concurrency: 2, // PDF + AI parsing is resource-intensive
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'PDF worker job failed');
  });

  return worker;
}
