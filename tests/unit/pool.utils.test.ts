import {
  MIN_OBSERVATIONS,
  balancedDraw,
  difficultyBand,
  empiricalP,
  selectForCheck,
  unseenShortfall,
  type PoolItem,
} from '@utils/pool';

const item = (over: Partial<PoolItem> & { id: string }): PoolItem => ({
  bloom_level: 'understand',
  difficulty: 'medium',
  seen_count: 0,
  correct_count: 0,
  ...over,
});

/** Deterministic rng so a draw's composition can be asserted, not just its size. */
const fixedRng = () => 0;

describe('empiricalP', () => {
  it('is null until there is enough evidence to beat the label', () => {
    expect(empiricalP(item({ id: '1', seen_count: MIN_OBSERVATIONS - 1, correct_count: 0 }))).toBeNull();
    expect(empiricalP(item({ id: '2' }))).toBeNull();
  });

  it('is the observed proportion once the threshold is reached', () => {
    expect(empiricalP(item({ id: '1', seen_count: 10, correct_count: 9 }))).toBeCloseTo(0.9);
  });

  it('clamps a corrupted correct_count rather than reporting p > 1', () => {
    expect(empiricalP(item({ id: '1', seen_count: 5, correct_count: 99 }))).toBe(1);
    expect(empiricalP(item({ id: '2', seen_count: 5, correct_count: -3 }))).toBe(0);
  });
});

describe('difficultyBand', () => {
  it('falls back to the LLM label while evidence is thin', () => {
    expect(difficultyBand(item({ id: '1', difficulty: 'hard' }))).toBe('hard');
    expect(difficultyBand(item({ id: '2', difficulty: 'easy' }))).toBe('easy');
    // An unrecognised label is treated as medium, not trusted blindly.
    expect(difficultyBand(item({ id: '3', difficulty: 'trivial' }))).toBe('medium');
  });

  it('lets real p-values OVERRIDE the label — the whole point of the counters', () => {
    // The model called it hard; students get it right 95% of the time.
    const mislabelled = item({ id: '1', difficulty: 'hard', seen_count: 20, correct_count: 19 });
    expect(difficultyBand(mislabelled)).toBe('easy');

    const alsoWrong = item({ id: '2', difficulty: 'easy', seen_count: 20, correct_count: 4 });
    expect(difficultyBand(alsoWrong)).toBe('hard');
  });
});

describe('balancedDraw', () => {
  const mixedPool = [
    ...Array.from({ length: 6 }, (_, i) => item({ id: `e${i}`, difficulty: 'easy' })),
    ...Array.from({ length: 6 }, (_, i) => item({ id: `m${i}`, difficulty: 'medium' })),
    ...Array.from({ length: 6 }, (_, i) => item({ id: `h${i}`, difficulty: 'hard' })),
  ];

  it('spreads the draw across bands instead of sampling uniformly', () => {
    const drawn = balancedDraw(mixedPool, 6, fixedRng);
    const bands = drawn.map(difficultyBand);
    expect(drawn).toHaveLength(6);
    expect(bands.filter((b) => b === 'easy')).toHaveLength(2);
    expect(bands.filter((b) => b === 'medium')).toHaveLength(2);
    expect(bands.filter((b) => b === 'hard')).toHaveLength(2);
  });

  it('fills up from the remaining bands when one is empty', () => {
    const easyOnly = mixedPool.filter((i) => i.difficulty === 'easy');
    expect(balancedDraw(easyOnly, 4, fixedRng)).toHaveLength(4);
  });

  it('returns the whole pool (shuffled) when it cannot fill the quota', () => {
    expect(balancedDraw(mixedPool.slice(0, 3), 8, fixedRng)).toHaveLength(3);
  });

  it('returns nothing for a non-positive count', () => {
    expect(balancedDraw(mixedPool, 0, fixedRng)).toEqual([]);
  });
});

describe('selectForCheck', () => {
  const pool = Array.from({ length: 16 }, (_, i) =>
    item({ id: `q${i}`, difficulty: i % 3 === 0 ? 'hard' : i % 3 === 1 ? 'medium' : 'easy' }),
  );

  it('draws only unseen items while there are enough of them', () => {
    const seenIds = new Set(['q0', 'q1', 'q2', 'q3']);
    const drawn = selectForCheck({ pool, seenIds, count: 8, rng: fixedRng });

    expect(drawn).toHaveLength(8);
    expect(drawn.every((q) => !seenIds.has(q.id))).toBe(true);
  });

  it('is the fix for "memorize 16 questions": a second check reuses nothing', () => {
    const first = selectForCheck({ pool, seenIds: new Set(), count: 8, rng: Math.random });
    const seenIds = new Set(first.map((q) => q.id));
    const second = selectForCheck({ pool, seenIds, count: 8, rng: Math.random });

    expect(second.filter((q) => seenIds.has(q.id))).toHaveLength(0);
  });

  it('tops up from seen items rather than returning a short paper', () => {
    const seenIds = new Set(pool.slice(0, 12).map((q) => q.id));
    const drawn = selectForCheck({ pool, seenIds, count: 8, rng: fixedRng });

    expect(drawn).toHaveLength(8);
    // All 4 unseen come first, then 4 repeats — never a 4-question check.
    expect(drawn.slice(0, 4).every((q) => !seenIds.has(q.id))).toBe(true);
    expect(drawn.filter((q) => seenIds.has(q.id))).toHaveLength(4);
  });

  it('never returns duplicates within one draw', () => {
    const seenIds = new Set(pool.slice(0, 14).map((q) => q.id));
    const drawn = selectForCheck({ pool, seenIds, count: 8, rng: Math.random });
    expect(new Set(drawn.map((q) => q.id)).size).toBe(drawn.length);
  });
});

describe('unseenShortfall', () => {
  const pool = Array.from({ length: 10 }, (_, i) => item({ id: `q${i}` }));

  it('is zero while a full paper of unseen items remains — no growth is paid for', () => {
    expect(unseenShortfall(pool, new Set(['q0']), 8)).toBe(0);
  });

  it('counts exactly how many more items are needed', () => {
    const seen = new Set(pool.slice(0, 5).map((q) => q.id));
    expect(unseenShortfall(pool, seen, 8)).toBe(3);
  });

  it('is the full count for an empty pool', () => {
    expect(unseenShortfall([], new Set(), 8)).toBe(8);
  });
});
