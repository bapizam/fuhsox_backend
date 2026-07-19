/**
 * Local type definitions that mirror the Prisma schema.
 *
 * These are defined here instead of re-exporting from @prisma/client because
 * the Prisma client requires `prisma generate` to produce its types, which
 * cannot run in an offline CI/build environment. In production, run
 * `npm run db:generate` before `npm run build` and these types will be
 * supplemented/overridden by the generated client.
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export type Role           = 'student' | 'admin' | 'superadmin';
export type AuthProvider   = 'email_otp' | 'google' | 'apple';
export type OTPPurpose     = 'registration' | 'login' | 'password_reset';
export type QuestionType   = 'mcq' | 'short_answer' | 'essay';
export type Difficulty     = 'easy' | 'medium' | 'hard';
export type QuestionStatus = 'draft' | 'review' | 'published' | 'archived';
export type QuestionSource = 'manual' | 'pdf_upload' | 'csv_upload' | 'ai_generated';
export type SessionMode    = 'practice' | 'exam' | 'review';
export type ConnectionStatus = 'pending' | 'accepted' | 'declined' | 'blocked';
export type NotificationType = 'event' | 'reminder' | 'social' | 'broadcast' | 'system';
export type TargetAudience = 'all' | 'faculty' | 'department';
export type ReminderFrequency = 'daily' | 'every_2_days' | 'weekly';
export type AIFeature      = 'question_generation' | 'quiz_feedback' | 'study_plan';

// ─── Model Interfaces ─────────────────────────────────────────────────────────

export interface Institution {
  id:            string;
  name:          string;
  slug:          string;
  email_domains: string[];
  logo_url:      string | null;
  primary_color: string;
  timezone:      string;
  ai_daily_limit: number;
  created_at:    Date;
}

export interface User {
  id:               string;
  institution_id:   string;
  email:            string;
  full_name:        string | null;
  faculty:          string | null;
  department:       string | null;
  avatar_url:       string | null;
  bio:              string | null;
  role:             Role;
  study_interests:  string[];
  xp_points:        number;
  streak_count:     number;
  last_active_at:   Date;
  last_streak_date: Date | null;
  email_verified:   boolean;
  auth_provider:    AuthProvider;
  google_id:        string | null;
  password_hash:    string | null;
  risk_flag:        boolean;
  risk_reason:      string | null;
  created_at:       Date;
  updated_at:       Date;
}

export interface OTPRequest {
  id:           string;
  user_id:      string | null;
  email:        string;
  otp_hash:     string;
  purpose:      OTPPurpose;
  attempts:     number;
  locked_until: Date | null;
  expires_at:   Date;
  used_at:      Date | null;
  created_at:   Date;
}

export interface RefreshToken {
  id:          string;
  user_id:     string;
  token_hash:  string;
  expires_at:  Date;
  created_at:  Date;
  revoked_at:  Date | null;
}

export interface Question {
  id:             string;
  institution_id: string;
  course_code:    string;
  course_name:    string;
  faculty:        string;
  department:     string | null;
  year:           number;
  topic:          string;
  question_text:  string;
  question_type:  QuestionType;
  options:        unknown;
  correct_answer: string;
  explanation:    string | null;
  difficulty:     Difficulty;
  status:         QuestionStatus;
  source:         QuestionSource;
  created_by:     string | null;
  ai_job_id:      string | null;
  created_at:     Date;
  updated_at:     Date;
}

export interface QuizSession {
  id:              string;
  user_id:         string;
  institution_id:  string;
  mode:            SessionMode;
  question_source: QuestionSource;
  total_questions: number;
  score_percent:   number | null;
  correct_count:   number | null;
  time_taken_secs: number | null;
  started_at:      Date;
  completed_at:    Date | null;
  question_ids:    string[];
}

export interface SessionAnswer {
  id:             string;
  session_id:     string;
  question_id:    string;
  chosen_answer:  string;
  is_correct:     boolean;
  time_taken_ms:  number;
  ai_feedback_id: string | null;
  answered_at:    Date;
}

export interface Bookmark {
  id:          string;
  user_id:     string;
  question_id: string;
  created_at:  Date;
}

export interface Connection {
  id:          string;
  sender_id:   string;
  receiver_id: string;
  status:      ConnectionStatus;
  created_at:  Date;
  updated_at:  Date;
}

export interface StudySchedule {
  id:                  string;
  user_id:             string;
  institution_id:      string;
  subject:             string;
  study_days:          number[];
  preferred_time_start: string;
  preferred_time_end:   string;
  exam_date:           Date;
  is_active:           boolean;
  sessions_planned:    number;
  sessions_completed:  number;
  created_at:          Date;
  updated_at:          Date;
}

export interface Notification {
  id:         string;
  user_id:    string;
  type:       NotificationType;
  title:      string;
  body:       string;
  action_url: string;
  is_read:    boolean;
  created_at: Date;
}

export interface Badge {
  id:          string;
  code:        string;
  name:        string;
  description: string;
  icon_url:    string;
  xp_award:    number;
}

export interface UserBadge {
  id:         string;
  user_id:    string;
  badge_id:   string;
  awarded_at: Date;
}

export interface Event {
  id:              string;
  institution_id:  string;
  created_by:      string;
  title:           string;
  description:     string;
  event_date:      Date;
  location:        string | null;
  target_audience: TargetAudience;
  target_value:    string | null;
  attachment_url:  string | null;
  cover_image_url: string | null;
  is_urgent:       boolean;
  status:          'draft' | 'scheduled' | 'published' | 'cancelled';
  scheduled_for:   Date | null;
  published_at:    Date | null;
  created_at:      Date;
  updated_at:      Date;
}

export interface NewsArticle {
  id:              string;
  institution_id:  string;
  created_by:      string;
  title:           string;
  category:        string;
  cover_image_url: string | null;
  html_body:       string;
  is_pinned:       boolean;
  published_at:    Date | null;
  scheduled_for:   Date | null;
  status:          'draft' | 'scheduled' | 'published';
  created_at:      Date;
  updated_at:      Date;
}

export interface NotificationPref {
  id:                 string;
  user_id:            string;
  opt_out_reminders:  boolean;
  quiet_hours_start:  string | null;
  quiet_hours_end:    string | null;
  reminder_frequency: ReminderFrequency;
  updated_at:         Date;
}

// ─── JWT Payload ───────────────────────────────────────────────────────────────

export interface JWTPayload {
  sub:            string;
  role:           string;
  institution_id: string;
  iat?:           number;
  exp?:           number;
}

// ─── API Response Helpers ──────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    total:      number;
    page:       number;
    limit:      number;
    hasMore:    boolean;
    totalPages: number;
  };
}

export interface AuthTokens {
  accessToken: string;
  // Present only for mobile clients (client_type: "mobile"); web uses an HttpOnly cookie.
  refreshToken?: string;
}

export type SafeUser = Omit<User, 'password_hash' | 'google_id'>;

export interface AuthResult extends AuthTokens {
  user:        SafeUser;
  institution: Institution;
  // Drives the mobile onboarding-vs-home routing decision (SRS §7.1 step 4).
  is_new_user: boolean;
}

// ─── Question Helpers ──────────────────────────────────────────────────────────

export interface QuestionWithBookmark extends Question {
  is_bookmarked: boolean;
}

export interface GeneratedQuestion {
  question_text:  string;
  options?:       Array<{ key: string; text: string }>;
  correct_answer: string;
  explanation?:   string;
  quality_flag:   'good' | 'flagged';
}

export interface AIGenerationResult {
  questions:       GeneratedQuestion[];
  daily_remaining: number;
}

// ─── Gamification ─────────────────────────────────────────────────────────────

export interface BadgeWithDetails extends Badge {
  awarded_at?: Date;
}

export interface SessionCompleteResult {
  score_percent:   number;
  correct_count:   number;
  total_questions: number;
  time_taken_secs: number;
  xp_earned:       number;
  badges_earned:   BadgeWithDetails[];
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank:         number;
  user_id:      string;
  full_name:    string | null;
  avatar_url:   string | null;
  faculty:      string | null;
  department:   string | null;
  xp_points:    number;
  streak_count: number;
  badge_count:  number;
}

// ─── Notifications ─────────────────────────────────────────────────────────────

export interface CreateNotificationInput {
  user_id:    string;
  type:       NotificationType;
  title:      string;
  body:       string;
  action_url: string;
}

// ─── Error Class ───────────────────────────────────────────────────────────────

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code:       string,
    message:                    string,
    public readonly details?:   unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// ─── Peer Discovery ────────────────────────────────────────────────────────────

export interface DiscoverFilter {
  faculty?:  string;
  interest?: string;
  page:      number;
  limit:     number;
  sort:      'best_match' | 'most_active' | 'recent';
}
