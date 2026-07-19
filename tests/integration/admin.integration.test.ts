import request from 'supertest';
import app from '../../src/app';
import prisma from '../../src/config/database';
import { createTestInstitution, createTestUser, createTestQuestion } from '../setup';
import { issueAccessToken } from '../../src/services/auth.service';

jest.mock('../../src/jobs/queues', () => ({
  emailQueue:     { add: jest.fn().mockResolvedValue({ id: 'mock-id' }), addBulk: jest.fn().mockResolvedValue([]) },
  aiQueue:        { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  pdfQueue:       { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  analyticsQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
}));

const BASE = '/api/v1/admin';

// ─── Shared setup helper ──────────────────────────────────────────────────────

async function setupAdminContext() {
  const institution = await createTestInstitution();
  const admin       = await createTestUser({ role: 'admin',   institution_id: institution.id });
  const student     = await createTestUser({ role: 'student', institution_id: institution.id });
  const adminToken   = issueAccessToken(admin);
  const studentToken = issueAccessToken(student);
  return { institution, admin, student, adminToken, studentToken };
}

// ══════════════════════════════════════════════════════════════════════════════
// RBAC TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('Admin route RBAC enforcement', () => {
  let studentToken: string;
  let institutionId: string;

  beforeAll(async () => {
    const { institution, studentToken: st } = await setupAdminContext();
    studentToken  = st;
    institutionId = institution.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns 403 when a student accesses an admin route', async () => {
    const res = await request(app)
      .get(`${BASE}/analytics/overview`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get(`${BASE}/analytics/overview`);
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/admin/analytics/overview', () => {
  let adminToken:   string;
  let institutionId: string;

  beforeAll(async () => {
    const ctx = await setupAdminContext();
    adminToken    = ctx.adminToken;
    institutionId = ctx.institution.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns analytics overview with all required fields', async () => {
    const res = await request(app)
      .get(`${BASE}/analytics/overview`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    expect(typeof data.active_today).toBe('number');
    expect(typeof data.quizzes_today).toBe('number');
    expect(typeof data.at_risk_count).toBe('number');
    expect(typeof data.total_students).toBe('number');
    expect(typeof data.total_questions).toBe('number');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// QUESTION MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/admin/questions — create question', () => {
  let adminToken:   string;
  let institutionId: string;

  beforeAll(async () => {
    const ctx = await setupAdminContext();
    adminToken    = ctx.adminToken;
    institutionId = ctx.institution.id;
  });

  afterAll(async () => {
    await prisma.question.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('creates a draft question successfully', async () => {
    const res = await request(app)
      .post(`${BASE}/questions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        course_code:    'PHY 201',
        course_name:    'Human Physiology',
        faculty:        'Basic Medical Sciences',
        year:           2023,
        topic:          'Renal Physiology',
        question_text:  'Where is glucose primarily reabsorbed in the nephron?',
        question_type:  'mcq',
        options: [
          { key: 'A', text: 'Glomerulus' },
          { key: 'B', text: 'Proximal convoluted tubule' },
          { key: 'C', text: 'Loop of Henle' },
          { key: 'D', text: 'Collecting duct' },
        ],
        correct_answer: 'B',
        explanation:    'Glucose is 100% reabsorbed in the PCT via SGLT2.',
        difficulty:     'medium',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    expect(res.body.data.course_code).toBe('PHY 201');
  });

  it('returns 422 when MCQ has fewer than 4 options', async () => {
    const res = await request(app)
      .post(`${BASE}/questions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        course_code:    'PHY 201',
        course_name:    'Human Physiology',
        faculty:        'Basic Medical Sciences',
        year:           2023,
        topic:          'Renal Physiology',
        question_text:  'What is the glomerular filtration rate?',
        question_type:  'mcq',
        options:        [{ key: 'A', text: 'Only one option' }],
        correct_answer: 'A',
        difficulty:     'easy',
      });

    expect(res.status).toBe(422);
  });

  it('returns 422 for missing required fields', async () => {
    const res = await request(app)
      .post(`${BASE}/questions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ course_code: 'PHY 201' }); // Missing most required fields

    expect(res.status).toBe(422);
  });
});

describe('PATCH /api/v1/admin/questions/:id/status — update question status', () => {
  let adminToken:   string;
  let institutionId: string;
  let questionId:   string;
  let adminId:      string;

  beforeAll(async () => {
    const ctx = await setupAdminContext();
    adminToken    = ctx.adminToken;
    institutionId = ctx.institution.id;
    adminId       = ctx.admin.id;

    const q = await createTestQuestion(institutionId, adminId, { status: 'draft' });
    questionId = q.id;
  });

  afterAll(async () => {
    await prisma.question.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('moves a question from draft to review', async () => {
    const res = await request(app)
      .patch(`${BASE}/questions/${questionId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'review' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('review');
  });

  it('publishes a question from review', async () => {
    const res = await request(app)
      .patch(`${BASE}/questions/${questionId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'published' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('published');
  });

  it('returns 400 for invalid status transition (published → draft)', async () => {
    const res = await request(app)
      .patch(`${BASE}/questions/${questionId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'draft' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// STUDENT MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/admin/students', () => {
  let adminToken:   string;
  let institutionId: string;

  beforeAll(async () => {
    const ctx = await setupAdminContext();
    adminToken    = ctx.adminToken;
    institutionId = ctx.institution.id;

    // Create a few more students
    await createTestUser({ role: 'student', institution_id: institutionId, xp_points: 100 });
    await createTestUser({ role: 'student', institution_id: institutionId, xp_points: 200 });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns paginated student list', async () => {
    const res = await request(app)
      .get(`${BASE}/students`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    // At least the original student + 2 new ones = 3 students
    expect(res.body.data.students.length).toBeGreaterThanOrEqual(3);
    expect(res.body.data.pagination.total).toBeGreaterThanOrEqual(3);
  });

  it('paginates correctly', async () => {
    const res = await request(app)
      .get(`${BASE}/students?limit=2&page=1`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.students).toHaveLength(2);
    expect(res.body.data.pagination.hasMore).toBe(true);
  });

  it('sorts by XP descending when sort=xp_desc', async () => {
    const res = await request(app)
      .get(`${BASE}/students?sort=xp_desc`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const xpValues: number[] = res.body.data.students.map((s: { xp_points: number }) => s.xp_points);
    for (let i = 0; i < xpValues.length - 1; i++) {
      expect(xpValues[i]!).toBeGreaterThanOrEqual(xpValues[i + 1]!);
    }
  });
});

describe('PATCH /api/v1/admin/students/:id/flag', () => {
  let adminToken:   string;
  let institutionId: string;
  let studentId:    string;

  beforeAll(async () => {
    const ctx = await setupAdminContext();
    adminToken    = ctx.adminToken;
    institutionId = ctx.institution.id;
    studentId     = ctx.student.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('flags a student as at-risk with a reason', async () => {
    const res = await request(app)
      .patch(`${BASE}/students/${studentId}/flag`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ flagged: true, reason: 'Unusual activity pattern' });

    expect(res.status).toBe(200);
    expect(res.body.data.flagged).toBe(true);
    expect(res.body.data.reason).toBe('Unusual activity pattern');

    const dbUser = await prisma.user.findUnique({ where: { id: studentId } });
    expect(dbUser?.risk_flag).toBe(true);
  });

  it('clears the risk flag', async () => {
    const res = await request(app)
      .patch(`${BASE}/students/${studentId}/flag`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ flagged: false });

    expect(res.status).toBe(200);
    expect(res.body.data.flagged).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// EVENT MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/admin/events — create and publish event', () => {
  let adminToken:   string;
  let institutionId: string;
  let eventId:      string;

  beforeAll(async () => {
    const ctx = await setupAdminContext();
    adminToken    = ctx.adminToken;
    institutionId = ctx.institution.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({});
    await prisma.event.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('creates an event in draft status', async () => {
    const res = await request(app)
      .post(`${BASE}/events`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title:           'End of Year Clinical Skills Assessment',
        description:     'All final-year students must attend the clinical skills assessment.',
        event_date:      new Date(Date.now() + 30 * 86400000).toISOString(),
        location:        'Clinical Skills Lab',
        target_audience: 'all',
        is_urgent:       false,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    eventId = res.body.data.id;
  });

  it('publishes the event and triggers notifications', async () => {
    const res = await request(app)
      .post(`${BASE}/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.published).toBe(true);

    const dbEvent = await prisma.event.findUnique({ where: { id: eventId } });
    expect(dbEvent?.status).toBe('published');
    expect(dbEvent?.published_at).not.toBeNull();
  });

  it('returns 409 when publishing an already-published event', async () => {
    const res = await request(app)
      .post(`${BASE}/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 422 when event_date is missing', async () => {
    const res = await request(app)
      .post(`${BASE}/events`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title:       'Missing date event',
        description: 'This event has no date',
        is_urgent:   false,
      });

    expect(res.status).toBe(422);
  });
});
