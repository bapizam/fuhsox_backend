/**
 * What a batch answer submission means when a row for that question already
 * exists.
 *
 * Silent runs (exam, mastery check) let a student walk back through the paper
 * and change their mind until they submit — so the batch endpoint can
 * no longer treat "there is already a row" as "ignore this". But it still has to
 * stay idempotent, because a dropped response makes the client re-send the whole
 * outstanding set and a retry must not be mistaken for a change of mind.
 *
 * The distinction is exactly the answer text:
 *
 * - `new`      — nothing on file. Insert, grade, and count it towards the item's
 *                empirical difficulty.
 * - `repeat`   — same answer already on file. Return the stored verdict and do
 *                nothing else: no re-grade (which for free response would spend
 *                AI budget) and no second difficulty datapoint.
 * - `revision` — a different answer. Replace the row and re-grade. Deliberately
 *                NOT counted again towards item difficulty: one student must not
 *                contribute two outcomes for one item.
 *
 * Kept pure and separate from `session.service` so the rule can be tested without
 * a database — it is small, and getting it wrong is either silent data loss (a
 * revision dropped) or a skewed statistic (a retry counted twice).
 */
export type AnswerSubmissionKind = 'new' | 'repeat' | 'revision';

export function classifyAnswerSubmission(
  previous: { chosen_answer: string } | undefined | null,
  incoming: { chosen_answer: string },
): AnswerSubmissionKind {
  if (!previous) return 'new';
  return previous.chosen_answer === incoming.chosen_answer ? 'repeat' : 'revision';
}

/** True when this submission needs grading — a repeat already has its verdict. */
export function needsGrading(kind: AnswerSubmissionKind): boolean {
  return kind !== 'repeat';
}

/** True when this submission may contribute to the item's difficulty statistics. */
export function countsTowardsItemStats(kind: AnswerSubmissionKind): boolean {
  return kind === 'new';
}
