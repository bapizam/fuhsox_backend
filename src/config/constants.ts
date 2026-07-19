// ─── Auth Constants ────────────────────────────────────────────────────────────
export const OTP_EXPIRY_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LOCKOUT_MINUTES = 30;
export const OTP_LENGTH = 6;

// ─── Token Constants ───────────────────────────────────────────────────────────
export const REFRESH_TOKEN_BYTES = 64;
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 min
export const REFRESH_TOKEN_TTL_DAYS = 30;

// ─── Rate Limiting ─────────────────────────────────────────────────────────────
export const RATE_LIMIT = {
  GLOBAL_PER_MINUTE: 100,
  OTP_PER_EMAIL_15MIN: 3,
  VERIFY_OTP_PER_IP_30MIN: 10,
  GOOGLE_AUTH_PER_IP_1MIN: 10,
  AI_DAILY_PER_USER: 20, // Shared budget: generation + study plan + quiz feedback. Overridden by institution.ai_daily_limit
} as const;

// ─── XP / Gamification ────────────────────────────────────────────────────────
export const XP = {
  PER_CORRECT_ANSWER: 10,
  PERFECT_SCORE_BONUS: 50,
  PER_AI_QUESTION: 5,
  BADGE_STREAK_7: 100,
  BADGE_STREAK_30: 500,
  BADGE_ACCURACY_90: 150,
  BADGE_QUIZ_MASTER_50: 300,
  BADGE_PERFECT_SCORE: 200,
  BADGE_FIRST_QUIZ: 50,
} as const;

// ─── Redis Key Patterns ────────────────────────────────────────────────────────
export const REDIS_KEYS = {
  OTP_RATE: (email: string) => `otp:${email}`,
  AI_DAILY: (userId: string, date: string) => `ai_daily:${userId}:${date}`,
  LEADERBOARD: (instId: string, scope: string, val?: string) =>
    `leaderboard:${instId}:${scope}${val ? `:${val}` : ''}`,
  ANALYTICS_OVERVIEW: (instId: string) => `analytics:overview:${instId}`,
  LAST_REMINDER: (userId: string, scheduleId: string) => `last_reminder:${userId}:${scheduleId}`,
  RE_ENGAGEMENT: (userId: string) => `re_engagement:${userId}`,
  PASSWORD_RESET: (token: string) => `pwd_reset:${token}`,
  REPORT_COUNT: (postId: string) => `post_reports:${postId}`,
  SCHEDULE_CHECKIN: (scheduleId: string, date: string) => `schedule_checkin:${scheduleId}:${date}`,
} as const;

// ─── Cache TTLs (seconds) ──────────────────────────────────────────────────────
export const TTL = {
  LEADERBOARD: 10 * 60,         // 10 minutes
  ANALYTICS_OVERVIEW: 5 * 60,   // 5 minutes
  LAST_REMINDER: 7 * 86400,     // 7 days
  RE_ENGAGEMENT: 7 * 86400,     // 7 days
  PASSWORD_RESET: 60 * 60,      // 1 hour
} as const;

// ─── Pagination Defaults ───────────────────────────────────────────────────────
export const PAGINATION = {
  DEFAULT_LIMIT: 12,
  MAX_LIMIT: 100,
} as const;

// ─── File Upload Limits ────────────────────────────────────────────────────────
export const UPLOAD = {
  AVATAR_MAX_BYTES: 2 * 1024 * 1024, // 2 MB
  PDF_MAX_BYTES: 50 * 1024 * 1024,   // 50 MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as string[],
  ALLOWED_DOC_TYPES: ['application/pdf', 'text/csv', 'application/json'] as string[],
} as const;

// ─── Email Batch Size ──────────────────────────────────────────────────────────
export const EMAIL_BATCH_SIZE = 500;

// ─── Risk Flagging Thresholds ──────────────────────────────────────────────────
export const RISK = {
  INACTIVE_DAYS: 8,
  ACCURACY_DROP_THRESHOLD: 0.25,
  RE_ENGAGEMENT_INACTIVE_DAYS: 14,
} as const;

// ─── Cron Schedules (UTC) ──────────────────────────────────────────────────────
export const CRON = {
  STUDY_REMINDER: '0 17 * * *',  // 5 PM UTC = 6 PM WAT
  RISK_FLAG:      '0 1 * * *',   // 1 AM UTC = 2 AM WAT
  ANALYTICS:      '0 0 * * *',   // Midnight UTC
} as const;

// ─── Timezone ──────────────────────────────────────────────────────────────────
export const TIMEZONE = 'Africa/Lagos';

// ─── AI Models ─────────────────────────────────────────────────────────────────
export const AI_MODELS = {
  QUESTION_GENERATION: 'claude-opus-4-6',
  QUIZ_FEEDBACK:       'claude-opus-4-6',
  STUDY_PLAN:          'claude-opus-4-6',
  PDF_PARSE:           'claude-opus-4-6',
} as const;

// ─── Post Report Threshold (notify admin) ─────────────────────────────────────
export const POST_REPORT_THRESHOLD = 3;

// ─── Leaderboard ──────────────────────────────────────────────────────────────
export const LEADERBOARD_DEFAULT_LIMIT = 50;
