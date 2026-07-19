import request from 'supertest';
import app from '../../src/app';
import prisma from '../../src/config/database';
import { createTestInstitution } from '../setup';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock email queue so no real emails are sent during tests
jest.mock('../../src/jobs/queues', () => ({
  emailQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
  aiQueue:    { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
  pdfQueue:   { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
  analyticsQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE = '/api/v1/auth';

async function getLatestOTP(email: string): Promise<string | null> {
  const otpReq = await prisma.oTPRequest.findFirst({
    where:   { email, used_at: null },
    orderBy: { created_at: 'desc' },
  });
  return otpReq?.otp_hash ? null : null; // hash is stored, not plain text
  // In integration tests we intercept via the mock email queue instead
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/auth/register', () => {
  let institutionId: string;

  beforeAll(async () => {
    const inst = await createTestInstitution();
    institutionId = inst.id;
  });

  afterEach(async () => {
    await prisma.oTPRequest.deleteMany({});
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns 200 and sends OTP for a valid institution email', async () => {
    const res = await request(app)
      .post(`${BASE}/register`)
      .send({ email: 'student@test.edu.ng' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toMatch(/OTP sent/i);

    // OTP request created in DB
    const otpRecord = await prisma.oTPRequest.findFirst({
      where: { email: 'student@test.edu.ng' },
    });
    expect(otpRecord).not.toBeNull();
    expect(otpRecord?.used_at).toBeNull();
  });

  it('returns 403 when email domain is not registered', async () => {
    const res = await request(app)
      .post(`${BASE}/register`)
      .send({ email: 'student@notregistered.com' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DOMAIN_NOT_ALLOWED');
  });

  it('returns 422 for malformed email', async () => {
    const res = await request(app)
      .post(`${BASE}/register`)
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when email field is missing', async () => {
    const res = await request(app)
      .post(`${BASE}/register`)
      .send({});

    expect(res.status).toBe(422);
  });

  it('invalidates previous OTP when a new one is requested', async () => {
    const email = 'student@test.edu.ng';

    // First OTP
    await request(app).post(`${BASE}/register`).send({ email });
    const first = await prisma.oTPRequest.findMany({ where: { email } });
    expect(first).toHaveLength(1);

    // Second OTP request
    await request(app).post(`${BASE}/register`).send({ email });

    // First OTP should now be marked as used (expired early)
    const all = await prisma.oTPRequest.findMany({ where: { email } });
    const unused = all.filter((r: { used_at: Date | null }) => r.used_at === null);
    expect(unused).toHaveLength(1); // Only the latest is active
  });
});

describe('POST /api/v1/auth/verify', () => {
  let institutionId: string;

  beforeAll(async () => {
    const inst = await createTestInstitution();
    institutionId = inst.id;
  });

  afterEach(async () => {
    await prisma.oTPRequest.deleteMany({});
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns 400 when no OTP exists for email', async () => {
    const res = await request(app)
      .post(`${BASE}/verify-otp`)
      .send({ email: 'nobody@test.edu.ng', otp: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('returns 400 for wrong OTP and increments attempts', async () => {
    const email = 'student@test.edu.ng';

    // Create an OTP entry manually for testing
    const { hashOTP } = await import('../../src/lib/otp');
    const hash = await hashOTP('999999');
    await prisma.oTPRequest.create({
      data: {
        email,
        otp_hash:   hash,
        purpose:    'login',
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const res = await request(app)
      .post(`${BASE}/verify-otp`)
      .send({ email, otp: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OTP');

    const updated = await prisma.oTPRequest.findFirst({ where: { email } });
    expect(updated?.attempts).toBe(1);
  });

  it('returns 200 with access token and refresh cookie on correct OTP', async () => {
    const email = 'newstudent@test.edu.ng';
    const otp   = '123456';

    const { hashOTP } = await import('../../src/lib/otp');
    const hash = await hashOTP(otp);

    await prisma.oTPRequest.create({
      data: {
        email,
        otp_hash:   hash,
        purpose:    'login',
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const res = await request(app)
      .post(`${BASE}/verify-otp`)
      .send({ email, otp });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.institution).toBeDefined();

    // Refresh token cookie must be set
    const cookies = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']]) as string[];
    expect(cookies).toBeDefined();
    const refreshCookie = cookies?.find((c: string) => c.startsWith('refresh_token='));
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain('HttpOnly');

    // OTP should now be marked as used
    const usedOTP = await prisma.oTPRequest.findFirst({ where: { email } });
    expect(usedOTP?.used_at).not.toBeNull();
  });

  it('creates a new user record when first-time login', async () => {
    const email = 'brandnew@test.edu.ng';
    const otp   = '654321';

    const { hashOTP } = await import('../../src/lib/otp');
    await prisma.oTPRequest.create({
      data: {
        email,
        otp_hash:   await hashOTP(otp),
        purpose:    'login',
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await request(app).post(`${BASE}/verify-otp`).send({ email, otp });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.email_verified).toBe(true);
    expect(user?.role).toBe('student');
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('returns 401 when no refresh token cookie is present', async () => {
    const res = await request(app).post(`${BASE}/refresh`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_TOKEN');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('returns 401 when no bearer token is provided', async () => {
    const res = await request(app).post(`${BASE}/logout`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/forgot-password', () => {
  it('always returns 200 regardless of whether email exists', async () => {
    const res = await request(app)
      .post(`${BASE}/forgot-password`)
      .send({ email: 'anyone@test.edu.ng' });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(/reset link/i);
  });

  it('returns 422 for invalid email', async () => {
    const res = await request(app)
      .post(`${BASE}/forgot-password`)
      .send({ email: 'not-valid' });

    expect(res.status).toBe(422);
  });
});
