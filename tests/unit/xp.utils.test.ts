import { calculateSessionXP, calculateScorePercent, evaluateStreak } from '@utils/xp';
import { XP } from '@config/constants';
import type { SessionAnswer } from '@typings/models';

// Minimal SessionAnswer fixture
const makeAnswer = (is_correct: boolean): SessionAnswer => ({
  id:             'answer-id',
  session_id:     'session-id',
  question_id:    'question-id',
  chosen_answer:  is_correct ? 'A' : 'B',
  is_correct,
  time_taken_ms:  1500,
  ai_feedback_id: null,
  answered_at:    new Date(),
} as SessionAnswer);

// ─── calculateSessionXP ────────────────────────────────────────────────────────

describe('calculateSessionXP', () => {
  it('awards XP for each correct answer', () => {
    const answers = [makeAnswer(true), makeAnswer(true), makeAnswer(false)];
    const { xpEarned, correctCount, isPerfect } = calculateSessionXP(answers, 3);

    expect(correctCount).toBe(2);
    expect(isPerfect).toBe(false);
    expect(xpEarned).toBe(2 * XP.PER_CORRECT_ANSWER);
  });

  it('awards perfect score bonus when all answers are correct', () => {
    const answers = [makeAnswer(true), makeAnswer(true), makeAnswer(true)];
    const { xpEarned, isPerfect } = calculateSessionXP(answers, 3);

    expect(isPerfect).toBe(true);
    expect(xpEarned).toBe(3 * XP.PER_CORRECT_ANSWER + XP.PERFECT_SCORE_BONUS);
  });

  it('awards zero XP when all answers are wrong', () => {
    const answers = [makeAnswer(false), makeAnswer(false)];
    const { xpEarned, correctCount } = calculateSessionXP(answers, 2);

    expect(correctCount).toBe(0);
    expect(xpEarned).toBe(0);
  });

  it('handles empty answers array gracefully', () => {
    const { xpEarned, correctCount, isPerfect } = calculateSessionXP([], 0);

    expect(xpEarned).toBe(XP.PERFECT_SCORE_BONUS); // 0 of 0 = perfect
    expect(correctCount).toBe(0);
    expect(isPerfect).toBe(true);
  });

  it('handles 1-question session correctly', () => {
    const answers = [makeAnswer(true)];
    const { xpEarned, isPerfect } = calculateSessionXP(answers, 1);

    expect(isPerfect).toBe(true);
    expect(xpEarned).toBe(XP.PER_CORRECT_ANSWER + XP.PERFECT_SCORE_BONUS);
  });
});

// ─── calculateScorePercent ────────────────────────────────────────────────────

describe('calculateScorePercent', () => {
  it('calculates 100% for perfect score', () => {
    expect(calculateScorePercent(10, 10)).toBe(100);
  });

  it('calculates 50% correctly', () => {
    expect(calculateScorePercent(5, 10)).toBe(50);
  });

  it('calculates 0% when none correct', () => {
    expect(calculateScorePercent(0, 10)).toBe(0);
  });

  it('returns 0 when total is zero to avoid division error', () => {
    expect(calculateScorePercent(0, 0)).toBe(0);
  });

  it('rounds to 2 decimal places', () => {
    // 7 / 30 = 23.333...% → should round to 23.33
    expect(calculateScorePercent(7, 30)).toBe(23.33);
  });
});

// ─── evaluateStreak ───────────────────────────────────────────────────────────

describe('evaluateStreak', () => {
  const today = new Date('2025-06-15T12:00:00Z');

  it('starts streak at 1 when no previous streak date', () => {
    const { newStreak, shouldUpdate } = evaluateStreak(0, null, today);
    expect(newStreak).toBe(1);
    expect(shouldUpdate).toBe(true);
  });

  it('extends streak by 1 for consecutive day activity', () => {
    const yesterday = new Date('2025-06-14T18:00:00Z');
    const { newStreak, shouldUpdate } = evaluateStreak(5, yesterday, today);
    expect(newStreak).toBe(6);
    expect(shouldUpdate).toBe(true);
  });

  it('does not update streak when already updated today', () => {
    const todayMorning = new Date('2025-06-15T08:00:00Z');
    const { newStreak, shouldUpdate } = evaluateStreak(5, todayMorning, today);
    expect(newStreak).toBe(5);
    expect(shouldUpdate).toBe(false);
  });

  it('resets streak to 1 when a day was skipped', () => {
    const twoDaysAgo = new Date('2025-06-13T10:00:00Z');
    const { newStreak, shouldUpdate } = evaluateStreak(10, twoDaysAgo, today);
    expect(newStreak).toBe(1);
    expect(shouldUpdate).toBe(true);
  });

  it('resets streak to 1 after a long absence', () => {
    const longAgo = new Date('2025-01-01T00:00:00Z');
    const { newStreak, shouldUpdate } = evaluateStreak(25, longAgo, today);
    expect(newStreak).toBe(1);
    expect(shouldUpdate).toBe(true);
  });
});
