import {
  partitionValidItems,
  validateGeneratedItem,
  validateMcqItem,
  validateShortAnswerItem,
} from '@utils/item-validation';

/** A structurally sound MCQ — every test below breaks exactly one thing about it. */
const goodMcq = (over: Record<string, unknown> = {}) => ({
  question_text: 'Which chamber of the heart pumps blood into the aorta?',
  question_type: 'mcq',
  options: [
    { key: 'A', text: 'Left ventricle' },
    { key: 'B', text: 'Right ventricle' },
    { key: 'C', text: 'Left atrium' },
    { key: 'D', text: 'Right atrium' },
  ],
  correct_answer: 'A',
  ...over,
});

describe('validateMcqItem', () => {
  it('accepts a well-formed item', () => {
    expect(validateMcqItem(goodMcq())).toEqual({ ok: true });
  });

  it('rejects an empty or fragment stem', () => {
    expect(validateMcqItem(goodMcq({ question_text: '' }))).toMatchObject({
      ok: false,
      reason: 'empty_or_short_stem',
    });
    expect(validateMcqItem(goodMcq({ question_text: 'Which?' }))).toMatchObject({ ok: false });
  });

  it('rejects a missing correct_answer', () => {
    expect(validateMcqItem(goodMcq({ correct_answer: '  ' }))).toMatchObject({
      ok: false,
      reason: 'missing_correct_answer',
    });
  });

  it('rejects fewer than three usable options', () => {
    expect(
      validateMcqItem(
        goodMcq({ options: [{ key: 'A', text: 'Left ventricle' }, { key: 'B', text: 'Right ventricle' }] }),
      ),
    ).toMatchObject({ ok: false, reason: 'too_few_options' });
  });

  it('ignores malformed option entries when counting', () => {
    // Two real options plus junk is still too few — junk must not pad the count.
    expect(
      validateMcqItem(
        goodMcq({
          options: [
            { key: 'A', text: 'Left ventricle' },
            { key: 'B', text: 'Right ventricle' },
            { key: 'C' },
            null,
            'D. Right atrium',
          ],
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'too_few_options' });
  });

  it('rejects duplicate option keys', () => {
    expect(
      validateMcqItem(
        goodMcq({
          options: [
            { key: 'A', text: 'Left ventricle' },
            { key: 'A', text: 'Right ventricle' },
            { key: 'C', text: 'Left atrium' },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'duplicate_option_keys' });
  });

  it('rejects duplicate option text regardless of case, spacing or trailing punctuation', () => {
    expect(
      validateMcqItem(
        goodMcq({
          options: [
            { key: 'A', text: 'Left ventricle' },
            { key: 'B', text: '  left   VENTRICLE.' },
            { key: 'C', text: 'Left atrium' },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'duplicate_option_text' });
  });

  it('rejects "all/none of the above" in every documented variant', () => {
    for (const text of [
      'All of the above',
      'none of the above',
      'None of these',
      'Both of the above',
      'neither of them',
    ]) {
      expect(
        validateMcqItem(
          goodMcq({
            options: [
              { key: 'A', text: 'Left ventricle' },
              { key: 'B', text: 'Right ventricle' },
              { key: 'C', text: 'Left atrium' },
              { key: 'D', text },
            ],
          }),
        ),
      ).toMatchObject({ ok: false, reason: 'catch_all_option' });
    }
  });

  it('rejects a correct_answer that names no option', () => {
    expect(validateMcqItem(goodMcq({ correct_answer: 'E' }))).toMatchObject({
      ok: false,
      reason: 'correct_answer_not_an_option',
    });
    // The model answering with the option TEXT instead of its key.
    expect(validateMcqItem(goodMcq({ correct_answer: 'Left ventricle' }))).toMatchObject({
      ok: false,
      reason: 'correct_answer_not_an_option',
    });
  });

  it('matches the correct_answer key case-insensitively', () => {
    expect(validateMcqItem(goodMcq({ correct_answer: 'a' }))).toEqual({ ok: true });
  });
});

describe('validateShortAnswerItem', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    question_text: 'State the formula for cardiac output.',
    question_type: 'short_answer',
    correct_answer: 'Cardiac output = stroke volume × heart rate',
    ...over,
  });

  it('accepts a stem with a substantive model answer', () => {
    expect(validateShortAnswerItem(item())).toEqual({ ok: true });
  });

  it('rejects a missing model answer', () => {
    expect(validateShortAnswerItem(item({ correct_answer: '' }))).toMatchObject({
      ok: false,
      reason: 'missing_model_answer',
    });
  });

  it('rejects a leaked MCQ letter as the model answer', () => {
    expect(validateShortAnswerItem(item({ correct_answer: 'B' }))).toMatchObject({
      ok: false,
      reason: 'model_answer_too_short',
    });
  });

  it('does not require options', () => {
    expect(validateShortAnswerItem(item({ options: undefined }))).toEqual({ ok: true });
  });
});

describe('validateGeneratedItem', () => {
  it('routes free-response types to the short-answer rules', () => {
    // No options at all — fatal for an MCQ, fine for a numeric item.
    const numeric = {
      question_text: 'Calculate cardiac output for SV 70 mL and HR 72 bpm, in L/min.',
      question_type: 'numeric',
      correct_answer: '5.04 L/min',
    };
    expect(validateGeneratedItem(numeric)).toEqual({ ok: true });
    expect(validateMcqItem(numeric)).toMatchObject({ ok: false, reason: 'too_few_options' });
  });

  it('treats an unknown or missing type as an MCQ', () => {
    expect(validateGeneratedItem({ ...goodMcq(), question_type: undefined })).toEqual({ ok: true });
  });
});

describe('partitionValidItems', () => {
  it('keeps the good and reports each rejection with its reason', () => {
    const { kept, rejected } = partitionValidItems([
      goodMcq(),
      goodMcq({ correct_answer: 'E' }),
      goodMcq({
        options: [
          { key: 'A', text: 'Left ventricle' },
          { key: 'B', text: 'Right ventricle' },
          { key: 'C', text: 'All of the above' },
        ],
      }),
    ]);

    expect(kept).toHaveLength(1);
    expect(rejected.map((r) => r.reason)).toEqual([
      'correct_answer_not_an_option',
      'catch_all_option',
    ]);
  });

  it('returns everything as rejected when the batch is unusable', () => {
    const { kept, rejected } = partitionValidItems([{ question_text: '' }, {}]);
    expect(kept).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });
});
