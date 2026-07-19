import { Prisma } from '@prisma/client';
import prisma from '@config/database';
import { pdfQueue } from '@jobs/queues';
import { uploadPDF } from '@lib/s3';
import { AppError } from '@typings/models';
import logger from '@lib/logger';

// ─── PDF Upload → Queue ────────────────────────────────────────────────────────

export async function uploadQuestionPDF(
  buffer:        Buffer,
  filename:      string,
  institutionId: string,
  uploadedBy:    string,
) {
  // Upload PDF to S3
  const { url: fileUrl } = await uploadPDF(institutionId, buffer, filename);

  // Create a parse job record in PostgreSQL
  const jobRecord = await prisma.pDFParseJob.create({
    data: {
      institution_id: institutionId,
      created_by:     uploadedBy,
      file_url:       fileUrl,
      status:         'processing',
    },
  });

  // Enqueue BullMQ job
  await pdfQueue.add('parse', {
    job_id:         jobRecord.id,
    file_url:       fileUrl,
    institution_id: institutionId,
    created_by:     uploadedBy,
  });

  logger.info({ jobId: jobRecord.id, filename, institutionId }, 'PDF question parse job queued');

  return { job_id: jobRecord.id, file_url: fileUrl, status: 'processing' };
}

// ─── CSV Import ────────────────────────────────────────────────────────────────

export interface CSVQuestionRow {
  course_code:    string;
  course_name:    string;
  faculty:        string;
  department?:    string;
  year:           string;
  topic:          string;
  question_text:  string;
  question_type:  string;
  option_a?:      string;
  option_b?:      string;
  option_c?:      string;
  option_d?:      string;
  correct_answer: string;
  explanation?:   string;
  difficulty:     string;
}

export async function importQuestionsFromCSV(
  rows:          CSVQuestionRow[],
  institutionId: string,
  createdBy:     string,
): Promise<{ created: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let created  = 0;
  let skipped  = 0;
  const toCreate = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-indexed + header

    // Validate required fields
    if (!row.course_code?.trim()) { errors.push(`Row ${rowNum}: course_code is required`); skipped++; continue; }
    if (!row.question_text?.trim()) { errors.push(`Row ${rowNum}: question_text is required`); skipped++; continue; }
    if (!row.correct_answer?.trim()) { errors.push(`Row ${rowNum}: correct_answer is required`); skipped++; continue; }

    const year = parseInt(row.year, 10);
    if (isNaN(year) || year < 1970 || year > new Date().getFullYear() + 1) {
      errors.push(`Row ${rowNum}: invalid year '${row.year}'`);
      skipped++;
      continue;
    }

    const validTypes = ['mcq', 'short_answer', 'essay'];
    const questionType = (row.question_type ?? 'mcq').toLowerCase();
    if (!validTypes.includes(questionType)) {
      errors.push(`Row ${rowNum}: invalid question_type '${row.question_type}'`);
      skipped++;
      continue;
    }

    const validDifficulties = ['easy', 'medium', 'hard'];
    const difficulty = (row.difficulty ?? 'medium').toLowerCase();
    if (!validDifficulties.includes(difficulty)) {
      errors.push(`Row ${rowNum}: invalid difficulty '${row.difficulty}'`);
      skipped++;
      continue;
    }

    // Build options for MCQ
    let options: { key: string; text: string }[] | null = null;
    if (questionType === 'mcq') {
      const opts = [
        row.option_a ? { key: 'A', text: row.option_a.trim() } : null,
        row.option_b ? { key: 'B', text: row.option_b.trim() } : null,
        row.option_c ? { key: 'C', text: row.option_c.trim() } : null,
        row.option_d ? { key: 'D', text: row.option_d.trim() } : null,
      ].filter((o): o is { key: string; text: string } => o !== null);

      if (opts.length !== 4) {
        errors.push(`Row ${rowNum}: MCQ must have 4 options (A, B, C, D)`);
        skipped++;
        continue;
      }
      options = opts;
    }

    // Empty strings deliberately become null (`??` would keep the '')
    const department  = row.department?.trim() ?? '';
    const explanation = row.explanation?.trim() ?? '';

    toCreate.push({
      institution_id: institutionId,
      created_by:     createdBy,
      source:         'csv_upload' as const,
      status:         'draft' as const,
      course_code:    row.course_code.trim().toUpperCase(),
      course_name:    row.course_name?.trim() ?? '',
      faculty:        row.faculty?.trim() ?? '',
      department:     department === '' ? null : department,
      year,
      topic:          row.topic?.trim() ?? '',
      question_text:  row.question_text.trim(),
      question_type:  questionType as 'mcq' | 'short_answer' | 'essay',
      options:        options ?? Prisma.JsonNull,
      correct_answer: row.correct_answer.trim().toUpperCase(),
      explanation:    explanation === '' ? null : explanation,
      difficulty:     difficulty as 'easy' | 'medium' | 'hard',
    });
  }

  if (toCreate.length > 0) {
    const result = await prisma.question.createMany({ data: toCreate });
    created = result.count;
  }

  logger.info({ institutionId, created, skipped, errors: errors.length }, 'CSV question import complete');

  return { created, skipped, errors };
}

// ─── Get PDF Parse Job Status ─────────────────────────────────────────────────

export async function getPDFJobStatus(jobId: string, institutionId: string) {
  const job = await prisma.pDFParseJob.findFirst({
    where: { id: jobId, institution_id: institutionId },
  });

  if (!job) throw new AppError(404, 'NOT_FOUND', 'Parse job not found');

  return job;
}

// ─── List PDF Parse Jobs ──────────────────────────────────────────────────────

export async function listPDFJobs(institutionId: string, page: number = 1, limit: number = 20) {
  const skip = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    prisma.pDFParseJob.findMany({
      where:   { institution_id: institutionId },
      orderBy: { created_at: 'desc' },
      skip,
      take:    limit,
    }),
    prisma.pDFParseJob.count({ where: { institution_id: institutionId } }),
  ]);

  return {
    jobs,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit), hasMore: page * limit < total },
  };
}

// ─── Admin Update Question ─────────────────────────────────────────────────────

export async function updateQuestion(
  questionId:    string,
  institutionId: string,
  data: Partial<{
    course_code:    string;
    course_name:    string;
    faculty:        string;
    department:     string;
    year:           number;
    topic:          string;
    question_text:  string;
    question_type:  'mcq' | 'short_answer' | 'essay';
    options:        { key: string; text: string }[] | null;
    correct_answer: string;
    explanation:    string;
    difficulty:     'easy' | 'medium' | 'hard';
    status:         'draft' | 'review' | 'published' | 'archived';
  }>,
) {
  const question = await prisma.question.findFirst({
    where: { id: questionId, institution_id: institutionId },
  });

  if (!question) throw new AppError(404, 'NOT_FOUND', 'Question not found');

  // Prisma's JSON columns take Prisma.JsonNull rather than a raw null.
  const { options, ...rest } = data;
  return prisma.question.update({
    where: { id: questionId },
    data: {
      ...rest,
      ...(options !== undefined && { options: options ?? Prisma.JsonNull }),
    },
  });
}

// ─── Bulk Status Update ────────────────────────────────────────────────────────

export async function bulkUpdateStatus(
  questionIds:   string[],
  institutionId: string,
  status:        'draft' | 'review' | 'published' | 'archived',
) {
  // Verify all questions belong to this institution
  const count = await prisma.question.count({
    where: { id: { in: questionIds }, institution_id: institutionId },
  });

  if (count !== questionIds.length) {
    throw new AppError(403, 'FORBIDDEN', 'Some questions do not belong to your institution');
  }

  const result = await prisma.question.updateMany({
    where: { id: { in: questionIds } },
    data:  { status },
  });

  return { updated: result.count };
}

export const questionAdminService = {
  uploadQuestionPDF,
  importQuestionsFromCSV,
  getPDFJobStatus,
  listPDFJobs,
  updateQuestion,
  bulkUpdateStatus,
};
