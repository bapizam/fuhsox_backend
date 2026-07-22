import {
  MASTERY,
  applyAttempt,
  computeConfidence,
  effectiveMastery,
  effectiveState,
  examReadiness,
  nextMasteryScore,
  retentionFactor,
  revisionPriority,
  topicMastery,
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
    expect(result.nextReviewAt).toEqual(daysFromNow(MASTERY.REVIEW_DAYS_AFTER_VERIFY));
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
    expect(result.nextReviewAt).toEqual(daysFromNow(MASTERY.REVIEW_DAYS_AFTER_MASTERY));
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
  it('discounts a stored score by how stale it is', () => {
    const stale = objective({
      mastery_score: 1,
      next_review_at: daysFromNow(-MASTERY.RETENTION_HALF_LIFE_DAYS),
    });
    expect(effectiveMastery(stale, NOW)).toBeCloseTo(0.5, 5);
  });
});
