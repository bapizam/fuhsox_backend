import { Queue } from 'bullmq';
import { env } from '@config/env';
import type { EmailJob, AIJob, PDFJob, AnalyticsJob, PushJob } from '@typings/jobs';

// BullMQ 5.x accepts RedisOptions (not a raw Redis instance) for connection.
// Using the URL string approach which is the most portable.
const connection = { url: env.REDIS_URL };

const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail:     { count: 500 },
  attempts:         3,
  backoff: {
    type:  'exponential' as const,
    delay: 2000,
  },
};

// ─── Queue Definitions ─────────────────────────────────────────────────────────

export const emailQueue = new Queue<EmailJob>('email', {
  connection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5, // More retries for email (SES transient errors)
  },
});

export const aiQueue = new Queue<AIJob>('ai', {
  connection,
  defaultJobOptions,
});

export const analyticsQueue = new Queue<AnalyticsJob>('analytics', {
  connection,
  defaultJobOptions,
});

export const pdfQueue = new Queue<PDFJob>('pdf', {
  connection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 2, // PDF parsing is expensive — limit retries
  },
});

export const pushQueue = new Queue<PushJob>('push', {
  connection,
  defaultJobOptions,
});

// ─── Queue Health Check ────────────────────────────────────────────────────────

export async function getQueueStats() {
  const [emailCounts, aiCounts, pdfCounts, pushCounts] = await Promise.all([
    emailQueue.getJobCounts(),
    aiQueue.getJobCounts(),
    pdfQueue.getJobCounts(),
    pushQueue.getJobCounts(),
  ]);

  return { email: emailCounts, ai: aiCounts, pdf: pdfCounts, push: pushCounts };
}

export const queues = { emailQueue, aiQueue, analyticsQueue, pdfQueue, pushQueue };
