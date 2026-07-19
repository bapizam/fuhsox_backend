import request from 'supertest';
import app from '../../src/app';
import prisma from '../../src/config/database';
import { createTestInstitution, createTestUser } from '../setup';
import { issueAccessToken } from '../../src/services/auth.service';

jest.mock('../../src/jobs/queues', () => ({
  emailQueue:     { add: jest.fn().mockResolvedValue({ id: 'mock-id' }), addBulk: jest.fn().mockResolvedValue([]) },
  aiQueue:        { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  pdfQueue:       { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  analyticsQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
}));

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATION INTEGRATION TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('Notification endpoints', () => {
  let token: string;
  let userId: string;
  let institutionId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;
    const user = await createTestUser({ role: 'student', institution_id: institutionId });
    userId = user.id;
    token  = issueAccessToken(user);

    // Create some notifications directly
    await prisma.notification.createMany({
      data: [
        { user_id: userId, type: 'system',  title: 'Welcome!',       body: 'Welcome to FuhsoX', action_url: '/dashboard', is_read: false },
        { user_id: userId, type: 'reminder', title: 'Study reminder', body: 'Time to study',     action_url: '/quiz',      is_read: false },
        { user_id: userId, type: 'social',  title: 'New connection',  body: 'Someone connected', action_url: '/profile',   is_read: true  },
      ],
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { user_id: userId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('GET /notifications — returns paginated notifications with unread count', async () => {
    const res = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.notifications).toHaveLength(3);
    expect(res.body.data.unread_count).toBe(2);
    expect(res.body.data.total).toBe(3);
  });

  it('GET /notifications — paginates correctly', async () => {
    const res = await request(app)
      .get('/api/v1/notifications?page=1&limit=2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.notifications).toHaveLength(2);
  });

  it('PATCH /notifications/:id/read — marks a single notification as read', async () => {
    const unread = await prisma.notification.findFirst({
      where: { user_id: userId, is_read: false },
    });
    expect(unread).not.toBeNull();

    const res = await request(app)
      .patch(`/api/v1/notifications/${unread!.id}/read`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.is_read).toBe(true);

    const updated = await prisma.notification.findUnique({ where: { id: unread!.id } });
    expect(updated?.is_read).toBe(true);
  });

  it('PATCH /notifications/read-all — marks all as read', async () => {
    const res = await request(app)
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.updated_count).toBeGreaterThanOrEqual(1);

    const remaining = await prisma.notification.count({
      where: { user_id: userId, is_read: false },
    });
    expect(remaining).toBe(0);
  });

  it('GET /notifications — returns 401 without token', async () => {
    const res = await request(app).get('/api/v1/notifications');
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// USER PROFILE INTEGRATION TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('User profile endpoints', () => {
  let token: string;
  let userId: string;
  let institutionId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;
    const user = await createTestUser({
      role:           'student',
      institution_id: institutionId,
      full_name:      'Ada Okonkwo',
    });
    userId = user.id;
    token  = issueAccessToken(user);
  });

  afterAll(async () => {
    await prisma.notificationPref.deleteMany({ where: { user_id: userId } });
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('GET /users/me — returns authenticated user profile', async () => {
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(userId);
    expect(res.body.data.full_name).toBe('Ada Okonkwo');
    expect(res.body.data.email).toBeDefined();
    expect(res.body.data.password_hash).toBeUndefined(); // Must never be returned
    expect(res.body.data.google_id).toBeUndefined();     // Must never be returned
    expect(typeof res.body.data.unread_notifications).toBe('number');
  });

  it('PATCH /users/me — updates profile fields', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        full_name:       'Dr. Ada Okonkwo',
        faculty:         'Clinical Sciences',
        department:      'Medicine',
        bio:             'Final year medical student passionate about neurology.',
        study_interests: ['Anatomy', 'Neurology', 'Pharmacology'],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.full_name).toBe('Dr. Ada Okonkwo');
    expect(res.body.data.faculty).toBe('Clinical Sciences');
    expect(res.body.data.study_interests).toContain('Neurology');
  });

  it('PATCH /users/me — persists notification preferences', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        notification_prefs: {
          opt_out_reminders:  false,
          quiet_hours_start:  '22:00',
          quiet_hours_end:    '06:00',
          reminder_frequency: 'every_2_days',
        },
      });

    expect(res.status).toBe(200);

    const pref = await prisma.notificationPref.findUnique({ where: { user_id: userId } });
    expect(pref).not.toBeNull();
    expect(pref?.quiet_hours_start).toBe('22:00');
    expect(pref?.reminder_frequency).toBe('every_2_days');
  });

  it('PATCH /users/me — returns 422 for bio exceeding 500 chars', async () => {
    const res = await request(app)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ bio: 'x'.repeat(501) });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /users/:id — returns another user\'s public profile', async () => {
    const otherUser = await createTestUser({ institution_id: institutionId });

    const res = await request(app)
      .get(`/api/v1/users/${otherUser.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(otherUser.id);
    expect(res.body.data.password_hash).toBeUndefined();
    expect(res.body.data.connection_status).toBeDefined(); // null if not connected
    expect(res.body.data.stats).toBeDefined();

    await prisma.user.delete({ where: { id: otherUser.id } });
  });

  it('GET /users/:id — returns 404 for user from a different institution', async () => {
    const otherInstitution = await prisma.institution.create({
      data: {
        name:          'Foreign University',
        slug:          'foreign-uni',
        email_domains: ['foreign.edu'],
      },
    });

    const foreignUser = await createTestUser({ institution_id: otherInstitution.id });

    const res = await request(app)
      .get(`/api/v1/users/${foreignUser.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);

    await prisma.user.delete({ where: { id: foreignUser.id } });
    await prisma.institution.delete({ where: { id: otherInstitution.id } });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CONNECTION INTEGRATION TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('Connection (social) endpoints', () => {
  let senderToken:   string;
  let receiverToken: string;
  let senderId:      string;
  let receiverId:    string;
  let institutionId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const sender   = await createTestUser({ institution_id: institutionId });
    const receiver = await createTestUser({ institution_id: institutionId });

    senderId      = sender.id;
    receiverId    = receiver.id;
    senderToken   = issueAccessToken(sender);
    receiverToken = issueAccessToken(receiver);
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({});
    await prisma.connection.deleteMany({});
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('POST /users/:id/connect — sends a connection request', async () => {
    const res = await request(app)
      .post(`/api/v1/users/${receiverId}/connect`)
      .set('Authorization', `Bearer ${senderToken}`);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.sender_id).toBe(senderId);
    expect(res.body.data.receiver_id).toBe(receiverId);
  });

  it('POST /users/:id/connect — returns 409 for duplicate pending request', async () => {
    const res = await request(app)
      .post(`/api/v1/users/${receiverId}/connect`)
      .set('Authorization', `Bearer ${senderToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('POST /users/:id/connect — returns 400 for connecting to self', async () => {
    const res = await request(app)
      .post(`/api/v1/users/${senderId}/connect`)
      .set('Authorization', `Bearer ${senderToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /users/connections/:id — receiver accepts the request', async () => {
    const connection = await prisma.connection.findFirst({
      where: { sender_id: senderId, receiver_id: receiverId },
    });

    const res = await request(app)
      .patch(`/api/v1/users/connections/${connection!.id}`)
      .set('Authorization', `Bearer ${receiverToken}`)
      .send({ action: 'accept' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('accepted');
  });

  it('PATCH /users/connections/:id — sender cannot respond to own request', async () => {
    // Create a new connection to test this
    const newReceiver = await createTestUser({ institution_id: institutionId });
    await request(app)
      .post(`/api/v1/users/${newReceiver.id}/connect`)
      .set('Authorization', `Bearer ${senderToken}`);

    const conn = await prisma.connection.findFirst({
      where: { sender_id: senderId, receiver_id: newReceiver.id },
    });

    // Sender tries to accept their own request — should fail (not found as receiver)
    const res = await request(app)
      .patch(`/api/v1/users/connections/${conn!.id}`)
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ action: 'accept' });

    expect(res.status).toBe(404);

    await prisma.connection.deleteMany({ where: { receiver_id: newReceiver.id } });
    await prisma.user.delete({ where: { id: newReceiver.id } });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LEADERBOARD INTEGRATION TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/leaderboard', () => {
  let token: string;
  let institutionId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    // Create students with varying XP to test ordering
    const [u1, u2, u3] = await Promise.all([
      createTestUser({ institution_id: institutionId, xp_points: 500 }),
      createTestUser({ institution_id: institutionId, xp_points: 300 }),
      createTestUser({ institution_id: institutionId, xp_points: 100 }),
    ]);

    token = issueAccessToken(u1);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns institution-scoped leaderboard ordered by XP descending', async () => {
    const res = await request(app)
      .get('/api/v1/leaderboard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.entries.length).toBeGreaterThanOrEqual(3);

    const xpValues: number[] = res.body.data.entries.map((e: { xp_points: number }) => e.xp_points);
    for (let i = 0; i < xpValues.length - 1; i++) {
      expect(xpValues[i]!).toBeGreaterThanOrEqual(xpValues[i + 1]!);
    }
  });

  it('assigns consecutive ranks starting from 1', async () => {
    const res = await request(app)
      .get('/api/v1/leaderboard')
      .set('Authorization', `Bearer ${token}`);

    const entries: { rank: number }[] = res.body.data.entries;
    for (let i = 0; i < entries.length; i++) {
      expect(entries[i]!.rank).toBe(i + 1);
    }
  });

  it('includes my_rank in the response', async () => {
    const res = await request(app)
      .get('/api/v1/leaderboard')
      .set('Authorization', `Bearer ${token}`);

    expect(typeof res.body.data.my_rank).toBe('number');
    expect(res.body.data.my_rank).toBeGreaterThanOrEqual(1);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app).get('/api/v1/leaderboard');
    expect(res.status).toBe(401);
  });
});
