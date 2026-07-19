// ─── Email Queue Jobs ──────────────────────────────────────────────────────────
export interface OTPEmailJob {
  type: 'otp';
  to: string;
  subject: string;
  template: 'otp';
  data: {
    otp_code: string;
    expiry_minutes: number;
    institution_name: string;
  };
}

export interface EventNotificationEmailJob {
  type: 'event_notification';
  to: string;
  subject: string;
  template: 'event-notification';
  data: {
    user_name: string;
    event_title: string;
    event_date: string;
    event_location: string;
    event_description: string;
    is_urgent: boolean;
    cta_link: string;
    institution_name: string;
  };
  delivery_id?: string;
}

export interface StudyReminderEmailJob {
  type: 'study_reminder';
  to: string;
  subject: string;
  template: 'study-reminder';
  data: {
    user_name: string;
    subject: string;
    time: string;
    quiz_link: string;
    streak_count: number;
    institution_name: string;
  };
}

export interface ExamCountdownEmailJob {
  type: 'exam_countdown';
  to: string;
  subject: string;
  template: 'exam-countdown';
  data: {
    user_name: string;
    subject: string;
    days_remaining: number;
    exam_date: string;
    quiz_link: string;
    institution_name: string;
  };
}

export interface ReEngagementEmailJob {
  type: 're_engagement';
  to: string;
  subject: string;
  template: 're-engagement';
  data: {
    user_name: string;
    trending_topic?: string;
    cta_link: string;
    institution_name: string;
  };
}

export interface BroadcastEmailJob {
  type: 'broadcast';
  to: string;
  subject: string;
  template: 'broadcast';
  data: {
    user_name: string;
    html_body: string;
    institution_name: string;
  };
  delivery_id?: string;
}

export interface PasswordResetEmailJob {
  type: 'password_reset';
  to: string;
  subject: string;
  template: 'password-reset';
  data: {
    user_name: string;
    reset_link: string;
    expiry_minutes: number;
    institution_name: string;
  };
}

export type EmailJob =
  | OTPEmailJob
  | EventNotificationEmailJob
  | StudyReminderEmailJob
  | ExamCountdownEmailJob
  | ReEngagementEmailJob
  | BroadcastEmailJob
  | PasswordResetEmailJob;

// ─── AI Queue Jobs ─────────────────────────────────────────────────────────────
export interface AIQuestionBatchJob {
  type: 'generate_batch';
  institution_id: string;
  requested_by: string;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
  count: number;
}

export type AIJob = AIQuestionBatchJob;

// ─── PDF Queue Jobs ────────────────────────────────────────────────────────────
export interface PDFParseJob {
  job_id: string;
  file_url: string;
  institution_id: string;
  created_by: string;
}

export type PDFJob = PDFParseJob;

// ─── Analytics Queue Jobs ──────────────────────────────────────────────────────
export interface AnalyticsAggregateJob {
  type: 'aggregate_daily';
  institution_id: string;
  date: string;
}

export type AnalyticsJob = AnalyticsAggregateJob;

// ─── Push Queue Jobs (M5) ──────────────────────────────────────────────────────
// One job per recipient — enqueued by notification.service so every existing
// fan-out point (connections, badges, feed likes/comments, events, reminders)
// gets a push for free. The worker resolves the user's device tokens itself.
export interface PushNotificationJob {
  type: 'notification';
  user_id: string;
  /** Absent for bulk-created notifications (createMany returns no rows). */
  notification_id?: string;
  notification_type: string;
  title: string;
  body: string;
  action_url: string;
}

export type PushJob = PushNotificationJob;
