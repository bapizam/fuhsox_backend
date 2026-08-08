import { gradedScore, hasAnswerKey } from '@utils/gradability';

describe('hasAnswerKey', () => {
  it('accepts a real key', () => {
    expect(hasAnswerKey('B')).toBe(true);
    expect(hasAnswerKey('Cardiac output = stroke volume × heart rate')).toBe(true);
  });

  it('rejects null and undefined', () => {
    expect(hasAnswerKey(null)).toBe(false);
    expect(hasAnswerKey(undefined)).toBe(false);
  });

  it('rejects a blank or whitespace-only key', () => {
    // An empty string is how a bad import writes "no key" without using null;
    // treating it as a key would grade every answer against "".
    expect(hasAnswerKey('')).toBe(false);
    expect(hasAnswerKey('   ')).toBe(false);
    expect(hasAnswerKey('\n\t')).toBe(false);
  });
});

describe('gradedScore', () => {
  const answer = (is_correct: boolean, gradable = true) => ({ is_correct, gradable });

  it('scores a fully gradable set normally', () => {
    const score = gradedScore([answer(true), answer(true), answer(false), answer(true)]);
    expect(score).toEqual({ correct: 3, gradable: 4, skipped: 0, fraction: 0.75 });
  });

  it('drops ungradable items from BOTH numerator and denominator', () => {
    // The whole point. Seven of eight correct with one unkeyed item is 100%,
    // not 87.5% — the student cannot be failed on a question nothing can mark.
    const answers = [...Array(7)].map(() => answer(true));
    answers.push(answer(false, false));

    const score = gradedScore(answers);
    expect(score.correct).toBe(7);
    expect(score.gradable).toBe(7);
    expect(score.skipped).toBe(1);
    expect(score.fraction).toBe(1);
  });

  it('never credits an ungradable item as correct', () => {
    // `is_correct: true` on an ungradable row should be impossible upstream, but
    // the scorer must not depend on that — it is the last line of defence.
    const score = gradedScore([answer(true, false), answer(true)]);
    expect(score.correct).toBe(1);
    expect(score.gradable).toBe(1);
    expect(score.fraction).toBe(1);
  });

  it('reports zero-but-empty when nothing was gradable', () => {
    // `fraction: 0` here means "no evidence", NOT "scored zero" — callers read
    // `gradable === 0` to tell them apart. completeMasteryCheck refuses rather
    // than feeding a fabricated 0 into the objective's EWMA.
    const score = gradedScore([answer(false, false), answer(false, false)]);
    expect(score).toEqual({ correct: 0, gradable: 0, skipped: 2, fraction: 0 });
  });

  it('handles an empty answer set without dividing by zero', () => {
    expect(gradedScore([])).toEqual({ correct: 0, gradable: 0, skipped: 0, fraction: 0 });
  });

  it('scores an all-wrong gradable set as a real zero', () => {
    const score = gradedScore([answer(false), answer(false)]);
    expect(score.fraction).toBe(0);
    expect(score.gradable).toBe(2);
  });
});
