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

/** WAT is UTC+1 and does not observe DST — the same constant `lib/redis.ts` uses. */
const WAT_OFFSET_MS = 60 * 60 * 1000;
const MS_PER_DAY = 86_400_000;

/**
 * Which WAT calendar day a moment falls on, as a day number.
 *
 * Deliberately NOT `setHours(0,0,0,0)`, which resolves midnight in the SERVER'S
 * local timezone — that made streaks depend on where the process happened to run
 * (UTC on Render, UTC+5:30 on a developer's laptop) and silently disagree with
 * every other daily boundary in the codebase. The AI budget, mastery-attempt caps
 * and study reminders are all keyed on WAT via `getTodayWAT()`; streaks now match.
 */
export function watDayNumber(date: Date): number {
  return Math.floor((date.getTime() + WAT_OFFSET_MS) / MS_PER_DAY);
}

/**
 * Whole WAT calendar days between two moments. `0` = same day, `1` = yesterday.
 *
 * Exported so every streak read agrees with `evaluateStreak` by construction:
 * `user.service` previously re-implemented this with server-local `setHours`,
 * which meant the dashboard's "practised today" and the streak that awards it
 * could disagree for an hour either side of midnight.
 */
export function watDaysBetween(from: Date, to: Date): number {
  return watDayNumber(to) - watDayNumber(from);
}

/**
 * Determine if a streak should be incremented based on last streak date.
 *
 * Streaks count CALENDAR days in WAT, not elapsed time: studying at 23:00 and
 * again at 01:00 the next day is a two-day streak, while two sessions twenty hours
 * apart on the same day is one. That is what a student means by "streak".
 */
export function evaluateStreak(
  currentStreak: number,
  lastStreakDate: Date | null,
  today: Date = new Date(),
): { newStreak: number; shouldUpdate: boolean } {
  if (!lastStreakDate) {
    return { newStreak: 1, shouldUpdate: true };
  }

  const todayDay = watDayNumber(today);
  const lastDay = watDayNumber(lastStreakDate);

  if (lastDay === todayDay) {
    // Already updated today — no change
    return { newStreak: currentStreak, shouldUpdate: false };
  }

  if (todayDay - lastDay === 1) {
    // Consecutive day — extend streak
    return { newStreak: currentStreak + 1, shouldUpdate: true };
  }

  // Streak broken — reset to 1. Also covers a lastStreakDate in the FUTURE
  // (clock skew, or a restored backup), which must not extend a streak.
  return { newStreak: 1, shouldUpdate: true };
}
