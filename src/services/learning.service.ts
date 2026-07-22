/**
 * Adaptive learning engine (M7 item 4) — resources → syllabus → objectives →
 * evidence of mastery.
 *
 * Two rules shape everything here:
 *
 * 1. **A mastery check IS a quiz.** It creates a normal `QuizSession` with
 *    `mode: 'mastery_check'` and Mongo question ids, so it inherits grading, the
 *    offline queue, resume, XP and the results screen. There is deliberately no
 *    parallel assessment engine.
 *
 * 2. **AI calls are the scarce resource** (20/day, shared with question generation
 *    and quiz feedback). So: syllabus structure is extracted ONCE per resource,
 *    objectives ONCE per chapter and only when opened, and an objective's question
 *    pool ONCE for its lifetime — every repeat attempt draws from the cache. All
 *    analytics are pure arithmetic in `utils/mastery.ts` and cost nothing.
 */
import prisma from '@config/database';
import { AIQuestion } from '../../mongo/schemas';
import { AppError } from '@typings/models';
import { MASTERY_CHECK, REDIS_KEYS } from '@config/constants';
import { getCount, getEndOfDayTTL, getTodayWAT, incrWithExpiry } from '@lib/redis';
import { downloadFromStorage, extractPdfText } from '@lib/pdf';
import { aiService } from './ai.service';
import {
  MASTERY,
  applyAttempt,
  computeConfidence,
  effectiveState,
  examReadiness,
  revisionPriority,
  topicMastery,
  type ObjectiveSnapshot,
} from '@utils/mastery';
import logger from '@lib/logger';

// ─── Resources ────────────────────────────────────────────────────────────────

export async function createResource(params: {
  userId:        string;
  institutionId: string;
  title:         string;
  kind:          'textbook' | 'notes' | 'pdf' | 'outline' | 'past_questions' | 'video_playlist';
  fileUrl?:      string;
  sourceUrl?:    string;
  courseCode?:   string;
}) {
  return prisma.learningResource.create({
    data: {
      user_id:        params.userId,
      institution_id: params.institutionId,
      title:          params.title,
      kind:           params.kind,
      file_url:       params.fileUrl ?? null,
      source_url:     params.sourceUrl ?? null,
      course_code:    params.courseCode ?? null,
      // A typed outline needs no parsing; an upload waits for extraction.
      parse_status:   params.fileUrl ? 'processing' : 'complete',
    },
  });
}

export async function listResources(userId: string) {
  return prisma.learningResource.findMany({
    where:   { user_id: userId },
    orderBy: { created_at: 'desc' },
    include: {
      nodes:  { orderBy: { ordinal: 'asc' } },
      _count: { select: { objectives: true } },
    },
  });
}

/** Ownership-checked fetch — every mutation below funnels through this. */
async function ownedResource(resourceId: string, userId: string) {
  const resource = await prisma.learningResource.findFirst({
    where: { id: resourceId, user_id: userId },
  });
  if (!resource) throw new AppError(404, 'NOT_FOUND', 'Resource not found');
  return resource;
}

export async function deleteResource(resourceId: string, userId: string) {
  await ownedResource(resourceId, userId);
  // Nodes cascade; objectives keep their history with node_id set null.
  await prisma.learningResource.delete({ where: { id: resourceId } });
  return { deleted: true };
}

// ─── Syllabus structure ───────────────────────────────────────────────────────

export interface OutlineChapter {
  title:    string;
  sections?: string[];
}

/**
 * Build the syllabus tree from a chapter list the student typed in. **Zero AI
 * calls** — this is the path that always works: a printed textbook, a lecturer's
 * handout, a PDF that refused to parse.
 *
 * Replaces any existing structure for the resource, so re-submitting is an edit.
 */
export async function setManualOutline(params: {
  resourceId: string;
  userId:     string;
  chapters:   OutlineChapter[];
}) {
  await ownedResource(params.resourceId, params.userId);

  await prisma.syllabusNode.deleteMany({ where: { resource_id: params.resourceId } });

  for (const [index, chapter] of params.chapters.entries()) {
    const parent = await prisma.syllabusNode.create({
      data: {
        resource_id: params.resourceId,
        title:       chapter.title,
        ordinal:     index,
        depth:       0,
      },
    });

    if (chapter.sections?.length) {
      await prisma.syllabusNode.createMany({
        data: chapter.sections.map((title, sectionIndex) => ({
          resource_id: params.resourceId,
          parent_id:   parent.id,
          title,
          ordinal:     sectionIndex,
          depth:       1,
        })),
      });
    }
  }

  await prisma.learningResource.update({
    where: { id: params.resourceId },
    data:  { parse_status: 'complete', parse_error: null },
  });

  return listNodes(params.resourceId);
}

/** Record the uploaded file against a resource and mark it ready to extract. */
export async function attachFile(params: {
  resourceId: string;
  userId:     string;
  fileUrl:    string;
}) {
  await ownedResource(params.resourceId, params.userId);
  return prisma.learningResource.update({
    where: { id: params.resourceId },
    data:  { file_url: params.fileUrl, parse_status: 'processing', parse_error: null },
  });
}

export async function listNodes(resourceId: string) {
  return prisma.syllabusNode.findMany({
    where:   { resource_id: resourceId },
    orderBy: [{ depth: 'asc' }, { ordinal: 'asc' }],
  });
}

/**
 * Extract chapter/section structure from a resource's text with ONE AI call, then
 * cache it as SyllabusNode rows forever. Re-running on a resource that already has
 * nodes is a no-op rather than a second charge.
 */
export async function extractSyllabus(params: {
  resourceId:    string;
  userId:        string;
  institutionId: string;
  text:          string;
}) {
  const resource = await ownedResource(params.resourceId, params.userId);

  const existing = await prisma.syllabusNode.count({ where: { resource_id: params.resourceId } });
  if (existing > 0) return listNodes(params.resourceId);

  try {
    const chapters = await aiService.extractSyllabusStructure({
      text:          params.text,
      title:         resource.title,
      userId:        params.userId,
      institutionId: params.institutionId,
    });

    if (chapters.length === 0) {
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Could not find any chapter structure in that document. Try adding the outline manually.',
      );
    }

    return await setManualOutline({
      resourceId: params.resourceId,
      userId:     params.userId,
      chapters,
    });
  } catch (err) {
    await prisma.learningResource.update({
      where: { id: params.resourceId },
      data:  {
        parse_status: 'failed',
        parse_error:  err instanceof AppError ? err.message : 'Extraction failed',
      },
    });
    throw err;
  }
}

/**
 * Download the resource's PDF, pull its text, and extract the structure.
 *
 * A PDF with no text layer (a scan or photo of a page) is the common real-world
 * failure. It fails with a message that points at the manual outline rather than
 * a generic error, because that path always works.
 */
export async function extractSyllabusFromFile(params: {
  resourceId:    string;
  userId:        string;
  institutionId: string;
}) {
  const resource = await ownedResource(params.resourceId, params.userId);
  if (!resource.file_url) {
    throw new AppError(400, 'VALIDATION_ERROR', 'This resource has no uploaded file');
  }

  const existing = await prisma.syllabusNode.count({ where: { resource_id: params.resourceId } });
  if (existing > 0) return listNodes(params.resourceId);

  const buffer = await downloadFromStorage(resource.file_url);
  const text = await extractPdfText(buffer);

  if (!text.trim()) {
    await prisma.learningResource.update({
      where: { id: params.resourceId },
      data:  { parse_status: 'failed', parse_error: 'No readable text in the PDF' },
    });
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'That PDF has no readable text — it may be a scan. Add the chapter list manually instead.',
    );
  }

  return extractSyllabus({ ...params, text });
}

// ─── Objectives ───────────────────────────────────────────────────────────────

/**
 * Objectives for one chapter, generated on FIRST open and cached thereafter.
 *
 * On-demand rather than up-front is the budget decision: extracting a 20-chapter
 * textbook's objectives eagerly would consume an entire day's AI allowance in one
 * tap, for chapters the student may never study.
 */
export async function generateObjectivesForNode(params: {
  nodeId:        string;
  userId:        string;
  institutionId: string;
}) {
  const node = await prisma.syllabusNode.findFirst({
    where:   { id: params.nodeId },
    include: { resource: true },
  });
  if (node?.resource.user_id !== params.userId) {
    throw new AppError(404, 'NOT_FOUND', 'Chapter not found');
  }

  const existing = await prisma.learningObjective.findMany({
    where:   { node_id: params.nodeId, user_id: params.userId },
    orderBy: { created_at: 'asc' },
  });
  if (existing.length > 0) return existing;

  const subject = node.resource.course_code ?? node.resource.title;
  const drafted = await aiService.generateLearningObjectives({
    chapterTitle:  node.title,
    resourceTitle: node.resource.title,
    subject,
    userId:        params.userId,
    institutionId: params.institutionId,
  });

  if (drafted.length === 0) {
    throw new AppError(422, 'VALIDATION_ERROR', 'The AI returned no objectives for that chapter');
  }

  await prisma.learningObjective.createMany({
    data: drafted.map((objective) => ({
      user_id:     params.userId,
      resource_id: node.resource_id,
      node_id:     node.id,
      subject,
      statement:   objective.statement,
      bloom_level: objective.bloom_level,
    })),
  });

  return prisma.learningObjective.findMany({
    where:   { node_id: params.nodeId, user_id: params.userId },
    orderBy: { created_at: 'asc' },
  });
}

export async function listObjectives(userId: string, filters: { subject?: string; nodeId?: string }) {
  const objectives = await prisma.learningObjective.findMany({
    where: {
      user_id: userId,
      ...(filters.subject ? { subject: filters.subject } : {}),
      ...(filters.nodeId ? { node_id: filters.nodeId } : {}),
    },
    orderBy: { created_at: 'asc' },
  });

  // `state` on the row is the last transition; what the learner should SEE
  // accounts for decay. Computed on read so no cron is needed.
  const now = new Date();
  return objectives.map((objective) => ({
    ...objective,
    effective_state: effectiveState(objective.state, objective.next_review_at, now),
  }));
}

// ─── Mastery checks ───────────────────────────────────────────────────────────

async function ownedObjective(objectiveId: string, userId: string) {
  const objective = await prisma.learningObjective.findFirst({
    where: { id: objectiveId, user_id: userId },
  });
  if (!objective) throw new AppError(404, 'NOT_FOUND', 'Objective not found');
  return objective;
}

/** Institution policy, falling back to the module default. */
async function thresholdFor(institutionId: string): Promise<number> {
  const institution = await prisma.institution.findUnique({
    where:  { id: institutionId },
    select: { mastery_threshold: true },
  });
  return institution?.mastery_threshold ?? MASTERY.DEFAULT_THRESHOLD;
}

/**
 * The objective's cached question pool, generating it once if absent.
 * `POOL_SIZE` questions are produced across the Bloom mix, and each attempt draws
 * `QUESTION_COUNT` of them — so retries aren't the same paper twice, at no extra
 * AI cost after the first.
 */
async function ensureQuestionPool(params: {
  objectiveId:   string;
  statement:     string;
  subject:       string;
  userId:        string;
  institutionId: string;
}): Promise<{ id: string; bloom_level: string }[]> {
  const cached = await AIQuestion.find(
    { objective_id: params.objectiveId, user_id: params.userId },
    { bloom_level: 1 },
  ).lean();

  if (cached.length >= MASTERY_CHECK.QUESTION_COUNT) {
    return cached.map((q) => ({
      id:          (q._id as { toString(): string }).toString(),
      bloom_level: q.bloom_level ?? 'understand',
    }));
  }

  const generated = await aiService.generateMasteryQuestions({
    objective:     params.statement,
    subject:       params.subject,
    poolSize:      MASTERY_CHECK.POOL_SIZE,
    userId:        params.userId,
    institutionId: params.institutionId,
    objectiveId:   params.objectiveId,
  });

  return generated.map((q) => ({ id: q.id, bloom_level: q.bloom_level }));
}

/** Fisher-Yates draw of `count` items. */
function sample<T>(items: T[], count: number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export interface StartedMasteryCheck {
  session_id:       string;
  objective_id:     string;
  question_ids:     string[];
  threshold:        number;
  attempts_left_today: number;
}

/**
 * Begin an assessment for one objective. Enforces the daily attempt cap FIRST, so
 * a capped user never spends an AI call, and returns a session the existing quiz
 * runner can play unmodified.
 */
export async function startMasteryCheck(params: {
  objectiveId:   string;
  userId:        string;
  institutionId: string;
}): Promise<StartedMasteryCheck> {
  const objective = await ownedObjective(params.objectiveId, params.userId);

  const redisKey = REDIS_KEYS.MASTERY_ATTEMPTS(params.objectiveId, getTodayWAT());
  const usedToday = await getCount(redisKey);
  if (usedToday >= MASTERY_CHECK.MAX_ATTEMPTS_PER_DAY) {
    throw new AppError(
      429,
      'RATE_LIMITED',
      `You've used all ${MASTERY_CHECK.MAX_ATTEMPTS_PER_DAY} mastery checks for this objective today. Revise the weak areas and come back tomorrow.`,
    );
  }

  const pool = await ensureQuestionPool({
    objectiveId:   objective.id,
    statement:     objective.statement,
    subject:       objective.subject,
    userId:        params.userId,
    institutionId: params.institutionId,
  });

  const drawn = sample(pool, Math.min(MASTERY_CHECK.QUESTION_COUNT, pool.length));

  const session = await prisma.quizSession.create({
    data: {
      user_id:         params.userId,
      institution_id:  params.institutionId,
      mode:            'mastery_check',
      question_source: 'ai_generated',
      total_questions: drawn.length,
      question_ids:    drawn.map((q) => q.id),
    },
  });

  await incrWithExpiry(redisKey, getEndOfDayTTL());

  // First activity on an untouched objective moves it off not_started.
  if (objective.state === 'not_started') {
    await prisma.learningObjective.update({
      where: { id: objective.id },
      data:  { state: 'learning' },
    });
  }

  return {
    session_id:          session.id,
    objective_id:        objective.id,
    question_ids:        drawn.map((q) => q.id),
    threshold:           await thresholdFor(params.institutionId),
    attempts_left_today: MASTERY_CHECK.MAX_ATTEMPTS_PER_DAY - usedToday - 1,
  };
}

export interface BloomBreakdown {
  bloom_level: string;
  correct:     number;
  total:       number;
}

export interface MasteryCheckResult {
  objective_id:   string;
  passed:         boolean;
  score_percent:  number;
  threshold:      number;
  state:          string;
  mastery_score:  number;
  confidence:     number;
  weak_concepts:  string[];
  /** Per-Bloom partial credit — a near miss reads as "recall solid, application
   *  weak" instead of a bare fail. */
  breakdown:      BloomBreakdown[];
  next_review_at: Date | null;
}

/**
 * Score a finished mastery-check session and advance the objective. Costs **zero
 * AI calls** — grading already happened per answer, and everything here is the
 * arithmetic in `utils/mastery.ts`.
 */
export async function completeMasteryCheck(params: {
  objectiveId:   string;
  sessionId:     string;
  userId:        string;
  institutionId: string;
}): Promise<MasteryCheckResult> {
  const objective = await ownedObjective(params.objectiveId, params.userId);

  const session = await prisma.quizSession.findFirst({
    where:   { id: params.sessionId, user_id: params.userId },
    include: { answers: true },
  });
  if (!session) throw new AppError(404, 'NOT_FOUND', 'Session not found');
  if (session.mode !== 'mastery_check') {
    throw new AppError(400, 'VALIDATION_ERROR', 'That session is not a mastery check');
  }
  if (session.answers.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'No answers recorded for this session');
  }

  const correct = session.answers.filter((a) => a.is_correct).length;
  const scoreFraction = correct / session.total_questions;
  const threshold = await thresholdFor(params.institutionId);

  // Per-Bloom breakdown + the concepts actually missed, both read off the cached
  // question docs — no extra generation.
  const questions = await AIQuestion.find(
    { _id: { $in: session.question_ids }, user_id: params.userId },
    { bloom_level: 1, topic: 1 },
  ).lean();

  const levelById = new Map(
    questions.map((q) => [
      (q._id as { toString(): string }).toString(),
      q.bloom_level ?? 'understand',
    ]),
  );

  const buckets = new Map<string, { correct: number; total: number }>();
  const missed: string[] = [];
  for (const answer of session.answers) {
    const level = levelById.get(answer.question_id) ?? 'understand';
    const bucket = buckets.get(level) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (answer.is_correct) bucket.correct += 1;
    else missed.push(level);
    buckets.set(level, bucket);
  }

  const now = new Date();
  const outcome = applyAttempt({
    currentState:    objective.state,
    previousMastery: objective.mastery_score,
    priorAttempts:   objective.attempts,
    scoreFraction,
    threshold,
    lastVerifiedAt:  objective.last_verified_at,
    now,
  });

  const recentScores = (
    await prisma.masteryAttempt.findMany({
      where:   { objective_id: objective.id },
      orderBy: { created_at: 'desc' },
      take:    4,
      select:  { score_percent: true },
    })
  ).map((a) => a.score_percent / 100);
  const confidence = computeConfidence([scoreFraction, ...recentScores]);

  const weakConcepts = [...new Set(missed)];

  await prisma.$transaction([
    prisma.masteryAttempt.create({
      data: {
        objective_id:  objective.id,
        user_id:       params.userId,
        session_id:    session.id,
        score_percent: Math.round(scoreFraction * 10000) / 100,
        // Snapshotted so a later policy change can't retroactively pass or fail this.
        threshold,
        passed:        scoreFraction >= threshold,
        weak_concepts: weakConcepts,
      },
    }),
    prisma.learningObjective.update({
      where: { id: objective.id },
      data:  {
        state:            outcome.state,
        mastery_score:    outcome.masteryScore,
        confidence,
        attempts:         { increment: 1 },
        weak_concepts:    weakConcepts,
        last_attempt_at:  now,
        last_verified_at: outcome.lastVerifiedAt,
        next_review_at:   outcome.nextReviewAt,
      },
    }),
  ]);

  logger.info(
    { objectiveId: objective.id, scoreFraction, state: outcome.state },
    'Mastery check completed',
  );

  return {
    objective_id:   objective.id,
    passed:         scoreFraction >= threshold,
    score_percent:  Math.round(scoreFraction * 10000) / 100,
    threshold,
    state:          outcome.state,
    mastery_score:  outcome.masteryScore,
    confidence,
    weak_concepts:  weakConcepts,
    breakdown:      [...buckets.entries()].map(([bloom_level, b]) => ({
      bloom_level,
      correct: b.correct,
      total:   b.total,
    })),
    next_review_at: outcome.nextReviewAt,
  };
}

// ─── Learner model ────────────────────────────────────────────────────────────

/**
 * The analytics dashboard payload. **Zero AI calls** — every number is computed
 * from the objective rows, which is what makes an always-on analytics screen
 * affordable against a 20-call daily budget.
 */
export async function getLearnerModel(userId: string) {
  const objectives = await prisma.learningObjective.findMany({
    where: { user_id: userId },
    select: {
      id: true,
      subject: true,
      state: true,
      mastery_score: true,
      confidence: true,
      weight: true,
      next_review_at: true,
      statement: true,
    },
  });

  const now = new Date();
  const snapshots: ObjectiveSnapshot[] = objectives;

  const topics = topicMastery(snapshots, now);
  const priorities = revisionPriority(snapshots, now).slice(0, 10);
  const statementById = new Map(objectives.map((o) => [o.id, o.statement]));

  const dueForReview = objectives.filter(
    (o) => o.next_review_at !== null && o.next_review_at <= now,
  ).length;

  return {
    exam_readiness:    examReadiness(snapshots, now),
    objectives_total:  objectives.length,
    objectives_verified: snapshots.filter((o) =>
      ['verified', 'mastered'].includes(effectiveState(o.state, o.next_review_at, now)),
    ).length,
    due_for_review:    dueForReview,
    topics,
    strongest_topics:  topics.slice(0, 3),
    // Weakest last-first, so the UI can show "highest risk" without re-sorting.
    highest_risk_topics: [...topics].reverse().slice(0, 3),
    revision_priority: priorities.map((p) => ({
      ...p,
      statement: statementById.get(p.objective_id) ?? '',
    })),
  };
}

export const learningService = {
  createResource,
  listResources,
  deleteResource,
  attachFile,
  setManualOutline,
  extractSyllabusFromFile,
  listNodes,
  extractSyllabus,
  generateObjectivesForNode,
  listObjectives,
  startMasteryCheck,
  completeMasteryCheck,
  getLearnerModel,
};
