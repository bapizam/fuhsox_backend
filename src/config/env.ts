import { z } from 'zod';

const envSchema = z.object({

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url(),

  DATABASE_URL: z.string().url(),

  MONGODB_URI: z.string().min(1),

  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),

  // Native Google Sign-In (mobile). Google issues the id_token with the *native*
  // client as the audience, so the web GOOGLE_CLIENT_ID alone cannot verify it.
  // Optional: unset simply means native Google is not enabled on this deployment.
  GOOGLE_IOS_CLIENT_ID: z.string().optional(),
  GOOGLE_ANDROID_CLIENT_ID: z.string().optional(),

  // Apple Sign-In (mobile). Optional so the server still boots without it configured;
  // POST /auth/apple returns a clear error at request time if unset.
  APPLE_CLIENT_ID: z.string().optional(),

  AI_PROVIDER:  z.enum(['claude', 'gemini']).default('gemini'),

  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-', 'ANTHROPIC_API_KEY must start with sk-ant-'),
  AI_DAILY_QUESTION_LIMIT: z.coerce.number().int().positive().default(20),

  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().default('af-south-1'),
  AWS_S3_BUCKET: z.string().min(1),
  AWS_SES_FROM_EMAIL: z.string().email(),

  // ─── Object storage (avatars, PDFs) ────────────────────────────────────────
  // The storage layer speaks plain S3, so ANY S3-compatible provider works —
  // Supabase Storage, Cloudflare R2, Backblaze B2, MinIO — not just AWS.
  //
  // Every var below is optional and falls back to the matching AWS_* above, so
  // existing AWS deployments are unaffected by their absence. They exist as
  // separate names because AWS_ACCESS_KEY_ID/_SECRET are ALSO consumed by SES in
  // email.service.ts: pointing storage at Supabase must not silently re-credential
  // the mailer.
  //
  // Supabase example:
  //   STORAGE_ENDPOINT=https://<project-ref>.supabase.co/storage/v1/s3
  //   STORAGE_PUBLIC_BASE_URL=https://<project-ref>.supabase.co/storage/v1/object/public/<bucket>
  //   STORAGE_REGION=<project region, e.g. eu-west-2>
  //   STORAGE_BUCKET=fuhsox
  //   STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY  (Storage → S3 access keys)
  //
  // Setting STORAGE_ENDPOINT also switches the client to path-style addressing,
  // which every non-AWS provider requires.
  STORAGE_ENDPOINT: z.string().url().optional(),
  // Public URL prefix a stored object is served from, WITHOUT a trailing slash.
  // Required whenever STORAGE_ENDPOINT is set: the S3 API endpoint and the public
  // read URL are different hosts on most providers, so it cannot be derived.
  STORAGE_PUBLIC_BASE_URL: z.string().url().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),

  // Which transport `sendEmail` uses. Unset keeps the historical behaviour —
  // SES in production, SMTP everywhere else — so existing deployments are
  // unaffected. Set it explicitly to run one provider from the other's
  // environment (e.g. MAIL_PROVIDER=brevo on Render to test without SES).
  //   ses    — AWS SES over the SDK (HTTPS:443)
  //   brevo  — Brevo transactional API (HTTPS:443)
  //   resend — Resend transactional API (HTTPS:443)
  //   smtp   — nodemailer (MailHog or Gmail locally)
  // NOTE: Render's free web services block outbound SMTP (ports 25/465/587), so
  // 'smtp' times out when deployed. All three HTTPS providers work there.
  MAIL_PROVIDER: z.enum(['ses', 'brevo', 'resend', 'smtp']).optional(),

  // Brevo REST key for MAIL_PROVIDER=brevo. This is the *API* key, which is a
  // different credential from the SMTP key used by the smtp transport.
  BREVO_API_KEY: z.string().optional(),

  // Resend key for MAIL_PROVIDER=resend. Resend is the only provider here that
  // can send without owning a domain: its onboarding@resend.dev sender is
  // pre-authenticated (SPF/DKIM/DMARC all valid), which is why mail from it
  // actually lands while noreply@fuhsox.ng silently disappears. The catch is
  // that an unverified account may only send TO its own signup address.
  RESEND_API_KEY: z.string().optional(),

  // Envelope From. Must be an identity the ACTIVE provider has verified — a
  // Brevo-verified sender differs from the SES one, so it is overridable.
  // Falls back to AWS_SES_FROM_EMAIL, which is what SES has always used.
  MAIL_FROM_EMAIL: z.string().email().optional(),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  SENTRY_DSN: z.string().url().optional(),
})
  // A custom S3 endpoint without a public base URL boots fine and then hands
  // clients AWS-shaped URLs that 404 — fail loudly at startup instead.
  .superRefine((cfg, ctx) => {
    if (cfg.STORAGE_ENDPOINT && !cfg.STORAGE_PUBLIC_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_PUBLIC_BASE_URL'],
        message:
          'STORAGE_PUBLIC_BASE_URL is required when STORAGE_ENDPOINT is set — the S3 API host and the public read host differ on non-AWS providers.',
      });
    }
  });

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const errorMessages = Object.entries(errors)
      .map(([key, msgs]) => `  ${key}: ${msgs?.join(', ')}`)
      .join('\n');

    // eslint-disable-next-line no-console -- runs before the logger can exist
    console.error(`Invalid environment variables:\n${errorMessages}`);
    process.exit(1);
  }
  return result.data;
}

export const env = validateEnv();
export type Env = z.infer<typeof envSchema>;