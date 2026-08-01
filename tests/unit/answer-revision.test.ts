import {
  classifyAnswerSubmission,
  countsTowardsItemStats,
  needsGrading,
} from '@utils/answer-revision';

describe('classifyAnswerSubmission', () => {
  it('is new when nothing is on file', () => {
    expect(classifyAnswerSubmission(undefined, { chosen_answer: 'B' })).toBe('new');
    expect(classifyAnswerSubmission(null, { chosen_answer: 'B' })).toBe('new');
  });

  it('is a repeat when the same answer comes back — a retried flush, not a change', () => {
    expect(classifyAnswerSubmission({ chosen_answer: 'B' }, { chosen_answer: 'B' })).toBe('repeat');
  });

  it('is a revision when the student picked something else', () => {
    expect(classifyAnswerSubmission({ chosen_answer: 'B' }, { chosen_answer: 'D' })).toBe('revision');
  });

  it('does not treat case or spacing as the same answer', () => {
    // Grading normalises; storage does not. Two different strings are two
    // different submissions, and re-storing the student's exact text is right.
    expect(classifyAnswerSubmission({ chosen_answer: 'b' }, { chosen_answer: 'B' })).toBe('revision');
  });
});

describe('what each kind costs', () => {
  it('never re-grades a repeat — that would spend AI budget on a retry', () => {
    expect(needsGrading('repeat')).toBe(false);
    expect(needsGrading('new')).toBe(true);
    expect(needsGrading('revision')).toBe(true);
  });

  it('counts only first attempts towards item difficulty', () => {
    expect(countsTowardsItemStats('new')).toBe(true);
    // A retried flush must not add a second datapoint …
    expect(countsTowardsItemStats('repeat')).toBe(false);
    // … and neither must changing your mind, or one student would count twice.
    expect(countsTowardsItemStats('revision')).toBe(false);
  });
});
