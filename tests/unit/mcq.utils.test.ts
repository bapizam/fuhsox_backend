import {
  describeChoice,
  findOption,
  parseOptions,
  renderOptions,
  shuffleOptions,
  type McqOption,
} from '@utils/mcq';

const OPTIONS: McqOption[] = [
  { key: 'A', text: 'Increases cardiac output' },
  { key: 'B', text: 'Decreases stroke volume', misconception: 'Confuses preload with afterload' },
  { key: 'C', text: 'No net change' },
  { key: 'D', text: 'Reverses venous return' },
];

/**
 * Fisher-Yates with `j = 0` at every step, which rotates the list left by one:
 * [A,B,C,D] → [B,C,D,A]. Deterministic, so positions can be asserted exactly.
 */
const rotateRng = () => 0;

describe('parseOptions', () => {
  it('accepts the stored shape and preserves misconception tags', () => {
    expect(parseOptions(OPTIONS)).toEqual(OPTIONS);
  });

  it('keys legacy positional strings A/B/C…', () => {
    expect(parseOptions(['first', 'second'])).toEqual([
      { key: 'A', text: 'first' },
      { key: 'B', text: 'second' },
    ]);
  });

  it('backfills a missing or blank key from the position', () => {
    expect(parseOptions([{ text: 'first' }, { key: '   ', text: 'second' }])).toEqual([
      { key: 'A', text: 'first' },
      { key: 'B', text: 'second' },
    ]);
  });

  it('is undefined — not partial — for anything unusable', () => {
    expect(parseOptions(undefined)).toBeUndefined();
    expect(parseOptions(null)).toBeUndefined();
    expect(parseOptions([])).toBeUndefined();
    expect(parseOptions('A, B, C')).toBeUndefined();
    // One bad entry rejects the whole list: a half-parsed option block shown to a
    // student is worse than none.
    expect(parseOptions([{ key: 'A', text: 'ok' }, { key: 'B', text: 42 }])).toBeUndefined();
  });

  it('drops a blank misconception rather than storing an empty tag', () => {
    expect(parseOptions([{ key: 'A', text: 'x', misconception: '  ' }])).toEqual([
      { key: 'A', text: 'x' },
    ]);
  });
});

describe('findOption', () => {
  it('matches case- and whitespace-insensitively', () => {
    expect(findOption(' c ', OPTIONS)?.text).toBe('No net change');
    expect(findOption('b', OPTIONS)?.misconception).toBe('Confuses preload with afterload');
  });

  it('is undefined for a non-key and for absent options', () => {
    expect(findOption('Z', OPTIONS)).toBeUndefined();
    expect(findOption('A', undefined)).toBeUndefined();
  });
});

describe('describeChoice', () => {
  it('resolves a letter to its text — the whole point of the feedback fix', () => {
    expect(describeChoice('A', OPTIONS)).toBe('A ("Increases cardiac output")');
  });

  it('passes a free-response answer through unchanged', () => {
    expect(describeChoice('raises CO', undefined)).toBe('raises CO');
  });

  it('never yields an empty answer line', () => {
    expect(describeChoice('   ', undefined)).toBe('(no answer given)');
  });
});

describe('renderOptions', () => {
  it('renders a labelled block', () => {
    expect(renderOptions(OPTIONS.slice(0, 2))).toBe(
      '  A. Increases cardiac output\n  B. Decreases stroke volume',
    );
  });

  it('is empty when there is nothing to show', () => {
    expect(renderOptions(undefined)).toBe('');
    expect(renderOptions([])).toBe('');
  });
});

describe('shuffleOptions', () => {
  it('remaps correct_answer to wherever the correct option landed', () => {
    const result = shuffleOptions(OPTIONS, 'A', rotateRng);
    const correct = findOption(result.correct_answer, result.options);
    expect(correct?.text).toBe('Increases cardiac output');
    // A rotate-left puts the old A last.
    expect(result.correct_answer).toBe('D');
  });

  it('re-keys options to A/B/C/D in their new positions', () => {
    const result = shuffleOptions(OPTIONS, 'A', rotateRng);
    expect(result.options?.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(result.options?.map((o) => o.text)).toEqual([
      'Decreases stroke volume',
      'No net change',
      'Reverses venous return',
      'Increases cardiac output',
    ]);
  });

  it('keeps each misconception tag attached to its own text', () => {
    const result = shuffleOptions(OPTIONS, 'A', rotateRng);
    const tagged = result.options?.find((o) => o.misconception);
    // The tag must follow "Decreases stroke volume" to whatever letter that text
    // landed on, not stay behind on letter B — Phase-1 diagnosis looks the
    // misconception up by the letter the student chose.
    expect(tagged?.text).toBe('Decreases stroke volume');
    expect(tagged?.key).toBe('A');
  });

  it('leaves the correct answer reachable under a real random shuffle', () => {
    for (let i = 0; i < 200; i++) {
      const result = shuffleOptions(OPTIONS, 'B');
      const correct = findOption(result.correct_answer, result.options);
      expect(correct?.text).toBe('Decreases stroke volume');
      expect(result.options).toHaveLength(4);
    }
  });

  it('actually moves the answer off A across many shuffles', () => {
    const landed = new Set<string>();
    for (let i = 0; i < 500; i++) {
      landed.add(shuffleOptions(OPTIONS, 'A').correct_answer);
    }
    expect(landed).toEqual(new Set(['A', 'B', 'C', 'D']));
  });

  it('is a no-op when there is nothing to shuffle', () => {
    expect(shuffleOptions(undefined, 'answer text')).toEqual({
      options: undefined,
      correct_answer: 'answer text',
    });
    const single: McqOption[] = [{ key: 'A', text: 'only' }];
    expect(shuffleOptions(single, 'A')).toEqual({ options: single, correct_answer: 'A' });
  });

  it('refuses to touch an MCQ whose correct_answer matches no key', () => {
    // Malformed row: re-keying would destroy the only record of what was correct.
    const result = shuffleOptions(OPTIONS, 'Increases cardiac output');
    expect(result.options).toBe(OPTIONS);
    expect(result.correct_answer).toBe('Increases cardiac output');
  });

  it('picks the right one when two options share identical text', () => {
    const dupes: McqOption[] = [
      { key: 'A', text: 'same' },
      { key: 'B', text: 'same' },
      { key: 'C', text: 'different' },
    ];
    const result = shuffleOptions(dupes, 'B', rotateRng);
    // Identity-based lookup, not text: a rotate-left moves the second entry to
    // the front, so the answer is 'A' — and crucially it tracked the object that
    // WAS 'B' rather than matching the first "same" it found.
    expect(result.correct_answer).toBe('A');
    expect(result.options?.map((o) => o.text)).toEqual(['same', 'different', 'same']);
  });
});
