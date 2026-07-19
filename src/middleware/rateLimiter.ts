import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '@config/redis';
import type { Request } from 'express';
import { RATE_LIMIT } from '@config/constants';

// ─── Redis store factory ───────────────────────────────────────────────────────

function createRedisStore(prefix: string) {
  return new RedisStore({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCommand: (...args: string[]): any => redis.call(args[0], ...args.slice(1)),
    prefix: `rl:${prefix}:`,
  });
}

// ─── Global rate limiter (all endpoints) ──────────────────────────────────────

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMIT.GLOBAL_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: createRedisStore('global'),
  message: {
    success: false,
    data: null,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
  },
});

// ─── OTP request limiter (per email, 15 min window) ───────────────────────────

export const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: RATE_LIMIT.OTP_PER_EMAIL_15MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: createRedisStore('otp_request'),
  // Key by email, not IP, so OTP rate limit is per-email
  keyGenerator: (req: Request) => {
    const email = (req.body as { email?: string }).email ?? req.ip ?? 'unknown';
    return `otp:${email}`;
  },
  message: {
    success: false,
    data: null,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many OTP requests for this email. Try again in 15 minutes.',
    },
  },
});

// ─── OTP verify limiter (per IP, 30 min window) ───────────────────────────────

export const otpVerifyLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 minutes
  max: RATE_LIMIT.VERIFY_OTP_PER_IP_30MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: createRedisStore('otp_verify'),
  message: {
    success: false,
    data: null,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many OTP verification attempts. Try again in 30 minutes.',
    },
  },
});

// ─── Google OAuth limiter (per IP, 1 min window) ──────────────────────────────

export const googleAuthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMIT.GOOGLE_AUTH_PER_IP_1MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: createRedisStore('google_auth'),
  message: {
    success: false,
    data: null,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many Google auth attempts. Please wait a moment.',
    },
  },
});

// ─── Strict API limiter for sensitive endpoints ────────────────────────────────

export const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: createRedisStore('strict'),
  message: {
    success: false,
    data: null,
    error: { code: 'RATE_LIMITED', message: 'Too many requests to this endpoint.' },
  },
});
