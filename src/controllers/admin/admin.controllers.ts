import type { Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { parse as csvParse } from 'csv-parse/sync';
import prisma from '@config/database';

import { analyticsService } from '@services/admin/analytics.service';
import { broadcastService } from '@services/admin/broadcast.service';
import { eventService } from '@services/admin/event.service';
import { newsService } from '@services/admin/news.service';
import { studentService } from '@services/admin/student.service';
import { questionAdminService } from '@services/admin/question.admin.service';
import { questionService } from '@services/question.service';
import { AppError } from '@typings/models';
import { ok, fail } from '@utils/response';
import asyncHandler from '@middleware/asyncHandler';
import { UPLOAD } from '@config/constants';

// ─── Multer config for PDF and CSV uploads ─────────────────────────────────────

export const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: UPLOAD.PDF_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new AppError(422, 'VALIDATION_ERROR', 'Only PDF files are accepted here'));
  },
});

export const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) return cb(null, true);
    cb(new AppError(422, 'VALIDATION_ERROR', 'Only CSV files are accepted here'));
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS ADMIN CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const getAnalyticsOverview = asyncHandler(async (req: Request, res: Response) => {
  const data = await analyticsService.getOverview(req.institutionId);
  res.status(200).json(ok(data));
});

export const getStudentAnalytics = asyncHandler(async (req: Request, res: Response) => {
  const { days } = z.object({ days: z.coerce.number().int().positive().max(365).default(30) }).parse(req.query);
  const data = await analyticsService.getStudentAnalytics(req.institutionId, days);
  res.status(200).json(ok(data));
});

export const getQuizAnalytics = asyncHandler(async (req: Request, res: Response) => {
  const { days } = z.object({ days: z.coerce.number().int().positive().max(365).default(30) }).parse(req.query);
  const data = await analyticsService.getQuizAnalytics(req.institutionId, days);
  res.status(200).json(ok(data));
});

export const getAIAnalytics = asyncHandler(async (req: Request, res: Response) => {
  const { days } = z.object({ days: z.coerce.number().int().positive().max(365).default(30) }).parse(req.query);
  const data = await analyticsService.getAIAnalytics(req.institutionId, days);
  res.status(200).json(ok(data));
});

// ══════════════════════════════════════════════════════════════════════════════
// STUDENT ADMIN CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const listStudentsSchema = z.object({
  search:     z.string().optional(),
  faculty:    z.string().optional(),
  department: z.string().optional(),
  risk_flag:  z.coerce.boolean().optional(),
  page:       z.coerce.number().int().positive().default(1),
  limit:      z.coerce.number().int().positive().max(100).default(20),
  sort:       z.enum(['xp_desc', 'xp_asc', 'active_desc', 'recent']).default('active_desc'),
});

export const adminListStudents = asyncHandler(async (req: Request, res: Response) => {
  const filter = listStudentsSchema.parse(req.query);
  const result = await studentService.listStudents(req.institutionId, filter);
  res.status(200).json(ok(result));
});

export const adminGetStudent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await studentService.getStudentDetail(id, req.institutionId);
  res.status(200).json(ok(result));
});

export const adminFlagStudent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { flagged, reason } = z.object({
    flagged: z.boolean(),
    reason:  z.string().max(500).optional(),
  }).parse(req.body);
  const result = await studentService.setRiskFlag(id, req.institutionId, flagged, reason);
  res.status(200).json(ok(result));
});

export const adminGetAtRiskStudents = asyncHandler(async (req: Request, res: Response) => {
  const { limit } = z.object({ limit: z.coerce.number().max(200).default(50) }).parse(req.query);
  const students = await studentService.getAtRiskStudents(req.institutionId, limit);
  res.status(200).json(ok(students));
});

// ══════════════════════════════════════════════════════════════════════════════
// QUESTION ADMIN CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const createQuestionSchema = z.object({
  course_code:    z.string().min(1).max(20),
  course_name:    z.string().min(1).max(255),
  faculty:        z.string().min(1).max(255),
  department:     z.string().optional(),
  year:           z.number().int().min(1970).max(new Date().getFullYear() + 1),
  topic:          z.string().min(1).max(500),
  question_text:  z.string().min(10),
  question_type:  z.enum(['mcq', 'short_answer', 'essay']),
  options: z.array(z.object({ key: z.string(), text: z.string() })).optional(),
  correct_answer: z.string().min(1),
  explanation:    z.string().optional(),
  difficulty:     z.enum(['easy', 'medium', 'hard']),
  status:         z.enum(['draft', 'review', 'published']).optional(),
});

export const adminCreateQuestion = asyncHandler(async (req: Request, res: Response) => {
  const body = createQuestionSchema.parse(req.body);
  const question = await questionService.createQuestion(req.institutionId, req.user.id, body);
  res.status(201).json(ok(question));
});

export const adminGetQuestions = asyncHandler(async (req: Request, res: Response) => {
  const filter = z.object({
    search:     z.string().optional(),
    status:     z.enum(['draft', 'review', 'published', 'archived']).optional(),
    type:       z.enum(['mcq', 'short_answer', 'essay']).optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    page:       z.coerce.number().int().positive().default(1),
    limit:      z.coerce.number().int().positive().max(100).default(20),
  }).parse(req.query);

  const result = await questionService.getAdminQuestions(req.institutionId, filter);
  res.status(200).json(ok(result));
});

export const adminUpdateQuestion = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const data = createQuestionSchema.partial().parse(req.body);
  const updated = await questionAdminService.updateQuestion(id, req.institutionId, data);
  res.status(200).json(ok(updated));
});

export const adminUpdateQuestionStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { status } = z.object({
    status: z.enum(['draft', 'review', 'published', 'archived']),
  }).parse(req.body);

  const isSuperAdmin = req.user.role === 'superadmin';
  const updated = await questionService.updateQuestionStatus(id, req.institutionId, status, isSuperAdmin);
  res.status(200).json(ok(updated));
});

export const adminBulkUpdateStatus = asyncHandler(async (req: Request, res: Response) => {
  const { question_ids, status } = z.object({
    question_ids: z.array(z.string().uuid()).min(1).max(500),
    status:       z.enum(['draft', 'review', 'published', 'archived']),
  }).parse(req.body);

  const result = await questionAdminService.bulkUpdateStatus(question_ids, req.institutionId, status);
  res.status(200).json(ok(result));
});

export const adminUploadPDF = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(422).json(fail('VALIDATION_ERROR', 'No PDF file uploaded'));
    return;
  }

  const result = await questionAdminService.uploadQuestionPDF(
    req.file.buffer,
    req.file.originalname,
    req.institutionId,
    req.user.id,
  );

  res.status(202).json(ok(result)); // 202 Accepted — processing is async
});

export const adminUploadCSV = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(422).json(fail('VALIDATION_ERROR', 'No CSV file uploaded'));
    return;
  }

  // Parse CSV using csv-parse (sync for simplicity — small files)
  let rows: Record<string, string>[];
  try {
    rows = csvParse(req.file.buffer.toString('utf-8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, string>[];
  } catch {
    res.status(422).json(fail('VALIDATION_ERROR', 'Invalid CSV format. Please check your file.'));
    return;
  }

  const result = await questionAdminService.importQuestionsFromCSV(
    rows as unknown as Parameters<typeof questionAdminService.importQuestionsFromCSV>[0],
    req.institutionId,
    req.user.id,
  );

  res.status(200).json(ok(result));
});

export const adminGetPDFJob = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const job = await questionAdminService.getPDFJobStatus(id, req.institutionId);
  res.status(200).json(ok(job));
});

export const adminListPDFJobs = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().max(50).default(20) }).parse(req.query);
  const result = await questionAdminService.listPDFJobs(req.institutionId, page, limit);
  res.status(200).json(ok(result));
});

// ══════════════════════════════════════════════════════════════════════════════
// EVENT ADMIN CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const createEventSchema = z.object({
  title:           z.string().min(5).max(255),
  description:     z.string().min(10),
  event_date:      z.string().datetime(),
  location:        z.string().max(255).optional(),
  target_audience: z.enum(['all', 'faculty', 'department']).default('all'),
  target_value:    z.string().optional(),
  is_urgent:       z.boolean().default(false),
  scheduled_for:   z.string().datetime().nullable().optional(),
});

export const adminCreateEvent = asyncHandler(async (req: Request, res: Response) => {
  const body = createEventSchema.parse(req.body);
  const event = await eventService.createEvent({
    institutionId:  req.institutionId,
    createdBy:      req.user.id,
    title:          body.title,
    description:    body.description,
    eventDate:      new Date(body.event_date),
    location:       body.location,
    targetAudience: body.target_audience,
    targetValue:    body.target_value,
    isUrgent:       body.is_urgent,
    scheduledFor:   body.scheduled_for ? new Date(body.scheduled_for) : null,
  });
  res.status(201).json(ok(event));
});

export const adminListEvents = asyncHandler(async (req: Request, res: Response) => {
  const filter = z.object({
    status: z.enum(['draft', 'scheduled', 'published', 'cancelled']).optional(),
    page:   z.coerce.number().default(1),
    limit:  z.coerce.number().max(100).default(20),
  }).parse(req.query);

  const result = await eventService.listEvents(req.institutionId, filter);
  res.status(200).json(ok(result));
});

export const adminUpdateEvent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const body = createEventSchema.partial().parse(req.body);

  const data: Record<string, unknown> = { ...body };
  if (body.event_date) data['event_date'] = new Date(body.event_date);
  if (body.scheduled_for !== undefined) data['scheduled_for'] = body.scheduled_for ? new Date(body.scheduled_for) : null;

  const updated = await eventService.updateEvent(id, req.institutionId, data);
  res.status(200).json(ok(updated));
});

export const adminPublishEvent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  await eventService.publishEvent(id, req.institutionId);
  res.status(200).json(ok({ published: true }));
});

export const adminCancelEvent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const updated = await eventService.cancelEvent(id, req.institutionId);
  res.status(200).json(ok(updated));
});

// ══════════════════════════════════════════════════════════════════════════════
// BROADCAST ADMIN CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const broadcastSchema = z.object({
  recipient_type:  z.enum(['all', 'faculty', 'department']),
  recipient_value: z.string().optional(),
  subject:         z.string().min(5).max(255),
  html_body:       z.string().min(10),
});

export const adminSendBroadcast = asyncHandler(async (req: Request, res: Response) => {
  const body = broadcastSchema.parse(req.body);
  const result = await broadcastService.sendBroadcast({
    institutionId:  req.institutionId,
    createdBy:      req.user.id,
    recipientType:  body.recipient_type,
    recipientValue: body.recipient_value,
    subject:        body.subject,
    htmlBody:       body.html_body,
  });
  res.status(202).json(ok(result)); // 202 Accepted — emails are async
});

export const adminGetBroadcasts = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().max(50).default(20) }).parse(req.query);
  const result = await broadcastService.getBroadcastHistory(req.institutionId, page, limit);
  res.status(200).json(ok(result));
});

export const adminGetBroadcastDetail = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const broadcast = await broadcastService.getBroadcastDetail(id, req.institutionId);
  if (!broadcast) throw new AppError(404, 'NOT_FOUND', 'Broadcast not found');
  res.status(200).json(ok(broadcast));
});

// ══════════════════════════════════════════════════════════════════════════════
// NEWS ADMIN CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const createArticleSchema = z.object({
  title:           z.string().min(5).max(500),
  category:        z.string().min(1).max(100),
  html_body:       z.string().min(50),
  cover_image_url: z.string().url().optional(),
  is_pinned:       z.boolean().default(false),
  scheduled_for:   z.string().datetime().nullable().optional(),
});

export const adminCreateArticle = asyncHandler(async (req: Request, res: Response) => {
  const body = createArticleSchema.parse(req.body);
  const article = await newsService.createArticle({
    institutionId:  req.institutionId,
    createdBy:      req.user.id,
    title:          body.title,
    category:       body.category,
    htmlBody:       body.html_body,
    coverImageUrl:  body.cover_image_url,
    isPinned:       body.is_pinned,
    scheduledFor:   body.scheduled_for ? new Date(body.scheduled_for) : null,
  });
  res.status(201).json(ok(article));
});

export const adminListArticles = asyncHandler(async (req: Request, res: Response) => {
  const filter = z.object({
    status:   z.enum(['draft', 'scheduled', 'published']).optional(),
    category: z.string().optional(),
    page:     z.coerce.number().default(1),
    limit:    z.coerce.number().max(100).default(20),
  }).parse(req.query);

  const result = await newsService.listArticles(req.institutionId, filter);
  res.status(200).json(ok(result));
});

export const adminUpdateArticle = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const body = createArticleSchema.partial().parse(req.body);
  const updated = await newsService.updateArticle(id, req.institutionId, body as Parameters<typeof newsService.updateArticle>[2]);
  res.status(200).json(ok(updated));
});

export const adminPublishArticle = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const published = await newsService.publishArticle(id, req.institutionId);
  res.status(200).json(ok(published));
});

export const adminTogglePin = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const updated = await newsService.togglePin(id, req.institutionId);
  res.status(200).json(ok({ is_pinned: updated.is_pinned }));
});

// ══════════════════════════════════════════════════════════════════════════════
// AUDIENCE PREVIEW
// ══════════════════════════════════════════════════════════════════════════════

export const getAudiencePreview = asyncHandler(async (req: Request, res: Response) => {
  const { target, value } = z.object({
    target: z.enum(['all', 'faculty', 'department']),
    value:  z.string().optional(),
  }).parse(req.query);

  const where: Record<string, unknown> = {
    institution_id: req.institutionId,
    role:           'student',
    ...(target === 'faculty'    && value && { faculty:    value }),
    ...(target === 'department' && value && { department: value }),
  };

  const count = await prisma.user.count({ where });
  res.status(200).json(ok({ count }));
});

// ══════════════════════════════════════════════════════════════════════════════
// UNIFIED FILE UPLOAD (PDF or CSV detected by MIME type)
// ══════════════════════════════════════════════════════════════════════════════

export const unifiedUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: UPLOAD.PDF_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'text/csv', 'text/plain', 'application/vnd.ms-excel'];
    if (allowed.some((t) => file.mimetype.includes(t)) || file.originalname.endsWith('.csv')) {
      return cb(null, true);
    }
    cb(new AppError(422, 'VALIDATION_ERROR', 'Only PDF or CSV files accepted'));
  },
});

export const adminUploadFile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(422).json(fail('VALIDATION_ERROR', 'No file uploaded'));
    return;
  }

  const mime     = req.file.mimetype;
  const filename = req.file.originalname.toLowerCase();

  if (mime === 'application/pdf' || filename.endsWith('.pdf')) {
    const result = await questionAdminService.uploadQuestionPDF(
      req.file.buffer,
      req.file.originalname,
      req.institutionId,
      req.user.id,
    );
    res.status(202).json(ok(result));
  } else {
    // CSV import
    // csvParse is statically imported at top of file
    let rows: Record<string, string>[];
    try {
      rows = csvParse(req.file.buffer.toString('utf-8'), {
        columns:           true,
        skip_empty_lines:  true,
        trim:              true,
      }) as Record<string, string>[];
    } catch {
      res.status(422).json(fail('VALIDATION_ERROR', 'Invalid CSV format'));
      return;
    }
    const result = await questionAdminService.importQuestionsFromCSV(
      rows as unknown as Parameters<typeof questionAdminService.importQuestionsFromCSV>[0],
      req.institutionId,
      req.user.id,
    );
    res.status(200).json(ok(result));
  }
});

