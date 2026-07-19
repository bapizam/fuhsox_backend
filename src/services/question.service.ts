import prisma from '@config/database';
import { AppError } from '@typings/models';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface QuestionFilter {
  course_code?: string;
  faculty?:     string;
  department?:  string;
  year?:        string; // comma-separated: "2020,2021"
  difficulty?:  'easy' | 'medium' | 'hard';
  type?:        'mcq' | 'short_answer' | 'essay';
  topic?:       string;
  search?:      string;
  page:         number;
  limit:        number;
}

// ─── Build Where Clause ────────────────────────────────────────────────────────

function buildStudentWhereClause(
  institutionId: string,
  filter: QuestionFilter,
): Record<string, unknown> {
  const years = filter.year
    ? filter.year.split(',').map((y) => parseInt(y.trim(), 10)).filter((y) => !isNaN(y))
    : undefined;

  return {
    institution_id: institutionId,
    status:         'published',
    ...(filter.course_code && { course_code: { equals: filter.course_code, mode: 'insensitive' } }),
    ...(filter.faculty     && { faculty:     { equals: filter.faculty,     mode: 'insensitive' } }),
    ...(filter.department  && { department:  { equals: filter.department,  mode: 'insensitive' } }),
    ...(filter.difficulty  && { difficulty:  filter.difficulty }),
    ...(filter.type        && { question_type: filter.type }),
    ...(filter.topic       && { topic: { contains: filter.topic, mode: 'insensitive' } }),
    ...(years?.length      && { year: { in: years } }),
    ...(filter.search      && {
      OR: [
        { question_text: { contains: filter.search, mode: 'insensitive' } },
        { topic:         { contains: filter.search, mode: 'insensitive' } },
        { course_name:   { contains: filter.search, mode: 'insensitive' } },
      ],
    }),
  };
}

// ─── Get Questions (Student) ───────────────────────────────────────────────────

export async function getPublishedQuestions(
  institutionId: string,
  userId:        string,
  filter:        QuestionFilter,
) {
  const skip = (filter.page - 1) * filter.limit;
  const where = buildStudentWhereClause(institutionId, filter);

  const [questions, total] = await Promise.all([
    prisma.question.findMany({
      where,
      skip,
      take:    filter.limit,
      orderBy: { created_at: 'desc' },
    }),
    prisma.question.count({ where }),
  ]);

  // Batch-check bookmarks for current user
  const questionIds = questions.map((q: { id: string }) => q.id);
  const bookmarks = await prisma.bookmark.findMany({
    where: { user_id: userId, question_id: { in: questionIds } },
    select: { question_id: true },
  });
  const bookmarkedSet = new Set(bookmarks.map((b: { question_id: string }) => b.question_id));

  const questionsWithBookmark = questions.map((q: { id: string }) => ({
    ...q,
    is_bookmarked: bookmarkedSet.has(q.id),
  }));

  return {
    questions: questionsWithBookmark,
    pagination: {
      total,
      page:       filter.page,
      limit:      filter.limit,
      totalPages: Math.ceil(total / filter.limit),
      hasMore:    filter.page * filter.limit < total,
    },
  };
}

// ─── Get Bookmarks ─────────────────────────────────────────────────────────────

export async function getUserBookmarks(
  userId:        string,
  institutionId: string,
  page:          number,
  limit:         number,
) {
  const skip = (page - 1) * limit;

  const [bookmarks, total] = await Promise.all([
    prisma.bookmark.findMany({
      where:   { user_id: userId, question: { institution_id: institutionId, status: 'published' } },
      include: { question: true },
      skip,
      take:    limit,
      orderBy: { created_at: 'desc' },
    }),
    prisma.bookmark.count({
      where: { user_id: userId, question: { institution_id: institutionId, status: 'published' } },
    }),
  ]);

  const questions = bookmarks.map((b: { question: Record<string, unknown>; question_id: string }) => ({ ...b.question, is_bookmarked: true }));

  return {
    questions,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit), hasMore: page * limit < total },
  };
}

// ─── Toggle Bookmark ───────────────────────────────────────────────────────────

export async function toggleBookmark(
  userId:     string,
  questionId: string,
): Promise<{ is_bookmarked: boolean }> {
  const question = await prisma.question.findUnique({
    where:  { id: questionId },
    select: { id: true, status: true },
  });

  if (question?.status !== 'published') {
    throw new AppError(404, 'NOT_FOUND', 'Question not found');
  }

  const existing = await prisma.bookmark.findUnique({
    where: { user_id_question_id: { user_id: userId, question_id: questionId } },
  });

  if (existing) {
    await prisma.bookmark.delete({
      where: { user_id_question_id: { user_id: userId, question_id: questionId } },
    });
    return { is_bookmarked: false };
  } else {
    await prisma.bookmark.create({
      data: { user_id: userId, question_id: questionId },
    });
    return { is_bookmarked: true };
  }
}

// ─── Admin: Get Questions ──────────────────────────────────────────────────────

export async function getAdminQuestions(
  institutionId: string,
  filter: {
    search?:     string;
    status?:     'draft' | 'review' | 'published' | 'archived';
    type?:       'mcq' | 'short_answer' | 'essay';
    difficulty?: 'easy' | 'medium' | 'hard';
    page:        number;
    limit:       number;
  },
) {
  const skip = (filter.page - 1) * filter.limit;

  const where: Record<string, unknown> = {
    institution_id: institutionId,
    ...(filter.status     && { status:        filter.status }),
    ...(filter.type       && { question_type: filter.type }),
    ...(filter.difficulty && { difficulty:    filter.difficulty }),
    ...(filter.search     && {
      OR: [
        { question_text: { contains: filter.search, mode: 'insensitive' } },
        { topic:         { contains: filter.search, mode: 'insensitive' } },
        { course_code:   { contains: filter.search, mode: 'insensitive' } },
        { course_name:   { contains: filter.search, mode: 'insensitive' } },
      ],
    }),
  };

  const [questions, total] = await Promise.all([
    prisma.question.findMany({
      where,
      skip,
      take:    filter.limit,
      orderBy: { updated_at: 'desc' },
    }),
    prisma.question.count({ where }),
  ]);

  return {
    questions,
    pagination: { total, page: filter.page, limit: filter.limit, totalPages: Math.ceil(total / filter.limit), hasMore: filter.page * filter.limit < total },
  };
}

// ─── Admin: Create Question ────────────────────────────────────────────────────

export async function createQuestion(
  institutionId: string,
  createdBy:     string,
  data: {
    course_code:    string;
    course_name:    string;
    faculty:        string;
    department?:    string;
    year:           number;
    topic:          string;
    question_text:  string;
    question_type:  'mcq' | 'short_answer' | 'essay';
    options?:       { key: string; text: string }[];
    correct_answer: string;
    explanation?:   string;
    difficulty:     'easy' | 'medium' | 'hard';
    status?:        'draft' | 'review' | 'published';
  },
) {
  if (data.question_type === 'mcq' && (data.options?.length !== 4)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'MCQ questions must have exactly 4 options');
  }

  return prisma.question.create({
    data: {
      institution_id: institutionId,
      created_by:     createdBy,
      source:         'manual',
      status:         data.status ?? 'draft',
      ...data,
    },
  });
}

// ─── Admin: Update Question Status ────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft:     ['review', 'archived'],
  review:    ['published', 'draft', 'archived'],
  published: ['archived'],
  archived:  ['draft'],
};

export async function updateQuestionStatus(
  questionId:    string,
  institutionId: string,
  newStatus:     'draft' | 'review' | 'published' | 'archived',
  isSuperAdmin:  boolean = false,
) {
  const question = await prisma.question.findFirst({
    where: { id: questionId, institution_id: institutionId },
  });

  if (!question) {
    throw new AppError(404, 'NOT_FOUND', 'Question not found');
  }

  const allowed = VALID_TRANSITIONS[question.status] ?? [];
  if (!isSuperAdmin && !allowed.includes(newStatus)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Cannot transition from '${question.status}' to '${newStatus}'. Allowed: ${allowed.join(', ')}`,
    );
  }

  return prisma.question.update({
    where: { id: questionId },
    data:  { status: newStatus },
  });
}

export const questionService = {
  getPublishedQuestions,
  getUserBookmarks,
  toggleBookmark,
  getAdminQuestions,
  createQuestion,
  updateQuestionStatus,
};
