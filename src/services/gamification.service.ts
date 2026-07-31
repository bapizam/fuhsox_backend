import prisma from '@config/database';
import { calculateSessionXP, earnsRewards, evaluateStreak } from '@utils/xp';
import type { QuizSession, SessionAnswer, User, Badge } from '@typings/models';
import { notificationService } from './notification.service';
import logger from '@lib/logger';
import { feedService } from './feed.service';

// ─── Badge Rules ───────────────────────────────────────────────────────────────

interface BadgeRule {
  code: string;
  check: (
    user: User,
    allSessions: (QuizSession & { answers: SessionAnswer[] })[],
    currentSession: QuizSession & { answers: SessionAnswer[] },
  ) => boolean;
}

const BADGE_RULES: BadgeRule[] = [
  {
    code:  'FIRST_QUIZ',
    check: (_, sessions) => sessions.length >= 1,
  },
  {
    code:  'STREAK_7',
    check: (user) => user.streak_count >= 7,
  },
  {
    code:  'STREAK_30',
    check: (user) => user.streak_count >= 30,
  },
  {
    code:  'ACCURACY_90',
    check: (_, sessions) => sessions.some((s) => (s.score_percent ?? 0) >= 90),
  },
  {
    code:  'QUIZ_MASTER_50',
    check: (_, sessions) => sessions.length >= 50,
  },
  {
    code:  'PERFECT_SCORE',
    check: (_, sessions) => sessions.some((s) => s.score_percent === 100),
  },
  {
    code:  'SOCIAL_CONNECTOR',
    check: (user) => user.xp_points >= 500,
  },
];

// ─── Main Processing Function ──────────────────────────────────────────────────

export async function processSessionComplete(
  userId: string,
  session: QuizSession & { answers: SessionAnswer[] },
): Promise<{ xpEarned: number; badges_earned: Badge[] }> {
  // The WHOLE reward pipeline is skipped for a measurement mode, not just the XP:
  // a streak day would claim the student studied when they have not yet, and a
  // perfect-score badge for a test designed to find gaps is nonsense. Guarded
  // here rather than at the call site so no future caller can reintroduce it.
  if (!earnsRewards(session.mode)) {
    logger.info({ userId, sessionId: session.id }, 'Placement session — no XP, streak or badges');
    return { xpEarned: 0, badges_earned: [] };
  }

  const { xpEarned } = calculateSessionXP(session.answers, session.total_questions);

  // Update user XP atomically
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data:  { xp_points: { increment: xpEarned } },
  });

  // Update streak
  await updateUserStreak(userId, updatedUser);

  // Re-fetch user with updated streak for badge evaluation
  const freshUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Check and award badges
  const earnedBadges = await checkAndAwardBadges(freshUser, session);

  // Notify for each new badge
  for (const badge of earnedBadges) {
    await notificationService.create({
      user_id:    userId,
      type:       'system',
      title:      `🏅 Badge Unlocked: ${badge.name}`,
      body:       badge.description,
      action_url: '/profile/badges',
    });
  }

  logger.info({ userId, xpEarned, badgesEarned: earnedBadges.length }, 'Session XP processed');

  return { xpEarned, badges_earned: earnedBadges };
}

// ─── Streak ───────────────────────────────────────────────────────────────────

async function updateUserStreak(userId: string, user: User): Promise<void> {
  const { newStreak, shouldUpdate } = evaluateStreak(
    user.streak_count,
    user.last_streak_date,
  );

  if (!shouldUpdate) return;

  await prisma.user.update({
    where: { id: userId },
    data: {
      streak_count:     newStreak,
      last_streak_date: new Date(),
    },
  });
}

// ─── Badge Awarding ────────────────────────────────────────────────────────────

async function checkAndAwardBadges(
  user: User,
  currentSession: QuizSession & { answers: SessionAnswer[] },
): Promise<Badge[]> {
  // Fetch all user sessions for rule evaluation. Placement is excluded here too:
  // this runs for LATER real sessions, and a past diagnostic must not quietly
  // count toward a "complete N quizzes" or accuracy badge it earned nothing for.
  const allSessions = await prisma.quizSession.findMany({
    where:   { user_id: user.id, completed_at: { not: null }, mode: { not: 'placement' } },
    include: { answers: true },
    orderBy: { completed_at: 'desc' },
    take:    100,
  });

  // Get badges already awarded to this user
  const alreadyAwarded = await prisma.userBadge.findMany({
    where:   { user_id: user.id },
    select:  { badge_id: true },
  }) as Array<{ badge_id: string }>;
  const awardedCodes = new Set(alreadyAwarded.map((ub) => ub.badge_id));

  // Get all badge definitions
  const allBadges = await prisma.badge.findMany() as Array<{ code: string; id: string; name: string; description: string; icon_url: string; xp_award: number }>;
  const badgeByCode = new Map(allBadges.map((b) => [b.code, b]));

  const newlyEarned: Badge[] = [];

  for (const rule of BADGE_RULES) {
    const badge = badgeByCode.get(rule.code);
    if (!badge) continue; // Badge not seeded yet
    if (awardedCodes.has(badge.id)) continue; // Already awarded

    const earned = rule.check(user, allSessions, currentSession);
    if (!earned) continue;

    // Award the badge
    await prisma.userBadge.create({
      data: { user_id: user.id, badge_id: badge.id },
    });

    // Award XP for the badge
    if (badge.xp_award > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data:  { xp_points: { increment: badge.xp_award } },
      });
    }

    newlyEarned.push(badge);
    logger.info({ userId: user.id, badge: rule.code }, 'Badge awarded');

    // Auto-create achievement post in the social feed
    feedService.createAchievementPost(
      user.id, user.institution_id, badge.name, badge.code,
    ).catch(() => {/* non-critical — don't fail session completion if feed post fails */});
  }

  return newlyEarned;
}

// ─── User Stats ────────────────────────────────────────────────────────────────

export async function getUserStats(userId: string): Promise<{
  total_quizzes: number;
  accuracy_rate: number;
  total_xp: number;
  streak_count: number;
}> {
  const [sessions, user] = await Promise.all([
    prisma.quizSession.findMany({
      // Placement is excluded for the same reason it earns no XP: it is a
      // measurement, not practice. Counting it would inflate "quizzes taken" and
      // drag down accuracy with a check the student is MEANT to partly fail —
      // punishing them, in their own stats, for finding out what they don't know.
      where:  { user_id: userId, completed_at: { not: null }, mode: { not: 'placement' } },
      select: { correct_count: true, total_questions: true },
    }),
    prisma.user.findUnique({
      where:  { id: userId },
      select: { xp_points: true, streak_count: true },
    }),
  ]);

  const totalQuizzes = sessions.length;
  const totalCorrect = sessions.reduce((sum: number, s: { correct_count: number | null }) => sum + (s.correct_count ?? 0), 0);
  const totalQuestions = sessions.reduce((sum: number, s: { total_questions: number }) => sum + s.total_questions, 0);
  const accuracyRate = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;

  return {
    total_quizzes: totalQuizzes,
    accuracy_rate: Math.round(accuracyRate * 100) / 100,
    total_xp:      user?.xp_points ?? 0,
    streak_count:  user?.streak_count ?? 0,
  };
}

export const gamificationService = {
  processSessionComplete,
  getUserStats,
  updateUserStreak,
};
