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
  /** Failover calls today — project-wide, deliberately not keyed by user. */
  AI_FALLBACK_DAILY: (date: string) => `ai_fallback_daily:${date}`,
  LEADERBOARD: (instId: string, scope: string, val?: string) =>
    `leaderboard:${instId}:${scope}${val ? `:${val}` : ''}`,
  ANALYTICS_OVERVIEW: (instId: string) => `analytics:overview:${instId}`,
  LAST_REMINDER: (userId: string, scheduleId: string) => `last_reminder:${userId}:${scheduleId}`,
  RE_ENGAGEMENT: (userId: string) => `re_engagement:${userId}`,
  PASSWORD_RESET: (token: string) => `pwd_reset:${token}`,
  REPORT_COUNT: (postId: string) => `post_reports:${postId}`,
  SCHEDULE_CHECKIN: (scheduleId: string, date: string) => `schedule_checkin:${scheduleId}:${date}`,
  /** Mastery-check attempts started today, per objective (anti-grind cap). */
  MASTERY_ATTEMPTS: (objectiveId: string, date: string) => `mastery_attempts:${objectiveId}:${date}`,
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

// ─── Adaptive Mastery Checks (M7 item 4) ───────────────────────────────────────
export const MASTERY_CHECK = {
  /**
   * Questions per assessment. At 8, a single miss is 87.5% — a genuine near-miss
   * against a 90% bar rather than an all-or-nothing coin flip. At 5 questions, 90%
   * would silently mean "perfect score required".
   */
  QUESTION_COUNT: 8,
  /**
   * Questions generated and cached per objective on FIRST use. Drawing 8 from 16
   * keeps repeat attempts from being the same paper twice while costing ONE
   * generation call to seed the objective.
   */
  POOL_SIZE: 16,
  /**
   * Items added when a student has exhausted the unseen part of a pool
   * (reformation Phase 2). A fixed 16-item pool meant a motivated student could
   * memorize it across days — the daily cap throttles grinding per day, not over
   * time. Growth is lazy: it costs a call only once the student has earned it.
   */
  GROWTH_BATCH: 8,
  /**
   * Ceiling on a single objective's pool. Growth has to stop somewhere or a
   * determined student could mint AI calls indefinitely against one objective;
   * 40 items is roughly five non-overlapping papers, well past the point where
   * memorization is a cheaper strategy than learning.
   */
  MAX_POOL_SIZE: 40,
  /**
   * Attempts per objective per day. Enough to genuinely retry after revising, few
   * enough that brute-forcing the pool isn't a strategy — otherwise "verified"
   * degrades into "kept trying until it passed", which is the exact failure this
   * milestone exists to fix.
   */
  MAX_ATTEMPTS_PER_DAY: 3,
  /**
   * Bloom mix for one assessment, summing to QUESTION_COUNT. Recall alone cannot
   * demonstrate understanding, so every assessment reaches into application.
   */
  BLOOM_MIX: [
    { level: 'remember', count: 2, difficulty: 'easy' },
    { level: 'understand', count: 2, difficulty: 'medium' },
    { level: 'apply', count: 2, difficulty: 'medium' },
    { level: 'analyze', count: 2, difficulty: 'hard' },
  ],
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
  // Hourly at :00 UTC. The job itself matches each schedule's preferred start
  // HOUR (in WAT) so a student is reminded around their own study time, not a
  // fixed 6 PM for everyone. The per-day frequency guard stops the other 23
  // hourly runs from re-sending.
  STUDY_REMINDER: '0 * * * *',
  RISK_FLAG:      '0 1 * * *',   // 1 AM UTC = 2 AM WAT
  ANALYTICS:      '0 0 * * *',   // Midnight UTC
} as const;

/** West Africa Time is UTC+1 year-round (no DST). */
export const WAT_OFFSET_MINUTES = 60;

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
