import request from 'supertest';
import app from '../../src/app';
import prisma from '../../src/config/database';
import { Post, Comment } from '../../mongo/schemas';
import { createTestInstitution, createTestUser } from '../setup';
import { issueAccessToken } from '../../src/services/auth.service';

jest.mock('../../src/jobs/queues', () => ({
  emailQueue:     { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  aiQueue:        { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  pdfQueue:       { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
  analyticsQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-id' }) },
}));

const BASE = '/api/v1/feed';

describe('POST /api/v1/feed — create post', () => {
  let studentToken: string;
  let institutionId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;
    const student = await createTestUser({ role: 'student', institution_id: institutionId });
    studentToken = issueAccessToken(student);
  });

  afterAll(async () => {
    await Post.deleteMany({});
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('creates a post and returns it', async () => {
    const res = await request(app)
      .post(`${BASE}/posts`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ content: 'Has anyone started studying for ANA 201 yet?', topic_tag: 'anatomy' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.content).toBe('Has anyone started studying for ANA 201 yet?');
    expect(res.body.data.topic_tag).toBe('anatomy');
    expect(res.body.data.comments_count).toBe(0);
  });

  it('returns 422 when content is empty', async () => {
    const res = await request(app)
      .post(`${BASE}/posts`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ content: '' });

    expect(res.status).toBe(422);
  });

  it('returns 422 when content exceeds 500 chars', async () => {
    const res = await request(app)
      .post(`${BASE}/posts`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ content: 'x'.repeat(501) });

    expect(res.status).toBe(422);
  });

  it('strips HTML tags from content for security', async () => {
    const res = await request(app)
      .post(`${BASE}/posts`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ content: '<script>alert("xss")</script>Hello world' });

    expect(res.status).toBe(201);
    expect(res.body.data.content).not.toContain('<script>');
    expect(res.body.data.content).toContain('Hello world');
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).post(`${BASE}/posts`).send({ content: 'test' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/feed — get feed', () => {
  let student1Token: string;
  let institutionId: string;
  let student1Id: string;
  let student2Id: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const student1 = await createTestUser({ role: 'student', institution_id: institutionId });
    const student2 = await createTestUser({ role: 'student', institution_id: institutionId });
    student1Id    = student1.id;
    student2Id    = student2.id;
    student1Token = issueAccessToken(student1);

    // Create an accepted connection so student2's posts appear in student1's feed
    await prisma.connection.create({
      data: { sender_id: student1.id, receiver_id: student2.id, status: 'accepted' },
    });

    // Create 3 posts — student1 (self) and student2 (connected) posts are visible
    await Post.create({ institution_id: institutionId, author_id: student1.id, content: 'Post A', type: 'post' });
    await Post.create({ institution_id: institutionId, author_id: student1.id, content: 'Post B', type: 'post' });
    await Post.create({ institution_id: institutionId, author_id: student2.id, content: 'Post C', type: 'post' });
  });

  afterAll(async () => {
    await Post.deleteMany({});
    await prisma.connection.deleteMany({});
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns all institution posts with author info', async () => {
    const res = await request(app)
      .get(BASE)
      .set('Authorization', `Bearer ${student1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.items[0].author).not.toBeNull();
    expect(typeof res.body.data.items[0].is_liked).toBe('boolean');
    expect(typeof res.body.data.items[0].likes_count).toBe('number');
  });

  it('paginates correctly', async () => {
    const res = await request(app)
      .get(`${BASE}?limit=2&page=1`)
      .set('Authorization', `Bearer ${student1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
    // Cursor pagination: next_cursor is non-null when there are more items
    expect(res.body.data.next_cursor !== undefined).toBe(true);
  });
});

describe('POST /api/v1/feed/:id/like — toggle like', () => {
  let studentToken: string;
  let institutionId: string;
  let postId: string;
  let studentId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const student = await createTestUser({ role: 'student', institution_id: institutionId });
    studentId    = student.id;
    studentToken = issueAccessToken(student);

    const post = await Post.create({
      institution_id: institutionId,
      author_id:      student.id,
      content:        'Like this post!',
      type:           'post',
    });
    postId = post._id.toString();
  });

  afterAll(async () => {
    await Post.deleteMany({});
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('likes a post on first call', async () => {
    const res = await request(app)
      .post(`${BASE}/posts/${postId}/like`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.is_liked).toBe(true);
    expect(res.body.data.likes_count).toBe(1);
  });

  it('unlikes a post on second call', async () => {
    const res = await request(app)
      .post(`${BASE}/posts/${postId}/like`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.is_liked).toBe(false);
    expect(res.body.data.likes_count).toBe(0);
  });
});

describe('POST /api/v1/feed/:id/comments — add comment', () => {
  let studentToken: string;
  let institutionId: string;
  let postId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const student = await createTestUser({ role: 'student', institution_id: institutionId });
    studentToken  = issueAccessToken(student);

    const post = await Post.create({
      institution_id: institutionId,
      author_id:      student.id,
      content:        'Comment on this.',
      type:           'post',
    });
    postId = post._id.toString();
  });

  afterAll(async () => {
    await Post.deleteMany({});
    await Comment.deleteMany({});
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('adds a comment to a post', async () => {
    const res = await request(app)
      .post(`${BASE}/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ body: 'This is a great post!' });

    expect(res.status).toBe(201);
    expect(res.body.data.body).toBe('This is a great post!');
    expect(res.body.data.author_id).toBeDefined();

    // Check comment count incremented
    const updatedPost = await Post.findById(postId);
    expect(updatedPost?.comments_count).toBe(1);
  });

  it('returns 422 for empty comment body', async () => {
    const res = await request(app)
      .post(`${BASE}/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ body: '' });

    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/v1/feed/:id — delete post', () => {
  let ownerToken: string;
  let otherToken: string;
  let adminToken: string;
  let institutionId: string;
  let postId: string;

  beforeAll(async () => {
    const institution = await createTestInstitution();
    institutionId = institution.id;

    const owner = await createTestUser({ role: 'student', institution_id: institutionId });
    const other = await createTestUser({ role: 'student', institution_id: institutionId });
    const admin = await createTestUser({ role: 'admin',   institution_id: institutionId });

    ownerToken = issueAccessToken(owner);
    otherToken = issueAccessToken(other);
    adminToken = issueAccessToken(admin);

    const post = await Post.create({
      institution_id: institutionId,
      author_id:      owner.id,
      content:        'Delete me.',
      type:           'post',
    });
    postId = post._id.toString();
  });

  afterAll(async () => {
    await Post.deleteMany({});
    await prisma.user.deleteMany({ where: { institution_id: institutionId } });
  });

  it('returns 403 when non-owner tries to delete', async () => {
    const res = await request(app)
      .delete(`${BASE}/posts/${postId}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  it('allows admin to delete any post', async () => {
    const res = await request(app)
      .delete(`${BASE}/posts/${postId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    // Verify soft-deleted
    const deleted = await Post.findById(postId);
    expect(deleted?.is_deleted).toBe(true);
  });
});
