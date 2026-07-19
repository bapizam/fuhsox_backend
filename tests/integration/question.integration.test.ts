import request from 'supertest';
import app from '../../src/app';
import prisma from '../../src/config/database';
import { createTestInstitution, createTestUser, createTestQuestion } from '../setup';
import { issueAccessToken } from '../../src/services/auth.service';

jest.mock('../../src/jobs/queues', () => ({
  emailQueue:     { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  aiQueue:        { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  pdfQueue:       { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  analyticsQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
}));

const BASE = '/api/v1/questions';

describe('GET /api/v1/questions', () => {
  let studentToken: string;
  let adminToken: string;
  let institutionId: string;
  let adminId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const admin   = await createTestUser({ role: 'admin', institution_id: institutionId });
    const student = await createTestUser({ role: 'student', institution_id: institutionId });
    adminId = admin.id;

    adminToken   = issueAccessToken(admin);
    studentToken = issueAccessToken(student);

    // Create published and draft questions
    await createTestQuestion(institutionId, adminId, { status: 'published' });
    await createTestQuestion(institutionId, adminId, { status: 'published', difficulty: 'hard' });
    await createTestQuestion(institutionId, adminId, { status: 'draft' }); // should not appear
  });

  afterAll(async () => {
    await prisma.question.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(401);
  });

  it('returns published questions only for a student', async () => {
    const res = await request(app)
      .get(BASE)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.questions).toHaveLength(2); // only published
    expect(res.body.data.pagination.total).toBe(2);
    // All returned questions should be published
    for (const q of res.body.data.questions) {
      expect(q.status).toBe('published');
    }
  });

  it('filters by difficulty correctly', async () => {
    const res = await request(app)
      .get(`${BASE}?difficulty=hard`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.questions).toHaveLength(1);
    expect(res.body.data.questions[0].difficulty).toBe('hard');
  });

  it('filters by course_code correctly', async () => {
    const res = await request(app)
      .get(`${BASE}?course_code=ANA 201`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.questions.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array and total 0 when no questions match filters', async () => {
    const res = await request(app)
      .get(`${BASE}?course_code=NONEXISTENT 999`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.questions).toHaveLength(0);
    expect(res.body.data.pagination.total).toBe(0);
  });

  it('includes is_bookmarked flag on each question', async () => {
    const res = await request(app)
      .get(BASE)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    for (const q of res.body.data.questions) {
      expect(typeof q.is_bookmarked).toBe('boolean');
    }
  });

  it('paginates correctly with page and limit params', async () => {
    const res = await request(app)
      .get(`${BASE}?page=1&limit=1`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.questions).toHaveLength(1);
    expect(res.body.data.pagination.hasMore).toBe(true);
    expect(res.body.data.pagination.totalPages).toBe(2);
  });

  it('returns 422 for invalid limit (over max)', async () => {
    const res = await request(app)
      .get(`${BASE}?limit=999`)
      .set('Authorization', `Bearer ${studentToken}`);

    // limit is capped at 50, so should still return 200
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/questions/:id/bookmark', () => {
  let studentToken: string;
  let institutionId: string;
  let questionId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const admin   = await createTestUser({ role: 'admin',   institution_id: institutionId });
    const student = await createTestUser({ role: 'student', institution_id: institutionId });

    studentToken = issueAccessToken(student);

    const question = await createTestQuestion(institutionId, admin.id, { status: 'published' });
    questionId = question.id;
  });

  afterAll(async () => {
    await prisma.bookmark.deleteMany({});
    await prisma.question.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('bookmarks a question (first call)', async () => {
    const res = await request(app)
      .post(`${BASE}/${questionId}/bookmark`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.is_bookmarked).toBe(true);
  });

  it('removes bookmark on second call (toggle)', async () => {
    const res = await request(app)
      .post(`${BASE}/${questionId}/bookmark`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.is_bookmarked).toBe(false);
  });

  it('returns 404 for non-existent question', async () => {
    const res = await request(app)
      .post(`${BASE}/00000000-0000-0000-0000-000000000000/bookmark`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/questions/bookmarks', () => {
  let studentToken: string;
  let institutionId: string;
  let questionId: string;
  let studentId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const admin   = await createTestUser({ role: 'admin',   institution_id: institutionId });
    const student = await createTestUser({ role: 'student', institution_id: institutionId });
    studentId    = student.id;
    studentToken = issueAccessToken(student);

    const question = await createTestQuestion(institutionId, admin.id, { status: 'published' });
    questionId = question.id;

    // Pre-create a bookmark
    await prisma.bookmark.create({ data: { user_id: studentId, question_id: questionId } });
  });

  afterAll(async () => {
    await prisma.bookmark.deleteMany({});
    await prisma.question.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns the student\'s bookmarked questions', async () => {
    const res = await request(app)
      .get(`${BASE}/bookmarks`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.questions).toHaveLength(1);
    expect(res.body.data.questions[0].id).toBe(questionId);
    expect(res.body.data.questions[0].is_bookmarked).toBe(true);
  });
});
