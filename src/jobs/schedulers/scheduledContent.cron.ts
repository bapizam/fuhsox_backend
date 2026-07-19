import cron from 'node-cron';
import { eventService } from '@services/admin/event.service';
import { newsService } from '@services/admin/news.service';
import logger from '@lib/logger';

/**
 * Scheduled Content Cron
 * Runs every 5 minutes. Checks for events and news articles whose
 * `scheduled_for` timestamp has arrived and auto-publishes them.
 *
 * This ensures admins can schedule content in advance without
 * manual intervention at publish time.
 */
async function runScheduledContentJob(): Promise<void> {
  const [eventsPublished, articlesPublished] = await Promise.all([
    eventService.processScheduledEvents(),
    newsService.processScheduledArticles(),
  ]);

  if (eventsPublished > 0 || articlesPublished > 0) {
    logger.info(
      { eventsPublished, articlesPublished },
      'Scheduled content auto-published',
    );
  }
}

export function startScheduledContentCron() {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    runScheduledContentJob().catch((err) => {
      logger.error({ err }, 'Scheduled content cron crashed');
    });
  });

  logger.info('Scheduled content cron registered (every 5 min)');
}

export { runScheduledContentJob };
