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

/**
 * Streak days are WAT (UTC+1) calendar days — the same boundary the AI budget,
 * mastery-attempt caps and study reminders use.
 *
 * Every instant below is written in UTC and annotated with its WAT wall-clock, so
 * these assertions are about the PRODUCT'S day boundary rather than the machine's.
 * The earlier version of this suite used bare UTC instants and therefore passed
 * only on a UTC runner; it failed on any other machine, which is what made these
 * two look like flaky "pre-existing failures" rather than a real timezone bug.
 */
describe('Streak boundary conditions', () => {
  it('correctly identifies yesterday vs two days ago (the exact WAT midnight boundary)', () => {
    // 2025-06-15 22:00 WAT — late on the 15th.
    const today      = new Date('2025-06-15T21:00:00Z');
    // 2025-06-14 00:30 WAT — the very first minutes of the 14th. Nearly 46 hours
    // earlier in elapsed time, but the PREVIOUS calendar day, so it extends.
    const yesterday  = new Date('2025-06-13T23:30:00Z');
    // 2025-06-13 23:30 WAT — the last minutes of the 13th. Only 22 hours before
    // `yesterday`, but a day further back on the calendar, so it resets.
    const twoDaysAgo = new Date('2025-06-13T22:30:00Z');

    const { newStreak: extendStreak } = evaluateStreak(5, yesterday, today);
    const { newStreak: resetStreak }  = evaluateStreak(5, twoDaysAgo, today);

    expect(extendStreak).toBe(6); // consecutive calendar day — extend
    expect(resetStreak).toBe(1);  // a day was missed — reset
  });

  it('does not double-increment streak when called twice on same day', () => {
    // Both 2025-06-15 in WAT: 21:00 and 09:00.
    const today        = new Date('2025-06-15T20:00:00Z');
    const todayMorning = new Date('2025-06-15T08:00:00Z');

    const { newStreak, shouldUpdate } = evaluateStreak(3, todayMorning, today);

    expect(newStreak).toBe(3);     // no change
    expect(shouldUpdate).toBe(false);
  });

  it('rolls the day at WAT midnight, not UTC midnight', () => {
    // 23:30 UTC on the 15th is already 00:30 WAT on the 16th. A UTC-based
    // implementation would call these the same day; a WAT one extends the streak.
    const lateNight = new Date('2025-06-15T22:30:00Z'); // 23:30 WAT, 15th
    const justAfter = new Date('2025-06-15T23:30:00Z'); // 00:30 WAT, 16th

    const { newStreak, shouldUpdate } = evaluateStreak(4, lateNight, justAfter);

    expect(newStreak).toBe(5);
    expect(shouldUpdate).toBe(true);
  });

  it('does not extend a streak from a future date (clock skew / restored backup)', () => {
    const today    = new Date('2025-06-15T12:00:00Z');
    const tomorrow = new Date('2025-06-16T12:00:00Z');

    expect(evaluateStreak(9, tomorrow, today).newStreak).toBe(1);
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
