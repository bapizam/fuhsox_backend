import cron from 'node-cron';
import prisma from '@config/database';
import { emailQueue } from '@jobs/queues';
import { notificationService } from '@services/notification.service';
import { get as redisGet, set as redisSet } from '@lib/redis';
import { CRON, REDIS_KEYS, TTL } from '@config/constants';
import { env } from '@config/env';
import logger from '@lib/logger';

// ─── Quiet Hours Check ─────────────────────────────────────────────────────────

function isInQuietHours(
  quietStart: string | null | undefined,
  quietEnd:   string | null | undefined,
  now:        Date,
): boolean {
  if (!quietStart || !quietEnd) return false;

  const [startH = 0, startM = 0] = quietStart.split(':').map(Number);
  const [endH = 0, endM = 0]   = quietEnd.split(':').map(Number);

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes   = startH * 60 + startM;
  const endMinutes     = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Spans midnight (e.g. 22:00 → 06:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

// ─── Reminder Frequency Check ─────────────────────────────────────────────────

function shouldSendReminder(
  frequency:    string | undefined,
  lastSentISO:  string | null,
): boolean {
  if (!lastSentISO) return true;

  const lastSent  = new Date(lastSentISO);
  const now       = new Date();
  const diffDays  = (now.getTime() - lastSent.getTime()) / 86400000;

  switch (frequency) {
    case 'daily':       return diffDays >= 1;
    case 'every_2_days': return diffDays >= 2;
    case 'weekly':      return diffDays >= 7;
    default:            return diffDays >= 1;
  }
}

// ─── Study Reminder Job ────────────────────────────────────────────────────────

async function runStudyReminderJob(): Promise<void> {
  logger.info('Study reminder cron started');

  const today = new Date();
  const dayOfWeek = today.getDay();

  const schedules = await prisma.studySchedule.findMany({
    where: {
      is_active:  true,
      study_days: { has: dayOfWeek },
    },
    include: {
      user: { include: { notification_pref: true } },
    },
  });

  let sent = 0;
  let skipped = 0;

  for (const schedule of schedules) {
    const user = schedule.user;
    const pref = user.notification_pref;

    try {
      // Skip opted-out users
      if (pref?.opt_out_reminders) { skipped++; continue; }

      // Skip quiet hours
      if (isInQuietHours(pref?.quiet_hours_start, pref?.quiet_hours_end, today)) {
        skipped++;
        continue;
      }

      // Frequency check
      const reminderKey = REDIS_KEYS.LAST_REMINDER(user.id, schedule.id);
      const lastReminderISO = await redisGet(reminderKey);
      if (!shouldSendReminder(pref?.reminder_frequency, lastReminderISO)) {
        skipped++;
        continue;
      }

      // Determine template based on exam proximity
      const daysUntilExam = Math.floor(
        (schedule.exam_date.getTime() - today.getTime()) / 86400000,
      );

      const isExamCountdown = daysUntilExam > 0 && daysUntilExam <= 3;

      const institution = await prisma.institution.findUnique({
        where:  { id: user.institution_id },
        select: { name: true },
      });

      const institutionName = institution?.name ?? 'FuhsoX';
      const firstName       = user.full_name?.split(' ')[0] ?? 'Scholar';
      const quizLink        = `${env.FRONTEND_URL}/quiz/browse?topic=${encodeURIComponent(schedule.subject)}`;

      if (isExamCountdown) {
        await emailQueue.add('send', {
          type:     'exam_countdown',
          to:       user.email,
          subject:  `⚡ ${daysUntilExam} day${daysUntilExam !== 1 ? 's' : ''} until your ${schedule.subject} exam!`,
          template: 'exam-countdown',
          data: {
            user_name:        firstName,
            subject:          schedule.subject,
            days_remaining:   daysUntilExam,
            exam_date:        schedule.exam_date.toLocaleDateString('en-NG'),
            quiz_link:        quizLink,
            institution_name: institutionName,
          },
        });
      } else {
        await emailQueue.add('send', {
          type:     'study_reminder',
          to:       user.email,
          subject:  `📚 Time to study ${schedule.subject}!`,
          template: 'study-reminder',
          data: {
            user_name:        firstName,
            subject:          schedule.subject,
            time:             schedule.preferred_time_start,
            quiz_link:        quizLink,
            streak_count:     user.streak_count,
            institution_name: institutionName,
          },
        });
      }

      // Create in-app notification
      await notificationService.create({
        user_id:    user.id,
        type:       'reminder',
        title:      isExamCountdown
          ? `⚡ ${daysUntilExam} day${daysUntilExam !== 1 ? 's' : ''} until ${schedule.subject} exam!`
          : `📚 Study time: ${schedule.subject}`,
        body:       `Your session is scheduled for ${schedule.preferred_time_start} today.`,
        action_url: `/quiz/browse?topic=${encodeURIComponent(schedule.subject)}`,
      });

      // Update frequency tracking
      await redisSet(reminderKey, today.toISOString(), TTL.LAST_REMINDER);

      sent++;

    } catch (err) {
      logger.error({ err, userId: user.id, scheduleId: schedule.id }, 'Error processing study reminder');
    }
  }

  logger.info({ total: schedules.length, sent, skipped }, 'Study reminder cron complete');
}

// ─── Register Cron ─────────────────────────────────────────────────────────────

export function startStudyReminderCron() {
  // 5 PM UTC = 6 PM WAT (Africa/Lagos)
  cron.schedule(CRON.STUDY_REMINDER, () => {
    runStudyReminderJob().catch((err) => {
      logger.error({ err }, 'Study reminder cron crashed');
    });
  }, {
    timezone: 'UTC',
  });

  logger.info('Study reminder cron registered');
}

export { runStudyReminderJob };
