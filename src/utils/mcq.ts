/**
 * MCQ option handling — normalising, describing and shuffling.
 *
 * Two long-standing bugs lived in the gap this file fills:
 *
 * 1. **Feedback saw letters, not answers.** `gradeSource` in `session.service`
 *    never carried `options`, so the tutor prompt read `STUDENT'S ANSWER: A` /
 *    `CORRECT ANSWER: C`. The model was asked to explain a misconception it
 *    could not see, and wrote generic filler. `describeChoice` + `renderOptions`
 *    put the actual text in front of it.
 *
 * 2. **The answer was almost always A.** Nothing shuffled options anywhere —
 *    `session.service`'s `shuffle` reorders QUESTIONS. Generators emit the
 *    correct option first the overwhelming majority of the time, so students
 *    learned to pick A. `shuffleOptions` fixes the position at persist time.
 *
 * Options are stored in two places with the same shape: Postgres
 * `Question.options` (`Json?`) and Mongo `AIQuestion.options`. `parseOptions`
 * accepts either, plus the legacy `string[]` form, and rejects anything else
 * rather than guessing.
 */

/** One MCQ choice. `misconception` tags a DISTRACTOR (reformation Phase 1). */
export interface McqOption {
  key: string;
  text: string;
  misconception?: string;
}

/** Canonical option letters, in order. */
const KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

/**
 * Normalise whatever is stored into `McqOption[]`, or `undefined` when the value
 * isn't a usable option list. Tolerates:
 * - `[{ key, text, misconception? }]` — the current shape, both stores
 * - `[{ key, text }]` with extra keys — ignored
 * - `["first", "second"]` — legacy positional strings, keyed A/B/C/…
 *
 * Returns `undefined` (never throws, never a partial list) so callers can treat
 * "no options" and "unparseable options" identically — both mean "don't render
 * an option block".
 */
export function parseOptions(raw: unknown): McqOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const out: McqOption[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry === 'string') {
      out.push({ key: KEYS[i] ?? String(i + 1), text: entry });
      continue;
    }
    if (entry === null || typeof entry !== 'object') return undefined;

    const record = entry as Record<string, unknown>;
    const text = record['text'];
    if (typeof text !== 'string') return undefined;

    const key = record['key'];
    const misconception = record['misconception'];
    out.push({
      key: typeof key === 'string' && key.trim() ? key.trim() : (KEYS[i] ?? String(i + 1)),
      ...(typeof misconception === 'string' && misconception.trim()
        ? { misconception: misconception.trim() }
        : {}),
      text,
    });
  }
  return out;
}

/** Case/whitespace-insensitive option lookup. */
export function findOption(
  answer: string,
  options: McqOption[] | undefined,
): McqOption | undefined {
  if (!options) return undefined;
  const needle = answer.trim().toUpperCase();
  return options.find((o) => o.key.trim().toUpperCase() === needle);
}

/**
 * Render an answer for a prompt: `A ("Increases cardiac output")` when the letter
 * resolves to an option, and the bare answer otherwise (free-response items, or
 * an MCQ whose options we couldn't parse).
 *
 * The quoting matters — it stops the model reading a multi-word option as
 * instructions rather than as the student's choice.
 */
export function describeChoice(answer: string, options: McqOption[] | undefined): string {
  const match = findOption(answer, options);
  const trimmed = answer.trim();
  if (!match) return trimmed || '(no answer given)';
  return `${match.key} ("${match.text}")`;
}

/** A labelled option block for a prompt. Empty string when there's nothing to show. */
export function renderOptions(options: McqOption[] | undefined): string {
  if (!options || options.length === 0) return '';
  return options.map((o) => `  ${o.key}. ${o.text}`).join('\n');
}

/** Fisher-Yates, with an injectable rng so tests can pin the order. */
function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Randomise which letter holds the correct answer.
 *
 * Options are shuffled and then **re-keyed to A/B/C/D in their new positions**,
 * and `correct_answer` is remapped to the letter the correct option landed on.
 * Re-keying (rather than shuffling the keys along with the text) is what keeps
 * every downstream consumer working unchanged: the client renders `options` in
 * array order, and a stored answer of "C" still means "the third one shown".
 *
 * Per-option `misconception` tags travel WITH their text, which is the whole
 * point — the diagnosis in `learning.service` looks up the misconception by the
 * letter the student chose, so a tag left behind on the old letter would
 * diagnose the wrong error.
 *
 * Returns the input untouched when there is nothing to do: a non-MCQ item, fewer
 * than two options, or a `correct_answer` that doesn't match any option key
 * (free-text answer stored on an MCQ — malformed, and silently re-keying it
 * would destroy the only record of what was correct).
 */
export function shuffleOptions(
  options: McqOption[] | undefined,
  correctAnswer: string,
  rng: () => number = Math.random,
): { options: McqOption[] | undefined; correct_answer: string } {
  if (!options || options.length < 2) {
    return { options, correct_answer: correctAnswer };
  }

  const correct = findOption(correctAnswer, options);
  if (!correct) {
    return { options, correct_answer: correctAnswer };
  }

  const reordered = shuffled(options, rng);
  const rekeyed = reordered.map((option, i) => ({
    ...option,
    key: KEYS[i] ?? String(i + 1),
  }));

  // Identity, not text: two options with identical text would both match a text
  // comparison, and `indexOf` on the pre-rekey array is exact.
  const correctIndex = reordered.indexOf(correct);
  return {
    options: rekeyed,
    correct_answer: rekeyed[correctIndex].key,
  };
}
