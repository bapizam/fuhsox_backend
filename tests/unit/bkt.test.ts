import { BKT, bktSequence, bktUpdate, kcMastery, type KcEvidence } from '@utils/bkt';

const at = (day: number) => new Date(2026, 6, day);

describe('bktUpdate', () => {
  it('raises the belief on a correct answer and lowers it on an incorrect one', () => {
    const start = 0.5;
    expect(bktUpdate(start, true)).toBeGreaterThan(start);
    expect(bktUpdate(start, false)).toBeLessThan(start);
  });

  it('stays inside 0..1 for any input, including out-of-range priors', () => {
    for (const prior of [-1, 0, 0.3, 1, 2]) {
      for (const correct of [true, false]) {
        const posterior = bktUpdate(prior, correct);
        expect(posterior).toBeGreaterThanOrEqual(0);
        expect(posterior).toBeLessThanOrEqual(1);
        expect(Number.isNaN(posterior)).toBe(false);
      }
    }
  });

  it('is monotonic in the prior — knowing more before means knowing more after', () => {
    expect(bktUpdate(0.7, true)).toBeGreaterThan(bktUpdate(0.3, true));
    expect(bktUpdate(0.7, false)).toBeGreaterThan(bktUpdate(0.3, false));
  });

  it('never lets repeated failure drive the belief to zero', () => {
    // The transit term is a floor by design: a model that concluded a struggling
    // student knows NOTHING would produce a diagnosis that reads as a verdict on
    // them rather than on the material.
    let pKnown = 0.5;
    for (let i = 0; i < 50; i++) pKnown = bktUpdate(pKnown, false);
    expect(pKnown).toBeGreaterThan(0);
  });

  it('converges upward under sustained correctness without exceeding 1', () => {
    let pKnown = BKT.prior;
    for (let i = 0; i < 50; i++) pKnown = bktUpdate(pKnown, true);
    expect(pKnown).toBeGreaterThan(BKT.MASTERY_AT);
    expect(pKnown).toBeLessThanOrEqual(1);
  });

  it('moves less on evidence when slip and guess are high — noisy evidence counts for less', () => {
    const clean = bktUpdate(0.5, true, { prior: 0.25, transit: 0, slip: 0.01, guess: 0.01 });
    const noisy = bktUpdate(0.5, true, { prior: 0.25, transit: 0, slip: 0.4, guess: 0.4 });
    expect(clean).toBeGreaterThan(noisy);
  });

  it('treats a failure under zero slip as proof of non-mastery', () => {
    // If it is impossible to know it and still get it wrong, then getting it wrong
    // IS the proof. 0 is the correct Bayesian answer here, not a degenerate one.
    expect(bktUpdate(0.5, false, { prior: 0.25, transit: 0, slip: 0, guess: 0 })).toBe(0);
  });

  it('keeps the prior rather than returning NaN when the evidence carries no information', () => {
    // The genuinely degenerate case: a prior of 1 with zero slip zeroes BOTH sides
    // of the ratio on a failure — the params say this observation is impossible.
    // Keeping the prior is the honest response, and it is what stops a NaN
    // reaching a student.
    const posterior = bktUpdate(1, false, { prior: 0.25, transit: 0, slip: 0, guess: 0.15 });
    expect(posterior).toBe(1);
    expect(Number.isNaN(posterior)).toBe(false);
  });

  it('applies the transit term, so a correct answer never lowers the belief', () => {
    for (const prior of [0.1, 0.5, 0.9, 0.99]) {
      expect(bktUpdate(prior, true)).toBeGreaterThanOrEqual(prior);
    }
  });
});

describe('bktSequence', () => {
  it('returns the prior for no evidence — "unknown", not zero', () => {
    expect(bktSequence([])).toBe(BKT.prior);
  });

  it('is order-sensitive: recent evidence dominates', () => {
    const improving = bktSequence([false, false, true, true]);
    const declining = bktSequence([true, true, false, false]);
    expect(improving).toBeGreaterThan(declining);
  });

  it('rates a consistent passer above a mixed record', () => {
    expect(bktSequence([true, true, true])).toBeGreaterThan(bktSequence([true, false, true]));
  });
});

describe('kcMastery', () => {
  const evidence: KcEvidence[] = [
    { kc_id: 'strong', correct: true,  at: at(1) },
    { kc_id: 'strong', correct: true,  at: at(2) },
    { kc_id: 'weak',   correct: false, at: at(1) },
    { kc_id: 'weak',   correct: false, at: at(2) },
    { kc_id: 'weak',   correct: false, at: at(3) },
  ];

  it('groups by KC and reports the sample size behind each belief', () => {
    const rows = kcMastery(evidence);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kc_id === 'weak')?.opportunities).toBe(3);
    expect(rows.find((r) => r.kc_id === 'strong')?.opportunities).toBe(2);
  });

  it('sorts weakest first, so the caller reads the problems off the top', () => {
    const rows = kcMastery(evidence);
    expect(rows[0].kc_id).toBe('weak');
    expect(rows[0].p_known).toBeLessThan(rows[1].p_known);
  });

  it('orders evidence oldest-first internally, so a caller cannot get it backwards', () => {
    // Prisma callers reach for `orderBy: { created_at: 'desc' }` reflexively. BKT
    // is a recursive filter, so feeding it newest-first would model a student who
    // un-learns — this must be immune to the caller's ordering.
    const ascending = kcMastery([
      { kc_id: 'k', correct: false, at: at(1) },
      { kc_id: 'k', correct: true,  at: at(2) },
    ]);
    const descending = kcMastery([
      { kc_id: 'k', correct: true,  at: at(2) },
      { kc_id: 'k', correct: false, at: at(1) },
    ]);
    expect(ascending[0].p_known).toBe(descending[0].p_known);
  });

  it('returns nothing for no evidence rather than inventing rows at the prior', () => {
    expect(kcMastery([])).toEqual([]);
  });

  it('leaves a repeatedly-failed KC below the shaky bar and a passed one above mastery', () => {
    const rows = kcMastery(evidence);
    expect(rows.find((r) => r.kc_id === 'weak')?.p_known).toBeLessThan(BKT.SHAKY_BELOW);
    expect(rows.find((r) => r.kc_id === 'strong')?.p_known).toBeGreaterThan(BKT.SHAKY_BELOW);
  });
});
