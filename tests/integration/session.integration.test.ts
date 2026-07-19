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

// Mock gamification to avoid badge-seeding requirement in tests
jest.mock('../../src/services/gamification.service', () => ({
  gamificationService: {
    processSessionComplete: jest.fn().mockResolvedValue({ xpEarned: 20, badges_earned: [] }),
    getUserStats: jest.fn().mockResolvedValue({ total_quizzes: 1, accuracy_rate: 80, total_xp: 20, streak_count: 1 }),
    updateUserStreak: jest.fn().mockResolvedValue(undefined),
  },
}));

const BASE = '/api/v1/sessions';

describe('POST /api/v1/sessions — create quiz session', () => {
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
    await prisma.sessionAnswer.deleteMany({});
    await prisma.quizSession.deleteMany({ where: { institution_id: institutionId } });
    await prisma.question.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).post(BASE).send({});
    expect(res.status).toBe(401);
  });

  it('creates a session with available questions', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        mode:            'practice',
        question_count:  1,
        question_source: 'past_questions',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.session).toBeDefined();
    expect(res.body.data.session.total_questions).toBe(1);
    expect(res.body.data.session.completed_at).toBeNull();
    expect(res.body.data.questions).toHaveLength(1);
  });

  it('returns 404 when no questions match filters', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        mode:            'practice',
        question_count:  5,
        question_source: 'past_questions',
        filters:         { course_code: 'NONEXISTENT 999' },
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 422 when question_count is below minimum', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        mode:            'practice',
        question_count:  2, // minimum is 5
        question_source: 'past_questions',
      });

    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/sessions/:id/answers — submit answer', () => {
  let studentToken: string;
  let institutionId: string;
  let sessionId: string;
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

    // Create session directly for this test group
    const session = await prisma.quizSession.create({
      data: {
        user_id:         studentId,
        institution_id:  institutionId,
        mode:            'practice',
        question_source: 'manual',
        total_questions: 1,
        question_ids:    [questionId],
      },
    });
    sessionId = session.id;
  });

  afterAll(async () => {
    await prisma.sessionAnswer.deleteMany({});
    await prisma.quizSession.deleteMany({ where: { institution_id: institutionId } });
    await prisma.question.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .patch(`${BASE}/${sessionId}/answer`)
      .send({ question_id: questionId, chosen_answer: 'D', time_taken_ms: 1500 });
    expect(res.status).toBe(401);
  });

  it('submits an answer and returns is_correct + correct_answer', async () => {
    const res = await request(app)
      .patch(`${BASE}/${sessionId}/answer`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ question_id: questionId, chosen_answer: 'D', time_taken_ms: 2000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.is_correct).toBe('boolean');
    expect(res.body.data.is_correct).toBe(true); // 'D' is the correct answer from createTestQuestion
    expect(res.body.data.correct_answer).toBe('D');
  });

  it('returns 409 when the same question is answered twice in a session', async () => {
    const res = await request(app)
      .patch(`${BASE}/${sessionId}/answer`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ question_id: questionId, chosen_answer: 'A', time_taken_ms: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('POST /api/v1/sessions/:id/complete', () => {
  let studentToken: string;
  let institutionId: string;
  let sessionId: string;
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

    // Create session and submit answer
    const session = await prisma.quizSession.create({
      data: {
        user_id:         studentId,
        institution_id:  institutionId,
        mode:            'practice',
        question_source: 'manual',
        total_questions: 1,
        question_ids:    [questionId],
      },
    });
    sessionId = session.id;

    await prisma.sessionAnswer.create({
      data: {
        session_id:    sessionId,
        question_id:   questionId,
        chosen_answer: 'D',
        is_correct:    true,
        time_taken_ms: 1500,
      },
    });
  });

  afterAll(async () => {
    await prisma.sessionAnswer.deleteMany({});
    await prisma.quizSession.deleteMany({ where: { institution_id: institutionId } });
    await prisma.question.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('completes a session and returns score + XP', async () => {
    const res = await request(app)
      .patch(`${BASE}/${sessionId}/complete`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.score_percent).toBe(100);
    expect(res.body.data.correct_count).toBe(1);
    expect(res.body.data.total_questions).toBe(1);
    expect(typeof res.body.data.xp_earned).toBe('number');
    expect(res.body.data.xp_earned).toBeGreaterThan(0);
    expect(Array.isArray(res.body.data.badges_earned)).toBe(true);
  });

  it('returns 409 when session is already completed', async () => {
    const res = await request(app)
      .patch(`${BASE}/${sessionId}/complete`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });
});

describe('GET /api/v1/sessions', () => {
  let studentToken: string;
  let institutionId: string;
  let studentId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const student = await createTestUser({ role: 'student', institution_id: institutionId });
    studentId    = student.id;
    studentToken = issueAccessToken(student);

    // Create a couple of sessions for this student
    await prisma.quizSession.createMany({
      data: [
        { user_id: studentId, institution_id: institutionId, mode: 'practice', question_source: 'manual', total_questions: 5, question_ids: [] },
        { user_id: studentId, institution_id: institutionId, mode: 'exam',     question_source: 'manual', total_questions: 10, question_ids: [] },
      ],
    });
  });

  afterAll(async () => {
    await prisma.quizSession.deleteMany({ where: { institution_id: institutionId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns only the current user\'s sessions', async () => {
    const res = await request(app)
      .get(`${BASE}/me`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toHaveLength(2);
    expect(res.body.data.total).toBe(2);
    // All sessions belong to this student
    for (const s of res.body.data.sessions) {
      expect(s.user_id).toBe(studentId);
    }
  });

  it('returns stats when stats=true is passed', async () => {
    const res = await request(app)
      .get(`${BASE}/me?stats=true`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.stats).toBeDefined();
    expect(typeof res.body.data.stats.total_quizzes).toBe('number');
  });
});
