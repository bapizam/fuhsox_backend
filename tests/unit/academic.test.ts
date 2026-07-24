import { resolveDiscipline, resolveInterests } from '@config/academic';

describe('resolveDiscipline — discipline-aware prompt framing', () => {
  it('gives a health department a mechanisms/clinical emphasis', () => {
    const d = resolveDiscipline('Basic Medical Sciences', 'Physiology');
    expect(d.faculty).toBe('Basic Medical Sciences');
    expect(d.department).toBe('Physiology');
    // Inherits the faculty emphasis (Physiology curates none of its own).
    expect(d.emphasis).toMatch(/mechanism|physiolog/i);
  });

  it('gives a MATHS student proofs, not anything clinical — the whole point', () => {
    const d = resolveDiscipline('Sciences', 'Mathematics');
    expect(d.emphasis).toMatch(/proof|derivation|working/i);
    expect(d.emphasis).not.toMatch(/clinical|health|medical/i);
  });

  it('lets a department override its faculty when the faculty is too coarse', () => {
    const sciences = resolveDiscipline('Sciences').emphasis;
    const cs = resolveDiscipline('Sciences', 'Computer Science').emphasis;
    const maths = resolveDiscipline('Sciences', 'Mathematics').emphasis;
    // All three are distinct — CS is not told to write proofs, Maths is not told to code.
    expect(cs).not.toBe(sciences);
    expect(maths).not.toBe(sciences);
    expect(cs).not.toBe(maths);
    expect(cs).toMatch(/algorithm|implementation|code/i);
  });

  it('falls back to the faculty emphasis for an uncurated department', () => {
    const faculty = resolveDiscipline('Law').emphasis;
    const dept = resolveDiscipline('Law', 'Common Law').emphasis;
    expect(dept).toBe(faculty);
    expect(dept).toMatch(/IRAC|statute|case/i);
  });

  it('matches case-insensitively and trims, so client free-text lines up', () => {
    const d = resolveDiscipline('  sciences ', ' mathematics ');
    expect(d.faculty).toBe('Sciences');
    expect(d.department).toBe('Mathematics');
  });

  it('passes unknown free-text through but uses a NEUTRAL, non-clinical emphasis', () => {
    const d = resolveDiscipline('Faculty of Wizardry', 'Potions');
    expect(d.faculty).toBe('Faculty of Wizardry');
    expect(d.department).toBe('Potions');
    expect(d.emphasis).not.toMatch(/clinical|health|medical/i);
    expect(d.emphasis.length).toBeGreaterThan(0);
  });

  it('handles a student with no discipline set at all', () => {
    const d = resolveDiscipline();
    expect(d.faculty).toBeNull();
    expect(d.department).toBeNull();
    expect(d.emphasis).not.toMatch(/clinical|health|medical/i);
  });

  it('never returns an empty emphasis for any known faculty', () => {
    for (const faculty of [
      'Medicine', 'Pharmacy', 'Sciences', 'Engineering', 'Law',
      'Arts & Humanities', 'Social Sciences', 'Management Sciences',
      'Education', 'Agriculture', 'Environmental Sciences', 'Basic Medical Sciences',
    ]) {
      expect(resolveDiscipline(faculty).emphasis.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('resolveInterests still works alongside the new emphasis field', () => {
  it('resolves department-first with a faculty fallback', () => {
    expect(resolveInterests('Sciences', 'Mathematics')).toContain('Calculus');
    // An unknown department under a known faculty inherits the faculty list.
    expect(resolveInterests('Law', 'Nonexistent Dept')).toEqual(resolveInterests('Law'));
  });
});
