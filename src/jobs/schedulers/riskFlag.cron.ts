import cron from 'node-cron';
import prisma from '@config/database';
import { emailQueue } from '@jobs/queues';
import { get as redisGet, set as redisSet } from '@lib/redis';
import { CRON, REDIS_KEYS, RISK, TTL } from '@config/constants';
import { env } from '@config/env';
import logger from '@lib/logger';

// ─── Accuracy Drop Detection ───────────────────────────────────────────────────

async function findStudentsWithAccuracyDrop(threshold: number): Promise<{ id: string }[]> {
  const now     = new Date();
  const week1Start = new Date(now.getTime() - 7 * 86400000);
  const week2Start = new Date(now.getTime() - 14 * 86400000);

  // Raw SQL aggregation via Prisma $queryRaw for performance
  const results = await prisma.$queryRaw<
    Array<{ user_id: string; recent_accuracy: number; prior_accuracy: number }>
  >`
    WITH recent AS (
      SELECT s.user_id,
             CASE WHEN SUM(s.total_questions) = 0 THEN 0
                  ELSE SUM(s.correct_count)::float / SUM(s.total_questions)
             END as accuracy
      FROM quiz_sessions s
      WHERE s.completed_at >= ${week1Start}
        AND s.completed_at < ${now}
      GROUP BY s.user_id
    ),
    prior AS (
      SELECT s.user_id,
             CASE WHEN SUM(s.total_questions) = 0 THEN 0
                  ELSE SUM(s.correct_count)::float / SUM(s.total_questions)
             END as accuracy
      FROM quiz_sessions s
      WHERE s.completed_at >= ${week2Start}
        AND s.completed_at < ${week1Start}
      GROUP BY s.user_id
    )
    SELECT r.user_id, r.accuracy as recent_accuracy, p.accuracy as prior_accuracy
    FROM recent r
    JOIN prior p ON r.user_id = p.user_id
    WHERE p.accuracy > 0
      AND (p.accuracy - r.accuracy) / p.accuracy >= ${threshold}
  `;

  return results.map((r: { user_id: string; recent_accuracy: number; prior_accuracy: number }) => ({ id: r.user_id }));
}

// ─── Main Risk Flag Job ────────────────────────────────────────────────────────

async function runRiskFlagJob(): Promise<void> {
  logger.info('Risk flag cron started');

  const now = new Date();

  // Rule 1: No login in last RISK.INACTIVE_DAYS days
  const inactiveStudents = await prisma.user.findMany({
    where: {
      role:          'student',
      last_active_at: { lt: new Date(now.getTime() - RISK.INACTIVE_DAYS * 86400000) },
    },
    select: { id: true },
  });

  // Rule 2: Accuracy dropped 25%+ in last 7 days vs prior 7 days
  const accuracyDropped = await findStudentsWithAccuracyDrop(RISK.ACCURACY_DROP_THRESHOLD);

  // Merge and deduplicate at-risk student IDs
  const atRiskIds = new Set<string>([
    ...inactiveStudents.map((u: { id: string }) => u.id),
    ...accuracyDropped.map((u: { id: string }) => u.id),
  ]);

  logger.info({ count: atRiskIds.size }, 'At-risk students identified');

  // Mark at-risk
  if (atRiskIds.size > 0) {
    await prisma.user.updateMany({
      where: { id: { in: Array.from(atRiskIds) } },
      data: {
        risk_flag:   true,
        risk_reason: 'Inactivity or accuracy drop',
      },
    });
  }

  // Clear flag for recovered students
  await prisma.user.updateMany({
    where: {
      role:      'student',
      risk_flag: true,
      id:        { notIn: Array.from(atRiskIds) },
    },
    data: { risk_flag: false, risk_reason: null },
  });

  // Rule 3: 14+ days inactive → send re-engagement email
  const reEngagementCandidates = await prisma.user.findMany({
    where: {
      role:          'student',
      last_active_at: { lt: new Date(now.getTime() - RISK.RE_ENGAGEMENT_INACTIVE_DAYS * 86400000) },
    },
    select: { id: true, email: true, full_name: true, institution_id: true },
  });

  let emailsSent = 0;

  for (const user of reEngagementCandidates as Array<{ id: string; email: string; full_name: string | null; institution_id: string }>) {
    const alreadySent = await redisGet(REDIS_KEYS.RE_ENGAGEMENT(user.id));
    if (alreadySent) continue;

    const institution = await prisma.institution.findUnique({
      where:  { id: user.institution_id },
      select: { name: true },
    });

    await emailQueue.add('send', {
      type:     're_engagement',
      to:       user.email,
      subject:  `We miss you at FuhsoX, ${user.full_name?.split(' ')[0] ?? 'Scholar'} 👋`,
      template: 're-engagement',
      data: {
        user_name:        user.full_name?.split(' ')[0] ?? 'Scholar',
        cta_link:         `${env.FRONTEND_URL}/dashboard`,
        institution_name: institution?.name ?? 'FuhsoX',
      },
    } as unknown as Parameters<typeof emailQueue.add>[1]);

    // Set cooldown — don't re-engage the same user within 7 days
    await redisSet(REDIS_KEYS.RE_ENGAGEMENT(user.id), '1', TTL.RE_ENGAGEMENT);

    emailsSent++;
  }

  logger.info({
    atRiskCount:       atRiskIds.size,
    reEngagementSent:  emailsSent,
  }, 'Risk flag cron complete');
}

// ─── Register Cron ─────────────────────────────────────────────────────────────

export function startRiskFlagCron() {
  // 1 AM UTC = 2 AM WAT
  cron.schedule(CRON.RISK_FLAG, () => {
    runRiskFlagJob().catch((err) => {
      logger.error({ err }, 'Risk flag cron crashed');
    });
  }, {
    timezone: 'UTC',
  });

  logger.info('Risk flag cron registered');
}

export { runRiskFlagJob };
