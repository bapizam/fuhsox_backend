import { Post, Comment } from '../../mongo/schemas';
import { AppError } from '@typings/models';
import { notificationService } from './notification.service';
import { incrWithExpiry, get as redisGet, set as redisSet } from '@lib/redis';
import { REDIS_KEYS, POST_REPORT_THRESHOLD } from '@config/constants';
import sanitizeHtml from 'sanitize-html';
import prisma from '@config/database';
import logger from '@lib/logger';
import type { Types } from 'mongoose';

// ─── Cursor-Based Feed (student posts + campus events + staff blogs) ──────────

/**
 * A feed row. `kind` is the discriminator the client switches on — a student
 * post, a campus event, or a staff-written blog.
 */
export interface FeedItem extends Record<string, unknown> {
  kind: 'post' | 'event' | 'blog';
  id: string;
  /** Sort key across all three sources. */
  created_at: Date;
}

/**
 * Campus events and blogs live in Postgres while student posts live in Mongo, so
 * the feed cannot be one query. Each source is fetched newest-first up to the
 * page size, merged, and re-sorted by time — the cursor is therefore a TIMESTAMP
 * rather than the old Mongo ObjectId, because an ObjectId cannot address a row
 * in another datastore.
 *
 * Over-fetching by `limit` per source is deliberate: after the merge only the
 * first `limit` survive, and each source must be able to supply the whole page
 * on its own (a day when staff post ten blogs and nobody posts anything else).
 */
export async function getFeed(
  userId:        string,
  institutionId: string,
  cursor?:       string,   // ISO timestamp; paginate backwards from here
  limit:         number = 10,
): Promise<{ items: FeedItem[]; next_cursor: string | null }> {
  const before = cursor ? new Date(cursor) : null;
  const beforeValid = before && !Number.isNaN(before.getTime()) ? before : null;

  const postQuery: Record<string, unknown> = {
    institution_id: institutionId,
    is_deleted:     false,
  };
  if (beforeValid) postQuery['createdAt'] = { $lt: beforeValid };

  const [posts, events, blogs] = await Promise.all([
    Post.find(postQuery).sort({ createdAt: -1 }).limit(limit + 1).lean(),
    prisma.event.findMany({
      where: {
        institution_id: institutionId,
        status:         'published',
        ...(beforeValid ? { published_at: { lt: beforeValid } } : {}),
      },
      orderBy: { published_at: 'desc' },
      take:    limit + 1,
    }),
    prisma.blog.findMany({
      where: {
        institution_id: institutionId,
        status:         'published',
        ...(beforeValid ? { published_at: { lt: beforeValid } } : {}),
      },
      orderBy: { published_at: 'desc' },
      take:    limit + 1,
    }),
  ]);

  // Author profiles for the student posts only — events and blogs are written by
  // the institution, and are labelled as such rather than by a staff member's name.
  const authorIdSet = [...new Set(posts.map((p) => p.author_id))];
  const authors = await prisma.user.findMany({
    where:  { id: { in: authorIdSet } },
    select: { id: true, full_name: true, avatar_url: true, faculty: true },
  });
  const authorMap = new Map(authors.map((a) => [a.id, a]));

  const postItems: FeedItem[] = posts.map((p) => ({
    ...p,
    kind:        'post',
    id:          p._id.toString(),
    created_at:  p.createdAt,
    author:      authorMap.get(p.author_id) ?? null,
    is_liked:    p.likes.includes(userId),
    likes_count: p.likes.length,
  }));

  const eventItems: FeedItem[] = events.map((e) => ({
    kind:            'event',
    id:              e.id,
    created_at:      e.published_at ?? e.created_at,
    title:           e.title,
    description:     e.description,
    event_date:      e.event_date,
    location:        e.location,
    cover_image_url: e.cover_image_url,
    is_urgent:       e.is_urgent,
  }));

  const blogItems: FeedItem[] = blogs.map((b) => ({
    kind:            'blog',
    id:              b.id,
    created_at:      b.published_at ?? b.created_at,
    title:           b.title,
    excerpt:         b.excerpt,
    body:            b.body,
    category:        b.category,
    cover_image_url: b.cover_image_url,
  }));

  const merged = [...postItems, ...eventItems, ...blogItems].sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );

  const hasMore = merged.length > limit;
  const items   = merged.slice(0, limit);

  // The cursor is the last item's timestamp, so the next page continues from the
  // merged stream rather than from any one source's position.
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.created_at.toISOString() : null;

  return { items, next_cursor: nextCursor };
}

// ─── Trending Topics (Redis-cached 1 hour) ─────────────────────────────────────

export async function getTrending(institutionId: string) {
  const topicsKey  = `trending:${institutionId}:topics`;
  const studentsKey = `trending:${institutionId}:students`;

  const [cachedTopics, cachedStudents] = await Promise.all([
    redisGet(topicsKey),
    redisGet(studentsKey),
  ]);

  if (cachedTopics && cachedStudents) {
    return {
      topics:      JSON.parse(cachedTopics) as { name: string; attempt_count: number }[],
      hot_students: JSON.parse(cachedStudents) as { id: string; full_name: string | null; avatar_url: string | null; xp_points: number }[],
    };
  }

  // Compute from PostgreSQL — top topics by attempt count in last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);

  const topics = await prisma.$queryRaw<Array<{ topic: string; attempt_count: bigint }>>`
    SELECT q.topic, COUNT(sa.id) AS attempt_count
    FROM session_answers sa
    JOIN questions q       ON q.id  = sa.question_id
    JOIN quiz_sessions qs  ON qs.id = sa.session_id
    WHERE qs.institution_id = ${institutionId}
      AND qs.started_at   >= ${sevenDaysAgo}
    GROUP BY q.topic
    ORDER BY attempt_count DESC
    LIMIT 5
  `;

  // Top students by XP gain in last 7 days (approximate via current XP with recent quiz count)
  const hotStudents = await prisma.user.findMany({
    where:   { institution_id: institutionId, role: 'student' },
    orderBy: { xp_points: 'desc' },
    take:    3,
    select:  { id: true, full_name: true, avatar_url: true, xp_points: true },
  });

  const result = {
    topics:      topics.map((t: { topic: string; attempt_count: bigint }) => ({ name: t.topic, attempt_count: Number(t.attempt_count) })),
    hot_students: hotStudents,
  };

  // Cache for 1 hour
  const ONE_HOUR = 3600;
  await Promise.all([
    redisSet(topicsKey,   JSON.stringify(result.topics),       ONE_HOUR),
    redisSet(studentsKey, JSON.stringify(result.hot_students),  ONE_HOUR),
  ]);

  return result;
}

// ─── Create Post ───────────────────────────────────────────────────────────────

export async function createPost(
  authorId:      string,
  institutionId: string,
  data: { content: string; topic_tag?: string },
) {
  const cleanContent = sanitizeHtml(data.content, {
    allowedTags:       [],
    allowedAttributes: {},
  });

  if (!cleanContent.trim()) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Post content cannot be empty after sanitisation');
  }

  const post = await Post.create({
    institution_id: institutionId,
    author_id:      authorId,
    type:           'post',
    content:        cleanContent,
    topic_tag:      data.topic_tag?.trim(),
  });

  return post;
}

// ─── Get Post Detail with Comments ────────────────────────────────────────────

export async function getPostDetail(postId: string, userId: string): Promise<Record<string, unknown>> {
  const post = await Post.findOne({ _id: postId, is_deleted: false }).lean();
  if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');

  // Fetch top-level comments sorted by likes DESC, then createdAt ASC
  const topLevelComments = await Comment.find({
    post_id:           postId,
    parent_comment_id: null,
    is_deleted:        false,
  })
    .sort({ likes: -1, createdAt: 1 })
    .lean();

  // Fetch up to 3 replies per top-level comment
  const commentIds = topLevelComments.map((c) => (c._id).toString());
  const replies = await Comment.find({
    parent_comment_id: { $in: commentIds },
    is_deleted:        false,
  })
    .sort({ createdAt: 1 })
    .lean();

  // Group replies by parent
  const repliesMap = new Map<string, typeof replies>();
  for (const reply of replies) {
    const parentId = (reply.parent_comment_id as Types.ObjectId).toString();
    const bucket = repliesMap.get(parentId);
    if (bucket) bucket.push(reply);
    else repliesMap.set(parentId, [reply]);
  }

  // Batch-fetch all authors
  const allAuthorIds = [
    post.author_id,
    ...topLevelComments.map((c) => c.author_id),
    ...replies.map((r) => r.author_id),
  ];
  const uniqueAuthorIds = [...new Set(allAuthorIds)];
  const authors = await prisma.user.findMany({
    where:  { id: { in: uniqueAuthorIds } },
    select: { id: true, full_name: true, avatar_url: true },
  });
  const authorMap = new Map(authors.map((a: { id: string; full_name: string | null; avatar_url: string | null; faculty?: string | null }) => [a.id, a]));

  const enrichedComments = topLevelComments.map((c) => ({
    ...c,
    id:      (c._id).toString(),
    author:  authorMap.get(c.author_id) ?? null,
    replies: (repliesMap.get((c._id).toString()) ?? [])
      .slice(0, 3)
      .map((r) => ({
        ...r,
        id:     (r._id).toString(),
        author: authorMap.get(r.author_id) ?? null,
      })),
  }));

  return {
    ...post,
    id:          (post._id).toString(),
    author:      authorMap.get(post.author_id) ?? null,
    is_liked:    (post.likes).includes(userId),
    likes_count: (post.likes).length,
    comments:    enrichedComments,
  };
}

// ─── Toggle Post Like ──────────────────────────────────────────────────────────

export async function togglePostLike(postId: string, userId: string) {
  const post = await Post.findOne({ _id: postId, is_deleted: false });
  if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');

  const alreadyLiked = (post.likes).includes(userId);

  if (alreadyLiked) {
    await Post.findByIdAndUpdate(postId, { $pull: { likes: userId } });
  } else {
    await Post.findByIdAndUpdate(postId, { $addToSet: { likes: userId } });

    if (post.author_id !== userId) {
      const liker = await prisma.user.findUnique({
        where:  { id: userId },
        select: { full_name: true },
      });
      await notificationService.create({
        user_id:    post.author_id,
        type:       'social',
        title:      'Post liked',
        body:       `${liker?.full_name ?? 'Someone'} liked your post`,
        action_url: `/feed/posts/${postId}`,
      });
    }
  }

  const updated = await Post.findById(postId).lean();
  return {
    is_liked:    !alreadyLiked,
    likes_count: (updated?.likes)?.length ?? 0,
  };
}

// ─── Delete Post ───────────────────────────────────────────────────────────────

export async function deletePost(
  postId:      string,
  requesterId: string,
  isAdmin:     boolean,
) {
  const post = await Post.findById(postId);
  if (!post || post.is_deleted) throw new AppError(404, 'NOT_FOUND', 'Post not found');

  if (!isAdmin && post.author_id !== requesterId) {
    throw new AppError(403, 'FORBIDDEN', 'Cannot delete another user\'s post');
  }

  await Post.findByIdAndUpdate(postId, { is_deleted: true });
  return { deleted: true };
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export async function createComment(
  postId:          string,
  authorId:        string,
  body:            string,
  parentCommentId?: string,
) {
  const post = await Post.findOne({ _id: postId, is_deleted: false });
  if (!post) throw new AppError(404, 'NOT_FOUND', 'Post not found');

  const cleanBody = sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} });

  const comment = await Comment.create({
    post_id:           postId,
    author_id:         authorId,
    body:              cleanBody,
    parent_comment_id: parentCommentId ?? null,
  });

  await Post.findByIdAndUpdate(postId, { $inc: { comments_count: 1 } });

  if (post.author_id !== authorId) {
    const commenter = await prisma.user.findUnique({
      where:  { id: authorId },
      select: { full_name: true },
    });
    await notificationService.create({
      user_id:    post.author_id,
      type:       'social',
      title:      'New comment on your post',
      body:       `${commenter?.full_name ?? 'Someone'} commented: "${cleanBody.substring(0, 80)}${cleanBody.length > 80 ? '...' : ''}"`,
      action_url: `/feed/posts/${postId}`,
    });
  }

  return comment;
}

export async function getPostComments(postId: string, page: number = 1, limit: number = 20): Promise<{ comments: Record<string, unknown>[]; pagination: { total: number; page: number; limit: number; totalPages: number; hasMore: boolean } }> {
  const skip = (page - 1) * limit;

  const [comments, total] = await Promise.all([
    Comment.find({ post_id: postId, is_deleted: false, parent_comment_id: null })
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Comment.countDocuments({ post_id: postId, is_deleted: false, parent_comment_id: null }),
  ]);

  const authorIds = [...new Set(comments.map((c) => c.author_id))];
  const authors = await prisma.user.findMany({
    where:  { id: { in: authorIds } },
    select: { id: true, full_name: true, avatar_url: true },
  });
  const authorMap = new Map(authors.map((a: { id: string; full_name: string | null; avatar_url: string | null; faculty?: string | null }) => [a.id, a]));

  return {
    comments: comments.map((c) => ({
      ...c,
      id:     (c._id).toString(),
      author: authorMap.get(c.author_id) ?? null,
    })),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore:    page * limit < total,
    },
  };
}

// ─── Report Post ───────────────────────────────────────────────────────────────

export async function reportPost(
  postId:       string,
  reporterId:   string,
  reason:       string,
  institutionId: string,
) {
  const key        = REDIS_KEYS.REPORT_COUNT(postId);
  const reporterKey = `${key}:${reporterId}`;

  const alreadyReported = await redisGet(reporterKey);
  if (alreadyReported) {
    throw new AppError(409, 'CONFLICT', 'You have already reported this post');
  }

  const reportCount = await incrWithExpiry(key, 30 * 86400);
  await redisSet(reporterKey, '1', 30 * 86400);

  if (reportCount >= POST_REPORT_THRESHOLD) {
    const admins = await prisma.user.findMany({
      where:  { institution_id: institutionId, role: { in: ['admin', 'superadmin'] } },
      select: { id: true },
    });

    await notificationService.createBulk(
      admins.map((a: { id: string }) => ({
        user_id:    a.id,
        type:       'system' as const,
        title:      'Post flagged for review',
        body:       `Post has been reported ${reportCount} times. Reason: "${reason.substring(0, 100)}"`,
        action_url: `/admin/content/${postId}`,
      })),
    );

    logger.warn({ postId, reportCount }, 'Post reached report threshold — admins notified');
  }

  return { reported: true, report_count: reportCount };
}

// Achievement auto-posting was REMOVED: every badge unlock wrote a "🏅 Earned
// the X badge!" post nobody composed, which buried the posts students actually
// wrote. Badges are celebrated in the unlock modal and kept on the profile.
// Historical achievement posts are left in place — they are real feed history.

export const feedService = {
  getFeed,
  getTrending,
  createPost,
  getPostDetail,
  togglePostLike,
  deletePost,
  createComment,
  getPostComments,
  reportPost,
};
