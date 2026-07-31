/**
 * Cold-start placement — the answer to "how do we know where this student is?"
 *
 * Before this existed, a study plan had no measurement to start from: it could
 * only order a resource's chapters the way the book does, so week one was
 * identical for a student who had already covered half the material and one who
 * had opened it for the first time.
 *
 * A placement check samples chapters across the whole resource, asks ONE
 * retrieval-grounded question about each, and records what came back. That is
 * enough to decide what to study first, which is all a plan needs.
 *
 * **It is deliberately not evidence for the learner model.** One item per chapter
 * is far too noisy to be mastery: writing it into `LearningObjective.mastery_score`
 * or `MasteryAttempt` would feed `examReadiness` and the BKT graph a 1-item
 * estimate and corrupt both, in a codebase that is otherwise careful to show
 * Wilson bands and refuse to calibrate below n=30. Placement answers live in
 * `ChapterPlacement` and are read only by the planner.
 */
import prisma from '@config/database';
import { AIQuestion } from '../../mongo/schemas';
import { retrieveChunksForQueries } from '@lib/retrieval';
import { AppError } from '@typings/models';
import * as aiService from '@services/ai.service';
import logger from '@lib/logger';

export const PLACEMENT = {
  /**
   * Chapters sampled per check. Ten items is a few minutes of the student's time
   * and one AI call; sampling evenly across the resource matters more than
   * covering every chapter, because the plan only needs to know roughly where
   * the student's knowledge stops.
   */
  MAX_CHAPTERS: 10,
  /** Passages retrieved per chapter to ground its item. */
  GROUNDING_PER_CHAPTER: 3,
} as const;

export interface StartedPlacement {
  session_id:   string;
  resource_id:  string;
  question_ids: string[];
  /** Chapters that produced a usable item, in the order they are asked. */
  chapters:     { node_id: string; title: string }[];
}

/**
 * Pick `count` chapters spread evenly across `total`, always including the first
 * and (where there is room) the last.
 *
 * Evenly rather than randomly: a placement that happens to draw five chapters
 * from the first third tells the planner nothing about the rest of the book.
 */
export function sampleChapterIndices(total: number, count: number): number[] {
  if (total <= 0 || count <= 0) return [];
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  if (count === 1) return [0];

  const step = (total - 1) / (count - 1);
  const picked = new Set<number>();
  for (let i = 0; i < count; i += 1) picked.add(Math.round(i * step));
  return [...picked].sort((a, b) => a - b);
}

/**
 * Generate and start a placement check for one resource.
 *
 * Requires an outline: without chapters there is nothing to sample, and the error
 * points at the two ways to get one (AI extraction or typing them in) rather than
 * failing blankly.
 */
export async function startPlacementCheck(params: {
  userId:        string;
  institutionId: string;
  resourceId:    string;
}): Promise<StartedPlacement> {
  const resource = await prisma.learningResource.findFirst({
    where: { id: params.resourceId, user_id: params.userId },
  });
  if (!resource) throw new AppError(404, 'NOT_FOUND', 'Resource not found');

  const chapters = await prisma.syllabusNode.findMany({
    where:   { resource_id: params.resourceId, depth: 0 },
    orderBy: { ordinal: 'asc' },
    select:  { id: true, title: true },
  });

  if (chapters.length === 0) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      'This resource has no chapters yet. Extract its outline, or type the chapter list in, then try again.',
    );
  }

  const sampled = sampleChapterIndices(chapters.length, PLACEMENT.MAX_CHAPTERS)
    .map((i) => chapters[i])
    .filter((c): c is { id: string; title: string } => c !== undefined);

  // One batched retrieval for every sampled chapter — see
  // `retrieveChunksForQueries`. Grounding is best-effort: a resource that was
  // never ingested simply produces title-only questions.
  const grounding = await retrieveChunksForQueries(
    params.resourceId,
    sampled.map((c) => c.title),
    PLACEMENT.GROUNDING_PER_CHAPTER,
  ).catch((err) => {
    logger.warn({ err, resourceId: params.resourceId }, 'Placement retrieval failed; going ungrounded');
    return sampled.map(() => []);
  });

  const items = await aiService.generatePlacementItems({
    subject:  resource.course_code ?? resource.title,
    chapters: sampled.map((chapter, i) => ({
      nodeId:    chapter.id,
      title:     chapter.title,
      grounding: (grounding[i] ?? []).map((g) => ({ text: g.text, page: g.page })),
    })),
    userId:        params.userId,
    institutionId: params.institutionId,
  });

  const titleByNode = new Map(sampled.map((c) => [c.id, c.title]));

  const session = await prisma.quizSession.create({
    data: {
      user_id:         params.userId,
      institution_id:  params.institutionId,
      mode:            'placement',
      question_source: 'ai_generated',
      total_questions: items.length,
      question_ids:    items.map((item) => item.id),
    },
  });

  logger.info(
    { resourceId: params.resourceId, sessionId: session.id, items: items.length },
    'Placement check started',
  );

  return {
    session_id:   session.id,
    resource_id:  params.resourceId,
    question_ids: items.map((item) => item.id),
    chapters:     items.map((item) => ({
      node_id: item.node_id,
      title:   titleByNode.get(item.node_id) ?? '',
    })),
  };
}

export interface PlacementChapterResult {
  node_id: string;
  title:   string;
  correct: boolean;
}

export interface PlacementResult {
  resource_id: string;
  /** Chapters answered, in the resource's own order. */
  chapters:    PlacementChapterResult[];
  /** How many of the answered chapters came back correct. */
  known:       number;
  answered:    number;
}

/**
 * Record a finished placement check.
 *
 * Reads the answers the ordinary quiz machinery already wrote, maps each back to
 * its chapter via `AIQuestion.node_id`, and upserts one row per chapter. Retaking
 * replaces the previous answer rather than accumulating, because a placement is a
 * snapshot of a starting point, not a history.
 *
 * Unanswered questions are skipped entirely — an abandoned check leaves the
 * chapters it never asked about unmeasured, which the planner treats differently
 * from "asked and got it wrong".
 */
export async function completePlacementCheck(params: {
  userId:     string;
  sessionId:  string;
}): Promise<PlacementResult> {
  const session = await prisma.quizSession.findFirst({
    where:   { id: params.sessionId, user_id: params.userId },
    include: { answers: true },
  });
  if (!session) throw new AppError(404, 'NOT_FOUND', 'Session not found');
  if (session.mode !== 'placement') {
    throw new AppError(400, 'VALIDATION_ERROR', 'That session is not a placement check');
  }

  const items = await AIQuestion.find(
    { _id: { $in: session.question_ids } },
    { node_id: 1 },
  ).lean();

  const nodeByQuestion = new Map(
    items
      .filter((item) => typeof item.node_id === 'string' && item.node_id.length > 0)
      .map((item) => [item._id.toString(), item.node_id as string]),
  );

  const nodes = await prisma.syllabusNode.findMany({
    where:   { id: { in: [...new Set(nodeByQuestion.values())] } },
    orderBy: { ordinal: 'asc' },
    select:  { id: true, title: true, resource_id: true },
  });
  const resourceId = nodes[0]?.resource_id;
  if (!resourceId) {
    throw new AppError(422, 'VALIDATION_ERROR', 'This placement check has no chapters left to record');
  }

  const correctByNode = new Map<string, boolean>();
  for (const answer of session.answers) {
    const nodeId = nodeByQuestion.get(answer.question_id);
    if (!nodeId) continue;
    correctByNode.set(nodeId, answer.is_correct);
  }

  await Promise.all(
    [...correctByNode].map(([nodeId, correct]) =>
      prisma.chapterPlacement.upsert({
        where:  { user_id_node_id: { user_id: params.userId, node_id: nodeId } },
        create: {
          user_id:     params.userId,
          resource_id: resourceId,
          node_id:     nodeId,
          session_id:  params.sessionId,
          correct,
        },
        update: { correct, session_id: params.sessionId, created_at: new Date() },
      }),
    ),
  );

  const chapters = nodes
    .filter((node) => correctByNode.has(node.id))
    .map((node) => ({
      node_id: node.id,
      title:   node.title,
      correct: correctByNode.get(node.id) ?? false,
    }));

  logger.info(
    { sessionId: params.sessionId, recorded: chapters.length },
    'Placement check recorded',
  );

  return {
    resource_id: resourceId,
    chapters,
    known:       chapters.filter((c) => c.correct).length,
    answered:    chapters.length,
  };
}

/**
 * The standing placement for a resource, newest answer per chapter. Read by the
 * planner to order chapters; empty when the student skipped placement.
 */
export async function getPlacementForResource(params: {
  userId:     string;
  resourceId: string;
}): Promise<{ node_id: string; correct: boolean }[]> {
  const rows = await prisma.chapterPlacement.findMany({
    where:  { user_id: params.userId, resource_id: params.resourceId },
    select: { node_id: true, correct: true },
  });
  return rows;
}
