import prisma from '@config/database';
import { redis } from '@config/redis';
import { REDIS_KEYS, TTL } from '@config/constants';

// ─── Overview Stats ────────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  active_today:          number;
  quizzes_today:         number;
  reminders_sent_week:   number;
  events_active:         number;
  ai_calls_today:        number;
  at_risk_count:         number;
  total_students:        number;
  total_questions:       number;
}

export async function getOverview(institutionId: string): Promise<AnalyticsOverview> {
  const cacheKey = REDIS_KEYS.ANALYTICS_OVERVIEW(institutionId);
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as AnalyticsOverview;

  const now   = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const weekAgo = new Date(now.getTime() - 7 * 86400000);

  const [
    activeToday,
    quizzesToday,
    eventsActive,
    atRiskCount,
    totalStudents,
    totalQuestions,
  ] = await Promise.all([
    // Students who touched the app today
    prisma.user.count({
      where: { institution_id: institutionId, role: 'student', last_active_at: { gte: today } },
    }),
    // Quiz sessions started today
    prisma.quizSession.count({
      where: { institution_id: institutionId, started_at: { gte: today } },
    }),
    // Currently published events (event_date in future or today)
    prisma.event.count({
      where: { institution_id: institutionId, status: 'published', event_date: { gte: today } },
    }),
    // Students with risk flag
    prisma.user.count({
      where: { institution_id: institutionId, role: 'student', risk_flag: true },
    }),
    prisma.user.count({ where: { institution_id: institutionId, role: 'student' } }),
    prisma.question.count({ where: { institution_id: institutionId, status: 'published' } }),
  ]);

  // AI calls today (sum from AIUsageLog)
  const aiCallsAgg = await prisma.aIUsageLog.aggregate({
    where: { institution_id: institutionId, created_at: { gte: today } },
    _count: { id: true },
  });
  const aiCallsToday = aiCallsAgg._count.id;

  // Notifications sent as reminders this week
  const remindersSentWeek = await prisma.notification.count({
    where: {
      type:       'reminder',
      created_at: { gte: weekAgo },
      user:       { institution_id: institutionId },
    },
  });

  const result: AnalyticsOverview = {
    active_today:        activeToday,
    quizzes_today:       quizzesToday,
    reminders_sent_week: remindersSentWeek,
    events_active:       eventsActive,
    ai_calls_today:      aiCallsToday,
    at_risk_count:       atRiskCount,
    total_students:      totalStudents,
    total_questions:     totalQuestions,
  };

  await redis.set(cacheKey, JSON.stringify(result), 'EX', TTL.ANALYTICS_OVERVIEW);

  return result;
}

// ─── Student Analytics ─────────────────────────────────────────────────────────

export async function getStudentAnalytics(
  institutionId: string,
  days: number = 30,
) {
  const from = new Date(Date.now() - days * 86400000);

  // New sign-ups per day (last N days)
  const signupsByDay = await prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
    SELECT DATE_TRUNC('day', created_at AT TIME ZONE 'Africa/Lagos')::date::text AS date,
           COUNT(*) AS count
    FROM users
    WHERE institution_id = ${institutionId}
      AND role = 'student'
      AND created_at >= ${from}
    GROUP BY 1
    ORDER BY 1
  `;

  // Daily active users per day
  const dauByDay = await prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
    SELECT DATE_TRUNC('day', last_active_at AT TIME ZONE 'Africa/Lagos')::date::text AS date,
           COUNT(DISTINCT id) AS count
    FROM users
    WHERE institution_id = ${institutionId}
      AND role = 'student'
      AND last_active_at >= ${from}
    GROUP BY 1
    ORDER BY 1
  `;

  // Faculty breakdown
  const facultyBreakdown = await prisma.user.groupBy({
    by:     ['faculty'],
    where:  { institution_id: institutionId, role: 'student', faculty: { not: null } },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });

  // Streak distribution
  const streakDistribution = await prisma.$queryRaw<Array<{ bucket: string; count: bigint }>>`
    SELECT
      CASE
        WHEN streak_count = 0 THEN '0'
        WHEN streak_count BETWEEN 1  AND 6  THEN '1-6'
        WHEN streak_count BETWEEN 7  AND 29 THEN '7-29'
        WHEN streak_count >= 30             THEN '30+'
      END AS bucket,
      COUNT(*) AS count
    FROM users
    WHERE institution_id = ${institutionId} AND role = 'student'
    GROUP BY bucket
    ORDER BY bucket
  `;

  return {
    signups_by_day: signupsByDay.map((r: { date: string; count: bigint }) => ({ date: r.date, count: Number(r.count) })),
    dau_by_day:     dauByDay.map((r: { date: string; count: bigint }) => ({ date: r.date, count: Number(r.count) })),
    faculty_breakdown: facultyBreakdown.map((f: { faculty: string | null; _count: { id: number } }) => ({
      faculty: f.faculty ?? 'Unknown',
      count:   f._count.id,
    })),
    streak_distribution: streakDistribution.map((r: { bucket: string; count: bigint }) => ({
      bucket: r.bucket,
      count:  Number(r.count),
    })),
  };
}

// ─── Quiz Analytics ─────────────────────────────────────────────────────────────

export async function getQuizAnalytics(
  institutionId: string,
  days: number = 30,
) {
  const from = new Date(Date.now() - days * 86400000);

  // Quizzes completed per day
  const quizzesByDay = await prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
    SELECT DATE_TRUNC('day', completed_at AT TIME ZONE 'Africa/Lagos')::date::text AS date,
           COUNT(*) AS count
    FROM quiz_sessions
    WHERE institution_id = ${institutionId}
      AND completed_at IS NOT NULL
      AND completed_at >= ${from}
    GROUP BY 1
    ORDER BY 1
  `;

  // Average score by difficulty
  const scoreByDifficulty = await prisma.$queryRaw<
    Array<{ difficulty: string; avg_score: number; count: bigint }>
  >`
    SELECT q.difficulty,
           ROUND(AVG(qs.score_percent)::numeric, 2) AS avg_score,
           COUNT(qs.id) AS count
    FROM quiz_sessions qs
    JOIN session_answers sa ON sa.session_id = qs.id
    JOIN questions q ON q.id = sa.question_id
    WHERE qs.institution_id = ${institutionId}
      AND qs.completed_at IS NOT NULL
      AND qs.completed_at >= ${from}
    GROUP BY q.difficulty
  `;

  // Most attempted courses
  const topCourses = await prisma.$queryRaw<Array<{ course_code: string; count: bigint }>>`
    SELECT q.course_code, COUNT(sa.id) AS count
    FROM session_answers sa
    JOIN questions q ON q.id = sa.question_id
    JOIN quiz_sessions qs ON qs.id = sa.session_id
    WHERE qs.institution_id = ${institutionId}
      AND qs.completed_at >= ${from}
    GROUP BY q.course_code
    ORDER BY count DESC
    LIMIT 10
  `;

  // Pass rate overall (score >= 50%)
  const passRateAgg = await prisma.quizSession.aggregate({
    where: {
      institution_id: institutionId,
      completed_at:   { gte: from },
      score_percent:  { not: null },
    },
    _avg:   { score_percent: true },
    _count: { id: true },
  });

  const passCount = await prisma.quizSession.count({
    where: {
      institution_id: institutionId,
      completed_at:   { gte: from },
      score_percent:  { gte: 50 },
    },
  });

  return {
    quizzes_by_day:      quizzesByDay.map((r: { date: string; count: bigint }) => ({ date: r.date, count: Number(r.count) })),
    score_by_difficulty: scoreByDifficulty.map((r: { difficulty: string; avg_score: number; count: bigint }) => ({
      difficulty: r.difficulty,
      avg_score:  r.avg_score,
      count:      Number(r.count),
    })),
    top_courses: topCourses.map((r: { course_code: string; count: bigint }) => ({ course_code: r.course_code, count: Number(r.count) })),
    average_score: passRateAgg._avg.score_percent ?? 0,
    total_sessions: passRateAgg._count.id,
    pass_rate: passRateAgg._count.id > 0
      ? Math.round((passCount / passRateAgg._count.id) * 100)
      : 0,
  };
}

// ─── AI Usage Analytics ───────────────────────────────────────────────────────

export async function getAIAnalytics(
  institutionId: string,
  days: number = 30,
) {
  const from = new Date(Date.now() - days * 86400000);

  const usageByDay = await prisma.$queryRaw<Array<{ date: string; feature: string; count: bigint; tokens: bigint }>>`
    SELECT DATE_TRUNC('day', created_at AT TIME ZONE 'Africa/Lagos')::date::text AS date,
           feature,
           COUNT(*) AS count,
           SUM(tokens_used) AS tokens
    FROM ai_usage_logs
    WHERE institution_id = ${institutionId}
      AND created_at >= ${from}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;

  const totalTokensAgg = await prisma.aIUsageLog.aggregate({
    where:  { institution_id: institutionId, created_at: { gte: from } },
    _sum:   { tokens_used: true },
    _count: { id: true },
  });

  const topUsers = await prisma.aIUsageLog.groupBy({
    by:      ['user_id'],
    where:   { institution_id: institutionId, created_at: { gte: from } },
    _count:  { id: true },
    orderBy: { _count: { id: 'desc' } },
    take:    10,
  });

  const topUserDetails = await prisma.user.findMany({
    where:  { id: { in: topUsers.map((u: { user_id: string; _count: { id: number } }) => u.user_id) } },
    select: { id: true, full_name: true, faculty: true },
  });

  const userMap = new Map(topUserDetails.map((u: { id: string; full_name: string | null; faculty: string | null }) => [u.id, u]));

  return {
    usage_by_day: usageByDay.map((r: { date: string; feature: string; count: bigint; tokens: bigint }) => ({
      date:    r.date,
      feature: r.feature,
      count:   Number(r.count),
      tokens:  Number(r.tokens),
    })),
    total_calls:   totalTokensAgg._count.id,
    total_tokens:  totalTokensAgg._sum.tokens_used ?? 0,
    top_users: topUsers.map((u: { user_id: string; _count: { id: number } }) => {
      const detail = userMap.get(u.user_id);
      return { ...(detail as object | undefined), call_count: u._count.id };
    }),
  };
}

export const analyticsService = {
  getOverview,
  getStudentAnalytics,
  getQuizAnalytics,
  getAIAnalytics,
};
