import { calculateSessionXP, evaluateStreak } from '@utils/xp';
import type { SessionAnswer } from '@typings/models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAnswers(correctCount: number, totalCount: number): SessionAnswer[] {
  return Array.from({ length: totalCount }, (_, i) => ({
    id:             `a-${i}`,
    session_id:     'sess-1',
    question_id:    `q-${i}`,
    chosen_answer:  i < correctCount ? 'A' : 'B',
    is_correct:     i < correctCount,
    time_taken_ms:  1000 + i * 100,
    ai_feedback_id: null,
    answered_at:    new Date(),
  } as SessionAnswer));
}

// ─── XP Edge Cases ────────────────────────────────────────────────────────────

describe('XP award edge cases', () => {
  it('handles 100 question session with 73 correct', () => {
    const answers = makeAnswers(73, 100);
    const { xpEarned, correctCount, isPerfect } = calculateSessionXP(answers, 100);

    expect(correctCount).toBe(73);
    expect(isPerfect).toBe(false);
    expect(xpEarned).toBe(73 * 10); // 730 XP — no perfect bonus
  });

  it('handles single correct answer in a 10-question session', () => {
    const answers = makeAnswers(1, 10);
    const { xpEarned, isPerfect } = calculateSessionXP(answers, 10);

    expect(isPerfect).toBe(false);
    expect(xpEarned).toBe(10); // 1 correct × 10 XP/correct
  });

  it('gives maximum XP for all-correct plus perfect bonus', () => {
    const answers = makeAnswers(20, 20);
    const { xpEarned, isPerfect } = calculateSessionXP(answers, 20);

    expect(isPerfect).toBe(true);
    expect(xpEarned).toBe(20 * 10 + 50); // 200 + 50 perfect bonus = 250
  });
});

// ─── Streak Edge Cases ────────────────────────────────────────────────────────

describe('Streak boundary conditions', () => {
  it('correctly identifies yesterday vs two days ago (the exact midnight boundary)', () => {
    const today          = new Date('2025-06-15T23:59:59Z');
    const yesterday      = new Date('2025-06-14T00:00:01Z');
    const twoDaysAgo     = new Date('2025-06-13T23:59:59Z');

    const { newStreak: extendStreak } = evaluateStreak(5, yesterday, today);
    const { newStreak: resetStreak }  = evaluateStreak(5, twoDaysAgo, today);

    expect(extendStreak).toBe(6); // consecutive — extend
    expect(resetStreak).toBe(1);  // gap — reset
  });

  it('does not double-increment streak when called twice on same day', () => {
    const today         = new Date('2025-06-15T20:00:00Z');
    const todayMorning  = new Date('2025-06-15T08:00:00Z');

    const { newStreak, shouldUpdate } = evaluateStreak(3, todayMorning, today);

    expect(newStreak).toBe(3);     // no change
    expect(shouldUpdate).toBe(false);
  });

  it('builds streak to arbitrarily large values correctly', () => {
    const base     = 999;
    const today    = new Date('2025-06-15T12:00:00Z');
    const yesterday = new Date('2025-06-14T12:00:00Z');

    const { newStreak } = evaluateStreak(base, yesterday, today);
    expect(newStreak).toBe(1000);
  });
});

// ─── Score Percent ────────────────────────────────────────────────────────────

describe('Score percent precision', () => {
  it('calculates fractional percentages to 2 decimal places', () => {
    // 1/3 = 33.33%
    const { calculateScorePercent } = require('@utils/xp');
    expect(calculateScorePercent(1, 3)).toBe(33.33);
    expect(calculateScorePercent(2, 3)).toBe(66.67);
    expect(calculateScorePercent(1, 7)).toBe(14.29);
  });
});
