/**
 * Question-pool economics (reformation Phase 2, critique #1).
 *
 * Two defects this fixes, both in the same draw:
 *
 * 1. **"Memorize 16 questions."** The pool was generated once and every re-check
 *    drew 8 at random from the same 16, so a motivated student saw heavy overlap
 *    across days. The daily cap throttles grinding per day, not over time. Now the
 *    draw PREFERS items this student has never seen, and the caller grows the pool
 *    when the unseen supply runs low.
 *
 * 2. **Difficulty was the LLM's self-label.** `difficulty: 'easy'|'hard'` was
 *    whatever the model guessed, so "90%" meant 90% of uncalibrated items. Once an
 *    item has been answered enough times its EMPIRICAL p-value (correct/seen)
 *    replaces the label, and the draw is balanced across those real bands.
 *
 * Deliberately PURE — no Mongo, no clock, injectable rng — so the selection policy
 * is unit-testable without a database.
 */

export type DifficultyBand = 'easy' | 'medium' | 'hard';

/** The subset of an AIQuestion row the draw needs. */
export interface PoolItem {
  id: string;
  bloom_level: string;
  /** The LLM's self-label — the fallback, not the truth. */
  difficulty?: string;
  seen_count?: number;
  correct_count?: number;
}

/**
 * Attempts before a p-value is trusted over the stored label. Five is low for
 * psychometrics and high enough to beat a guess: with per-user pools an item may
 * never be seen more than a handful of times, and waiting for n=30 would mean the
 * empirical path never activates at all.
 */
export const MIN_OBSERVATIONS = 5;

/** p-value thresholds: an item most students get right is, empirically, easy. */
const EASY_P = 0.8;
const MEDIUM_P = 0.5;

/** Round-robin order for a balanced draw — hardest first so a short draw keeps its teeth. */
const BAND_ORDER: readonly DifficultyBand[] = ['hard', 'medium', 'easy'];

/**
 * Observed proportion correct, or null while the evidence is too thin to prefer
 * over the model's label. `correct_count` is clamped to `seen_count` so a
 * mis-incremented counter can't produce p > 1.
 */
export function empiricalP(item: PoolItem): number | null {
  const seen = item.seen_count ?? 0;
  if (seen < MIN_OBSERVATIONS) return null;
  const correct = Math.min(Math.max(item.correct_count ?? 0, 0), seen);
  return correct / seen;
}

/** Empirical band when there is evidence; the stored label otherwise. */
export function difficultyBand(item: PoolItem): DifficultyBand {
  const p = empiricalP(item);
  if (p !== null) {
    if (p >= EASY_P) return 'easy';
    if (p >= MEDIUM_P) return 'medium';
    return 'hard';
  }
  return item.difficulty === 'easy' || item.difficulty === 'hard' ? item.difficulty : 'medium';
}

/** Fisher-Yates, with an injectable rng so tests can pin the order. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Draw `count` items spread across difficulty bands rather than uniformly at
 * random. A uniform draw over a pool that skews easy produces an easy paper, and
 * the 90% bar then measures the pool's luck instead of the student.
 *
 * Buckets are shuffled internally, so two balanced draws over the same pool still
 * differ — the balance constrains the mix, not the identity of the items.
 */
export function balancedDraw(items: PoolItem[], count: number, rng: () => number): PoolItem[] {
  if (count <= 0) return [];
  if (items.length <= count) return shuffle(items, rng);

  const buckets = new Map<DifficultyBand, PoolItem[]>();
  for (const band of BAND_ORDER) buckets.set(band, []);
  for (const item of items) buckets.get(difficultyBand(item))?.push(item);
  for (const band of BAND_ORDER) buckets.set(band, shuffle(buckets.get(band) ?? [], rng));

  const drawn: PoolItem[] = [];
  // Cycle the bands until the quota is met; an empty bucket is simply skipped, so
  // a pool with no hard items still fills up rather than returning short.
  while (drawn.length < count) {
    let tookAny = false;
    for (const band of BAND_ORDER) {
      if (drawn.length >= count) break;
      const next = buckets.get(band)?.shift();
      if (next) {
        drawn.push(next);
        tookAny = true;
      }
    }
    if (!tookAny) break;
  }

  return drawn;
}

/**
 * The draw for one mastery check: unseen items first, band-balanced, topping up
 * from already-seen items only when the unseen supply cannot fill the paper.
 *
 * Rotation is what makes a re-check evidence rather than a memory test. Seen items
 * are a deliberate fallback rather than an error — a student who has exhausted the
 * pool must still be able to attempt the objective, and the caller grows the pool
 * before this point whenever it can.
 */
export function selectForCheck(params: {
  pool: PoolItem[];
  /** Question ids this user has already answered for this objective. */
  seenIds: Set<string>;
  count: number;
  rng?: () => number;
}): PoolItem[] {
  const rng = params.rng ?? Math.random;
  const unseen = params.pool.filter((item) => !params.seenIds.has(item.id));
  const seen = params.pool.filter((item) => params.seenIds.has(item.id));

  const fromUnseen = balancedDraw(unseen, Math.min(params.count, unseen.length), rng);
  if (fromUnseen.length >= params.count) return fromUnseen;

  const topUp = balancedDraw(seen, params.count - fromUnseen.length, rng);
  return [...fromUnseen, ...topUp];
}

/**
 * How many more items an objective needs before its next check can be drawn
 * entirely from unseen material. Zero means no generation is needed — which is the
 * common case, and the reason this is worth computing rather than always growing.
 */
export function unseenShortfall(pool: PoolItem[], seenIds: Set<string>, count: number): number {
  const unseen = pool.reduce((total, item) => total + (seenIds.has(item.id) ? 0 : 1), 0);
  return Math.max(0, count - unseen);
}
