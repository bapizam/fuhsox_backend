import type { Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { userService } from '@services/user.service';
import { questionService } from '@services/question.service';
import { sessionService } from '@services/session.service';
import { aiService } from '@services/ai.service';
import { feedService } from '@services/feed.service';
import { notificationService } from '@services/notification.service';
import { gamificationService } from '@services/gamification.service';
import { ok, fail } from '@utils/response';
import asyncHandler from '@middleware/asyncHandler';
import { AppError } from '@typings/models';
import { UPLOAD, REDIS_KEYS, TTL } from '@config/constants';
import { get as redisGet, set as redisSet, getCount, getTodayWAT, getEndOfDayTTL } from '@lib/redis';
import prisma from '@config/database';
import { Message, StudyPlan } from '../../mongo/schemas';

// ─── Multer for avatar uploads ─────────────────────────────────────────────────

export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: UPLOAD.AVATAR_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if ((UPLOAD.ALLOWED_IMAGE_TYPES).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(422, 'VALIDATION_ERROR', 'Only image files are allowed (JPEG, PNG, WebP, GIF)'));
    }
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// USER CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const updateProfileSchema = z.object({
  full_name:       z.string().max(255).optional(),
  username:        z.string()
                     .min(3, 'Username must be at least 3 characters')
                     .max(30, 'Username must be at most 30 characters')
                     .regex(/^[a-z0-9_]+$/, 'Username may only contain lowercase letters, numbers, and underscores')
                     .optional(),
  faculty:         z.string().optional(),
  department:      z.string().optional(),
  bio:             z.string().max(500).optional(),
  avatar_url:      z.string().url().optional(),
  study_interests: z.array(z.string()).min(1).max(30).optional(),
  notification_prefs: z.object({
    opt_out_reminders:  z.boolean(),
    quiet_hours_start:  z.string().nullable(),
    quiet_hours_end:    z.string().nullable(),
    reminder_frequency: z.enum(['daily', 'every_2_days', 'weekly']),
  }).optional(),
}).strict();

const discoverSchema = z.object({
  faculty:  z.string().optional(),
  interest: z.string().optional(),
  page:     z.coerce.number().int().positive().default(1),
  limit:    z.coerce.number().int().positive().max(24).default(12),
  sort:     z.enum(['best_match', 'most_active', 'recent']).default('best_match'),
});

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const profile = await userService.getMyProfile(req.user.id);
  res.status(200).json(ok(profile));
});

export const getDashboard = asyncHandler(async (req: Request, res: Response) => {
  const dashboard = await userService.getDashboard(req.user.id);
  res.status(200).json(ok(dashboard));
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const data = updateProfileSchema.parse(req.body);
  const updated = await userService.updateProfile(req.user.id, data);
  res.status(200).json(ok(updated));
});

export const uploadAvatar = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(422).json(fail('VALIDATION_ERROR', 'No file uploaded'));
    return;
  }
  const result = await userService.updateAvatar(req.user.id, req.file.buffer, req.file.mimetype);
  res.status(200).json(ok(result));
});

export const deleteMe = asyncHandler(async (req: Request, res: Response) => {
  await userService.deleteAccount(req.user.id);
  res.status(200).json(ok({ message: 'Your account has been deleted' }));
});

export const getUserProfile = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const profile = await userService.getPublicProfile(id, req.user.id, req.institutionId);
  res.status(200).json(ok(profile));
});

export const discoverUsers = asyncHandler(async (req: Request, res: Response) => {
  const filter = discoverSchema.parse(req.query);
  const user = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { id: true, institution_id: true, study_interests: true },
  });
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

  const result = await userService.discoverPeers(user, filter);
  res.status(200).json(ok(result));
});

export const sendConnection = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const connection = await userService.sendConnectionRequest(req.user.id, id, req.institutionId);
  res.status(201).json(ok(connection));
});

export const listUserConnections = asyncHandler(async (req: Request, res: Response) => {
  const { status } = z.object({
    status: z.enum(['pending', 'accepted']).optional(),
  }).parse(req.query);
  const result = await userService.listConnections(req.user.id, status);
  res.status(200).json(ok(result));
});

export const respondConnection = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { action } = z.object({ action: z.enum(['accept', 'decline']) }).parse(req.body);
  const updated = await userService.respondToConnection(id, req.user.id, action);
  res.status(200).json(ok(updated));
});

// ══════════════════════════════════════════════════════════════════════════════
// QUESTION CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const questionFilterSchema = z.object({
  course_code: z.string().optional(),
  faculty:     z.string().optional(),
  department:  z.string().optional(),
  year:        z.string().optional(),
  difficulty:  z.enum(['easy', 'medium', 'hard']).optional(),
  type:        z.enum(['mcq', 'short_answer', 'essay']).optional(),
  topic:       z.string().optional(),
  search:      z.string().optional(),
  page:        z.coerce.number().int().positive().default(1),
  limit:       z.coerce.number().int().positive().max(50).default(12),
});

export const getQuestions = asyncHandler(async (req: Request, res: Response) => {
  const filter = questionFilterSchema.parse(req.query);
  const result = await questionService.getPublishedQuestions(req.institutionId, req.user.id, filter);
  res.status(200).json(ok(result));
});

export const getBookmarks = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().max(50).default(12) }).parse(req.query);
  const result = await questionService.getUserBookmarks(req.user.id, req.institutionId, page, limit);
  res.status(200).json(ok(result));
});

export const toggleBookmark = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await questionService.toggleBookmark(req.user.id, id);
  res.status(200).json(ok(result));
});

// ══════════════════════════════════════════════════════════════════════════════
// SESSION CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const createSessionSchema = z.object({
  mode:            z.enum(['practice', 'exam']),
  question_count:  z.number().int().min(5).max(100),
  question_source: z.enum(['past_questions', 'ai_generated', 'bookmarks', 'mixed']).default('past_questions'),
  ai_question_ids: z.array(z.string()).optional(),
  filters: z.object({
    course_code: z.string().optional(),
    faculty:     z.string().optional(),
    year:        z.number().int().optional(),
    difficulty:  z.string().optional(),
    type:        z.string().optional(),
    topic:       z.string().optional(),
  }).optional(),
});

const answerSchema = z.object({
  question_id:   z.string().min(24).max(36), // Allows both UUIDs and Mongo ObjectIds
  chosen_answer: z.string().min(1),
  time_taken_ms: z.number().int().positive(),
});

export const createSession = asyncHandler(async (req: Request, res: Response) => {
  const body = createSessionSchema.parse(req.body);
  const result = await sessionService.createSession({
    userId:         req.user.id,
    institutionId:  req.institutionId,
    mode:           body.mode,
    questionCount:  body.question_count,
    questionSource: body.question_source,
    aiQuestionIds:  body.ai_question_ids,
    filters:        body.filters,
  });
  res.status(201).json(ok(result));
});

export const submitAnswer = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const body = answerSchema.parse(req.body);
  const result = await sessionService.submitAnswer({
    sessionId:    id,
    userId:       req.user.id,
    questionId:   body.question_id,
    chosenAnswer: body.chosen_answer,
    timeTakenMs:  body.time_taken_ms,
  });
  res.status(200).json(ok(result));
});

/**
 * Bulk sibling of `answerSchema`. Capped at 200 — comfortably above any real
 * session (the runner tops out well below that) while bounding one request's work.
 */
const answersBatchSchema = z.object({
  answers: z.array(answerSchema).min(1).max(200),
});

export const submitAnswers = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const body = answersBatchSchema.parse(req.body);
  const result = await sessionService.submitAnswers({
    sessionId: id,
    userId:    req.user.id,
    answers:   body.answers,
  });
  res.status(200).json(ok(result));
});

export const completeSession = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await sessionService.completeSession(id, req.user.id);
  res.status(200).json(ok(result));
});

export const getMySessions = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, stats } = z.object({
    page:  z.coerce.number().default(1),
    limit: z.coerce.number().max(50).default(10),
    stats: z.coerce.boolean().default(false),
  }).parse(req.query);

  const skip = (page - 1) * limit;
  const [sessions, total] = await Promise.all([
    prisma.quizSession.findMany({
      where:   { user_id: req.user.id },
      orderBy: { started_at: 'desc' },
      skip,
      take:    limit,
    }),
    prisma.quizSession.count({ where: { user_id: req.user.id } }),
  ]);

  let aggregate = null;
  if (stats) {
    aggregate = await gamificationService.getUserStats(req.user.id);
  }

  res.status(200).json(ok({ sessions, total, page, limit, ...(aggregate && { stats: aggregate }) }));
});

export const getSessionById = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await sessionService.getSessionDetail(id, req.user.id);
  res.status(200).json(ok(result));
});

// ══════════════════════════════════════════════════════════════════════════════
// AI CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const generateQuestionsSchema = z.object({
  topic:         z.string().min(10).max(2000),
  question_type: z.enum(['mcq', 'short_answer', 'fill_blank']),
  difficulty:    z.enum(['easy', 'medium', 'hard']),
  count:         z.number().int().min(1).max(20),
});

export const generateAIQuestions = asyncHandler(async (req: Request, res: Response) => {
  const body = generateQuestionsSchema.parse(req.body);
  const result = await aiService.generateQuestions({
    ...body,
    userId:        req.user.id,
    institutionId: req.institutionId,
  });
  res.status(200).json(ok(result));
});

export const generateStudyPlan = asyncHandler(async (req: Request, res: Response) => {
  const schema = z.object({
    subjects:    z.array(z.string().min(1)).min(1).max(10),
    exam_date:   z.string().datetime(),
    daily_hours: z.number().positive().max(16),
  });

  const { subjects, exam_date, daily_hours } = schema.parse(req.body);

  const plan = await aiService.generateStudyPlan({
    userId:        req.user.id,
    institutionId: req.institutionId,
    subjects,
    examDate:      new Date(exam_date),
    dailyHours:    daily_hours,
  });

  // Save/update study plan in MongoDB
  await StudyPlan.findOneAndUpdate(
    { user_id: req.user.id },
    {
      user_id:        req.user.id,
      institution_id: req.institutionId,
      subjects,
      exam_date:      new Date(exam_date),
      daily_hours,
      ...(plan),
    },
    { upsert: true, new: true },
  );

  res.status(200).json(ok(plan));
});

export const getAIUsageToday = asyncHandler(async (req: Request, res: Response) => {
  const institution = await prisma.institution.findUnique({
    where:  { id: req.institutionId },
    select: { ai_daily_limit: true },
  });

  const dailyLimit = institution?.ai_daily_limit ?? 20;
  const key = REDIS_KEYS.AI_DAILY(req.user.id, getTodayWAT());
  const used = await getCount(key);

  res.status(200).json(ok({ used, limit: dailyLimit, remaining: Math.max(0, dailyLimit - used) }));
});

// ══════════════════════════════════════════════════════════════════════════════
// FEED CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const createPostSchema = z.object({
  content:   z.string().min(1).max(500),
  topic_tag: z.string().max(100).optional(),
});

const commentSchema = z.object({
  body:              z.string().min(1).max(1000),
  parent_comment_id: z.string().optional(),
});

const reportSchema = z.object({ reason: z.string().max(500) });

export const getFeed = asyncHandler(async (req: Request, res: Response) => {
  const { cursor, limit } = z.object({
    cursor: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid cursor format').optional(),
    limit:  z.coerce.number().int().positive().max(20).default(10),
  }).parse(req.query);
  const result = await feedService.getFeed(req.user.id, req.institutionId, cursor, limit);
  res.status(200).json(ok(result));
});

export const createPost = asyncHandler(async (req: Request, res: Response) => {
  const body = createPostSchema.parse(req.body);
  const post = await feedService.createPost(req.user.id, req.institutionId, body);
  res.status(201).json(ok(post));
});

export const toggleLike = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await feedService.togglePostLike(id, req.user.id);
  res.status(200).json(ok(result));
});

export const deletePost = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
  const result = await feedService.deletePost(id, req.user.id, isAdmin);
  res.status(200).json(ok(result));
});

export const addComment = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { body, parent_comment_id } = commentSchema.parse(req.body);
  const comment = await feedService.createComment(id, req.user.id, body, parent_comment_id);
  res.status(201).json(ok(comment));
});

export const getComments = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { page, limit } = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().max(50).default(20) }).parse(req.query);
  const result = await feedService.getPostComments(id, page, limit);
  res.status(200).json(ok(result));
});

export const reportPost = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { reason } = reportSchema.parse(req.body);
  const result = await feedService.reportPost(id, req.user.id, reason, req.institutionId);
  res.status(200).json(ok(result));
});

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const getNotifications = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().max(50).default(20) }).parse(req.query);
  const result = await notificationService.getUserNotifications(req.user.id, page, limit);
  res.status(200).json(ok(result));
});

export const markNotificationRead = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const notification = await notificationService.markAsRead(id, req.user.id);
  res.status(200).json(ok(notification));
});

export const markAllNotificationsRead = asyncHandler(async (req: Request, res: Response) => {
  const result = await notificationService.markAllAsRead(req.user.id);
  res.status(200).json(ok(result));
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const getConversations = asyncHandler(async (req: Request, res: Response) => {
  // Find unique conversation partners
  const sent = await Message.find({ sender_id: req.user.id }).distinct('receiver_id');
  const received = await Message.find({ receiver_id: req.user.id }).distinct('sender_id');
  const partnerIds = [...new Set([...sent, ...received])];

  const conversations = await Promise.all(
    partnerIds.map(async (partnerId) => {
      const lastMessage = await Message.findOne({
        $or: [
          { sender_id: req.user.id,   receiver_id: partnerId },
          { sender_id: partnerId, receiver_id: req.user.id },
        ],
        is_deleted: false,
      }).sort({ createdAt: -1 }).lean();

      const unreadCount = await Message.countDocuments({
        sender_id:   partnerId,
        receiver_id: req.user.id,
        read_at:     null,
        is_deleted:  false,
      });

      const partner = await prisma.user.findUnique({
        where:  { id: partnerId },
        select: { id: true, full_name: true, avatar_url: true },
      });

      return { partner, last_message: lastMessage, unread_count: unreadCount };
    }),
  );

  // Sort by last message time
  conversations.sort((a, b) => {
    const timeA = (a.last_message as { createdAt?: Date } | null)?.createdAt?.getTime() ?? 0;
    const timeB = (b.last_message as { createdAt?: Date } | null)?.createdAt?.getTime() ?? 0;
    return timeB - timeA;
  });

  res.status(200).json(ok(conversations));
});

export const getMessageHistory = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params as { userId: string };
  const { page, limit } = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().max(50).default(20) }).parse(req.query);

  // Verify they're connected
  const connection = await prisma.connection.findFirst({
    where: {
      OR: [
        { sender_id: req.user.id, receiver_id: userId },
        { sender_id: userId, receiver_id: req.user.id },
      ],
      status: 'accepted',
    },
  });

  if (!connection) throw new AppError(403, 'FORBIDDEN', 'You must be connected to view messages');

  const skip = (page - 1) * limit;

  const [messages, total] = await Promise.all([
    Message.find({
      $or: [
        { sender_id: req.user.id, receiver_id: userId },
        { sender_id: userId, receiver_id: req.user.id },
      ],
      is_deleted: false,
    }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Message.countDocuments({
      $or: [
        { sender_id: req.user.id, receiver_id: userId },
        { sender_id: userId, receiver_id: req.user.id },
      ],
      is_deleted: false,
    }),
  ]);

  // Mark messages as read
  await Message.updateMany(
    { sender_id: userId, receiver_id: req.user.id, read_at: null },
    { read_at: new Date() },
  );

  res.status(200).json(ok({ messages, pagination: { total, page, limit, hasMore: page * limit < total } }));
});

export const deleteMessage = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const message = await Message.findOne({ _id: id, sender_id: req.user.id });
  if (!message) throw new AppError(404, 'NOT_FOUND', 'Message not found or not owned by you');
  await Message.findByIdAndUpdate(id, { is_deleted: true });
  res.status(200).json(ok({ deleted: true }));
});

// ══════════════════════════════════════════════════════════════════════════════
// STUDY SCHEDULE CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

const scheduleSchema = z.object({
  subject:               z.string().max(255),
  study_days:            z.array(z.number().int().min(0).max(6)),
  preferred_time_start:  z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM'),
  preferred_time_end:    z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM'),
  exam_date:             z.string().datetime(),
});

export const getSchedules = asyncHandler(async (req: Request, res: Response) => {
  const schedules = await prisma.studySchedule.findMany({
    where:   { user_id: req.user.id, is_active: true },
    orderBy: { created_at: 'desc' },
  });

  const enriched = schedules.map((s: Record<string, unknown> & { sessions_planned: number; sessions_completed: number }) => ({
    ...s,
    adherence_rate: s.sessions_planned > 0
      ? Math.round((s.sessions_completed / s.sessions_planned) * 100) / 100
      : 0,
  }));

  res.status(200).json(ok(enriched));
});

export const createSchedule = asyncHandler(async (req: Request, res: Response) => {
  const body = scheduleSchema.parse(req.body);
  const examDate = new Date(body.exam_date);
  const today = new Date();
  const weeksLeft = Math.max(0, Math.ceil((examDate.getTime() - today.getTime()) / (7 * 86400000)));
  const sessionsPlanned = weeksLeft * body.study_days.length;

  const schedule = await prisma.studySchedule.create({
    data: {
      user_id:               req.user.id,
      institution_id:        req.institutionId,
      subject:               body.subject,
      study_days:            body.study_days,
      preferred_time_start:  body.preferred_time_start,
      preferred_time_end:    body.preferred_time_end,
      exam_date:             examDate,
      sessions_planned:      sessionsPlanned,
    },
  });

  res.status(201).json(ok(schedule));
});

export const updateSchedule = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const data = scheduleSchema.partial().parse(req.body);

  // sessions_planned derives from exam_date × study_days — recompute when
  // either changes (creation used to be the only place it was calculated,
  // so edits silently skewed adherence).
  let sessionsPlanned: number | undefined;
  if (data.exam_date !== undefined || data.study_days !== undefined) {
    const existing = await prisma.studySchedule.findFirst({
      where: { id, user_id: req.user.id, is_active: true },
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Schedule not found');

    const examDate  = data.exam_date ? new Date(data.exam_date) : existing.exam_date;
    const studyDays = data.study_days ?? existing.study_days;
    const weeksLeft = Math.max(0, Math.ceil((examDate.getTime() - Date.now()) / (7 * 86400000)));
    sessionsPlanned = weeksLeft * studyDays.length;
  }

  const schedule = await prisma.studySchedule.updateMany({
    where: { id, user_id: req.user.id, is_active: true },
    data:  { ...data, ...(sessionsPlanned !== undefined && { sessions_planned: sessionsPlanned }) },
  });
  if (schedule.count === 0) throw new AppError(404, 'NOT_FOUND', 'Schedule not found');
  res.status(200).json(ok({ updated: true }));
});

export const deleteSchedule = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await prisma.studySchedule.updateMany({
    where: { id, user_id: req.user.id },
    data:  { is_active: false },
  });
  if (result.count === 0) throw new AppError(404, 'NOT_FOUND', 'Schedule not found');
  res.status(200).json(ok({ deleted: true }));
});

/**
 * Mobile-additive "I studied today" check-in. `sessions_completed` had no
 * write path, so adherence_rate was permanently 0. Guarded to once per WAT
 * day per schedule (Redis) and clamped at sessions_planned.
 */
export const checkInSchedule = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const schedule = await prisma.studySchedule.findFirst({
    where: { id, user_id: req.user.id, is_active: true },
  });
  if (!schedule) throw new AppError(404, 'NOT_FOUND', 'Schedule not found');

  const checkinKey = REDIS_KEYS.SCHEDULE_CHECKIN(id, getTodayWAT());
  if (await redisGet(checkinKey)) {
    throw new AppError(409, 'CONFLICT', 'Already checked in today for this schedule');
  }
  if (schedule.sessions_completed >= schedule.sessions_planned) {
    throw new AppError(409, 'CONFLICT', 'All planned sessions are already completed');
  }

  const updated = await prisma.studySchedule.update({
    where: { id },
    data:  { sessions_completed: { increment: 1 } },
  });
  await redisSet(checkinKey, '1', getEndOfDayTTL());

  res.status(200).json(ok({
    ...updated,
    adherence_rate: updated.sessions_planned > 0
      ? Math.round((updated.sessions_completed / updated.sessions_planned) * 100) / 100
      : 0,
  }));
});

// ══════════════════════════════════════════════════════════════════════════════
// LEADERBOARD CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const getLeaderboard = asyncHandler(async (req: Request, res: Response) => {
  const { scope, value, page, limit } = z.object({
    scope: z.enum(['institution', 'faculty', 'department']).default('institution'),
    value: z.string().optional(),
    page:  z.coerce.number().default(1),
    limit: z.coerce.number().max(100).default(50),
  }).parse(req.query);

  const where = {
    institution_id: req.institutionId,
    role:           'student' as const,
    ...(scope === 'faculty'    && value && { faculty:    value }),
    ...(scope === 'department' && value && { department: value }),
  };

  // my_rank is personal — computed fresh on EVERY request and never cached
  // (it used to be baked into the cached blob, so everyone saw the rank of
  // whoever warmed the cache).
  const myUser = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { xp_points: true },
  });
  const myXP = myUser?.xp_points ?? 0;
  const myRankResult = await prisma.user.count({
    where: { ...where, xp_points: { gt: myXP } },
  });
  const myRank = myRankResult + 1;

  // Page-scoped key — the base key alone served page 1's entries to every page.
  const cacheKey = `${REDIS_KEYS.LEADERBOARD(req.institutionId, scope, value)}:p${page}:l${limit}`;

  const cached = await redisGet(cacheKey);
  if (cached) {
    res.status(200).json(ok({ ...(JSON.parse(cached) as Record<string, unknown>), my_rank: myRank }));
    return;
  }

  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { xp_points: 'desc' },
      skip,
      take:    limit,
      select: {
        id:           true,
        full_name:    true,
        avatar_url:   true,
        faculty:      true,
        department:   true,
        xp_points:    true,
        streak_count: true,
        _count:       { select: { badges: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  const entries = users.map((u: Record<string, unknown>, idx: number) => ({
    rank:        skip + idx + 1,
    user_id:     u.id,
    full_name:   u.full_name,
    avatar_url:  u.avatar_url,
    faculty:     u.faculty,
    department:  u.department,
    xp_points:   u.xp_points,
    streak_count: u.streak_count,
    badge_count: (u._count as { badges: number }).badges,
  }));

  // Cache only the shared page data — my_rank stays per-request (see above).
  const pageData = { entries, total, page, limit };
  await redisSet(cacheKey, JSON.stringify(pageData), TTL.LEADERBOARD);

  res.status(200).json(ok({ ...pageData, my_rank: myRank }));
});

// ══════════════════════════════════════════════════════════════════════════════
// NEWS & EVENTS CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const getNews = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = z.object({ page: z.coerce.number().default(1), limit: z.coerce.number().max(50).default(10) }).parse(req.query);
  const skip = (page - 1) * limit;

  const [pinned, regular, total] = await Promise.all([
    prisma.newsArticle.findMany({
      where:   { institution_id: req.institutionId, status: 'published', is_pinned: true },
      orderBy: { published_at: 'desc' },
    }),
    prisma.newsArticle.findMany({
      where:   { institution_id: req.institutionId, status: 'published', is_pinned: false },
      orderBy: { published_at: 'desc' },
      skip,
      take:    limit,
    }),
    prisma.newsArticle.count({ where: { institution_id: req.institutionId, status: 'published' } }),
  ]);

  res.status(200).json(ok({ pinned, articles: regular, total, page, limit }));
});

export const getNewsById = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const article = await prisma.newsArticle.findFirst({
    where: { id, institution_id: req.institutionId, status: 'published' },
  });
  if (!article) throw new AppError(404, 'NOT_FOUND', 'Article not found');
  res.status(200).json(ok(article));
});

export const getEvents = asyncHandler(async (req: Request, res: Response) => {
  // Audience filter (M5): publish-time notifications were already faculty/
  // department-targeted, but this list returned every published event. Match
  // the targeting here; a null profile field simply never matches a targeted
  // event (same degradation as the notification fan-out).
  const me = await prisma.user.findUnique({
    where:  { id: req.user.id },
    select: { faculty: true, department: true },
  });

  const events = await prisma.event.findMany({
    where: {
      institution_id: req.institutionId,
      status:         'published',
      event_date:     { gte: new Date() },
      OR: [
        { target_audience: 'all' },
        ...(me?.faculty ? [{ target_audience: 'faculty' as const, target_value: me.faculty }] : []),
        ...(me?.department ? [{ target_audience: 'department' as const, target_value: me.department }] : []),
      ],
    },
    orderBy: { event_date: 'asc' },
  });
  res.status(200).json(ok(events));
});

// ══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL AI CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const getMyStudyPlan = asyncHandler(async (req: Request, res: Response) => {
  const plan = await aiService.getStudyPlan(req.user.id);
  res.status(200).json(ok({ plan }));
});

export const updateStudyPlanTask = asyncHandler(async (req: Request, res: Response) => {
  const body = z.object({
    week_number: z.number().int().positive(),
    date:        z.string().min(1),
    task_index:  z.number().int().min(0),
    completed:   z.boolean(),
  }).parse(req.body);

  const plan = await aiService.updateStudyPlanTask(req.user.id, body);
  res.status(200).json(ok({ plan }));
});

export const getMyAIFeedback = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, course_code, search } = z.object({
    page:        z.coerce.number().int().positive().default(1),
    limit:       z.coerce.number().int().positive().max(50).default(20),
    course_code: z.string().optional(),
    search:      z.string().optional(),
  }).parse(req.query);

  const result = await aiService.getAIFeedbackHistory(
    req.user.id, req.institutionId, page, limit, { course_code, search },
  );
  res.status(200).json(ok(result));
});

export const flagAIQuestion = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(req.body);
  const result = await aiService.flagAIQuestion(id, req.user.id, reason);
  res.status(200).json(ok(result));
});

// ══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL FEED CONTROLLERS
// ══════════════════════════════════════════════════════════════════════════════

export const getFeedTrending = asyncHandler(async (req: Request, res: Response) => {
  const result = await feedService.getTrending(req.institutionId);
  res.status(200).json(ok(result));
});

export const getPostById = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await feedService.getPostDetail(id, req.user.id);
  res.status(200).json(ok(result));
});

