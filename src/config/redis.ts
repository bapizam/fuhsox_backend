import Redis from 'ioredis';
import { env } from './env';
import logger from '@lib/logger';

const globalForRedis = globalThis as unknown as { redis?: Redis };

function createRedisClient(): Redis {
  const isTest = process.env['NODE_ENV'] === 'test';

  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: isTest ? 0    : 3,
    enableReadyCheck:     false,         // Required for BullMQ
    lazyConnect:          isTest ? true  : false,
    retryStrategy: (times: number) => {
      if (times > 10) {
        logger.error('Redis: Maximum retries reached. Giving up.');
        return null;
      }
      const delay = Math.min(times * 200, 2000);
      logger.warn(`Redis: Retrying connection in ${delay}ms (attempt ${times})`);
      return delay;
    },
  });

  client.on('connect', () => logger.info('✅ Redis connected'));
  client.on('ready', () => logger.info('✅ Redis ready'));
  client.on('error', (err) => logger.error({ err }, 'Redis error'));
  client.on('close', () => logger.warn('Redis connection closed'));
  client.on('reconnecting', () => logger.warn('Redis reconnecting...'));

  return client;
}

export const redis: Redis = globalForRedis.redis ?? createRedisClient();

if (env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}

export default redis;
