import { Rating } from 'ts-fsrs';
import {
  MASTERY,
  applyAttempt,
  calibration,
  computeConfidence,
  effectiveMastery,
  effectiveState,
  examReadiness,
  examReadinessBand,
  nextMasteryScore,
  ratingForScore,
  retentionFactor,
  retrievability,
  revisionPriority,
  scheduleReview,
  topicMastery,
  wilsonInterval,
  type ObjectiveSnapshot,
} from '@utils/mastery';

const NOW = new Date('2026-07-22T12:00:00.000Z');
const DAY = 86_400_000;
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY);

const objective = (over: Partial<ObjectiveSnapshot> = {}): ObjectiveSnapshot => ({
  id: 'obj-1',
  subject: 'Human Physiology',
  state: 'not_started',
  mastery_score: 0,
  confidence: 0,
  weight: 1,
  next_review_at: null,
  ...over,
});

describe('nextMasteryScore', () => {
  it('adopts the first attempt outright rather than averaging against a no-evidence zero', () => {
    expect(nextMasteryScore(0, 0.8, 0)).toBeCloseTo(0.8);
  });

  it('weights recent evidence more heavily but keeps history', () => {
    const next = nextMasteryScore(0.4, 1, 3);
    expect(next).toBeCloseTo(MASTERY.EWMA_ALPHA * 1 + (1 - MASTERY.EWMA_ALPHA) * 0.4);
    expect(next).toBeGreaterThan(0.4);
    expect(next).toBeLessThan(1);
  });

  it('stays within 0..1', () => {
    expect(nextMasteryScore(1, 5, 2)).toBe(1);
    expect(nextMasteryScore(0, -3, 2)).toBe(0);
  });
});

describe('computeConfidence', () => {
  it('caps a single attempt — one data point cannot show consistency', () => {
    expect(computeConfidence([1])).toBeCloseTo(0.5);
  });

  it('rates consistent scores above erratic ones with the same mean', () => {
    const steady = computeConfidence([0.8, 0.8, 0.8]);
    const erratic = computeConfidence([0.4, 1.0, 1.0]);
    expect(steady).toBeGreaterThan(erratic);
  });

  it('is zero with no evidence', () => {
    expect(computeConfidence([])).toBe(0);
  });
});

describe('retentionFactor', () => {
  it('is full while the objective is not yet due', () => {
    expect(retentionFactor(daysFromNow(5), NOW)).toBe(1);
    expect(retentionFactor(null, NOW)).toBe(1);
  });

  it('halves after one half-life past due', () => {
    const due = daysFromNow(-MASTERY.RETENTION_HALF_LIFE_DAYS);
    expect(retentionFactor(due, NOW)).toBeCloseTo(0.5, 5);
  });

  it('keeps decaying without going negative', () => {
    expect(retentionFactor(daysFromNow(-365), NOW)).toBeGreaterThanOrEqual(0);
    expect(retentionFactor(daysFromNow(-365), NOW)).toBeLessThan(0.01);
  });
});

describe('applyAttempt — the progression gate', () => {
  const base = {
    previousMastery: 0,
    priorAttempts: 0,
    threshold: 0.9,
    lastVerifiedAt: null,
    now: NOW,
  };

  it('does NOT verify below the threshold, however close', () => {
    const result = applyAttempt({ ...base, currentState: 'practicing', scoreFraction: 0.89 });
    expect(result.state).toBe('practicing');
    expect(result.nextReviewAt).toBeNull();
  });

  it('verifies at exactly the threshold', () => {
    const result = applyAttempt({ ...base, currentState: 'practicing', scoreFraction: 0.9 });
    expect(result.state).toBe('verified');
    expect(result.lastVerifiedAt).toEqual(NOW);
    expect(result.nextReviewAt).not.toBeNull();
  });

  /**
   * PARITY GUARD for the Phase 3 FSRS swap. The flat rule this replaced scheduled
   * a first pass at 3 days and a second at 14; FSRS arrives at the same answer for
   * that straightforward path from the item's own history. If this ever drifts,
   * the swap changed behaviour on the common case and that is worth knowing.
   */
  it('schedules a first pass where the old flat rule did (~3 days)', () => {
    const result = applyAttempt({ ...base, currentState: 'practicing', scoreFraction: 0.9 });
    const days = (result.nextReviewAt!.getTime() - NOW.getTime()) / DAY;
    expect(days).toBeCloseTo(MASTERY.REVIEW_DAYS_AFTER_VERIFY, 0);
  });

  it('calls a first failure "learning", not "practicing", from not_started', () => {
    expect(applyAttempt({ ...base, currentState: 'not_started', scoreFraction: 0.2 }).state).toBe(
      'learning',
    );
  });

  it('refuses mastery for two passes in the same sitting — that is cramming', () => {
    const result = applyAttempt({
      ...base,
      currentState: 'verified',
      lastVerifiedAt: NOW,
      scoreFraction: 1,
    });
    expect(result.state).toBe('verified');
  });

  it('grants mastery for a second pass after the retention gap', () => {
    const result = applyAttempt({
      ...base,
      currentState: 'verified',
      lastVerifiedAt: daysFromNow(-MASTERY.MIN_DAYS_TO_MASTERY),
      scoreFraction: 0.95,
      priorAttempts: 1,
      previousMastery: 0.9,
    });
    expect(result.state).toBe('mastered');
    // Parity guard, as above: the old flat rule said 14 days here and FSRS agrees
    // for a clean second pass. Loose tolerance — FSRS derives it, we don't set it.
    const days = (result.nextReviewAt!.getTime() - NOW.getTime()) / DAY;
    expect(days).toBeGreaterThan(MASTERY.REVIEW_DAYS_AFTER_VERIFY);
    expect(days).toBeLessThanOrEqual(MASTERY.REVIEW_DAYS_AFTER_MASTERY + 7);
  });

  it('regresses a mastered objective to practicing on failure, without wiping the score', () => {
    const result = applyAttempt({
      ...base,
      currentState: 'mastered',
      previousMastery: 0.95,
      priorAttempts: 4,
      lastVerifiedAt: daysFromNow(-30),
      scoreFraction: 0.3,
    });
    expect(result.state).toBe('practicing');
    expect(result.masteryScore).toBeGreaterThan(0);
    // The earlier verification is not erased — history is preserved.
    expect(result.lastVerifiedAt).toEqual(daysFromNow(-30));
  });
});

describe('effectiveState', () => {
  it('decays a verified objective back to practicing once review is overdue', () => {
    expect(effectiveState('verified', daysFromNow(-1), NOW)).toBe('practicing');
    expect(effectiveState('mastered', daysFromNow(-1), NOW)).toBe('practicing');
  });

  it('leaves an objective alone while still within its review window', () => {
    expect(effectiveState('verified', daysFromNow(1), NOW)).toBe('verified');
  });

  it('never promotes an unproven objective', () => {
    expect(effectiveState('learning', daysFromNow(-99), NOW)).toBe('learning');
  });
});

describe('examReadiness', () => {
  it('is zero with no objectives', () => {
    expect(examReadiness([], NOW)).toBe(0);
  });

  it('does NOT report high readiness for deep mastery of thin coverage', () => {
    // One objective perfect, four untouched: 100% of 20% is not readiness.
    const objectives = [
      objective({ id: 'a', state: 'mastered', mastery_score: 1, next_review_at: daysFromNow(10) }),
      objective({ id: 'b' }),
      objective({ id: 'c' }),
      objective({ id: 'd' }),
      objective({ id: 'e' }),
    ];
    expect(examReadiness(objectives, NOW)).toBeLessThan(10);
  });

  it('approaches 100 only when everything is both covered and mastered', () => {
    const objectives = ['a', 'b', 'c'].map((id) =>
      objective({ id, state: 'mastered', mastery_score: 1, next_review_at: daysFromNow(10) }),
    );
    expect(examReadiness(objectives, NOW)).toBe(100);
  });

  it('falls as verified work goes stale, without any state write', () => {
    const fresh = [objective({ state: 'verified', mastery_score: 1, next_review_at: daysFromNow(5) })];
    const stale = [
      objective({
        state: 'verified',
        mastery_score: 1,
        next_review_at: daysFromNow(-MASTERY.RETENTION_HALF_LIFE_DAYS * 3),
      }),
    ];
    expect(examReadiness(fresh, NOW)).toBeGreaterThan(examReadiness(stale, NOW));
  });
});

describe('topicMastery', () => {
  it('groups by subject and counts only currently-verified objectives', () => {
    const rows = topicMastery(
      [
        objective({ id: 'a', subject: 'Anatomy', state: 'mastered', mastery_score: 1, next_review_at: daysFromNow(9) }),
        objective({ id: 'b', subject: 'Anatomy', state: 'learning', mastery_score: 0.2 }),
        // Verified but overdue — must NOT be counted as verified today.
        objective({ id: 'c', subject: 'Biochem', state: 'verified', mastery_score: 1, next_review_at: daysFromNow(-60) }),
      ],
      NOW,
    );

    const anatomy = rows.find((r) => r.subject === 'Anatomy');
    const biochem = rows.find((r) => r.subject === 'Biochem');
    expect(anatomy?.objectives_total).toBe(2);
    expect(anatomy?.objectives_verified).toBe(1);
    expect(biochem?.objectives_verified).toBe(0);
  });
});

describe('revisionPriority', () => {
  it('ranks never-attempted and faded work above solid work', () => {
    const rows = revisionPriority(
      [
        objective({ id: 'solid', state: 'mastered', mastery_score: 0.98, next_review_at: daysFromNow(10) }),
        objective({ id: 'fresh-gap', state: 'not_started' }),
        objective({ id: 'faded', state: 'verified', mastery_score: 1, next_review_at: daysFromNow(-60) }),
      ],
      NOW,
    );

    expect(rows[0].objective_id).not.toBe('solid');
    const ids = rows.map((r) => r.objective_id);
    expect(ids.indexOf('fresh-gap')).toBeLessThan(ids.indexOf('solid'));
    expect(ids.indexOf('faded')).toBeLessThan(ids.indexOf('solid'));
  });

  it('labels why each objective surfaced', () => {
    const rows = revisionPriority([objective({ id: 'x', state: 'not_started' })], NOW);
    expect(rows[0].reason).toBe('never_attempted');
  });

  it('weights higher-stakes objectives above equally-weak low-stakes ones', () => {
    const rows = revisionPriority(
      [
        objective({ id: 'minor', state: 'learning', mastery_score: 0.5, weight: 1 }),
        objective({ id: 'major', state: 'learning', mastery_score: 0.5, weight: 3 }),
      ],
      NOW,
    );
    expect(rows[0].objective_id).toBe('major');
  });

  it('drops fully-mastered fresh objectives from the list entirely', () => {
    const rows = revisionPriority(
      [objective({ id: 'done', state: 'mastered', mastery_score: 1, next_review_at: daysFromNow(10) })],
      NOW,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('effectiveMastery', () => {
  it('discounts a stored score by how stale it is (legacy curve, no FSRS state)', () => {
    const stale = objective({
      mastery_score: 1,
      next_review_at: daysFromNow(-MASTERY.RETENTION_HALF_LIFE_DAYS),
    });
    expect(effectiveMastery(stale, NOW)).toBeCloseTo(0.5, 5);
  });
});

// ─── FSRS-driven decay (reformation Phase 3.5) ────────────────────────────────

describe('retrievability', () => {
  it('falls back to the legacy curve when there is no FSRS stability', () => {
    // The compatibility story: objectives predating Phase 3 must still decay.
    const legacy = retrievability({
      stability: null,
      lastReview: null,
      nextReviewAt: daysFromNow(-MASTERY.RETENTION_HALF_LIFE_DAYS),
      now: NOW,
    });
    expect(legacy).toBeCloseTo(0.5, 5);
  });

  it('falls back when stability exists but the review date does not, and vice versa', () => {
    const noReview = retrievability({
      stability: 14, lastReview: null, nextReviewAt: null, now: NOW,
    });
    const noStability = retrievability({
      stability: null, lastReview: daysFromNow(-10), nextReviewAt: null, now: NOW,
    });
    expect(noReview).toBe(1);
    expect(noStability).toBe(1);
  });

  it('is 0.9 at exactly one stability-interval — the definition of stability', () => {
    for (const S of [2, 14, 60]) {
      const r = retrievability({
        stability: S, lastReview: daysFromNow(-S), nextReviewAt: null, now: NOW,
      });
      expect(r).toBeCloseTo(0.9, 2);
    }
  });

  it('decays a SHAKY objective far faster than a SOLID one — the whole point', () => {
    const shaky = retrievability({
      stability: 3, lastReview: daysFromNow(-30), nextReviewAt: null, now: NOW,
    });
    const solid = retrievability({
      stability: 60, lastReview: daysFromNow(-30), nextReviewAt: null, now: NOW,
    });
    // The flat legacy curve gave these two IDENTICAL decay. That was the flaw.
    expect(shaky).toBeLessThan(solid);
    expect(solid - shaky).toBeGreaterThan(0.2);
  });

  it('never exceeds 1, even if last_review is stamped in the future', () => {
    const skewed = retrievability({
      stability: 14, lastReview: daysFromNow(5), nextReviewAt: null, now: NOW,
    });
    expect(skewed).toBeLessThanOrEqual(1);
    expect(skewed).toBe(1);
  });

  it('stays within 0..1 across an absurd elapsed time', () => {
    const ancient = retrievability({
      stability: 1, lastReview: daysFromNow(-3650), nextReviewAt: null, now: NOW,
    });
    expect(ancient).toBeGreaterThanOrEqual(0);
    expect(ancient).toBeLessThanOrEqual(1);
  });
});

describe('readiness impact of the Phase 3.5 decay swap', () => {
  /**
   * Documents — rather than merely asserts — how much the numbers moved, because
   * this change shifts every figure on the analytics dashboard and a silent shift
   * would be indistinguishable from a bug six months from now.
   */
  const stale = (over: Partial<ObjectiveSnapshot>) =>
    objective({
      state: 'verified',
      mastery_score: 1,
      next_review_at: daysFromNow(-60),
      ...over,
    });

  it('reads a long-stale objective as better retained than the flat curve did', () => {
    const withFsrs = stale({ fsrs_stability: 30, fsrs_last_review: daysFromNow(-60) });
    const withoutFsrs = stale({});

    // FSRS: power-law, long tail. Legacy: exponential, effectively zero by 60 days.
    expect(effectiveMastery(withFsrs, NOW)).toBeGreaterThan(effectiveMastery(withoutFsrs, NOW));
    expect(effectiveMastery(withoutFsrs, NOW)).toBeLessThan(0.2);
    expect(effectiveMastery(withFsrs, NOW)).toBeGreaterThan(0.7);
  });

  it('does NOT let that soften staleness overall, because coverage still collapses', () => {
    // The safeguard that makes the gentler depth curve honest: a past-due
    // objective reads as `practicing`, so it leaves the verified count entirely
    // and readiness is coverage × depth. Decay is still counted — once, not twice.
    const rows = [stale({ fsrs_stability: 30, fsrs_last_review: daysFromNow(-60) })];
    expect(effectiveState(rows[0].state, rows[0].next_review_at, NOW)).toBe('practicing');
    expect(examReadiness(rows, NOW)).toBe(0);
  });

  it('leaves a FRESH objective essentially untouched by the swap', () => {
    // Regression guard: the common case (recently verified, not yet due) must not
    // have moved. If this drifts, the swap changed more than it was meant to.
    const fresh = objective({
      state: 'verified',
      mastery_score: 1,
      next_review_at: daysFromNow(3),
      fsrs_stability: 30,
      fsrs_last_review: NOW,
    });
    expect(effectiveMastery(fresh, NOW)).toBeCloseTo(1, 2);
    expect(examReadiness([fresh], NOW)).toBeGreaterThan(99);
  });
});

// ─── FSRS scheduling (reformation Phase 3) ────────────────────────────────────

describe('ratingForScore', () => {
  const THRESHOLD = 0.9;

  it('treats a genuinely failed recall as a lapse', () => {
    expect(ratingForScore(0.2, THRESHOLD)).toBe(Rating.Again);
    expect(ratingForScore(0.49, THRESHOLD)).toBe(Rating.Again);
  });

  it('treats a near miss as Hard, NOT as a lapse', () => {
    // The whole point of the cut point: 87.5% against a 90% bar is one unlucky
    // item, not a forgotten objective. Rating it `Again` would punish it as if
    // the student had drawn a blank.
    expect(ratingForScore(0.875, THRESHOLD)).toBe(Rating.Hard);
    expect(ratingForScore(0.5, THRESHOLD)).toBe(Rating.Hard);
  });

  it('grades a comfortable pass Good and a clean sweep Easy', () => {
    expect(ratingForScore(0.9, THRESHOLD)).toBe(Rating.Good);
    expect(ratingForScore(0.94, THRESHOLD)).toBe(Rating.Good);
    expect(ratingForScore(1, THRESHOLD)).toBe(Rating.Easy);
  });

  it('follows the institution threshold rather than a hardcoded 90%', () => {
    // A school with a 70% bar: 75% is a pass and must not read as a near miss.
    expect(ratingForScore(0.75, 0.7)).toBe(Rating.Good);
    expect(ratingForScore(0.75, 0.95)).toBe(Rating.Hard);
  });
});

describe('scheduleReview', () => {
  const pass = { scoreFraction: 1, threshold: 0.9, now: NOW };

  it('starts a fresh card for an objective that predates Phase 3', () => {
    // The entire backfill story: null FSRS state must schedule, not throw.
    const next = scheduleReview({ previous: null, ...pass });
    expect(next.stability).toBeGreaterThan(0);
    expect(next.due).not.toBeNull();
    expect(next.reps).toBe(1);
  });

  it('lengthens the interval as an objective proves stable', () => {
    const first = scheduleReview({ previous: null, ...pass });
    const second = scheduleReview({ previous: first, ...pass, now: first.due! });
    const firstGap = first.due!.getTime() - NOW.getTime();
    const secondGap = second.due!.getTime() - first.due!.getTime();
    expect(secondGap).toBeGreaterThan(firstGap);
    expect(second.stability).toBeGreaterThan(first.stability!);
  });

  it('shortens the interval and counts a lapse on a failure', () => {
    const solid = scheduleReview({ previous: null, ...pass });
    const grown = scheduleReview({ previous: solid, ...pass, now: solid.due! });
    const lapsed = scheduleReview({
      previous: grown,
      scoreFraction: 0.2,
      threshold: 0.9,
      now: grown.due!,
    });

    const grownGap = grown.due!.getTime() - solid.due!.getTime();
    const lapsedGap = lapsed.due!.getTime() - grown.due!.getTime();
    expect(lapsedGap).toBeLessThan(grownGap);
    expect(lapsed.lapses).toBeGreaterThan(grown.lapses);
  });

  it('is deterministic — fuzz is disabled so the same input schedules the same day', () => {
    const a = scheduleReview({ previous: null, ...pass });
    const b = scheduleReview({ previous: null, ...pass });
    expect(a.due).toEqual(b.due);
  });
});

describe('applyAttempt FSRS integration', () => {
  const base = {
    currentState: 'practicing' as const,
    previousMastery: 0.5,
    priorAttempts: 2,
    threshold: 0.9,
    lastVerifiedAt: null,
    now: NOW,
  };

  it('advances the card on a FAILURE too — a lapse is information the scheduler needs', () => {
    const result = applyAttempt({ ...base, scoreFraction: 0.3 });
    // No review date (a failure is due now, as before) but the card still moved.
    expect(result.nextReviewAt).toBeNull();
    expect(result.fsrs.reps).toBe(1);
    expect(result.fsrs.stability).not.toBeNull();
  });

  it('carries stored card state forward instead of restarting each attempt', () => {
    const first = applyAttempt({ ...base, scoreFraction: 0.95 });
    const second = applyAttempt({
      ...base,
      scoreFraction: 0.95,
      now: first.fsrs.due!,
      fsrs: first.fsrs,
    });
    expect(second.fsrs.reps).toBe(2);
    expect(second.fsrs.stability!).toBeGreaterThan(first.fsrs.stability!);
  });

  it('schedules a repeatedly-lapsed objective sooner than a consistently-passed one', () => {
    // This is the entire argument for FSRS over a flat rule: two objectives with
    // identical state but different histories must not get the same interval.
    let solid = applyAttempt({ ...base, scoreFraction: 1 });
    let shaky = applyAttempt({ ...base, scoreFraction: 1 });
    for (let i = 0; i < 2; i++) {
      solid = applyAttempt({ ...base, scoreFraction: 1, now: solid.fsrs.due!, fsrs: solid.fsrs });
      shaky = applyAttempt({ ...base, scoreFraction: 0.2, now: shaky.fsrs.due!, fsrs: shaky.fsrs });
    }
    const finalShaky = applyAttempt({
      ...base, scoreFraction: 1, now: shaky.fsrs.due!, fsrs: shaky.fsrs,
    });
    expect(finalShaky.fsrs.stability!).toBeLessThan(solid.fsrs.stability!);
  });
});

// ─── Metacognitive calibration (reformation Phase 3) ──────────────────────────

describe('calibration', () => {
  it('is null when nothing was rated — not a misleading zero', () => {
    expect(calibration([])).toBeNull();
    expect(
      calibration([
        { confidence: null, isCorrect: true },
        { confidence: undefined, isCorrect: false },
      ]),
    ).toBeNull();
  });

  it('reports overconfidence as a positive gap', () => {
    const result = calibration([
      { confidence: 5, isCorrect: false },
      { confidence: 5, isCorrect: false },
      { confidence: 5, isCorrect: true },
      { confidence: 5, isCorrect: false },
    ]);
    expect(result).not.toBeNull();
    expect(result!.claimed).toBe(1);
    expect(result!.actual).toBe(0.25);
    expect(result!.gap).toBeGreaterThan(0);
  });

  it('reports underconfidence as a negative gap', () => {
    const result = calibration([
      { confidence: 1, isCorrect: true },
      { confidence: 1, isCorrect: true },
      { confidence: 2, isCorrect: true },
      { confidence: 1, isCorrect: true },
    ]);
    expect(result!.gap).toBeLessThan(0);
  });

  it('reports a well-calibrated student as roughly zero', () => {
    const result = calibration([
      { confidence: 5, isCorrect: true },
      { confidence: 5, isCorrect: true },
      { confidence: 1, isCorrect: false },
      { confidence: 1, isCorrect: false },
    ]);
    expect(Math.abs(result!.gap)).toBeLessThan(0.01);
  });

  it('ignores unrated items rather than counting them as zero confidence', () => {
    const result = calibration([
      { confidence: 5, isCorrect: true },
      { confidence: null, isCorrect: false },
      { confidence: null, isCorrect: false },
    ]);
    expect(result!.rated).toBe(1);
    expect(result!.claimed).toBe(1);
    expect(result!.actual).toBe(1);
  });
});

// ─── Measurement honesty (reformation Phase 2) ────────────────────────────────

describe('wilsonInterval', () => {
  it('brackets the observed proportion', () => {
    const { low, high } = wilsonInterval(7, 8);
    expect(low).toBeLessThan(7 / 8);
    expect(high).toBeGreaterThan(7 / 8);
  });

  it('still admits doubt at a perfect score — where the normal interval collapses', () => {
    const { low, high } = wilsonInterval(8, 8);
    expect(high).toBe(1);
    // The textbook normal approximation would give [1, 1] here, claiming certainty
    // from eight questions. Wilson does not.
    expect(low).toBeGreaterThan(0.6);
    expect(low).toBeLessThan(1);
  });

  it('never leaves 0..1, including at a zero score', () => {
    const { low, high } = wilsonInterval(0, 8);
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });

  it('narrows as the sample grows — the argument for more than 8 items', () => {
    const short = wilsonInterval(7, 8);
    const long = wilsonInterval(70, 80);
    expect(long.high - long.low).toBeLessThan(short.high - short.low);
  });

  it('is maximally uncertain with no evidence', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('shows an 8-item check cannot cleanly resolve the 90% gate', () => {
    // 7/8 = 87.5% "fails" a 90% bar, but the interval comfortably contains 90% —
    // the measurement is noisier than the thing it gates, which is exactly why the
    // band is surfaced instead of a bare verdict.
    const { low, high } = wilsonInterval(7, 8);
    expect(low).toBeLessThan(0.9);
    expect(high).toBeGreaterThan(0.9);
  });
});

describe('examReadinessBand', () => {
  it('brackets the point estimate', () => {
    const rows = [
      objective({ id: 'a', state: 'verified', mastery_score: 0.9, next_review_at: daysFromNow(3) }),
      objective({ id: 'b', state: 'verified', mastery_score: 0.8, next_review_at: daysFromNow(3) }),
      objective({ id: 'c', state: 'learning', mastery_score: 0.3 }),
      objective({ id: 'd', state: 'not_started', mastery_score: 0 }),
    ];

    const point = examReadiness(rows, NOW);
    const band = examReadinessBand(rows, NOW);

    expect(band.low).toBeLessThanOrEqual(point);
    expect(band.high).toBeGreaterThanOrEqual(point);
  });

  it('is zero-width with nothing to measure', () => {
    expect(examReadinessBand([], NOW)).toEqual({ low: 0, high: 0 });
  });

  it('is wide on few objectives and tighter on many at the same coverage', () => {
    const build = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        objective({
          id: `o${i}`,
          state: i % 2 === 0 ? 'verified' : 'learning',
          mastery_score: 0.8,
          next_review_at: i % 2 === 0 ? daysFromNow(3) : null,
        }),
      );

    const few = examReadinessBand(build(4), NOW);
    const many = examReadinessBand(build(40), NOW);
    expect(many.high - many.low).toBeLessThan(few.high - few.low);
  });
});
