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

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  SENTRY_DSN: z.string().url().optional(),
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