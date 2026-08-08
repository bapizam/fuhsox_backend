import prisma from '@config/database';
import { AIQuestion, AIFeedback } from '../../mongo/schemas';
import { AppError } from '@typings/models';
import { calculateScorePercent } from '@utils/xp';
import { parseOptions, type McqOption } from '@utils/mcq';
import {
  classifyAnswerSubmission,
  countsTowardsItemStats,
  needsGrading,
} from '@utils/answer-revision';
import { gamificationService } from './gamification.service';
import logger from '@lib/logger';
import { getIO } from '@lib/socket-ref';
import { aiService, exactMatchGrade, type AnswerToGrade } from './ai.service';
import { gradedScore, hasAnswerKey } from '@utils/gradability';

// ─── Empirical difficulty (reformation Phase 2) ────────────────────────────────

/**
 * Record what actually happened to an AI-generated item.
 *
 * `AIQuestion.difficulty` is the LLM's self-label; these counters are the evidence.
 * Once an item has been answered enough times, `correct_count / seen_count` is a
 * real p-value and the mastery-check draw balances on THAT instead of the guess
 * (see `utils/pool.ts`).
 *
 * A cross-store write on the grading path, so it is fire-and-forget: a Mongo blip
 * must never fail an answer the student already gave. The counters are analytics,
 * not the record of the attempt — that lives in `session_answers`.
 */
/**
 * True when the student PRODUCES the answer rather than picking one. Everything
 * that is not an MCQ is free-response — `short_answer`, `fill_blank`, `numeric`
 * and the bank's `essay` — and none of them can be graded by string equality.
 */
function isFreeResponse(questionType: string | undefined): boolean {
  return questionType !== undefined && questionType !== 'mcq';
}

function recordItemOutcomes(outcomes: { questionId: string; isCorrect: boolean }[]): void {
  const mongoOutcomes = outcomes.filter((o) => /^[0-9a-fA-F]{24}$/.test(o.questionId));
  if (mongoOutcomes.length === 0) return;

  void AIQuestion.bulkWrite(
    mongoOutcomes.map((o) => ({
      updateOne: {
        filter: { _id: o.questionId },
        update: { $inc: { seen_count: 1, correct_count: o.isCorrect ? 1 : 0 } },
      },
    })),
    { ordered: false },
  ).catch((err: unknown) => {
    logger.warn({ err, count: mongoOutcomes.length }, 'Failed to record item difficulty counters');
  });
}

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
  /** Self-reported 1–5, captured before the verdict (reformation Phase 3). */
  confidence?:  number;
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
    /** Null for an imported item whose answer key was never published. */
    correct_answer: string | null;
    explanation?:   string;
    course_code:    string;
    topic:          string;
    /** Non-MCQ items need the AI grader, not string equality (Phase 2). */
    question_type?: string;
    rubric?:        string;
    /**
     * The MCQ choices. Carried so the tutor prompt can name what the student
     * actually picked — it used to see only the letter "A" and was asked to
     * explain a misconception it had no way to see.
     */
    options?:       McqOption[];
  } | null = null;
  let questionPayload: unknown = question;

  if (question) {
    gradeSource = {
      question_text:  question.question_text,
      correct_answer: question.correct_answer,
      explanation:    question.explanation ?? undefined,
      course_code:    question.course_code,
      topic:          question.topic,
      question_type:  question.question_type,
      options:        parseOptions(question.options),
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
        question_type:  aiQuestion.question_type,
        rubric:         aiQuestion.rubric ?? undefined,
        options:        parseOptions(aiQuestion.options),
      };
      questionPayload = aiQuestion;
    }
  }

  if (!gradeSource) {
    throw new AppError(404, 'NOT_FOUND', 'Question not found');
  }

  // MCQ letters grade by exact match; anything the student WRITES is graded by the
  // AI, because "raises cardiac output" and "increases CO" are the same answer and
  // only one of them ever matched a string comparison (reformation Phase 2).
  // `gradeAnswers` degrades to exact match on budget/provider failure, so this
  // path can never fail an answer the student already gave.
  //
  // BUDGET: unlike the batch path, practice is per-answer, so a typed answer costs
  // one credit to grade and — if it is wrong — a second to stream tutor feedback
  // below. Ten wrong typed answers can therefore exhaust a 20/day budget in one
  // session. Accepted as-is (2026-07-23): the degradation is graceful and the
  // common path (mastery checks) batches to a single call. If students start
  // hitting AI_LIMIT_REACHED here, the fix is to fold the verdict into the feedback
  // stream so a wrong typed answer costs one credit rather than two.
  // FAIL-CLOSED: an item with no answer key is ungradable, not wrong. Note this
  // short-circuits BEFORE the AI grader — asking a model to mark an answer
  // against a key we don't have is how an invented answer becomes a stored fact.
  const key = gradeSource.correct_answer;
  const gradable = hasAnswerKey(key);

  const isCorrect =
    !gradable || key === null
      ? false
      : isFreeResponse(gradeSource.question_type)
        ? (
            await aiService.gradeAnswer({
              item: {
                question_text:  gradeSource.question_text,
                correct_answer: key,
                rubric:         gradeSource.rubric,
                question_type:  gradeSource.question_type,
                student_answer: chosenAnswer,
              },
              userId,
              institutionId: session.institution_id,
            })
          ).is_correct
        : exactMatchGrade(chosenAnswer, key);

  // Record answer
  const answer = await prisma.sessionAnswer.create({
    data: {
      session_id:    sessionId,
      question_id:   questionId,
      chosen_answer: chosenAnswer,
      is_correct:    isCorrect,
      gradable,
      time_taken_ms: timeTakenMs,
      confidence:    params.confidence ?? null,
    },
  });

  // Empirical difficulty is a p-value over real outcomes; an ungradable item has
  // no outcome, and folding its forced `false` in would make every unkeyed
  // question look maximally hard.
  if (gradable) recordItemOutcomes([{ questionId, isCorrect }]);

  // In practice mode, automatically stream AI feedback for incorrect answers.
  // Never for an ungradable one: `isCorrect` is false there by construction, and
  // the tutor would confidently explain a mistake nobody established was made.
  if (!isCorrect && hasAnswerKey(key)) {
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
              // `key` rather than `gradeSource.correct_answer`: the guard above
              // narrowed it to a real string, so the tutor prompt cannot be built
              // around a null the way the field's type still permits.
              question:      { ...gradeSource, correct_answer: key },
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
  /** Self-reported 1–5, captured before the verdict (reformation Phase 3). */
  confidence?:   number;
}

export interface BatchAnswerResult {
  question_id:      string;
  is_correct:       boolean;
  /** Null for an item with no published answer key; pair with `gradable`. */
  correct_answer:   string | null;
  /** False when the item had no key — `is_correct` is then meaningless, not wrong. */
  gradable:         boolean;
  /**
   * True when the stored answer was kept as-is — i.e. this submission repeated an
   * answer already on file. A submission that CHANGES the answer is not
   * "already answered": it replaces the row and comes back with the new verdict.
   */
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
 * Idempotent per item rather than all-or-nothing: re-submitting the SAME answer
 * comes back with `already_answered: true` and the stored verdict instead of
 * failing the batch. A retried flush after a dropped response must not 409 the
 * whole exam.
 *
 * **A DIFFERENT answer replaces the stored one** while the session is open. This
 * is what lets a student walk back through an exam and change their mind before
 * submitting — a paper you cannot revise is not a paper. The window closes at
 * `completed_at`, which is checked above, so a finished exam is still immutable.
 * Note that only this bulk path allows it: `submitAnswer` (practice) still 409s,
 * because practice reveals the verdict immediately and revising after seeing the
 * answer would not be a revision.
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
    select: { id: true, question_id: true, is_correct: true, chosen_answer: true },
  });
  const existingByQuestion = new Map(existing.map((a) => [a.question_id, a]));

  /** new / repeat / revision — see `utils/answer-revision` for why it matters. */
  const classify = (item: BatchAnswerInput) =>
    classifyAnswerSubmission(existingByQuestion.get(item.question_id), item);

  // Questions are dual-sourced exactly as in `submitAnswer` and `completeSession`:
  // bank questions live in PostgreSQL, AI-generated ones in MongoDB.
  const bankQuestions = await prisma.question.findMany({
    where:  { id: { in: questionIds } },
    select: { id: true, correct_answer: true, question_text: true, question_type: true },
  });

  interface GradeSource {
    /** Null for an imported item whose answer key was never published. */
    correct_answer: string | null;
    question_text:  string;
    question_type:  string;
    rubric?:        string;
  }

  const sourceByQuestion = new Map<string, GradeSource>(
    bankQuestions.map((q) => [
      q.id,
      {
        correct_answer: q.correct_answer,
        question_text:  q.question_text,
        question_type:  q.question_type,
      },
    ]),
  );

  const mongoIds = questionIds.filter(
    (id) => !sourceByQuestion.has(id) && /^[0-9a-fA-F]{24}$/.test(id),
  );
  if (mongoIds.length > 0) {
    const aiQuestions = await AIQuestion.find(
      { _id: { $in: mongoIds }, user_id: userId },
      { correct_answer: 1, question_text: 1, question_type: 1, rubric: 1 },
    ).lean();
    for (const q of aiQuestions) {
      sourceByQuestion.set((q._id as { toString(): string }).toString(), {
        correct_answer: q.correct_answer,
        question_text:  q.question_text,
        question_type:  q.question_type,
        rubric:         q.rubric ?? undefined,
      });
    }
  }

  /**
   * Free-response items in the batch are graded by the AI in ONE call for the whole
   * set (reformation Phase 2). Batching matters: a per-item call would put a single
   * silent paper at N credits against a 20/day budget shared with generation,
   * planning and tutor feedback. MCQ items never reach the grader.
   *
   * The grader falls back to exact match internally when the budget is spent or the
   * provider is down, so an exam or mastery check always submits.
   *
   * **EXAM MODE IS DELIBERATELY NOT RESTRICTED TO MCQ** (decided 2026-07-23). The
   * Phase 2 handoff proposed keeping exams MCQ-only to protect the offline story;
   * the guarantee that actually protects it is the fallback above — grading can
   * degrade, but a submit can never be blocked or rate-limited. The residual cost
   * is that a fully-offline exam shows the client's provisional exact-match verdict
   * for typed answers until the batch syncs, at which point the server's verdict
   * overwrites it. `completeSession` scores from the stored rows and flushes first,
   * so the FINAL score is always the AI verdict. Do not "fix" this by excluding
   * non-MCQ items from exams without revisiting that decision.
   */
  const toGrade: { questionId: string; item: AnswerToGrade }[] = [];
  for (const item of deduped) {
    const source = sourceByQuestion.get(item.question_id);
    // A repeat costs nothing: its verdict is already stored. A REVISION is graded
    // afresh, because the text the grader saw is no longer the text on file.
    if (!source || !needsGrading(classify(item))) continue;
    if (!isFreeResponse(source.question_type)) continue;
    // FAIL-CLOSED: never send an unkeyed item to the grader. It would have
    // nothing to mark against, and would mark something anyway.
    if (!hasAnswerKey(source.correct_answer)) continue;
    toGrade.push({
      questionId: item.question_id,
      item: {
        question_text:  source.question_text,
        correct_answer: source.correct_answer,
        rubric:         source.rubric,
        question_type:  source.question_type,
        student_answer: item.chosen_answer,
      },
    });
  }

  const aiVerdicts = new Map<string, boolean>();
  if (toGrade.length > 0) {
    const grades = await aiService.gradeAnswers({
      items:         toGrade.map((g) => g.item),
      userId,
      institutionId: session.institution_id,
    });
    toGrade.forEach((g, index) => {
      const grade = grades[index];
      if (grade) aiVerdicts.set(g.questionId, grade.is_correct);
    });
  }

  const results: BatchAnswerResult[] = [];
  const toCreate: {
    session_id:    string;
    question_id:   string;
    chosen_answer: string;
    is_correct:    boolean;
    gradable:      boolean;
    time_taken_ms: number;
    confidence:    number | null;
  }[] = [];

  const toUpdate: {
    id:            string;
    chosen_answer: string;
    is_correct:    boolean;
    gradable:      boolean;
    time_taken_ms: number;
    confidence:    number | null;
  }[] = [];

  for (const item of deduped) {
    const source = sourceByQuestion.get(item.question_id);
    if (source === undefined) {
      throw new AppError(404, 'NOT_FOUND', `Question not found: ${item.question_id}`);
    }
    const correctAnswer = source.correct_answer;
    const gradable = hasAnswerKey(correctAnswer);

    const previous = existingByQuestion.get(item.question_id);
    if (previous && classify(item) === 'repeat') {
      results.push({
        question_id:      item.question_id,
        is_correct:       previous.is_correct,
        correct_answer:   correctAnswer,
        gradable,
        already_answered: true,
      });
      continue;
    }

    // MCQ uses the same rule as `submitAnswer`, so a client grading offline agrees
    // with us. Free-response takes the AI verdict resolved above — the client's
    // offline exact-match guess is overwritten when the batch lands.
    //
    // FAIL-CLOSED: an unkeyed item was never sent to the grader, so it has no
    // verdict to take, and exact-matching against null is not a comparison worth
    // making. It records false + ungradable and is scored by neither side.
    const isCorrect =
      !gradable || correctAnswer === null
        ? false
        : (aiVerdicts.get(item.question_id) ?? exactMatchGrade(item.chosen_answer, correctAnswer));

    if (previous) {
      toUpdate.push({
        id:            previous.id,
        chosen_answer: item.chosen_answer,
        is_correct:    isCorrect,
        gradable,
        time_taken_ms: item.time_taken_ms,
        confidence:    item.confidence ?? null,
      });
    } else {
      toCreate.push({
        session_id:    sessionId,
        question_id:   item.question_id,
        chosen_answer: item.chosen_answer,
        is_correct:    isCorrect,
        gradable,
        time_taken_ms: item.time_taken_ms,
        confidence:    item.confidence ?? null,
      });
    }

    results.push({
      question_id:      item.question_id,
      is_correct:       isCorrect,
      correct_answer:   correctAnswer,
      gradable,
      already_answered: false,
    });
  }

  if (toCreate.length > 0) {
    await prisma.sessionAnswer.createMany({ data: toCreate });
  }

  if (toUpdate.length > 0) {
    await prisma.$transaction(
      toUpdate.map((a) =>
        prisma.sessionAnswer.update({
          where: { id: a.id },
          data:  {
            chosen_answer: a.chosen_answer,
            is_correct:    a.is_correct,
            time_taken_ms: a.time_taken_ms,
            confidence:    a.confidence,
          },
        }),
      ),
    );
  }

  /**
   * Empirical item difficulty counts FIRST attempts only — see
   * `countsTowardsItemStats`. A revision would otherwise let one student
   * contribute two outcomes for the same item, skewing the very statistic the
   * pool rotation ranks on.
   */
  const statsWorthy = deduped.filter((item) => countsTowardsItemStats(classify(item)));
  if (statsWorthy.length > 0) {
    const verdictByQuestion = new Map(results.map((r) => [r.question_id, r.is_correct]));
    recordItemOutcomes(
      statsWorthy.map((a) => ({
        questionId: a.question_id,
        isCorrect:  verdictByQuestion.get(a.question_id) ?? false,
      })),
    );
  }

  logger.info(
    {
      sessionId,
      submitted: toCreate.length,
      revised:   toUpdate.length,
      unchanged: deduped.length - toCreate.length - toUpdate.length,
      ai_graded: aiVerdicts.size,
    },
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

  /**
   * Scored over the answers that could actually be graded, not over
   * `total_questions`.
   *
   * The two differ only when the paper contained an item with no answer key —
   * an imported past paper, typically. Scoring such a session out of
   * `total_questions` would fail a student on a question nothing could mark:
   * seven of eight correct reads as 87.5% against a 90% gate, and the eighth
   * was never markable in either direction.
   *
   * A session where NOTHING was gradable scores 0 with `gradable: 0`. That is
   * "no evidence", not "scored zero" — which is why the mastery path checks the
   * count before recording an attempt.
   */
  const score = gradedScore(session.answers);
  const correctCount = score.correct;
  const scorePercent = calculateScorePercent(correctCount, score.gradable);

  if (score.skipped > 0) {
    logger.info(
      { sessionId, skipped: score.skipped, gradable: score.gradable },
      'Session contained items with no answer key — excluded from scoring',
    );
  }

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
