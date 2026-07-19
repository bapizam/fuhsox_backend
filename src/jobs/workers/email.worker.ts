import { Worker, type Job } from 'bullmq';
import { renderEmailTemplate, sendEmail } from '@services/email.service';
import prisma from '@config/database';
import type { EmailJob } from '@typings/jobs';
import logger from '@lib/logger';

export function startEmailWorker() {
  const worker = new Worker<EmailJob>(
    'email',
    async (job: Job<EmailJob>) => {
      const payload = job.data;

      logger.info({ jobId: job.id, type: payload.type, to: payload.to }, 'Processing email job');

      // 1. Render HTML from Handlebars template
      const html = await renderEmailTemplate(payload.template, payload.data);

      // 2. Send via SES (production) or Nodemailer (dev)
      await sendEmail({ to: payload.to, subject: payload.subject, html });

      // 3. Update EmailDelivery record if delivery_id is present
      if ('delivery_id' in payload && payload.delivery_id) {
        await prisma.emailDelivery.update({
          where: { id: payload.delivery_id },
          data:  { status: 'sent', sent_at: new Date() },
        });
      }

      logger.info({ jobId: job.id, to: payload.to }, 'Email sent successfully');
    },
    {
      connection:  { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' },
      concurrency: 10,
    },
  );

  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Email job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Email job failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Email worker error');
  });

  return worker;
}
