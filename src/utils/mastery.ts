/**
 * Mastery model — the arithmetic behind evidence-based progress (M7 item 4).
 *
 * Deliberately PURE: no Prisma, no AI, no clock beyond an injected `now`. Every
 * analytic the study dashboard shows is computed here from the objective rows, so
 * the whole surface costs ZERO AI calls. That matters — the per-user budget is 20
 * calls/day shared across question generation, planning and feedback, and an
 * analytics screen that spent them would starve the features that need them.
 */

export type ObjectiveState =
  | 'not_started'
  | 'learning'
  | 'practicing'
  | 'verified'
  | 'mastered';

// ─── Tuning ───────────────────────────────────────────────────────────────────

export const MASTERY = {
  /** Fallback when no institution/user threshold is set. */
  DEFAULT_THRESHOLD: 0.9,
  /**
   * Weight of the newest attempt in the mastery EWMA. 0.6 means recent evidence
   * dominates but one unlucky run cannot erase a solid history — the learner
   * should feel the score respond, without it being a pure last-attempt readout.
   */
  EWMA_ALPHA: 0.6,
  /**
   * Days after a pass before the objective is due for review. Deliberately short
   * for the first pass and longer once genuinely mastered (a crude SM-2).
   */
  REVIEW_DAYS_AFTER_VERIFY: 3,
  REVIEW_DAYS_AFTER_MASTERY: 14,
  /**
   * Half-life in days for retention decay. After this long past the review date,
   * the retention factor halves. 21 days approximates the classic forgetting
   * curve for meaningfully-learned material.
   */
  RETENTION_HALF_LIFE_DAYS: 21,
  /**
   * A `verified` objective needs a second pass at least this many days later to
   * become `mastered`. This gap is the whole point: passing twice in one sitting
   * is cramming, not retention.
   */
  MIN_DAYS_TO_MASTERY: 3,
} as const;

const MS_PER_DAY = 86_400_000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Exponentially-weighted mastery. `previous` is the stored score, `scoreFraction`
 * the new attempt in 0..1. The first attempt adopts its score outright rather than
 * being dragged halfway down from a zero that means "no evidence", not "failed".
 */
export function nextMasteryScore(
  previous: number,
  scoreFraction: number,
  priorAttempts: number,
): number {
  if (priorAttempts <= 0) return clamp01(scoreFraction);
  return clamp01(MASTERY.EWMA_ALPHA * scoreFraction + (1 - MASTERY.EWMA_ALPHA) * previous);
}

/**
 * Confidence = consistency, measured as 1 − (spread of recent scores). Two runs at
 * 0.9 is stronger evidence than a 0.6 followed by a 1.0 averaging the same, and
 * this is what separates "knows it" from "got lucky". Never self-reported.
 *
 * A single attempt caps at 0.5: one data point cannot demonstrate consistency.
 */
export function computeConfidence(recentScores: number[]): number {
  if (recentScores.length === 0) return 0;
  if (recentScores.length === 1) return clamp01(recentScores[0]) * 0.5;

  const mean = recentScores.reduce((sum, s) => sum + s, 0) / recentScores.length;
  const variance =
    recentScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / recentScores.length;
  // Scores live in 0..1, so the theoretical max standard deviation is 0.5.
  const spread = Math.min(1, Math.sqrt(variance) / 0.5);
  return clamp01(mean * (1 - spread));
}

/**
 * How much of a past demonstration still stands, given time since it was due for
 * review. 1 while not yet due, then halving every `RETENTION_HALF_LIFE_DAYS`.
 *
 * This is what stops the planner rewarding a topic crammed two months ago.
 */
export function retentionFactor(nextReviewAt: Date | null, now: Date): number {
  if (!nextReviewAt) return 1;
  const overdueDays = daysBetween(nextReviewAt, now);
  if (overdueDays <= 0) return 1;
  return clamp01(Math.pow(0.5, overdueDays / MASTERY.RETENTION_HALF_LIFE_DAYS));
}

// ─── State machine ────────────────────────────────────────────────────────────

export interface AttemptOutcome {
  state: ObjectiveState;
  masteryScore: number;
  nextReviewAt: Date | null;
  lastVerifiedAt: Date | null;
}

/**
 * Advance one objective given one assessment.
 *
 *   not_started ─(any attempt)────────────────> learning
 *   learning    ─(below threshold)───────────> practicing
 *   practicing  ─(>= threshold)──────────────> verified
 *   verified    ─(>= threshold, >= 3d later)─> mastered
 *   verified/mastered ─(below threshold)─────> practicing   [regression]
 *
 * Failing after a pass drops back to `practicing` rather than clearing progress:
 * the mastery score already carries the history, and wiping the state would make
 * the learner feel punished for attempting a review.
 */
export function applyAttempt(params: {
  currentState: ObjectiveState;
  previousMastery: number;
  priorAttempts: number;
  scoreFraction: number;
  threshold: number;
  lastVerifiedAt: Date | null;
  now: Date;
}): AttemptOutcome {
  const { currentState, previousMastery, priorAttempts, scoreFraction, threshold, lastVerifiedAt, now } =
    params;

  const masteryScore = nextMasteryScore(previousMastery, scoreFraction, priorAttempts);
  const passed = scoreFraction >= threshold;

  if (!passed) {
    // Any failure lands in `practicing` — except from `not_started`, where the
    // learner has only just begun and `learning` is the honest description.
    const state: ObjectiveState = currentState === 'not_started' ? 'learning' : 'practicing';
    return { state, masteryScore, nextReviewAt: null, lastVerifiedAt };
  }

  const alreadyVerified = currentState === 'verified' || currentState === 'mastered';
  const daysSinceVerified = lastVerifiedAt ? daysBetween(lastVerifiedAt, now) : 0;
  const earnsMastery = alreadyVerified && daysSinceVerified >= MASTERY.MIN_DAYS_TO_MASTERY;

  const state: ObjectiveState = earnsMastery ? 'mastered' : 'verified';
  const reviewDays = earnsMastery
    ? MASTERY.REVIEW_DAYS_AFTER_MASTERY
    : MASTERY.REVIEW_DAYS_AFTER_VERIFY;

  return {
    state,
    masteryScore,
    nextReviewAt: new Date(now.getTime() + reviewDays * MS_PER_DAY),
    // A pass at the mastery gap resets the clock; the first pass sets it.
    lastVerifiedAt: now,
  };
}

/**
 * `state` as it should READ today, accounting for decay. Stored state is the last
 * transition; this is the live view. Computed on read so no cron is needed.
 */
export function effectiveState(
  storedState: ObjectiveState,
  nextReviewAt: Date | null,
  now: Date,
): ObjectiveState {
  if (storedState !== 'verified' && storedState !== 'mastered') return storedState;
  if (!nextReviewAt || nextReviewAt > now) return storedState;
  return 'practicing';
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/** The subset of a LearningObjective row the analytics need. */
export interface ObjectiveSnapshot {
  id: string;
  subject: string;
  state: ObjectiveState;
  mastery_score: number;
  confidence: number;
  weight: number;
  next_review_at: Date | null;
}

export interface TopicMastery {
  subject: string;
  /** 0..100, decay-adjusted. */
  mastery_percent: number;
  confidence_percent: number;
  objectives_total: number;
  objectives_verified: number;
}

/** Decay-adjusted mastery for one objective, 0..1. */
export function effectiveMastery(objective: ObjectiveSnapshot, now: Date): number {
  return clamp01(objective.mastery_score * retentionFactor(objective.next_review_at, now));
}

const VERIFIED_STATES: ReadonlySet<ObjectiveState> = new Set(['verified', 'mastered']);

export function topicMastery(objectives: ObjectiveSnapshot[], now: Date): TopicMastery[] {
  const bySubject = new Map<string, ObjectiveSnapshot[]>();
  for (const objective of objectives) {
    const bucket = bySubject.get(objective.subject);
    if (bucket) bucket.push(objective);
    else bySubject.set(objective.subject, [objective]);
  }

  const rows: TopicMastery[] = [];
  for (const [subject, group] of bySubject) {
    const totalWeight = group.reduce((sum, o) => sum + o.weight, 0) || 1;
    const weighted = group.reduce((sum, o) => sum + effectiveMastery(o, now) * o.weight, 0);
    const confidence = group.reduce((sum, o) => sum + o.confidence, 0) / group.length;

    rows.push({
      subject,
      mastery_percent: Math.round((weighted / totalWeight) * 1000) / 10,
      confidence_percent: Math.round(confidence * 1000) / 10,
      objectives_total: group.length,
      objectives_verified: group.filter((o) => VERIFIED_STATES.has(effectiveState(o.state, o.next_review_at, now)))
        .length,
    });
  }

  return rows.sort((a, b) => b.mastery_percent - a.mastery_percent);
}

/**
 * Exam readiness, 0..100 — `coverage × depth`, where coverage is the share of
 * objectives actually verified and depth is decay-adjusted mastery across all of
 * them.
 *
 * Multiplying rather than averaging is deliberate: 100% mastery of the 20% you
 * bothered to verify is NOT readiness, and a metric that reported it as such would
 * be actively misleading before an exam.
 */
export function examReadiness(objectives: ObjectiveSnapshot[], now: Date): number {
  if (objectives.length === 0) return 0;

  const verified = objectives.filter((o) =>
    VERIFIED_STATES.has(effectiveState(o.state, o.next_review_at, now)),
  ).length;
  const coverage = verified / objectives.length;

  const totalWeight = objectives.reduce((sum, o) => sum + o.weight, 0) || 1;
  const depth =
    objectives.reduce((sum, o) => sum + effectiveMastery(o, now) * o.weight, 0) / totalWeight;

  return Math.round(coverage * depth * 1000) / 10;
}

export interface RevisionPriority {
  objective_id: string;
  subject: string;
  /** Higher = revise sooner. Unitless; only the ordering is meaningful. */
  priority: number;
  reason: 'never_attempted' | 'weak' | 'due_for_review';
}

/**
 * What to revise next: `(1 − effective mastery) × weight`, so both "never learnt"
 * and "learnt but faded" surface, ranked by how much the exam cares.
 */
export function revisionPriority(objectives: ObjectiveSnapshot[], now: Date): RevisionPriority[] {
  return objectives
    .map((objective) => {
      const effective = effectiveMastery(objective, now);
      const decayed =
        objective.next_review_at !== null && objective.next_review_at <= now;

      const reason: RevisionPriority['reason'] =
        objective.state === 'not_started'
          ? 'never_attempted'
          : decayed
            ? 'due_for_review'
            : 'weak';

      return {
        objective_id: objective.id,
        subject: objective.subject,
        priority: Math.round((1 - effective) * objective.weight * 1000) / 1000,
        reason,
      };
    })
    .filter((row) => row.priority > 0)
    .sort((a, b) => b.priority - a.priority);
}
