/**
 * Fail-closed grading: what happens when an item has no answer key.
 *
 * Every item in the bank used to carry a `correct_answer`, so "can this be
 * graded?" was never a question. Imported past papers break that assumption —
 * most are bare question papers whose answer key was never published — and a
 * nullable key needs a rule, because the failure modes on either side are bad in
 * different ways:
 *
 *   - Grading a null key as CORRECT invents a pass out of nothing, and in the
 *     learner model an invented pass is indistinguishable from a real one.
 *   - Grading it as WRONG punishes the student for the bank's gap, and drags an
 *     objective's EWMA down on evidence that never existed.
 *
 * So an unkeyed item is neither: it is **ungradable**. It never scores correct
 * (that is the fail-closed half), and it leaves the denominator entirely (that is
 * the half people forget). Both halves are needed — see `gradedScore`.
 *
 * Pure and unit-tested; the service layer only decides what to persist.
 */

/**
 * An item is gradable exactly when it carries a non-blank answer key.
 *
 * A type predicate on purpose: every call site that checks gradability also then
 * wants to USE the key, and narrowing here means no call site has to reach for a
 * non-null assertion to do it. `!` is exactly the operator you do not want in the
 * one code path whose whole job is to distrust a missing value.
 */
export function hasAnswerKey(correctAnswer: string | null | undefined): correctAnswer is string {
  return typeof correctAnswer === 'string' && correctAnswer.trim().length > 0;
}

export interface GradableAnswer {
  is_correct: boolean;
  /** False for an item that carried no answer key when it was submitted. */
  gradable:   boolean;
}

export interface GradedScore {
  /** Correct answers among the gradable ones. */
  correct:  number;
  /** How many answers could be graded at all — the denominator. */
  gradable: number;
  /** Answers dropped for want of an answer key. */
  skipped:  number;
  /** `correct / gradable`, or 0 when nothing was gradable. */
  fraction: number;
}

/**
 * Score a set of answers, counting only the ones that could be graded.
 *
 * Leaving ungradable items in the denominator is the subtle half of the bug. A
 * student who answers seven of eight perfectly scores 87.5% against a 90% gate
 * and FAILS — on a question the system could never have marked either way. The
 * denominator has to shrink with the numerator.
 *
 * Returns 0 when nothing was gradable, which callers should treat as "no
 * evidence" rather than "scored zero"; `gradable === 0` is the flag for that.
 */
export function gradedScore(answers: GradableAnswer[]): GradedScore {
  const gradableAnswers = answers.filter((a) => a.gradable);
  const correct = gradableAnswers.filter((a) => a.is_correct).length;

  return {
    correct,
    gradable: gradableAnswers.length,
    skipped:  answers.length - gradableAnswers.length,
    fraction: gradableAnswers.length === 0 ? 0 : correct / gradableAnswers.length,
  };
}
