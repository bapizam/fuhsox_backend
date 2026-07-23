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
import { AIQuestion, ResourceChunk } from '../../mongo/schemas';
import { AppError } from '@typings/models';
import { MASTERY_CHECK, REDIS_KEYS } from '@config/constants';
import { getCount, getEndOfDayTTL, getTodayWAT, incrWithExpiry } from '@lib/redis';
import { downloadFromStorage, extractPdfText } from '@lib/pdf';
import { chunkText } from '@lib/chunk';
import { embedTexts, embeddingsAvailable } from '@lib/embeddings';
import { retrieveChunks } from '@lib/retrieval';
import { aiService } from './ai.service';
import {
  MASTERY,
  applyAttempt,
  calibration,
  computeConfidence,
  effectiveState,
  examReadiness,
  examReadinessBand,
  revisionPriority,
  topicMastery,
  wilsonInterval,
  type Calibration,
  type ObjectiveSnapshot,
} from '@utils/mastery';
import { selectForCheck, unseenShortfall, type PoolItem } from '@utils/pool';
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
  // Nodes cascade; objectives keep their history with node_id set null. The
  // grounding chunks live in Mongo (no FK), so drop them explicitly.
  await prisma.learningResource.delete({ where: { id: resourceId } });
  await deleteResourceChunks(resourceId);
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

  // Ingest the content for RAG grounding (reformation Phase 1) before structure
  // extraction. Best-effort: grounding is an enhancement, so a failure here must
  // not block the student getting their chapter list — generation just falls back
  // to ungrounded when no chunks exist.
  await ingestResourceChunks(params.resourceId, params.userId, text).catch((err) => {
    logger.warn({ err, resourceId: params.resourceId }, 'Resource chunk ingestion failed (non-fatal)');
  });

  return extractSyllabus({ ...params, text });
}

/**
 * Chunk + embed a resource's text into `ResourceChunk` rows for retrieval. Runs
 * once per resource (idempotent — skips if chunks already exist) and costs one AI
 * budget unit, like syllabus extraction. No-op when embeddings aren't configured.
 */
export async function ingestResourceChunks(
  resourceId: string,
  userId: string,
  text: string,
): Promise<void> {
  if (!embeddingsAvailable()) {
    logger.info({ resourceId }, 'Embeddings unconfigured — skipping grounding ingestion');
    return;
  }

  const existing = await ResourceChunk.countDocuments({ resource_id: resourceId });
  if (existing > 0) return;

  const chunks = chunkText(text);
  if (chunks.length === 0) return;

  const embeddings = await embedTexts(chunks.map((c) => c.text), 'document');

  await ResourceChunk.insertMany(
    chunks.map((c, i) => ({
      resource_id: resourceId,
      user_id:     userId,
      ordinal:     c.ordinal,
      text:        c.text,
      embedding:   embeddings[i],
    })),
  );

  logger.info({ resourceId, chunks: chunks.length }, 'Resource ingested for grounding');
}

/** Delete a resource's chunks — called when the resource itself is deleted. */
async function deleteResourceChunks(resourceId: string): Promise<void> {
  await ResourceChunk.deleteMany({ resource_id: resourceId }).catch(() => {});
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

  // Ground objectives in the chapter's actual content when the resource was
  // ingested (reformation Phase 1). Retrieval returns [] for a manually-typed
  // outline or an un-ingested resource, so generation cleanly falls back to
  // title-only.
  const grounding = await retrieveChunks(node.resource_id, node.title, 6).catch(() => []);

  const drafted = await aiService.generateLearningObjectives({
    chapterTitle:   node.title,
    resourceTitle:  node.resource.title,
    subject,
    groundingChunks: grounding.map((g) => g.text),
    userId:         params.userId,
    institutionId:  params.institutionId,
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

/** Load an objective's whole cached pool, with the fields the draw needs. */
async function loadPool(objectiveId: string, userId: string): Promise<PoolItem[]> {
  const cached = await AIQuestion.find(
    { objective_id: objectiveId, user_id: userId },
    { bloom_level: 1, difficulty: 1, seen_count: 1, correct_count: 1 },
  ).lean();

  return cached.map((q) => ({
    id:            (q._id as { toString(): string }).toString(),
    bloom_level:   q.bloom_level ?? 'understand',
    difficulty:    q.difficulty,
    seen_count:    q.seen_count ?? 0,
    correct_count: q.correct_count ?? 0,
  }));
}

/**
 * Every question id this user has already answered for this objective.
 *
 * Read off `SessionAnswer` rather than the session's `question_ids`, because a
 * check the student walked away from should not burn the items it never asked.
 *
 * `MasteryAttempt` is the only objective→session link that exists (a QuizSession
 * row carries no objective), so an ABANDONED check — one that never reached
 * `completeMasteryCheck` — leaves no attempt row and its items still read as
 * unseen. That is the conservative direction to be wrong in: the cost is
 * occasionally re-showing an item, not silently exhausting the pool.
 */
async function seenQuestionIds(objectiveId: string, userId: string): Promise<Set<string>> {
  const attempts = await prisma.masteryAttempt.findMany({
    where:  { objective_id: objectiveId, user_id: userId },
    select: { session_id: true },
  });

  const sessionIds = attempts.flatMap((a) => (a.session_id ? [a.session_id] : []));
  if (sessionIds.length === 0) return new Set();

  const answers = await prisma.sessionAnswer.findMany({
    where:  { session_id: { in: sessionIds } },
    select: { question_id: true },
  });

  return new Set(answers.map((a) => a.question_id));
}

/**
 * The objective's cached question pool, generated once if absent and GROWN when
 * the student has seen most of it (reformation Phase 2).
 *
 * The original design generated `POOL_SIZE` items once and drew `QUESTION_COUNT`
 * from them forever — so a motivated student saw heavy overlap across re-checks
 * and could memorize the pool. The daily cap throttled grinding per day, not over
 * time. Growth is lazy and bounded by `MAX_POOL_SIZE`: it costs an AI call only
 * when the student has actually earned it by exhausting the unseen items, and it
 * APPENDS (never replaces), so difficulty counters and history survive.
 */
async function ensureQuestionPool(params: {
  objectiveId:   string;
  statement:     string;
  subject:       string;
  /** Set for chapter objectives; null for topic (plan-task) objectives. Enables
   *  grounding the pool in the resource's content. */
  resourceId:    string | null;
  userId:        string;
  institutionId: string;
  /** Ids already answered — drives lazy growth. */
  seenIds:       Set<string>;
}): Promise<PoolItem[]> {
  const cached = await loadPool(params.objectiveId, params.userId);

  const shortfall = unseenShortfall(cached, params.seenIds, MASTERY_CHECK.QUESTION_COUNT);
  const canGrow = cached.length < MASTERY_CHECK.MAX_POOL_SIZE;

  // Enough unseen material for a full paper — the common case, and free.
  if (cached.length >= MASTERY_CHECK.QUESTION_COUNT && (shortfall === 0 || !canGrow)) {
    return cached;
  }

  // Ground the pool in the objective's source material when available (P1).
  const grounding = params.resourceId
    ? await retrieveChunks(params.resourceId, params.statement, 6).catch(() => [])
    : [];

  // A first generation builds the whole pool; a top-up asks only for the shortfall
  // (rounded up to a batch) so growing an exhausted pool is cheaper than seeding one.
  const isFirst = cached.length === 0;
  const requested = isFirst
    ? MASTERY_CHECK.POOL_SIZE
    : Math.min(
        Math.max(shortfall, MASTERY_CHECK.GROWTH_BATCH),
        MASTERY_CHECK.MAX_POOL_SIZE - cached.length,
      );

  try {
    await aiService.generateMasteryQuestions({
      objective:     params.statement,
      subject:       params.subject,
      poolSize:      requested,
      grounding:     grounding.map((g) => ({ text: g.text, page: g.page })),
      userId:        params.userId,
      institutionId: params.institutionId,
      objectiveId:   params.objectiveId,
    });
  } catch (err) {
    // A top-up that fails (budget spent, provider down) must not block the check —
    // the student falls back to a repeat of seen items, which is worse than fresh
    // ones and far better than being locked out of their own objective.
    if (isFirst) throw err;
    logger.warn(
      { err, objectiveId: params.objectiveId },
      'Pool growth failed; drawing from the existing pool',
    );
    return cached;
  }

  return loadPool(params.objectiveId, params.userId);
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
/**
 * Shared core: enforce the daily cap, ensure the pool, mint a mastery_check
 * session. Both entry points (an explicit objective, and a plan topic) funnel
 * through here so they can't drift on the cap or the caching discipline.
 */
async function beginCheckForObjective(
  objective: { id: string; statement: string; subject: string; state: string; resource_id: string | null },
  userId: string,
  institutionId: string,
): Promise<StartedMasteryCheck> {
  const redisKey = REDIS_KEYS.MASTERY_ATTEMPTS(objective.id, getTodayWAT());
  const usedToday = await getCount(redisKey);
  if (usedToday >= MASTERY_CHECK.MAX_ATTEMPTS_PER_DAY) {
    throw new AppError(
      429,
      'RATE_LIMITED',
      `You've used all ${MASTERY_CHECK.MAX_ATTEMPTS_PER_DAY} mastery checks for this today. Revise the weak areas and come back tomorrow.`,
    );
  }

  // Rotation (reformation Phase 2): the draw prefers items this student has never
  // seen, so a re-check is fresh evidence rather than a memory test of the pool.
  const seenIds = await seenQuestionIds(objective.id, userId);

  const pool = await ensureQuestionPool({
    objectiveId:   objective.id,
    statement:     objective.statement,
    subject:       objective.subject,
    resourceId:    objective.resource_id,
    userId,
    institutionId,
    seenIds,
  });

  const drawn = selectForCheck({
    pool,
    seenIds,
    count: Math.min(MASTERY_CHECK.QUESTION_COUNT, pool.length),
  });

  const session = await prisma.quizSession.create({
    data: {
      user_id:         userId,
      institution_id:  institutionId,
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
    threshold:           await thresholdFor(institutionId),
    attempts_left_today: MASTERY_CHECK.MAX_ATTEMPTS_PER_DAY - usedToday - 1,
  };
}

export async function startMasteryCheck(params: {
  objectiveId:   string;
  userId:        string;
  institutionId: string;
}): Promise<StartedMasteryCheck> {
  const objective = await ownedObjective(params.objectiveId, params.userId);
  return beginCheckForObjective(objective, params.userId, params.institutionId);
}

/**
 * Start a check from a study-plan task's topic — the evidence gate that replaced
 * the plan's "I've studied" checkbox.
 *
 * The plan's AI tasks are free-text topics with no objective row, so this upserts
 * a durable objective keyed by (user, subject, statement=topic). Deterministic on
 * purpose: verifying the same task again reuses the objective AND its cached
 * question pool, so a re-check costs no AI budget — and the topic's mastery, decay
 * and readiness all flow into the same learner model as chapter objectives, rather
 * than living in a parallel "did they tick it" world.
 */
export async function startTopicMasteryCheck(params: {
  userId:        string;
  institutionId: string;
  subject:       string;
  topic:         string;
}): Promise<StartedMasteryCheck> {
  const subject = params.subject.trim();
  const statement = params.topic.trim();
  if (!subject || !statement) {
    throw new AppError(400, 'VALIDATION_ERROR', 'A subject and topic are required to verify a task');
  }

  const existing = await prisma.learningObjective.findFirst({
    where: { user_id: params.userId, subject, statement },
  });

  const objective =
    existing ??
    (await prisma.learningObjective.create({
      data: {
        user_id:     params.userId,
        subject,
        statement,
        bloom_level: 'understand',
      },
    }));

  return beginCheckForObjective(objective, params.userId, params.institutionId);
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
  /**
   * 95% Wilson interval around `score_percent`, 0..100 (reformation Phase 2).
   *
   * An 8-item check is a high-variance estimate: one unlucky item swings 87.5% →
   * 75%, so the 90% gate was being applied to a measurement noisier than the thing
   * it gates. Showing the band is the honest version of the same number — and the
   * kinder one, because a near-miss reads as a range rather than a verdict.
   */
  score_interval: { low: number; high: number };
  threshold:      number;
  state:          string;
  mastery_score:  number;
  confidence:     number;
  weak_concepts:  string[];
  /** Per-Bloom partial credit — a near miss reads as "recall solid, application
   *  weak" instead of a bare fail. */
  breakdown:      BloomBreakdown[];
  /**
   * How well the student's self-rated confidence matched reality (Phase 3). Null
   * when no item carried a rating — an honest "not measured" rather than a zero
   * that would read as perfect calibration.
   */
  calibration:    Calibration | null;
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
    { bloom_level: 1, topic: 1, options: 1 },
  ).lean();

  const levelById = new Map<string, string>();
  // question id → (option key → the misconception that option represents).
  const misconceptionByQuestion = new Map<string, Map<string, string>>();
  for (const q of questions) {
    const id = (q._id as { toString(): string }).toString();
    levelById.set(id, q.bloom_level ?? 'understand');
    const optionMap = new Map<string, string>();
    for (const opt of q.options ?? []) {
      if (opt.key && opt.misconception) optionMap.set(opt.key.trim().toUpperCase(), opt.misconception);
    }
    misconceptionByQuestion.set(id, optionMap);
  }

  const buckets = new Map<string, { correct: number; total: number }>();
  // The REAL diagnosis (reformation Phase 1): the misconception behind the
  // distractor the student actually chose — not the Bloom level. Falls back to
  // Bloom levels only for legacy pools whose options carry no misconception tags.
  const misconceptions: string[] = [];
  const missedLevels: string[] = [];
  for (const answer of session.answers) {
    const level = levelById.get(answer.question_id) ?? 'understand';
    const bucket = buckets.get(level) ?? { correct: 0, total: 0 };
    bucket.total += 1;
    if (answer.is_correct) {
      bucket.correct += 1;
    } else {
      missedLevels.push(level);
      const chosen = answer.chosen_answer.trim().toUpperCase();
      const misconception = misconceptionByQuestion.get(answer.question_id)?.get(chosen);
      if (misconception) misconceptions.push(misconception);
    }
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
    // Null on an objective that predates Phase 3 — FSRS rebuilds from an empty
    // card, so no backfill is needed (reformation Phase 3).
    fsrs: {
      stability:  objective.fsrs_stability,
      difficulty: objective.fsrs_difficulty,
      reps:       objective.fsrs_reps,
      lapses:     objective.fsrs_lapses,
      state:      objective.fsrs_state,
      due:        objective.next_review_at,
      lastReview: objective.fsrs_last_review,
    },
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

  // Prefer real misconceptions; fall back to Bloom levels for legacy pools.
  const weakConcepts =
    misconceptions.length > 0 ? [...new Set(misconceptions)] : [...new Set(missedLevels)];

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
        // FSRS advances on every attempt, pass or fail — a lapse is information
        // the scheduler needs (reformation Phase 3).
        fsrs_stability:   outcome.fsrs.stability,
        fsrs_difficulty:  outcome.fsrs.difficulty,
        fsrs_reps:        outcome.fsrs.reps,
        fsrs_lapses:      outcome.fsrs.lapses,
        fsrs_state:       outcome.fsrs.state,
        fsrs_last_review: outcome.fsrs.lastReview,
      },
    }),
  ]);

  logger.info(
    { objectiveId: objective.id, scoreFraction, state: outcome.state },
    'Mastery check completed',
  );

  // The band is computed on the ATTEMPT (correct out of items asked), not on the
  // EWMA — it describes how precisely this one check measured the student.
  const interval = wilsonInterval(correct, session.total_questions);

  return {
    objective_id:   objective.id,
    passed:         scoreFraction >= threshold,
    score_percent:  Math.round(scoreFraction * 10000) / 100,
    score_interval: {
      low:  Math.round(interval.low * 10000) / 100,
      high: Math.round(interval.high * 10000) / 100,
    },
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
    calibration:    calibration(
      session.answers.map((a) => ({ confidence: a.confidence, isCorrect: a.is_correct })),
    ),
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
      // Phase 3.5: decay is now driven by the objective's own FSRS stability.
      // Omitting these here would silently fall every objective back to the flat
      // legacy half-life — the analytics would still compute, just wrongly.
      fsrs_stability: true,
      fsrs_last_review: true,
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
    /**
     * The band around readiness (reformation Phase 2). Readiness is `coverage ×
     * depth` and coverage is a binomial proportion, so its sampling error is a
     * Wilson interval. Nothing in this pipeline has EVER been checked against a
     * real exam result, so the number is an estimate — the client must label it
     * as one, and `ExamOutcome` rows are what will eventually calibrate it.
     */
    readiness_band:    examReadinessBand(snapshots, now),
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

// ─── Exam outcomes (ground truth — reformation Phase 2) ───────────────────────

/** Optional free-text field → a stored null, so "" never becomes a value. */
function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Record a real exam result the student reports.
 *
 * This is the first thing in the whole pipeline that comes from OUTSIDE it. The
 * readiness number has never been checked against reality, so it is an estimate
 * presented with more authority than it earned; these rows are what will
 * eventually let it be calibrated.
 *
 * The readiness the model predicts TODAY is snapshotted onto the row, because
 * readiness decays — recomputing it months later would answer a different question
 * than "what did we tell this student before they sat the exam?". Computing it
 * costs zero AI calls (it is arithmetic over the objective rows).
 */
export async function recordExamOutcome(params: {
  userId:        string;
  institutionId: string;
  subject:       string;
  courseCode?:   string;
  scorePercent:  number;
  gradeLabel?:   string;
  examDate:      Date;
}) {
  const model = await getLearnerModel(params.userId);

  return prisma.examOutcome.create({
    data: {
      user_id:             params.userId,
      institution_id:      params.institutionId,
      subject:             params.subject.trim(),
      // An empty string is a missing value here, not a value — `??` would store it.
      course_code:         emptyToNull(params.courseCode),
      score_percent:       params.scorePercent,
      grade_label:         emptyToNull(params.gradeLabel),
      exam_date:           params.examDate,
      predicted_readiness: model.objectives_total > 0 ? model.exam_readiness : null,
    },
  });
}

/** The student's reported grades, newest exam first. */
export async function listExamOutcomes(userId: string) {
  return prisma.examOutcome.findMany({
    where:   { user_id: userId },
    orderBy: { exam_date: 'desc' },
  });
}

export async function deleteExamOutcome(outcomeId: string, userId: string) {
  const outcome = await prisma.examOutcome.findFirst({
    where: { id: outcomeId, user_id: userId },
  });
  if (!outcome) throw new AppError(404, 'NOT_FOUND', 'Exam result not found');

  await prisma.examOutcome.delete({ where: { id: outcomeId } });
  return { deleted: true };
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
  startTopicMasteryCheck,
  completeMasteryCheck,
  getLearnerModel,
  recordExamOutcome,
  listExamOutcomes,
  deleteExamOutcome,
};
