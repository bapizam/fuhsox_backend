/**
 * Mastery model — the arithmetic behind evidence-based progress (M7 item 4).
 *
 * Deliberately PURE: no Prisma, no AI, no clock beyond an injected `now`. Every
 * analytic the study dashboard shows is computed here from the objective rows, so
 * the whole surface costs ZERO AI calls. That matters — the per-user budget is 20
 * calls/day shared across question generation, planning and feedback, and an
 * analytics screen that spent them would starve the features that need them.
 *
 * `ts-fsrs` is the one dependency (reformation Phase 3). It is a pure scheduling
 * function with no I/O, so the "no side effects" property above still holds.
 */
import {
  Rating,
  createEmptyCard,
  default_w,
  forgetting_curve,
  fsrs,
  type Card,
  type Grade,
} from 'ts-fsrs';

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
   * The flat review intervals that FSRS REPLACED in Phase 3. No longer applied to
   * anything — kept as the documented parity reference, because FSRS's own answer
   * for a straightforward first and second pass lands on these same 3 and 14 days.
   * The unit tests assert that parity, which is what makes the swap auditable
   * rather than a leap of faith. Delete them only when that test goes.
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
  /**
   * Score→FSRS rating cut points (reformation Phase 3).
   *
   * FSRS wants a 4-point rating; a mastery check produces a fraction. This mapping
   * is the entire adapter between them, so it lives here as tuning rather than
   * buried in the scheduler.
   *
   * `LAPSE` is deliberately well below the pass threshold: scoring 45% is a
   * genuinely failed recall and should shorten the interval hard, whereas an 85%
   * near-miss against a 90% bar is "shaky", not "forgotten" — rating that as
   * `Again` would punish a good student for a single unlucky item.
   */
  RATING_LAPSE_BELOW: 0.5,
  /** At or above this, the pass was comfortable enough to stretch the interval. */
  RATING_EASY_AT: 0.95,
} as const;

/**
 * The shared FSRS scheduler (reformation Phase 3).
 *
 * - `enable_fuzz: false` — fuzz randomizes each interval by a few percent to stop
 *   flashcard reviews clumping. It would make `applyAttempt` non-deterministic and
 *   therefore untestable, and it buys nothing at 3 checks/day.
 * - `enable_short_term: false` — the sub-day learning steps exist for drilling a
 *   card repeatedly in one sitting. A mastery check is capped at 3/day and is
 *   explicitly not a cramming tool, so those steps would never fire correctly.
 */
const scheduler = fsrs({ enable_fuzz: false, enable_short_term: false });

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
 * LEGACY decay — one flat 21-day half-life applied to every objective, measured
 * from the date it fell due. Superseded by `retrievability` in Phase 3.5, and kept
 * as the fallback for objectives with no FSRS stability yet (rows predating
 * Phase 3, and any objective never assessed since).
 *
 * Its flaw is the same one FSRS fixes everywhere else: it decays a rock-solid
 * objective at exactly the rate it decays a shaky one.
 */
export function retentionFactor(nextReviewAt: Date | null, now: Date): number {
  if (!nextReviewAt) return 1;
  const overdueDays = daysBetween(nextReviewAt, now);
  if (overdueDays <= 0) return 1;
  return clamp01(Math.pow(0.5, overdueDays / MASTERY.RETENTION_HALF_LIFE_DAYS));
}

/**
 * How much of a past demonstration still stands (reformation Phase 3.5).
 *
 * FSRS's own forgetting curve, driven by the objective's measured **stability** —
 * so an objective the student has proved repeatedly fades slowly, and one they
 * scraped through fades fast. Phase 3 left this incoherent: FSRS set each
 * objective's review INTERVAL from its own history while decay stayed a flat
 * 21-day half-life for everything. Same system, two disagreeing models of
 * forgetting.
 *
 * Note the two models are on different clocks and different shapes:
 *   - legacy: exponential, measured from the DUE date, 1.0 until due.
 *   - FSRS:   power-law, measured from the LAST REVIEW, and 0.9 exactly at the due
 *             date (that is the definition of stability — the interval at R=90%).
 *
 * FSRS is harsher immediately (0.9 vs 1.0 at the due date) and far gentler on a
 * long tail. That is intentional and it is not over-claiming, because
 * `examReadiness` already penalises staleness a SECOND time through coverage: a
 * past-due objective reads as `practicing` via `effectiveState`, so it drops out
 * of the verified count entirely. The old model therefore double-counted decay —
 * once in coverage, once in depth. This fixes the depth half.
 *
 * Falls back to `retentionFactor` when there is no stability to work from.
 */
export function retrievability(params: {
  stability:    number | null | undefined;
  lastReview:   Date | null | undefined;
  nextReviewAt: Date | null;
  now:          Date;
}): number {
  const { stability, lastReview } = params;
  if (stability === null || stability === undefined || stability <= 0 || !lastReview) {
    return retentionFactor(params.nextReviewAt, params.now);
  }

  // Clamp at 0 so clock skew (or a last_review stamped slightly ahead) can't
  // produce a retrievability above 1.
  const elapsedDays = Math.max(0, daysBetween(lastReview, params.now));
  return clamp01(forgetting_curve(default_w, elapsedDays, stability));
}

// ─── Uncertainty ──────────────────────────────────────────────────────────────

export interface ScoreInterval {
  /** Lower bound of the confidence interval, 0..1. */
  low: number;
  /** Upper bound, 0..1. */
  high: number;
}

/**
 * Wilson score interval for a binomial proportion (reformation Phase 2).
 *
 * An 8-item check is a HIGH-VARIANCE estimate of ability: one unlucky item swings
 * 87.5% → 75%, and the 90% gate was being applied to a measurement whose noise band
 * is wider than the thing it gates. Reporting `[low, high]` beside the score is the
 * honest version of the same number — and it is also the kinder one, because a
 * near-miss reads as "somewhere around here" rather than a verdict.
 *
 * Wilson rather than the textbook normal approximation because the normal
 * interval is badly wrong exactly where this lives: small n and proportions near
 * 1. At 8/8 the normal interval collapses to [1, 1]; Wilson still admits doubt.
 */
export function wilsonInterval(correct: number, total: number, z = 1.96): ScoreInterval {
  if (total <= 0) return { low: 0, high: 1 };

  const n = total;
  const p = clamp01(correct / n);
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return {
    low: clamp01((centre - margin) / denominator),
    high: clamp01((centre + margin) / denominator),
  };
}

// ─── FSRS scheduling (reformation Phase 3) ────────────────────────────────────

/**
 * The FSRS state persisted on a LearningObjective. All optional: an objective
 * that predates Phase 3 has none, and is reconstructed from an empty card on its
 * next attempt. That is the whole backfill story — there is no migration script.
 */
export interface FsrsState {
  stability:  number | null;
  difficulty: number | null;
  reps:       number;
  lapses:     number;
  /** `ts-fsrs` State enum as an int: 0 New, 1 Learning, 2 Review, 3 Relearning. */
  state:      number;
  /** Mirrors `next_review_at`; the card's own due date. */
  due:        Date | null;
  lastReview: Date | null;
}

/**
 * Translate a mastery-check score into the 4-point rating FSRS expects.
 *
 * This is the only place the two models meet, and it is a judgement call rather
 * than a derivation — hence pure, exported, and unit-tested. The cut points live
 * in `MASTERY` so they can be tuned without touching the scheduler.
 */
export function ratingForScore(scoreFraction: number, threshold: number): Grade {
  if (scoreFraction < MASTERY.RATING_LAPSE_BELOW) return Rating.Again;
  if (scoreFraction < threshold) return Rating.Hard;
  if (scoreFraction < MASTERY.RATING_EASY_AT) return Rating.Good;
  return Rating.Easy;
}

/**
 * Rebuild a `ts-fsrs` Card from the stored columns, or start a fresh one.
 *
 * An objective with no stability has never been scheduled by FSRS — either it is
 * new, or it predates Phase 3. Both cases are identical from here: an empty card
 * carrying the review history we do know (`reps`/`lapses`), so a long-standing
 * objective is not treated as difficult just because it lacks the new columns.
 */
function toCard(state: FsrsState | null, now: Date): Card {
  const empty = createEmptyCard(now);
  if (state?.stability === null || state?.stability === undefined) return empty;
  if (state.difficulty === null) return empty;

  return {
    ...empty,
    due:            state.due ?? now,
    stability:      state.stability,
    difficulty:     state.difficulty,
    reps:           state.reps,
    lapses:         state.lapses,
    state:          state.state,
    ...(state.lastReview ? { last_review: state.lastReview } : {}),
  };
}

/** The stored shape of a card after review — what `applyAttempt` writes back. */
function fromCard(card: Card): FsrsState {
  return {
    stability:  card.stability,
    difficulty: card.difficulty,
    reps:       card.reps,
    lapses:     card.lapses,
    state:      card.state,
    due:        card.due,
    lastReview: card.last_review ?? null,
  };
}

/**
 * Schedule the next review with FSRS.
 *
 * Replaces the flat 3-then-14-day rule, which applied the same interval to every
 * objective regardless of how hard THAT objective had proved for THIS student.
 * FSRS sets each interval from the item's own observed stability and difficulty,
 * which is what the whole spaced-repetition literature says to do.
 *
 * Reassuringly, FSRS's own answer for a straightforward pass/pass sequence comes
 * out at ~3 then ~14 days — the exact constants that were hand-tuned here before.
 * The gain is not on that happy path; it is that a repeatedly-lapsed objective now
 * comes back fast and a genuinely solid one stops nagging.
 */
export function scheduleReview(params: {
  previous:      FsrsState | null;
  scoreFraction: number;
  threshold:     number;
  now:           Date;
}): FsrsState {
  const card = toCard(params.previous, params.now);
  const grade = ratingForScore(params.scoreFraction, params.threshold);
  // Review AT the due date when it has already passed, so an overdue objective is
  // scheduled from now rather than from a date in the past.
  const reviewedAt = params.now;
  return fromCard(scheduler.next(card, reviewedAt, grade).card);
}

// ─── Metacognitive calibration (reformation Phase 3) ──────────────────────────

export interface CalibrationInput {
  /** The student's own 1–5 claim. Null/undefined = they weren't asked. */
  confidence: number | null | undefined;
  isCorrect:  boolean;
}

export interface Calibration {
  /** Mean self-reported confidence mapped to 0..1. */
  claimed:  number;
  /** Actual proportion correct, 0..1. */
  actual:   number;
  /**
   * `claimed − actual`. Positive = overconfident (the common and more dangerous
   * direction), negative = underconfident, ~0 = well calibrated.
   */
  gap:      number;
  /** Items that carried a confidence rating — the sample this is based on. */
  rated:    number;
}

/** 1–5 self-report onto 0..1, so it can be compared with an accuracy proportion. */
function confidenceToFraction(rating: number): number {
  return clamp01((rating - 1) / 4);
}

/**
 * Compare what the student SAID they knew against what they actually got right.
 *
 * This is the critique's recommendation E, and it is the cheapest real win in the
 * whole reformation: it costs zero AI calls, it produces a genuine confidence
 * signal (unlike `computeConfidence`, which infers one from score variance), and
 * asking students to predict their own performance is independently one of the
 * best-evidenced study interventions there is.
 *
 * Returns null when nothing was rated — an honest "no data" rather than a
 * meaningless zero, which would otherwise render as "perfectly calibrated".
 */
export function calibration(answers: CalibrationInput[]): Calibration | null {
  const rated = answers.filter(
    (a): a is { confidence: number; isCorrect: boolean } =>
      typeof a.confidence === 'number' && Number.isFinite(a.confidence),
  );
  if (rated.length === 0) return null;

  const claimed =
    rated.reduce((sum, a) => sum + confidenceToFraction(a.confidence), 0) / rated.length;
  const actual = rated.filter((a) => a.isCorrect).length / rated.length;

  return {
    claimed: Math.round(claimed * 1000) / 1000,
    actual:  Math.round(actual * 1000) / 1000,
    gap:     Math.round((claimed - actual) * 1000) / 1000,
    rated:   rated.length,
  };
}

// ─── State machine ────────────────────────────────────────────────────────────

export interface AttemptOutcome {
  state: ObjectiveState;
  masteryScore: number;
  nextReviewAt: Date | null;
  lastVerifiedAt: Date | null;
  /** FSRS card state to persist (reformation Phase 3). */
  fsrs: FsrsState;
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
  /** Stored FSRS card, or null for an objective that predates Phase 3. */
  fsrs?: FsrsState | null;
}): AttemptOutcome {
  const { currentState, previousMastery, priorAttempts, scoreFraction, threshold, lastVerifiedAt, now } =
    params;

  const masteryScore = nextMasteryScore(previousMastery, scoreFraction, priorAttempts);
  const passed = scoreFraction >= threshold;

  // FSRS advances on EVERY attempt, pass or fail — a lapse is information the
  // scheduler needs, and withholding it would leave difficulty permanently
  // optimistic for an objective the student keeps failing.
  const fsrs = scheduleReview({
    previous:      params.fsrs ?? null,
    scoreFraction,
    threshold,
    now,
  });

  if (!passed) {
    // Any failure lands in `practicing` — except from `not_started`, where the
    // learner has only just begun and `learning` is the honest description.
    const state: ObjectiveState = currentState === 'not_started' ? 'learning' : 'practicing';
    // `nextReviewAt` stays null on a failure, exactly as before: a failed
    // objective is due NOW, and `revisionPriority` already surfaces it via its low
    // mastery. Setting a future date would hide a failure from the "due" count.
    return { state, masteryScore, nextReviewAt: null, lastVerifiedAt, fsrs };
  }

  const alreadyVerified = currentState === 'verified' || currentState === 'mastered';
  const daysSinceVerified = lastVerifiedAt ? daysBetween(lastVerifiedAt, now) : 0;
  const earnsMastery = alreadyVerified && daysSinceVerified >= MASTERY.MIN_DAYS_TO_MASTERY;

  const state: ObjectiveState = earnsMastery ? 'mastered' : 'verified';

  return {
    state,
    masteryScore,
    // The interval is now FSRS's, derived from this objective's own history,
    // rather than a flat 3-or-14 applied to every objective alike.
    nextReviewAt: fsrs.due,
    // A pass at the mastery gap resets the clock; the first pass sets it.
    lastVerifiedAt: now,
    fsrs,
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
  /**
   * FSRS stability + last review (Phase 3.5). Optional: absent means the caller
   * didn't select them, or the objective predates Phase 3 — either way decay
   * falls back to the flat legacy half-life rather than failing.
   */
  fsrs_stability?: number | null;
  fsrs_last_review?: Date | null;
}

export interface TopicMastery {
  subject: string;
  /** 0..100, decay-adjusted. */
  mastery_percent: number;
  confidence_percent: number;
  objectives_total: number;
  objectives_verified: number;
}

/**
 * Decay-adjusted mastery for one objective, 0..1.
 *
 * Since Phase 3.5 the decay term is FSRS retrievability driven by the objective's
 * own stability, falling back to the flat legacy curve when it has none.
 */
export function effectiveMastery(objective: ObjectiveSnapshot, now: Date): number {
  return clamp01(
    objective.mastery_score *
      retrievability({
        stability:    objective.fsrs_stability,
        lastReview:   objective.fsrs_last_review,
        nextReviewAt: objective.next_review_at,
        now,
      }),
  );
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

/**
 * The band around `examReadiness`, 0..100 (reformation Phase 2).
 *
 * Readiness is `coverage × depth`, and **coverage is a binomial proportion** — the
 * share of objectives verified — so its sampling error is exactly what a Wilson
 * interval describes. Depth is carried through as a point estimate: it is a
 * weighted mean over every objective, not a count, so it has no comparable
 * closed-form band. The result is therefore a band on the part of the number that
 * is genuinely a proportion, which is narrower than the true uncertainty and is
 * labelled in the UI as an estimate rather than a guarantee.
 *
 * This exists because the readiness figure was the product's strongest claim and
 * its least-supported one: nothing in the loop has ever been checked against a real
 * exam result. Until `ExamOutcome` data can calibrate it, showing the band is the
 * honest interim.
 */
export function examReadinessBand(objectives: ObjectiveSnapshot[], now: Date): ScoreInterval {
  if (objectives.length === 0) return { low: 0, high: 0 };

  const verified = objectives.filter((o) =>
    VERIFIED_STATES.has(effectiveState(o.state, o.next_review_at, now)),
  ).length;

  const totalWeight = objectives.reduce((sum, o) => sum + o.weight, 0) || 1;
  const depth =
    objectives.reduce((sum, o) => sum + effectiveMastery(o, now) * o.weight, 0) / totalWeight;

  const coverage = wilsonInterval(verified, objectives.length);

  return {
    low: Math.round(coverage.low * depth * 1000) / 10,
    high: Math.round(coverage.high * depth * 1000) / 10,
  };
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
