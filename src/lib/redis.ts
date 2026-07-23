import { redis } from '@config/redis';

/**
 * Get a value from Redis. Returns null if the key does not exist.
 */
export async function get(key: string): Promise<string | null> {
  return redis.get(key);
}

/**
 * Set a value in Redis with an optional TTL in seconds.
 */
export async function set(key: string, value: string, ttlSeconds?: number): Promise<void> {
  if (ttlSeconds !== undefined) {
    await redis.set(key, value, 'EX', ttlSeconds);
  } else {
    await redis.set(key, value);
  }
}

/**
 * Delete one or more keys from Redis.
 */
export async function del(...keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  return redis.del(...keys);
}

/**
 * Delete every key matching a glob pattern. Returns how many were removed.
 *
 * SCAN rather than KEYS: KEYS walks the entire keyspace in a single blocking call,
 * stalling every other client for its duration — and this runs on account deletion,
 * where the per-user keys it targets (`ai_daily:<id>:*`) are a handful of entries
 * scattered through a keyspace shared with sessions, queues and rate limits.
 */
export async function delByPattern(pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) deleted += await redis.del(...keys);
  } while (cursor !== '0');

  return deleted;
}

/**
 * Increment a counter in Redis and set an expiry on first creation.
 * Returns the new value after increment.
 */
export async function incrWithExpiry(key: string, ttlSeconds: number): Promise<number> {
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.expire(key, ttlSeconds);
  const results = await pipeline.exec();
  const incrResult = results?.[0];
  if (!incrResult) return 0;
  return (incrResult[1] as number) ?? 0;
}

/**
 * Get the remaining TTL of a key in seconds. Returns -1 if no TTL, -2 if key missing.
 */
export async function ttl(key: string): Promise<number> {
  return redis.ttl(key);
}

/**
 * Check if a key exists in Redis.
 */
export async function exists(key: string): Promise<boolean> {
  const count = await redis.exists(key);
  return count === 1;
}

/**
 * Get the current value as a number (for counters). Returns 0 if key doesn't exist.
 */
export async function getCount(key: string): Promise<number> {
  const val = await redis.get(key);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Get end-of-day TTL in seconds for Africa/Lagos timezone.
 * Used for daily AI rate limiting.
 */
export function getEndOfDayTTL(): number {
  const now = new Date();
  // WAT = UTC+1
  const watNow = new Date(now.getTime() + 60 * 60 * 1000);
  const endOfDayWAT = new Date(watNow);
  endOfDayWAT.setHours(23, 59, 59, 999);
  const secondsLeft = Math.floor((endOfDayWAT.getTime() - watNow.getTime()) / 1000);
  return Math.max(secondsLeft, 1);
}

/**
 * Get today's date string in WAT (YYYY-MM-DD format) for AI daily keys.
 */
export function getTodayWAT(): string {
  const now = new Date();
  const watNow = new Date(now.getTime() + 60 * 60 * 1000);
  return watNow.toISOString().split('T')[0];
}

export { redis };
