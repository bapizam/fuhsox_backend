/**
 * Bayesian Knowledge Tracing — the per-knowledge-component student model
 * (reformation Phase 4, Workstream A).
 *
 * **What this fixes.** `utils/mastery.ts` tracks an EWMA per OBJECTIVE, and the
 * critique's point #2 was that a bag of independent EWMAs cannot reason: it knows
 * you failed Cardiac Output and has no way to suspect Membrane Potentials, because
 * no objective has any relation to any other. BKT gives each *knowledge component*
 * a probability that the student knows it, `p_known`, which is the quantity the
 * prerequisite graph in `utils/kc-graph.ts` then walks over.
 *
 * **Why BKT and not something heavier.** BKT is four numbers and one line of Bayes.
 * That is the ceiling here on purpose — deep knowledge tracing needs data volumes
 * this product does not have, and more importantly its output cannot be explained
 * to the student it is about. "You have probably not got membrane potentials yet,
 * because you have missed it 3 times out of 4" is a claim a learner can argue with.
 * A neural embedding is not.
 *
 * **Why it is not the same thing as `mastery_score`.** The EWMA is a smoothed
 * average of past scores — a description of what happened. `p_known` is a belief
 * about a latent state, with slip and guess explicitly modelled, so a single lucky
 * pass moves it far less than it moves an average. They answer different questions
 * and both are kept.
 *
 * Deliberately PURE: no Prisma, no AI, no clock. Every value is derived on read
 * from `MasteryAttempt` rows that already exist, so BKT adds no write path and
 * nothing to keep in sync — the same choice `effectiveState` makes.
 */

// ─── Tuning ───────────────────────────────────────────────────────────────────

export interface BktParams {
  /** P(L0) — probability the student already knows a KC before any evidence. */
  prior: number;
  /** P(T) — probability of learning it between one opportunity and the next. */
  transit: number;
  /** P(S) — probability of getting it wrong despite knowing it. */
  slip: number;
  /** P(G) — probability of getting it right without knowing it. */
  guess: number;
}

/**
 * Standard BKT parameters, held as documented tuning rather than magic numbers —
 * the same treatment `MASTERY` gets in `utils/mastery.ts`.
 *
 * These are literature-standard starting values, NOT fitted to this population.
 * Fitting them needs per-KC attempt volumes that do not exist yet, and inventing a
 * fit from thin data is precisely the sin the reformation set out to fix. When
 * there is volume, fit `slip`/`guess` per KC first — they are the two that vary
 * most between topics.
 */
export const BKT: BktParams & { MASTERY_AT: number; SHAKY_BELOW: number } = {
  /**
   * A student arriving at a KC is assumed more likely not to know it than to know
   * it. 0.25 rather than 0.5 because these KCs come from the student's own
   * syllabus — material they are studying *because* it is new to them.
   */
  prior: 0.25,
  /**
   * Each assessed opportunity carries a real chance of learning. Kept modest: a
   * mastery check is an assessment, not a lesson, so most of the learning happens
   * between attempts rather than during one.
   */
  transit: 0.1,
  /**
   * Knowing it and still getting it wrong. A mastery check is a MULTI-ITEM pass/fail
   * against a 90% bar, so a slip means several careless items in one sitting —
   * rarer than a single-item slip, hence the low value.
   */
  slip: 0.1,
  /**
   * Getting it right without knowing it. A whole check passed by guessing is very
   * unlikely, which is exactly why the check is the evidence unit here.
   */
  guess: 0.15,
  /** At or above this, treat the KC as known — used only for labelling. */
  MASTERY_AT: 0.85,
  /**
   * Below this a KC is weak enough to be worth naming as a prerequisite gap.
   * Above the prior, so a KC with NO evidence at all never gets reported as a
   * diagnosis — "you have not studied this yet" is not the same claim as "this is
   * why you are failing", and conflating them would put words in the model's mouth.
   */
  SHAKY_BELOW: 0.4,
} as const;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ─── The model ────────────────────────────────────────────────────────────────

/**
 * One BKT step: posterior after observing evidence, then the learning transition.
 *
 *   P(L | correct)   = P(L)(1−S)             / [ P(L)(1−S) + (1−P(L))G     ]
 *   P(L | incorrect) = P(L)S                 / [ P(L)S     + (1−P(L))(1−G) ]
 *   P(L')            = P(L | obs) + (1 − P(L | obs)) · T
 *
 * The transit term is why a correct answer can never *lower* `p_known` and why
 * repeated failure still leaves a floor — the student is assumed to be learning
 * between opportunities even when the evidence is bad. That floor is deliberate:
 * a model that drove a struggling student's belief to zero would produce a
 * diagnosis that reads as a verdict on them rather than on the material.
 */
export function bktUpdate(pKnown: number, correct: boolean, params: BktParams = BKT): number {
  const prior = clamp01(pKnown);
  const { slip, guess, transit } = params;

  const numerator = correct ? prior * (1 - slip) : prior * slip;
  const denominator = correct
    ? prior * (1 - slip) + (1 - prior) * guess
    : prior * slip + (1 - prior) * (1 - guess);

  // Only reachable with degenerate params (slip=0 and guess=0 on an incorrect
  // observation, say). Keeping the prior is the honest response to evidence that
  // carries no information, and it is what stops a NaN reaching a student.
  const posterior = denominator > 0 ? numerator / denominator : prior;

  return clamp01(posterior + (1 - posterior) * transit);
}

/**
 * Fold a whole ordered evidence sequence into one `p_known`.
 *
 * Order matters and must be OLDEST FIRST — BKT is a recursive filter, so feeding
 * it newest-first would model a student who un-learns. Callers reading from Prisma
 * generally have `orderBy: { created_at: 'desc' }` reflexes, which is exactly why
 * this takes the sequence rather than letting each caller roll its own loop.
 *
 * An empty sequence returns the prior, which is the correct "no evidence" answer
 * rather than zero.
 */
export function bktSequence(evidence: boolean[], params: BktParams = BKT): number {
  return evidence.reduce((pKnown, correct) => bktUpdate(pKnown, correct, params), params.prior);
}

export interface KcEvidence {
  kc_id: string;
  /** Passed the mastery check. The evidence unit is a CHECK, not an item. */
  correct: boolean;
  /** Used only to order the fold; the value itself never enters the maths. */
  at: Date;
}

export interface KcMastery {
  kc_id: string;
  /** 0..1 — probability the student knows this KC. */
  p_known: number;
  /** How many assessed opportunities this belief rests on. */
  opportunities: number;
}

/**
 * `p_known` per KC from a flat evidence list, sorted internally so callers cannot
 * get the direction wrong.
 *
 * `opportunities` is returned alongside because a probability with no sample size
 * is the kind of number this codebase has spent three phases learning not to
 * publish. One failed check and five failed checks produce similar `p_known` and
 * are not similar claims.
 */
export function kcMastery(evidence: KcEvidence[], params: BktParams = BKT): KcMastery[] {
  const byKc = new Map<string, KcEvidence[]>();
  for (const item of evidence) {
    const bucket = byKc.get(item.kc_id);
    if (bucket) bucket.push(item);
    else byKc.set(item.kc_id, [item]);
  }

  const rows: KcMastery[] = [];
  for (const [kc_id, items] of byKc) {
    const ordered = [...items].sort((a, b) => a.at.getTime() - b.at.getTime());
    rows.push({
      kc_id,
      p_known: Math.round(bktSequence(ordered.map((i) => i.correct), params) * 1000) / 1000,
      opportunities: ordered.length,
    });
  }

  return rows.sort((a, b) => a.p_known - b.p_known);
}
