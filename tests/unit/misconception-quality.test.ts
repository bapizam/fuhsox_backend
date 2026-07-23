import {
  assessMisconception,
  isLegacyBloomConcept,
  misconceptionSetKey,
  usableMisconceptions,
} from '@utils/misconception-quality';

describe('assessMisconception', () => {
  it('accepts a specific, diagnostic misconception', () => {
    for (const good of [
      'confuses preload with afterload',
      'applies Boyle’s law where Charles’s law applies',
      'thinks the P wave represents ventricular depolarisation',
      'reverses the direction of the sodium gradient',
    ]) {
      expect(assessMisconception(good)).toEqual({ ok: true });
    }
  });

  it('rejects a missing or empty string', () => {
    expect(assessMisconception(null)).toMatchObject({ ok: false, reason: 'missing' });
    expect(assessMisconception(undefined)).toMatchObject({ ok: false, reason: 'missing' });
    expect(assessMisconception('   ')).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('rejects strings too short or too terse to name a relationship', () => {
    expect(assessMisconception('wrong')).toMatchObject({ ok: false });
    expect(assessMisconception('bad units')).toMatchObject({ ok: false });
  });

  it('rejects generic boilerplate — the model’s failure mode', () => {
    for (const bad of [
      'The answer is wrong',
      'incorrect',
      'a common misconception',
      'misunderstanding',
      'student does not understand the concept',
      'lack of understanding',
      'misunderstands the concept',
      'Not the correct answer',
      'guessing randomly',
    ]) {
      const verdict = assessMisconception(bad);
      expect(verdict.ok).toBe(false);
    }
  });

  it('does NOT reject a good string merely for containing a generic word', () => {
    // Anchoring matters: this is diagnostic despite the word "misconception".
    expect(
      assessMisconception('confuses preload with afterload, a common misconception in cardiology'),
    ).toEqual({ ok: true });
  });

  it('rejects a misconception that just echoes its own option', () => {
    expect(
      assessMisconception('The left ventricle', { optionText: 'Left ventricle' }),
    ).toMatchObject({ ok: false, reason: 'echoes_option_text' });

    // Also when the option is embedded in a slightly longer restatement.
    expect(
      assessMisconception('picks the left ventricle here', { optionText: 'left ventricle' }),
    ).toMatchObject({ ok: false, reason: 'echoes_option_text' });
  });

  it('still accepts a real diagnosis that mentions the option in a meaningful way', () => {
    expect(
      assessMisconception('believes the aorta leaves the right side of the heart', {
        optionText: 'Right ventricle',
      }),
    ).toEqual({ ok: true });
  });
});

describe('usableMisconceptions', () => {
  it('keeps the good, reports the rejected with reasons', () => {
    const { usable, rejected } = usableMisconceptions([
      'confuses preload with afterload',
      'incorrect',
      'thinks the P wave represents ventricular depolarisation',
      '',
    ]);

    expect(usable).toHaveLength(2);
    expect(rejected).toHaveLength(2);
    expect(rejected.map((r) => r.reason)).toContain('empty');
  });

  it('deduplicates the same misconception chosen on several questions', () => {
    const { usable } = usableMisconceptions([
      'confuses preload with afterload',
      'Confuses Preload With Afterload.',
      '  confuses   preload with afterload  ',
    ]);
    expect(usable).toHaveLength(1);
  });

  it('accepts plain strings and {text, optionText} candidates alike', () => {
    const { usable } = usableMisconceptions([
      'confuses preload with afterload',
      { text: 'The left ventricle', optionText: 'Left ventricle' },
      { text: 'reverses the direction of the sodium gradient' },
    ]);
    expect(usable).toEqual([
      'confuses preload with afterload',
      'reverses the direction of the sodium gradient',
    ]);
  });

  it('returns nothing usable for an all-generic set — the case that must block generation', () => {
    const { usable, rejected } = usableMisconceptions([
      'incorrect',
      'misunderstands the concept',
      'wrong',
    ]);
    expect(usable).toHaveLength(0);
    expect(rejected).toHaveLength(3);
  });
});

describe('misconceptionSetKey', () => {
  it('is order-independent, so a re-fail hits the cache', () => {
    const a = misconceptionSetKey(['confuses preload with afterload', 'reverses the sodium gradient']);
    const b = misconceptionSetKey(['reverses the sodium gradient', 'confuses preload with afterload']);
    expect(a).toBe(b);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(misconceptionSetKey(['Confuses Preload With Afterload'])).toBe(
      misconceptionSetKey(['  confuses preload with afterload  ']),
    );
  });

  it('distinguishes genuinely different sets', () => {
    expect(misconceptionSetKey(['a specific error here'])).not.toBe(
      misconceptionSetKey(['a different specific error']),
    );
  });
});

describe('isLegacyBloomConcept', () => {
  it('identifies pre-Phase-1 Bloom levels stored in weak_concepts', () => {
    for (const level of ['remember', 'understand', 'Apply', 'ANALYZE', 'evaluate', 'create']) {
      expect(isLegacyBloomConcept(level)).toBe(true);
    }
  });

  it('does not mistake a real misconception for a Bloom level', () => {
    expect(isLegacyBloomConcept('confuses preload with afterload')).toBe(false);
  });
});
