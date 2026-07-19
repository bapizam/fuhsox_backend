/**
 * Jest Global Test Setup
 *
 * This file is loaded by Jest via setupFilesAfterEnv — it runs once per test
 * file, after the Jest test framework is installed, but before any test in that
 * file executes. That means beforeAll / afterAll / afterEach hooks registered
 * here apply to EVERY test file automatically.
 *
 * Databases used in tests
 * ────────────────────────
 * PostgreSQL : real test database (DATABASE_URL env, defaults to fuhsox_test)
 *              Prisma auto-connects on first query; we disconnect in afterAll.
 * MongoDB    : in-memory via MongoMemoryServer (fully isolated, no external dep)
 *              Connected in beforeAll; dropped and disconnected in afterAll.
 * Redis      : NOT connected in unit/integration tests — all queue/rate-limiter
 *              code that touches Redis is mocked via jest.mock() in each test file.
 */

// ─── Environment — must be set BEFORE any source module is imported ────────────

process.env['NODE_ENV']               = 'test';
process.env['PORT']                   = '4001';
process.env['FRONTEND_URL']           = 'http://localhost:3000';
process.env['JWT_ACCESS_SECRET']      = 'test-access-secret-that-is-exactly-32-chars!!';
process.env['JWT_REFRESH_SECRET']     = 'test-refresh-secret-that-is-exactly-32chars!';
process.env['JWT_ACCESS_EXPIRES_IN']  = '15m';
process.env['JWT_REFRESH_EXPIRES_IN'] = '30d';

// PostgreSQL — use a dedicated test database so tests never touch dev data
process.env['DATABASE_URL'] =
  process.env['DATABASE_URL'] ??
  'postgresql://fuhsox:fuhsox_dev_pass@localhost:5432/fuhsox_test';

// MongoDB — overridden in beforeAll once MongoMemoryServer has a URI
process.env['MONGODB_URI'] = 'mongodb://127.0.0.1:27017/fuhsox_test';

// Redis — tests mock this; a dummy URL keeps env validation happy
process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';

// Anthropic — never called in tests (mocked at service level)
process.env['ANTHROPIC_API_KEY']     = 'sk-ant-test-placeholder-key-for-env-validation';
process.env['AI_DAILY_QUESTION_LIMIT'] = '10';

// AWS — never called in tests (services are mocked)
process.env['AWS_ACCESS_KEY_ID']     = 'test-aws-key-id';
process.env['AWS_SECRET_ACCESS_KEY'] = 'test-aws-secret-key';
process.env['AWS_REGION']            = 'af-south-1';
process.env['AWS_S3_BUCKET']         = 'fuhsox-test-bucket';
process.env['AWS_SES_FROM_EMAIL']    = 'noreply@fuhso.edu.ng';

// Google OAuth — never called in tests
process.env['GOOGLE_CLIENT_ID']      = 'test-google-client-id.apps.googleusercontent.com';
process.env['GOOGLE_CLIENT_SECRET']  = 'test-google-client-secret';
process.env['GOOGLE_REDIRECT_URI']   = 'http://localhost:3000/auth/callback/google';

// Email (SMTP dev fallback)
process.env['SMTP_HOST'] = 'localhost';
process.env['SMTP_PORT'] = '1025';

// ─── Imports — after env vars are set ─────────────────────────────────────────

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PrismaClient } from '@prisma/client';

// ─── Singletons ────────────────────────────────────────────────────────────────

let mongoServer: MongoMemoryServer;

// Prisma client for test teardown — created lazily so unit tests that don't
// need a database still run even if prisma generate hasn't been executed yet.
// In a real CI environment, prisma generate runs before tests.
let _prismaClient: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!_prismaClient) {
    try {
      _prismaClient = new PrismaClient({ log: [] });
    } catch {
      throw new Error(
        'PrismaClient could not be initialised. Run `npm run db:generate` first.',
      );
    }
  }
  return _prismaClient;
}

// ─── Lifecycle Hooks ───────────────────────────────────────────────────────────

beforeAll(async () => {
  // Start MongoDB in-memory server and connect Mongoose to it.
  // All Mongoose models (Post, Comment, Message, etc.) will use this connection.
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  // Override the MONGODB_URI env var so any code that reads it gets the test URI.
  process.env['MONGODB_URI'] = mongoUri;

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri, { dbName: 'fuhsox_test' });
  }
}, 30_000);

afterAll(async () => {
  // Drop the in-memory MongoDB database and shut down
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  await mongoServer?.stop();

  // Cleanly disconnect the Prisma test client (only if it was created)
  if (_prismaClient) await _prismaClient.$disconnect();
}, 30_000);

afterEach(async () => {
  // Clear all Mongoose collections between tests so each test starts clean.
  // This is fast because MongoMemoryServer runs in-process.
  const collections = mongoose.connection.collections;
  const dropPromises = Object.values(collections).map((col) =>
    col.deleteMany({}).catch(() => {/* ignore if collection doesn't exist */}),
  );
  await Promise.all(dropPromises);
});

// ─── Exported Test Helpers ─────────────────────────────────────────────────────
// These are convenience functions used across integration test files.
// They always return data scoped to the test institution/user passed in.

/** Lazy-initialised Prisma test client — only usable in integration tests. */
export function getTestPrisma(): PrismaClient { return getPrisma(); }
export { getPrisma as testPrisma };

/**
 * Create or find the shared test institution.
 * Uses upsert so multiple test files can call this without conflicting.
 */
export async function createTestInstitution() {
  return getPrisma().institution.upsert({
    where:  { slug: 'test-inst' },
    update: {},
    create: {
      name:           'Test University',
      slug:           'test-inst',
      email_domains:  ['test.edu.ng'],
      ai_daily_limit: 10,
    },
  });
}

/**
 * Create a test user. Each call creates a unique user (unique email via Date.now()).
 */
export async function createTestUser(overrides: Partial<{
  email:          string;
  full_name:      string;
  role:           'student' | 'admin' | 'superadmin';
  institution_id: string;
  xp_points:      number;
  streak_count:   number;
}> = {}) {
  const institution = await createTestInstitution();

  return getPrisma().user.create({
    data: {
      institution_id:  overrides.institution_id ?? institution.id,
      email:           overrides.email          ?? `user-${Date.now()}-${Math.random().toString(36).slice(2)}@test.edu.ng`,
      full_name:       overrides.full_name      ?? 'Test User',
      role:            overrides.role           ?? 'student',
      email_verified:  true,
      auth_provider:   'email_otp',
      xp_points:       overrides.xp_points      ?? 0,
      streak_count:    overrides.streak_count   ?? 0,
    },
  });
}

/**
 * Create a published test question belonging to the given institution.
 */
export async function createTestQuestion(
  institutionId: string,
  adminId:       string,
  overrides: Partial<{
    status:      'draft' | 'review' | 'published';
    difficulty:  'easy' | 'medium' | 'hard';
    course_code: string;
  }> = {},
) {
  return getPrisma().question.create({
    data: {
      institution_id: institutionId,
      created_by:     adminId,
      source:         'manual',
      status:         overrides.status      ?? 'published',
      course_code:    overrides.course_code ?? 'ANA 201',
      course_name:    'Human Anatomy',
      faculty:        'Basic Medical Sciences',
      year:           2023,
      topic:          'Cardiovascular System',
      question_text:  'Which chamber of the heart pumps oxygenated blood to the systemic circulation?',
      question_type:  'mcq',
      options: [
        { key: 'A', text: 'Right atrium'    },
        { key: 'B', text: 'Right ventricle' },
        { key: 'C', text: 'Left atrium'     },
        { key: 'D', text: 'Left ventricle'  },
      ],
      correct_answer: 'D',
      explanation:    'The left ventricle pumps oxygenated blood into the aorta for systemic circulation.',
      difficulty:     overrides.difficulty ?? 'easy',
    },
  });
}

/**
 * Create a test badge (required for gamification tests).
 */
export async function createTestBadge(code: string = 'FIRST_QUIZ') {
  return getPrisma().badge.upsert({
    where:  { code },
    update: {},
    create: {
      code,
      name:        'First Quiz',
      description: 'Completed your first quiz.',
      icon_url:    'https://cdn.fuhsox.ng/badges/first_quiz.png',
      xp_award:    50,
    },
  });
}
