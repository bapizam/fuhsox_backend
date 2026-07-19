import { XP } from '@config/constants';
import type { SessionAnswer } from '@typings/models';

/**
 * Calculate XP earned from a completed quiz session.
 */
export function calculateSessionXP(
  answers: SessionAnswer[],
  totalQuestions: number,
): { xpEarned: number; isPerfect: boolean; correctCount: number } {
  const correctCount = answers.filter((a) => a.is_correct).length;
  const isPerfect = correctCount === totalQuestions;

  let xpEarned = correctCount * XP.PER_CORRECT_ANSWER;
  if (isPerfect) xpEarned += XP.PERFECT_SCORE_BONUS;

  return { xpEarned, isPerfect, correctCount };
}

/**
 * Calculate the score percentage from a session.
 */
export function calculateScorePercent(correctCount: number, totalQuestions: number): number {
  if (totalQuestions === 0) return 0;
  return Math.round((correctCount / totalQuestions) * 100 * 100) / 100;
}

/**
 * Determine if a streak should be incremented based on last streak date.
 */
export function evaluateStreak(
  currentStreak: number,
  lastStreakDate: Date | null,
  today: Date = new Date(),
): { newStreak: number; shouldUpdate: boolean } {
  const todayMidnight = new Date(today);
  todayMidnight.setHours(0, 0, 0, 0);

  const yesterdayMidnight = new Date(todayMidnight.getTime() - 86400000);

  if (!lastStreakDate) {
    return { newStreak: 1, shouldUpdate: true };
  }

  const lastMidnight = new Date(lastStreakDate);
  lastMidnight.setHours(0, 0, 0, 0);

  if (lastMidnight.getTime() === todayMidnight.getTime()) {
    // Already updated today — no change
    return { newStreak: currentStreak, shouldUpdate: false };
  }

  if (lastMidnight.getTime() === yesterdayMidnight.getTime()) {
    // Consecutive day — extend streak
    return { newStreak: currentStreak + 1, shouldUpdate: true };
  }

  // Streak broken — reset to 1
  return { newStreak: 1, shouldUpdate: true };
}
