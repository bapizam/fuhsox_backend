import { Worker, type Job } from 'bullmq';
import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import prisma from '@config/database';
import type { PushJob } from '@typings/jobs';
import logger from '@lib/logger';

// ─── Expo Push Fan-out Worker (M5) ────────────────────────────────────────────
// Consumes the `push` queue (one job per recipient, enqueued by
// notification.service) and delivers via Expo's push API. Best-effort by
// design: users without registered device tokens are a silent no-op, and
// `DeviceNotRegistered` tickets prune the dead token row so the table
// self-cleans as users uninstall.

const expo = new Expo();

// ─── Quiet Hours (reminder pushes only) ───────────────────────────────────────
// Same server-local-time semantics as studyReminder.cron.ts (WAT assumption —
// deliberate, do not "fix" independently). Only `reminder`-type pushes respect
// quiet hours / opt-out; social and event pushes deliver regardless, matching
// common messaging-app behavior. Today the reminder cron already applies these
// prefs before creating the notification, so this is defense-in-depth for any
// future reminder producer.

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

async function shouldSkipReminderPush(userId: string): Promise<boolean> {
  const pref = await prisma.notificationPref.findUnique({
    where: { user_id: userId },
  });
  if (!pref) return false;
  if (pref.opt_out_reminders) return true;
  return isInQuietHours(pref.quiet_hours_start, pref.quiet_hours_end, new Date());
}

// ─── Job Processing ────────────────────────────────────────────────────────────

async function processPushJob(job: Job<PushJob>): Promise<void> {
  const payload = job.data;

  if (payload.notification_type === 'reminder' && (await shouldSkipReminderPush(payload.user_id))) {
    logger.debug({ jobId: job.id, userId: payload.user_id }, 'Reminder push skipped (prefs/quiet hours)');
    return;
  }

  const devices = await prisma.devicePushToken.findMany({
    where: { user_id: payload.user_id },
  });
  if (devices.length === 0) return;

  // Malformed rows can never deliver — prune them instead of retrying forever.
  const invalid = devices.filter((d) => !Expo.isExpoPushToken(d.expo_push_token));
  if (invalid.length > 0) {
    await prisma.devicePushToken.deleteMany({
      where: { expo_push_token: { in: invalid.map((d) => d.expo_push_token) } },
    });
  }

  const valid = devices.filter((d) => Expo.isExpoPushToken(d.expo_push_token));
  if (valid.length === 0) return;

  // Android channel the client creates on launch (`lib/notifications/push.ts`
  // ANDROID_CHANNEL_ID) and the expo-notifications plugin declares as the FCM
  // default. Ignored by iOS. Naming it explicitly keeps delivery predictable —
  // API 26+ drops notifications routed to a channel that does not exist.
  const messages: ExpoPushMessage[] = valid.map((device) => ({
    to:        device.expo_push_token,
    sound:     'default',
    channelId: 'default',
    title:     payload.title,
    body:      payload.body,
    data: {
      action_url: payload.action_url,
      type:       payload.notification_type,
      ...(payload.notification_id ? { notification_id: payload.notification_id } : {}),
    },
  }));

  const deadTokens: string[] = [];

  for (const chunk of expo.chunkPushNotifications(messages)) {
    const tickets = await expo.sendPushNotificationsAsync(chunk);
    tickets.forEach((ticket, index) => {
      if (ticket.status !== 'error') return;
      const token = chunk[index]?.to;
      if (ticket.details?.error === 'DeviceNotRegistered' && typeof token === 'string') {
        deadTokens.push(token);
      } else {
        logger.warn(
          { jobId: job.id, error: ticket.details?.error, message: ticket.message },
          'Push ticket error',
        );
      }
    });
  }

  if (deadTokens.length > 0) {
    await prisma.devicePushToken.deleteMany({
      where: { expo_push_token: { in: deadTokens } },
    });
    logger.info({ count: deadTokens.length }, 'Pruned unregistered push tokens');
  }
}

// ─── Worker ────────────────────────────────────────────────────────────────────

export function startPushWorker() {
  const worker = new Worker<PushJob>(
    'push',
    processPushJob,
    {
      connection:  { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' },
      concurrency: 10,
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Push job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Push job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Push worker error');
  });

  return worker;
}
