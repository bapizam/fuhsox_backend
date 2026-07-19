import 'dotenv/config';

import http from 'http';
import type { Worker } from 'bullmq';
import app from './app';
import { env } from '@config/env';
import { connectDatabases, disconnectDatabases } from '@config/database';
import { initSocketServer } from '@socket/socket.server';
import { startEmailWorker } from '@jobs/workers/email.worker';
import { startPDFWorker } from '@jobs/workers/pdf.worker';
import { startStudyReminderCron } from '@jobs/schedulers/studyReminder.cron';
import { startRiskFlagCron } from '@jobs/schedulers/riskFlag.cron';
import { startScheduledContentCron } from '@jobs/schedulers/scheduledContent.cron';
import logger from '@lib/logger';

// ─── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap() {
  logger.info('🚀 Booting FuhsoX API...');

  // 1. Connect to PostgreSQL, MongoDB
  await connectDatabases();

  // 2. Create HTTP server from Express app
  const httpServer = http.createServer(app);

  // 3. Attach Socket.io real-time layer to the HTTP server
  initSocketServer(httpServer);

  // 4. Start background workers and cron schedulers
  //    (skipped in test environment — each test controls its own mocks)
  const workers: Worker[] = [];

  if (env.NODE_ENV !== 'test') {
    workers.push(startEmailWorker());
    workers.push(startPDFWorker());

    startStudyReminderCron();
    startRiskFlagCron();
    startScheduledContentCron();
  }

  // 5. Begin accepting connections
  await new Promise<void>((resolve) => {
    httpServer.listen(env.PORT, "0.0.0.0", resolve);
  });

  logger.info(`✅ FuhsoX API listening on port ${env.PORT} [${env.NODE_ENV}]`);

  // 6. Graceful shutdown handler (sync — Node's signal/close callbacks expect
  // void, so the async teardown runs in an explicitly-voided IIFE)
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Graceful shutdown initiated...');

    // Stop accepting new HTTP connections
    httpServer.close(() => {
      logger.info('HTTP server closed');

      void (async () => {
        // Drain and close BullMQ workers
        await Promise.all(workers.map((w) => w.close()));
        if (workers.length) logger.info('BullMQ workers stopped');

        // Disconnect databases
        await disconnectDatabases();

        logger.info('Shutdown complete ✅');
        process.exit(0);
      })();
    });

    // Force-kill if graceful shutdown takes longer than 30 s
    setTimeout(() => {
      logger.error('Forced shutdown after 30-second timeout');
      process.exit(1);
    }, 30_000).unref(); // .unref() prevents the timer keeping the process alive on its own
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  // Log unhandled rejections — Sentry captures them; we keep the process alive
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '⚠️  Unhandled Promise Rejection');
  });

  // Uncaught exceptions are fatal — log and exit cleanly
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '💥 Uncaught Exception — shutting down');
    process.exit(1);
  });

  return httpServer;
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Bootstrap failed');
  process.exit(1);
});