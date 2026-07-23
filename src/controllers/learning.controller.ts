import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import asyncHandler from '@middleware/asyncHandler';
import { AppError } from '@typings/models';
import { UPLOAD } from '@config/constants';
import { ok } from '@utils/response';
import { uploadPDF } from '@lib/s3';
import { learningService } from '@services/learning.service';

/**
 * Adaptive learning engine endpoints (M7 item 4).
 *
 * Two ways to get a syllabus in, because a student with a printed textbook must
 * not be locked out: upload a PDF for AI extraction, or type the chapter list.
 * The manual path costs zero AI calls and is also the fallback whenever
 * extraction fails.
 */

export const resourceUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: UPLOAD.PDF_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new AppError(422, 'VALIDATION_ERROR', 'Only PDF files are supported'));
  },
});

const RESOURCE_KINDS = ['textbook', 'notes', 'pdf', 'outline', 'past_questions', 'video_playlist'] as const;

const createResourceSchema = z.object({
  title:       z.string().min(1).max(255),
  kind:        z.enum(RESOURCE_KINDS),
  source_url:  z.string().url().optional(),
  course_code: z.string().max(32).optional(),
}).strict();

const outlineSchema = z.object({
  chapters: z.array(
    z.object({
      title:    z.string().min(1).max(255),
      sections: z.array(z.string().min(1).max(255)).max(50).optional(),
    }),
  ).min(1).max(80),
}).strict();

// ─── Resources ────────────────────────────────────────────────────────────────

export const listResources = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json(ok(await learningService.listResources(req.user.id)));
});

export const createResource = asyncHandler(async (req: Request, res: Response) => {
  const body = createResourceSchema.parse(req.body);
  const resource = await learningService.createResource({
    userId:        req.user.id,
    institutionId: req.institutionId,
    title:         body.title,
    kind:          body.kind,
    sourceUrl:     body.source_url,
    courseCode:    body.course_code,
  });
  res.status(201).json(ok(resource));
});

/**
 * Upload the PDF for an existing resource. Kept separate from creation so the
 * metadata lands even if the upload fails, and so the client can show the row
 * immediately while the file goes up.
 */
export const uploadResourceFile = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (!req.file) throw new AppError(422, 'VALIDATION_ERROR', 'No file uploaded');

  const { url } = await uploadPDF(req.institutionId, req.file.buffer, req.file.originalname);
  const resource = await learningService.attachFile({
    resourceId: id,
    userId:     req.user.id,
    fileUrl:    url,
  });
  res.status(200).json(ok(resource));
});

export const deleteResource = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  res.status(200).json(ok(await learningService.deleteResource(id, req.user.id)));
});

// ─── Syllabus ─────────────────────────────────────────────────────────────────

export const setOutline = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const body = outlineSchema.parse(req.body);
  const nodes = await learningService.setManualOutline({
    resourceId: id,
    userId:     req.user.id,
    chapters:   body.chapters,
  });
  res.status(200).json(ok(nodes));
});

export const extractOutline = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const nodes = await learningService.extractSyllabusFromFile({
    resourceId:    id,
    userId:        req.user.id,
    institutionId: req.institutionId,
  });
  res.status(200).json(ok(nodes));
});

// ─── Objectives ───────────────────────────────────────────────────────────────

export const listObjectives = asyncHandler(async (req: Request, res: Response) => {
  const query = z.object({
    subject: z.string().optional(),
    node_id: z.string().uuid().optional(),
  }).parse(req.query);

  const objectives = await learningService.listObjectives(req.user.id, {
    subject: query.subject,
    nodeId:  query.node_id,
  });
  res.status(200).json(ok(objectives));
});

export const generateObjectives = asyncHandler(async (req: Request, res: Response) => {
  const { nodeId } = req.params as { nodeId: string };
  const objectives = await learningService.generateObjectivesForNode({
    nodeId,
    userId:        req.user.id,
    institutionId: req.institutionId,
  });
  res.status(200).json(ok(objectives));
});

// ─── Mastery ──────────────────────────────────────────────────────────────────

export const startMasteryCheck = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const started = await learningService.startMasteryCheck({
    objectiveId:   id,
    userId:        req.user.id,
    institutionId: req.institutionId,
  });
  res.status(201).json(ok(started));
});

const topicCheckSchema = z.object({
  subject: z.string().min(1).max(255),
  topic:   z.string().min(1).max(255),
}).strict();

/**
 * Start a mastery check from a study-plan task's topic — the plan's evidence
 * gate. Upserts a topic objective server-side, so the client only sends what it
 * has (the task's subject + topic).
 */
export const startTopicMasteryCheck = asyncHandler(async (req: Request, res: Response) => {
  const body = topicCheckSchema.parse(req.body);
  const started = await learningService.startTopicMasteryCheck({
    userId:        req.user.id,
    institutionId: req.institutionId,
    subject:       body.subject,
    topic:         body.topic,
  });
  res.status(201).json(ok(started));
});

export const completeMasteryCheck = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const body = z.object({ session_id: z.string().uuid() }).strict().parse(req.body);

  const result = await learningService.completeMasteryCheck({
    objectiveId:   id,
    sessionId:     body.session_id,
    userId:        req.user.id,
    institutionId: req.institutionId,
  });
  res.status(200).json(ok(result));
});

// ─── Learner model ────────────────────────────────────────────────────────────

export const getLearnerModel = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json(ok(await learningService.getLearnerModel(req.user.id)));
});

// ─── Exam outcomes (ground truth — reformation Phase 2) ───────────────────────

const examOutcomeSchema = z.object({
  subject:       z.string().min(1).max(255),
  course_code:   z.string().max(32).optional(),
  score_percent: z.number().min(0).max(100),
  grade_label:   z.string().max(16).optional(),
  /** Full ISO datetime, matching the study-schedule convention. */
  exam_date:     z.string().datetime(),
}).strict();

/**
 * Self-reported exam result — the only ground truth the engine collects.
 *
 * Deliberately unvalidated against anything: a student's own grade is noisy, and a
 * noisy real signal beats a closed loop that never touches reality. The
 * calibration model that compares these against predicted readiness is a later
 * phase; this endpoint only starts the collection.
 */
export const recordExamOutcome = asyncHandler(async (req: Request, res: Response) => {
  const body = examOutcomeSchema.parse(req.body);
  const outcome = await learningService.recordExamOutcome({
    userId:        req.user.id,
    institutionId: req.institutionId,
    subject:       body.subject,
    courseCode:    body.course_code,
    scorePercent:  body.score_percent,
    gradeLabel:    body.grade_label,
    examDate:      new Date(body.exam_date),
  });
  res.status(201).json(ok(outcome));
});

export const listExamOutcomes = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json(ok(await learningService.listExamOutcomes(req.user.id)));
});

export const deleteExamOutcome = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  res.status(200).json(ok(await learningService.deleteExamOutcome(id, req.user.id)));
});
