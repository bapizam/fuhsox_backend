import prisma from '@config/database';
import { AIQuestion, AIFeedback } from '../../mongo/schemas';
import { AppError } from '@typings/models';
import { calculateScorePercent } from '@utils/xp';
import { gamificationService } from './gamification.service';
import logger from '@lib/logger';
import { getIO } from '@lib/socket-ref';
import { aiService } from './ai.service';

// ─── Fisher-Yates Shuffle ──────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Create Session ────────────────────────────────────────────────────────────

export async function createSession(params: {
  userId:         string;
  institutionId:  string;
  mode:           'practice' | 'exam';
  questionCount:  number;
  questionSource: 'past_questions' | 'ai_generated' | 'bookmarks' | 'mixed';
  aiQuestionIds?: string[];
  filters?: {
    course_code?: string;
    faculty?:     string;
    year?:        number;
    difficulty?:  string;
    type?:        string;
    topic?:       string;
  };
}) {
  let questionIds: string[] = [];
  let questionObjects: unknown[] = [];

  const { questionCount, questionSource, filters, aiQuestionIds, userId, institutionId } = params;

  if (questionSource === 'past_questions' || questionSource === 'mixed') {
    const where: Record<string, unknown> = {
      institution_id: institutionId,
      status:         'published',
      ...(filters?.course_code && { course_code: filters.course_code }),
      ...(filters?.faculty     && { faculty:     filters.faculty }),
      ...(filters?.year        && { year:        filters.year }),
      ...(filters?.difficulty  && { difficulty:  filters.difficulty }),
      ...(filters?.type        && { question_type: filters.type }),
      ...(filters?.topic       && { topic: { contains: filters.topic, mode: 'insensitive' } }),
    };

    const questions = await prisma.question.findMany({
      where,
      take: questionSource === 'mixed' ? Math.ceil(questionCount / 2) : questionCount,
    });

    questionIds = [...questionIds, ...questions.map((q: { id: string }) => q.id)];
    questionObjects = [...questionObjects, ...questions];
  }

  if (questionSource === 'bookmarks') {
    const bookmarks = await prisma.bookmark.findMany({
      where:   { user_id: userId },
      include: { question: true },
      take:    questionCount,
    });

    const bqIds = bookmarks.map((b: { question_id: string; question: Record<string, unknown> }) => b.question_id);
    questionIds = bqIds;
    questionObjects = bookmarks.map((b: { question_id: string; question: Record<string, unknown> }) => b.question);
  }

  if (questionSource === 'ai_generated' && aiQuestionIds?.length) {
    const aiQuestions = await AIQuestion.find({
      _id:     { $in: aiQuestionIds },
      user_id: userId,
    }).lean();

    questionIds = aiQuestions.map((q) => (q._id as { toString(): string }).toString());
    questionObjects = aiQuestions;
  }

  if (questionSource === 'mixed' && aiQuestionIds?.length) {
    const remaining = questionCount - questionIds.length;
    const aiQuestions = await AIQuestion.find({
      _id:     { $in: aiQuestionIds.slice(0, remaining) },
      user_id: userId,
    }).lean();

    questionIds = [...questionIds, ...aiQuestions.map((q) => (q._id as { toString(): string }).toString())];
    questionObjects = [...questionObjects, ...aiQuestions];
  }

  if (questionIds.length === 0) {
    throw new AppError(404, 'NOT_FOUND', 'No questions found matching the specified criteria');
  }

  // Shuffle questions
  const shuffledIds = shuffle(questionIds);
  const finalIds = shuffledIds.slice(0, questionCount);

  // Create the session
  const session = await prisma.quizSession.create({
    data: {
      user_id:         userId,
      institution_id:  institutionId,
      mode:            params.mode,
      question_source: questionSource === 'bookmarks'     ? 'manual'
                      : questionSource === 'ai_generated' ? 'ai_generated'
                      : 'manual',
      total_questions: finalIds.length,
      question_ids:    finalIds,
    },
  });

  logger.info({ userId, sessionId: session.id, count: finalIds.length }, 'Quiz session created');

  return { session, questions: questionObjects };
}

// ─── Submit Answer ─────────────────────────────────────────────────────────────

export async function submitAnswer(params: {
  sessionId:    string;
  userId:       string;
  questionId:   string;
  chosenAnswer: string;
  timeTakenMs:  number;
}) {
  const { sessionId, userId, questionId, chosenAnswer, timeTakenMs } = params;

  // Validate session ownership and state
  const session = await prisma.quizSession.findFirst({
    where: { id: sessionId, user_id: userId },
  });

  if (!session) {
    throw new AppError(404, 'NOT_FOUND', 'Session not found');
  }

  if (session.completed_at) {
    throw new AppError(400, 'CONFLICT', 'This session is already completed');
  }

  // Check question belongs to this session
  if (!session.question_ids.includes(questionId)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Question does not belong to this session');
  }

  // Check not already answered
  const existingAnswer = await prisma.sessionAnswer.findFirst({
    where: { session_id: sessionId, question_id: questionId },
  });

  if (existingAnswer) {
    throw new AppError(409, 'CONFLICT', 'Question already answered in this session');
  }

  // Fetch question to evaluate correctness. Questions are dual-sourced:
  // bank questions live in PostgreSQL, AI-generated ones in MongoDB —
  // ai_generated sessions store Mongo _ids in question_ids, so when the
  // Prisma lookup misses we fall back to the AIQuestion collection.
  const question = await prisma.question.findUnique({ where: { id: questionId } });

  let gradeSource: {
    question_text:  string;
    correct_answer: string;
    explanation?:   string;
    course_code:    string;
    topic:          string;
  } | null = null;
  let questionPayload: unknown = question;

  if (question) {
    gradeSource = {
      question_text:  question.question_text,
      correct_answer: question.correct_answer,
      explanation:    question.explanation ?? undefined,
      course_code:    question.course_code,
      topic:          question.topic,
    };
  } else if (/^[0-9a-fA-F]{24}$/.test(questionId)) {
    const aiQuestion = await AIQuestion.findOne({ _id: questionId, user_id: userId }).lean();
    if (aiQuestion) {
      gradeSource = {
        question_text:  aiQuestion.question_text,
        correct_answer: aiQuestion.correct_answer,
        explanation:    aiQuestion.explanation ?? undefined,
        course_code:    'AI',
        topic:          aiQuestion.topic,
      };
      questionPayload = aiQuestion;
    }
  }

  if (!gradeSource) {
    throw new AppError(404, 'NOT_FOUND', 'Question not found');
  }

  const isCorrect = chosenAnswer.trim().toUpperCase() === gradeSource.correct_answer.trim().toUpperCase();

  // Record answer
  const answer = await prisma.sessionAnswer.create({
    data: {
      session_id:    sessionId,
      question_id:   questionId,
      chosen_answer: chosenAnswer,
      is_correct:    isCorrect,
      time_taken_ms: timeTakenMs,
    },
  });

  // In practice mode, automatically stream AI feedback for incorrect answers
  if (!isCorrect) {
    const session = await prisma.quizSession.findUnique({
      where:  { id: params.sessionId },
      select: { mode: true, user_id: true, institution_id: true },
    });

    if (session?.mode === 'practice') {
      const io = getIO();
      if (io) {
        // Find the user's connected socket(s) and stream feedback
        const userRoom = `user:${params.userId}`;
        const sockets  = await io.in(userRoom).fetchSockets();

        if (sockets.length > 0) {
          // Fire-and-forget — don't block the HTTP response
          aiService.streamAnswerFeedback(
            sockets[0] as unknown as import('socket.io').Socket,
            {
              sessionId:     params.sessionId,
              questionId:    params.questionId,
              question:      gradeSource,
              chosenAnswer:  params.chosenAnswer,
              userId:        params.userId,
              institutionId: session.institution_id,
            },
          ).catch((err: unknown) => {
            logger.error({ err, sessionId: params.sessionId }, 'Auto AI feedback failed');
          });
        }
      }
    }
  }

  return { answer, is_correct: isCorrect, correct_answer: gradeSource.correct_answer, question: questionPayload };
}

// ─── Submit Answers (batch) ────────────────────────────────────────────────────

export interface BatchAnswerInput {
  question_id:   string;
  chosen_answer: string;
  time_taken_ms: number;
}

export interface BatchAnswerResult {
  question_id:      string;
  is_correct:       boolean;
  correct_answer:   string;
  /** True when this question already had an answer — the stored one is returned. */
  already_answered: boolean;
}

/**
 * Submit many answers in one request — the exam-mode path.
 *
 * Exam submits are silent by design (no per-question feedback is shown), so the
 * per-answer round trip bought nothing during the exam: a 40-question exam cost
 * 42 requests, and the server repeated the session lookup, the duplicate check and
 * the question fetch 40 times over. This does each once and one bulk insert.
 *
 * Deliberately does NOT stream AI tutor feedback. That is what makes practice mode
 * worth its per-answer round trip, and the backend only streams to an already
 * connected socket — so practice keeps using `submitAnswer` and this stays the
 * quiet bulk path.
 *
 * Idempotent per item rather than all-or-nothing: a question that already has an
 * answer comes back with `already_answered: true` and the STORED verdict instead
 * of failing the batch. A retried flush after a dropped response must not 409 the
 * whole exam.
 */
export async function submitAnswers(params: {
  sessionId: string;
  userId:    string;
  answers:   BatchAnswerInput[];
}): Promise<{ results: BatchAnswerResult[] }> {
  const { sessionId, userId, answers } = params;

  const session = await prisma.quizSession.findFirst({
    where: { id: sessionId, user_id: userId },
  });

  if (!session) {
    throw new AppError(404, 'NOT_FOUND', 'Session not found');
  }

  if (session.completed_at) {
    throw new AppError(400, 'CONFLICT', 'This session is already completed');
  }

  // Reject the whole batch if any question is foreign to the session — that is a
  // client bug, not a race, and silently dropping it would corrupt the score.
  const sessionQuestionIds = new Set(session.question_ids);
  for (const item of answers) {
    if (!sessionQuestionIds.has(item.question_id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Question does not belong to this session');
    }
  }

  // Last write wins within one payload, so a duplicated question_id can't produce
  // two rows for the same question.
  const deduped = [...new Map(answers.map((a) => [a.question_id, a])).values()];
  const questionIds = deduped.map((a) => a.question_id);

  const existing = await prisma.sessionAnswer.findMany({
    where:  { session_id: sessionId, question_id: { in: questionIds } },
    select: { question_id: true, is_correct: true },
  });
  const existingByQuestion = new Map(existing.map((a) => [a.question_id, a]));

  // Questions are dual-sourced exactly as in `submitAnswer` and `completeSession`:
  // bank questions live in PostgreSQL, AI-generated ones in MongoDB.
  const bankQuestions = await prisma.question.findMany({
    where:  { id: { in: questionIds } },
    select: { id: true, correct_answer: true },
  });
  const correctByQuestion = new Map(bankQuestions.map((q) => [q.id, q.correct_answer]));

  const mongoIds = questionIds.filter(
    (id) => !correctByQuestion.has(id) && /^[0-9a-fA-F]{24}$/.test(id),
  );
  if (mongoIds.length > 0) {
    const aiQuestions = await AIQuestion.find(
      { _id: { $in: mongoIds }, user_id: userId },
      { correct_answer: 1 },
    ).lean();
    for (const q of aiQuestions) {
      correctByQuestion.set((q._id as { toString(): string }).toString(), q.correct_answer);
    }
  }

  const results: BatchAnswerResult[] = [];
  const toCreate: {
    session_id:    string;
    question_id:   string;
    chosen_answer: string;
    is_correct:    boolean;
    time_taken_ms: number;
  }[] = [];

  for (const item of deduped) {
    const correctAnswer = correctByQuestion.get(item.question_id);
    if (correctAnswer === undefined) {
      throw new AppError(404, 'NOT_FOUND', `Question not found: ${item.question_id}`);
    }

    const previous = existingByQuestion.get(item.question_id);
    if (previous) {
      results.push({
        question_id:      item.question_id,
        is_correct:       previous.is_correct,
        correct_answer:   correctAnswer,
        already_answered: true,
      });
      continue;
    }

    // Same rule as `submitAnswer`, so a client grading offline agrees with us.
    const isCorrect =
      item.chosen_answer.trim().toUpperCase() === correctAnswer.trim().toUpperCase();

    toCreate.push({
      session_id:    sessionId,
      question_id:   item.question_id,
      chosen_answer: item.chosen_answer,
      is_correct:    isCorrect,
      time_taken_ms: item.time_taken_ms,
    });

    results.push({
      question_id:      item.question_id,
      is_correct:       isCorrect,
      correct_answer:   correctAnswer,
      already_answered: false,
    });
  }

  if (toCreate.length > 0) {
    await prisma.sessionAnswer.createMany({ data: toCreate });
  }

  logger.info(
    { sessionId, submitted: toCreate.length, skipped: deduped.length - toCreate.length },
    'Batch answers submitted',
  );

  return { results };
}

// ─── Complete Session ──────────────────────────────────────────────────────────

export async function completeSession(sessionId: string, userId: string) {
  const session = await prisma.quizSession.findFirst({
    where:   { id: sessionId, user_id: userId },
    include: { answers: true },
  });

  if (!session) {
    throw new AppError(404, 'NOT_FOUND', 'Session not found');
  }

  if (session.completed_at) {
    throw new AppError(409, 'CONFLICT', 'Session is already completed');
  }

  const correctCount = session.answers.filter((a: { is_correct: boolean }) => a.is_correct).length;
  const scorePercent = calculateScorePercent(correctCount, session.total_questions);

  const startTime = session.started_at.getTime();
  const timeTakenSecs = Math.floor((Date.now() - startTime) / 1000);

  // Update session
  const completedSession = await prisma.quizSession.update({
    where: { id: sessionId },
    data: {
      completed_at:    new Date(),
      score_percent:   scorePercent,
      correct_count:   correctCount,
      time_taken_secs: timeTakenSecs,
    },
    include: { answers: true },
  });

  // Process gamification
  const { xpEarned, badges_earned } = await gamificationService.processSessionComplete(
    userId,
    completedSession,
  );

  logger.info({ userId, sessionId, scorePercent, xpEarned }, 'Session completed');

  return {
    score_percent:    scorePercent,
    correct_count:    correctCount,
    total_questions:  session.total_questions,
    time_taken_secs:  timeTakenSecs,
    xp_earned:        xpEarned,
    badges_earned,
  };
}

// ─── Get Session Detail ────────────────────────────────────────────────────────

export async function getSessionDetail(sessionId: string, userId: string) {
  const session = await prisma.quizSession.findFirst({
    where:   { id: sessionId, user_id: userId },
    include: { answers: true },
  });

  if (!session) {
    throw new AppError(404, 'NOT_FOUND', 'Session not found');
  }

  // Fetch questions — dual-sourced like submitAnswer: ids the Prisma lookup
  // misses are Mongo _ids from an ai_generated session.
  const bankQuestions = await prisma.question.findMany({
    where: { id: { in: session.question_ids } },
  });

  const foundIds = new Set(bankQuestions.map((q: { id: string }) => q.id));
  const mongoIds = session.question_ids.filter(
    (id: string) => !foundIds.has(id) && /^[0-9a-fA-F]{24}$/.test(id),
  );
  const aiQuestions = mongoIds.length > 0
    ? await AIQuestion.find({ _id: { $in: mongoIds }, user_id: userId }).lean()
    : [];

  const questions = [...bankQuestions, ...aiQuestions];

  // Fetch AI feedback for wrong answers
  const feedbackIds = session.answers.flatMap(
    (a: { ai_feedback_id: string | null }) => (a.ai_feedback_id ? [a.ai_feedback_id] : []),
  );

  const feedbacks = feedbackIds.length > 0
    ? await AIFeedback.find({ _id: { $in: feedbackIds } }).lean()
    : [];

  const feedbackMap = new Map(feedbacks.map((f) => [(f._id as { toString(): string }).toString(), f]));

  return {
    session,
    questions,
    answers: session.answers.map((a: Record<string, unknown>) => ({
      ...a,
      ai_feedback: a.ai_feedback_id ? feedbackMap.get(a.ai_feedback_id as string) : null,
    })),
  };
}

export const sessionService = {
  createSession,
  submitAnswer,
  submitAnswers,
  completeSession,
  getSessionDetail,
};
