/**
 * Generation-time item validation (reformation Phase 2, critique #1).
 *
 * The whole engine inherits the quality of the items it generates: mastery state,
 * readiness, "academically defensible" — all of it rests on questions an LLM wrote
 * and nobody checked. A single malformed item (two correct options, "all of the
 * above", a duplicated distractor) poisons an objective's pool for its lifetime,
 * because the pool is generated once and cached forever.
 *
 * So every item is checked BEFORE it is written to Mongo. This module is
 * deliberately PURE — no AI, no DB, no clock — so the rules are unit-testable and
 * cheap to run on every generated batch.
 *
 * These rules catch STRUCTURE, not truth. A hallucinated fact in a well-formed MCQ
 * still passes; grounding (Phase 1) and student flagging are what address that.
 */

export type ItemVerdict = { ok: true } | { ok: false; reason: string };

/** The subset of a raw generated item these rules can judge. */
export interface RawItem {
  question_text?: unknown;
  options?: unknown;
  correct_answer?: unknown;
  question_type?: unknown;
}

/**
 * Options that are structurally usable — anything missing a key or text is dropped
 * before the rules run, so "3 distinct options" counts real options only.
 */
interface CleanOption {
  key: string;
  text: string;
}

/**
 * Stems shorter than this are not questions — they are fragments the model emitted
 * while padding a batch to the requested count.
 */
const MIN_STEM_CHARS = 12;

/** Below three options an MCQ is a coin flip, not an assessment. */
const MIN_OPTIONS = 3;

/**
 * "All/none of the above" is the single most-documented LLM item defect: it is
 * trivially gameable, it tests test-taking rather than the objective, and it breaks
 * distractor→misconception mapping (Phase 1) because there is no misconception a
 * student who picks "all of the above" actually holds.
 */
const CATCH_ALL_OPTION = /\b(all|none|both|neither)\s+of\s+(the\s+)?(above|these|them)\b/i;

/** Case/whitespace/punctuation-insensitive comparison key for option texts. */
function textKey(text: string): string {
  return text
    // Models emit non-breaking spaces and other unicode whitespace; \s covers them,
    // so two options differing only by that are still caught as duplicates.
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.;,:]+$/, '');
}

function cleanOptions(value: unknown): CleanOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const option = raw as Record<string, unknown>;
    if (typeof option.key !== 'string' || typeof option.text !== 'string') return [];
    const key = option.key.trim();
    const text = option.text.trim();
    if (!key || !text) return [];
    return [{ key, text }];
  });
}

function stemOf(raw: RawItem): string {
  return typeof raw.question_text === 'string' ? raw.question_text.trim() : '';
}

/**
 * Structural validity of one generated MCQ. Returns the FIRST failure only — the
 * reason is for logging and for telling a repair pass what went wrong, not for a
 * per-item report card.
 */
export function validateMcqItem(raw: RawItem): ItemVerdict {
  const stem = stemOf(raw);
  if (stem.length < MIN_STEM_CHARS) return { ok: false, reason: 'empty_or_short_stem' };

  const correct = typeof raw.correct_answer === 'string' ? raw.correct_answer.trim() : '';
  if (!correct) return { ok: false, reason: 'missing_correct_answer' };

  const options = cleanOptions(raw.options);
  if (options.length < MIN_OPTIONS) return { ok: false, reason: 'too_few_options' };

  // Duplicate KEYS make `correct_answer` ambiguous even when the texts differ.
  const keys = options.map((o) => o.key.toUpperCase());
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'duplicate_option_keys' };

  const texts = options.map((o) => textKey(o.text));
  if (new Set(texts).size !== texts.length) return { ok: false, reason: 'duplicate_option_text' };

  if (options.some((o) => CATCH_ALL_OPTION.test(o.text))) {
    return { ok: false, reason: 'catch_all_option' };
  }

  // Exactly one option must be the key. A `correct_answer` naming no option (the
  // model answering with the option TEXT, or with "E") is the common failure.
  const matches = keys.filter((key) => key === correct.toUpperCase());
  if (matches.length === 0) return { ok: false, reason: 'correct_answer_not_an_option' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous_correct_answer' };

  return { ok: true };
}

/**
 * Structural validity of one generated free-response item. Much lighter than the
 * MCQ rules by necessity — a short-answer item's correctness lives in the model
 * answer's semantics, which only the AI grader can judge. What we CAN insist on is
 * that a model answer exists and is substantive enough to grade against.
 */
export function validateShortAnswerItem(raw: RawItem): ItemVerdict {
  const stem = stemOf(raw);
  if (stem.length < MIN_STEM_CHARS) return { ok: false, reason: 'empty_or_short_stem' };

  const answer = typeof raw.correct_answer === 'string' ? raw.correct_answer.trim() : '';
  if (!answer) return { ok: false, reason: 'missing_model_answer' };
  // A one-character model answer is either a leaked MCQ letter or a truncation;
  // either way there is nothing for the grader to match a paraphrase against.
  if (answer.length < 2) return { ok: false, reason: 'model_answer_too_short' };

  return { ok: true };
}

/** Dispatch on the item's declared type; unknown types are judged as MCQ. */
export function validateGeneratedItem(raw: RawItem): ItemVerdict {
  return raw.question_type === 'short_answer' || raw.question_type === 'numeric'
    ? validateShortAnswerItem(raw)
    : validateMcqItem(raw);
}

export interface PartitionedItems<T> {
  kept: T[];
  /** Rejected items with the rule that rejected them — logged, never shown. */
  rejected: { item: T; reason: string }[];
}

/** Split a generated batch into what may be cached and what must be discarded. */
export function partitionValidItems<T extends RawItem>(items: T[]): PartitionedItems<T> {
  const kept: T[] = [];
  const rejected: { item: T; reason: string }[] = [];

  for (const item of items) {
    const verdict = validateGeneratedItem(item);
    if (verdict.ok) kept.push(item);
    else rejected.push({ item, reason: verdict.reason });
  }

  return { kept, rejected };
}
