/**
 * Misconception-string quality guard (reformation Phase 3, Workstream C).
 *
 * **Why this exists, and why it is not optional.**
 *
 * Phase 1 made the engine record *which misconception* a student's chosen
 * distractor represents. Workstream C now turns those strings into TEACHING —
 * a generated worked example addressing that specific error. That inverts the
 * cost of a bad string: a vague `weak_concepts` entry used to make one analytics
 * row read poorly; now it becomes the premise of a lesson the student is invited
 * to trust. In a health-sciences context, confidently teaching from
 * "misunderstands the concept" is worse than teaching nothing at all.
 *
 * So no lesson is ever generated from a string that fails these rules. The gate
 * is enforced HERE, in code, on every request — not by a one-off human review,
 * because a bad pool can be generated at any time, not just on the day someone
 * happened to look.
 *
 * Deliberately PURE so the policy is unit-testable without AI, DB or clock.
 */

export type MisconceptionVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Below this, a string cannot be naming a specific error. "Wrong units" is 11
 * characters and genuinely diagnostic, so the bar is set under that.
 */
const MIN_CHARS = 10;

/**
 * A specific misconception names a *relationship* the student got wrong, which in
 * practice always takes more than one word ("confuses preload with afterload").
 */
const MIN_WORDS = 3;

/**
 * Strings that are grammatically fine and diagnostically empty. These are the
 * model's failure mode when it has nothing real to say: it restates that the
 * answer was wrong, in the shape of a misconception.
 *
 * Anchored at the start, because "confuses X with Y — a common misunderstanding"
 * is a GOOD string that merely contains one of these words.
 */
const GENERIC_OPENERS = [
  /^(this|the)?\s*(answer|option|choice)\s+is\s+(just\s+)?(wrong|incorrect|not correct)/i,
  /^(wrong|incorrect|not correct|invalid)\.?$/i,
  /^(a\s+)?(common\s+)?(misconception|misunderstanding|confusion|error|mistake)\.?$/i,
  /^(student|learner|they)?\s*(does not|doesn't|did not|didn't|fails to)\s+(understand|know|grasp|recall)\s*(the\s*(concept|topic|material|content))?\.?$/i,
  /^(lack|lacks|lacking)\s+(of\s+)?(understanding|knowledge)/i,
  /^(misunderstands?|misreads?)\s+(the\s+)?(concept|question|topic|material)\.?$/i,
  /^(no|not)\s+(the\s+)?(correct|right)\s+answer/i,
  /^(guess|guessing|random)/i,
];

/** Collapse whitespace/case/trailing punctuation for comparison. */
function normalize(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.;,:!]+$/, '');
}

/**
 * Judge one misconception string.
 *
 * `optionText` is the distractor the string is attached to. A "misconception"
 * that merely restates its own option ("the left ventricle" on option
 * "Left ventricle") diagnoses nothing — it is the model filling a required field.
 */
export function assessMisconception(
  text: string | null | undefined,
  context: { optionText?: string | null } = {},
): MisconceptionVerdict {
  if (typeof text !== 'string') return { ok: false, reason: 'missing' };

  const normalized = normalize(text);
  if (normalized.length === 0) return { ok: false, reason: 'empty' };
  if (normalized.length < MIN_CHARS) return { ok: false, reason: 'too_short' };

  const words = normalized.split(' ').filter(Boolean);
  if (words.length < MIN_WORDS) return { ok: false, reason: 'too_few_words' };

  if (GENERIC_OPENERS.some((pattern) => pattern.test(normalized))) {
    return { ok: false, reason: 'generic_boilerplate' };
  }

  // Echoes its own option — the field was filled, not diagnosed.
  const option = context.optionText ? normalize(context.optionText) : '';
  if (option && (normalized === option || normalized.includes(option))) {
    return { ok: false, reason: 'echoes_option_text' };
  }

  return { ok: true };
}

export interface MisconceptionCandidate {
  text: string;
  /** The distractor this was attached to, when the caller knows it. */
  optionText?: string | null;
}

export interface UsableMisconceptions {
  /** Deduplicated, trimmed strings safe to generate teaching from. */
  usable: string[];
  rejected: { text: string; reason: string }[];
}

/**
 * Filter a set of recorded misconceptions down to those worth teaching from.
 *
 * Deduplicates case-insensitively: the same misconception chosen on three
 * questions is one thing to teach, not three.
 */
export function usableMisconceptions(
  candidates: (MisconceptionCandidate | string)[],
): UsableMisconceptions {
  const usable: string[] = [];
  const rejected: { text: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    const candidate: MisconceptionCandidate =
      typeof raw === 'string' ? { text: raw } : raw;

    const verdict = assessMisconception(candidate.text, { optionText: candidate.optionText });
    if (!verdict.ok) {
      rejected.push({ text: candidate.text ?? '', reason: verdict.reason });
      continue;
    }

    const key = normalize(candidate.text);
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(candidate.text.trim());
  }

  return { usable, rejected };
}

/**
 * Stable cache key for a set of misconceptions.
 *
 * Sorted and normalized so the same set in a different order is the same lesson —
 * that is what stops a re-failed check regenerating (and re-charging) content the
 * student has already been shown.
 */
export function misconceptionSetKey(misconceptions: string[]): string {
  return [...new Set(misconceptions.map(normalize))].sort().join('|');
}

/**
 * Bloom levels a lesson can be built for. Legacy pools stored Bloom levels in
 * `weak_concepts` before Phase 1, and those must never be mistaken for
 * misconceptions — "apply" is not something you can write a worked example about.
 */
const LEGACY_BLOOM_LEVELS = new Set([
  'remember', 'understand', 'apply', 'analyze', 'evaluate', 'create',
]);

/** True when `weak_concepts` holds pre-Phase-1 Bloom levels rather than real diagnoses. */
export function isLegacyBloomConcept(concept: string): boolean {
  return LEGACY_BLOOM_LEVELS.has(normalize(concept));
}
