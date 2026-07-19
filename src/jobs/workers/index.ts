import { connectDatabases } from '@config/database';
import { startEmailWorker } from './email.worker';
import { startPDFWorker } from './pdf.worker';
import { startPushWorker } from './push.worker';
import logger from '@lib/logger';

/**
 * Worker entry point — can be run independently from the main API server.
 * Handles: email delivery, PDF question parsing, push notification fan-out.
 *
 * Run with: npm run workers:start
 */
async function startWorkers() {
  logger.info('Starting background workers...');

  // Connect databases
  await connectDatabases();

  // Start workers
  const emailWorker = startEmailWorker();
  const pdfWorker   = startPDFWorker();
  const pushWorker  = startPushWorker();

  logger.info('✅ All background workers started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down workers...');
    await Promise.all([
      emailWorker.close(),
      pdfWorker.close(),
      pushWorker.close(),
    ]);
    logger.info('Workers stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}

startWorkers().catch((err) => {
  logger.error({ err }, 'Worker startup failed');
  process.exit(1);
});
