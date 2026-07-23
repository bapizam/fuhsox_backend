/**
 * Admin queue for AI-generated items students have flagged (reformation Phase 4,
 * Workstream B — **the ungated slice**).
 *
 * **Why only a slice.** Workstream B proper is human curation of generated content
 * plus institution-shared question pools. Both are gated on a real institution
 * partner: an approval workflow with nobody authorised to approve is theatre, and
 * that gate is not open. What IS buildable without a partner is this — students
 * have been able to flag a bad AI question since M2, `quality_flag: 'flagged'` and
 * `flag_reason` have been written on every one of those taps, and **nothing has
 * ever read them**. That is a queue with no screen, silently accumulating exactly
 * the signal a curator would want on day one.
 *
 * So this surfaces the data that already exists. It deliberately does NOT promote
 * items into the Postgres `Question` bank, add a review-before-use toggle, or build
 * shared pools — those are the partner-gated half and are called out as unbuilt
 * rather than half-done.
 *
 * Reads Mongo (`AIQuestion`) and is institution-scoped like every other admin
 * surface. Zero AI calls.
 */
import { AIQuestion } from '../../../mongo/schemas';
import { AppError } from '@typings/models';
import logger from '@lib/logger';

export interface FlaggedAIQuestion {
  id: string;
  user_id: string;
  topic: string;
  question_type: string;
  question_text: string;
  options: { key: string; text: string; misconception?: string }[];
  correct_answer: string;
  explanation: string | null;
  difficulty: string;
  flag_reason: string | null;
  /** Set when the item belongs to an objective's cached mastery pool. */
  objective_id: string | null;
  /**
   * Observed difficulty (reformation Phase 2) — `correct_count / seen_count`.
   * Null until the item has actually been answered. Worth showing beside the flag:
   * an item everybody gets wrong is corroborating evidence that the flag is right,
   * and one everybody gets right suggests the flag was a student's frustration.
   */
  p_value: number | null;
  seen_count: number;
  created_at: Date;
}

/**
 * Flagged items for an institution, newest first.
 *
 * Paginated in the same envelope shape the rest of the admin surface returns, so
 * the existing client pagination works against it unmodified.
 */
export async function listFlaggedAIQuestions(params: {
  institutionId: string;
  page?:         number;
  limit?:        number;
  /** Narrow to one objective's pool, when triaging a specific complaint. */
  topic?:        string;
}): Promise<{ items: FlaggedAIQuestion[]; pagination: { total: number; page: number; limit: number; totalPages: number; hasMore: boolean } }> {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));

  const filter = {
    institution_id: params.institutionId,
    quality_flag:   'flagged' as const,
    ...(params.topic ? { topic: params.topic } : {}),
  };

  const [docs, total] = await Promise.all([
    AIQuestion.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AIQuestion.countDocuments(filter),
  ]);

  return {
    items: docs.map((doc) => {
      const seen = doc.seen_count ?? 0;
      return {
        id:             (doc._id as { toString(): string }).toString(),
        user_id:        doc.user_id,
        topic:          doc.topic,
        question_type:  doc.question_type,
        question_text:  doc.question_text,
        options:        doc.options ?? [],
        correct_answer: doc.correct_answer,
        explanation:    doc.explanation ?? null,
        difficulty:     doc.difficulty,
        flag_reason:    doc.flag_reason ?? null,
        objective_id:   doc.objective_id ?? null,
        p_value:        seen > 0 ? Math.round(((doc.correct_count ?? 0) / seen) * 100) / 100 : null,
        seen_count:     seen,
        created_at:     doc.createdAt,
      };
    }),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore:    page * limit < total,
    },
  };
}

/** How many items are waiting — cheap enough for a nav badge. */
export async function countFlaggedAIQuestions(institutionId: string): Promise<number> {
  return AIQuestion.countDocuments({ institution_id: institutionId, quality_flag: 'flagged' });
}

export type FlagResolution = 'dismiss' | 'remove';

/**
 * Clear an item from the queue.
 *
 * A queue that cannot be emptied is not a queue, so triage needs both verdicts:
 *
 * - `dismiss` — the flag was wrong; the item goes back to `good` and stays in the
 *   student's pool.
 * - `remove` — the item is genuinely bad. It is DELETED rather than left flagged,
 *   because leaving it in place means the student keeps being served a question
 *   an admin has just agreed is broken. Pools regenerate lazily
 *   (`ensureQuestionPool`), so removal costs at most one future generation and
 *   never leaves an empty check.
 */
export async function resolveFlaggedAIQuestion(params: {
  questionId:    string;
  institutionId: string;
  resolution:    FlagResolution;
  adminId:       string;
}): Promise<{ id: string; resolution: FlagResolution }> {
  const doc = await AIQuestion.findOne({
    _id:            params.questionId,
    institution_id: params.institutionId,
  });
  if (!doc) throw new AppError(404, 'NOT_FOUND', 'Flagged question not found');

  if (params.resolution === 'remove') {
    await AIQuestion.deleteOne({ _id: params.questionId });
  } else {
    doc.quality_flag = 'good';
    doc.flag_reason = undefined;
    await doc.save();
  }

  logger.info(
    { questionId: params.questionId, resolution: params.resolution, adminId: params.adminId },
    'Flagged AI question resolved',
  );

  return { id: params.questionId, resolution: params.resolution };
}

export const aiContentAdminService = {
  listFlaggedAIQuestions,
  countFlaggedAIQuestions,
  resolveFlaggedAIQuestion,
};
