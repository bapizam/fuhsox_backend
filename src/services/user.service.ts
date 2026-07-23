import prisma from '@config/database';
import { AppError } from '@typings/models';
import {
  Post,
  Comment,
  Message,
  RoomMessage,
  AIFeedback,
  AIQuestion,
  ResourceChunk,
  MicroLesson,
  StudyPlan,
} from '../../mongo/schemas';
import { notificationService } from './notification.service';
import { gamificationService } from './gamification.service';
import { uploadAvatar, deleteFromS3, extractKeyFromUrl } from '@lib/s3';
import { del as redisDel, delByPattern } from '@lib/redis';
import { REDIS_KEYS } from '@config/constants';
import { watDaysBetween } from '@utils/xp';
import logger from '@lib/logger';

// ─── Get My Profile ────────────────────────────────────────────────────────────

export async function getMyProfile(userId: string) {
  const [user, unreadCount] = await Promise.all([
    prisma.user.findUnique({
      where:   { id: userId },
      include: {
        notification_pref: true,
        badges: { include: { badge: true } },
      },
    }),
    prisma.notification.count({ where: { user_id: userId, is_read: false } }),
  ]);

  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

  const { password_hash: _, google_id: __, ...safeUser } = user;

  return { ...safeUser, unread_notifications: unreadCount };
}

// ─── Get My Dashboard ──────────────────────────────────────────────────────────

/**
 * Aggregated Home-screen payload (mobile): XP/streak/accuracy stats, the next
 * upcoming exam (from active study schedules), the most recent quiz session
 * (client resumes it if `completed_at` is null), latest badges, and the unread
 * notification count — one round trip instead of five.
 */
export async function getDashboard(userId: string) {
  const now = new Date();

  const [user, stats, nextExam, lastSession, recentBadges, unreadCount] = await Promise.all([
    prisma.user.findUnique({
      where:  { id: userId },
      select: { streak_count: true, last_streak_date: true },
    }),
    gamificationService.getUserStats(userId),
    prisma.studySchedule.findFirst({
      where:   { user_id: userId, is_active: true, exam_date: { gte: now } },
      orderBy: { exam_date: 'asc' },
      select:  { id: true, subject: true, exam_date: true },
    }),
    prisma.quizSession.findFirst({
      where:   { user_id: userId },
      orderBy: { started_at: 'desc' },
      select:  {
        id:              true,
        mode:            true,
        total_questions: true,
        score_percent:   true,
        correct_count:   true,
        started_at:      true,
        completed_at:    true,
      },
    }),
    prisma.userBadge.findMany({
      where:   { user_id: userId },
      orderBy: { awarded_at: 'desc' },
      take:    3,
      include: { badge: true },
    }),
    prisma.notification.count({ where: { user_id: userId, is_read: false } }),
  ]);

  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

  // Same WAT day semantics as utils/xp `evaluateStreak`, and now literally the
  // same function: a streak is alive only if it was last extended today or
  // yesterday — older than that it reads as 0 (the stored count is stale until
  // the next completed session resets it). This used to re-implement the
  // comparison with server-local `setHours`, so the dashboard and the streak that
  // feeds it could disagree for an hour either side of midnight.
  const daysSinceStreak = user.last_streak_date
    ? watDaysBetween(user.last_streak_date, now)
    : Number.POSITIVE_INFINITY;

  return {
    stats: {
      xp_points:       stats.total_xp,
      streak_count:    daysSinceStreak <= 1 ? user.streak_count : 0,
      practiced_today: daysSinceStreak === 0,
      total_quizzes:   stats.total_quizzes,
      accuracy_rate:   stats.accuracy_rate,
    },
    next_exam:    nextExam,
    last_session: lastSession,
    recent_badges: recentBadges.map((ub) => ({
      id:          ub.badge.id,
      code:        ub.badge.code,
      name:        ub.badge.name,
      description: ub.badge.description,
      icon_url:    ub.badge.icon_url,
      awarded_at:  ub.awarded_at,
    })),
    unread_notifications: unreadCount,
  };
}

// ─── Get Public Profile ────────────────────────────────────────────────────────

export async function getPublicProfile(
  targetUserId: string,
  requestingUserId: string,
  institutionId:    string,
) {
  const user = await prisma.user.findFirst({
    where: { id: targetUserId, institution_id: institutionId },
    include: {
      badges: { include: { badge: true } },
    },
  });

  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

  // Get connection status
  const connection = await prisma.connection.findFirst({
    where: {
      OR: [
        { sender_id: requestingUserId, receiver_id: targetUserId },
        { sender_id: targetUserId,     receiver_id: requestingUserId },
      ],
    },
  });

  // Get quiz stats
  const stats = await gamificationService.getUserStats(targetUserId);

  const { password_hash: _, google_id: __, ...safeUser } = user;

  return {
    ...safeUser,
    connection_status: connection?.status ?? null,
    connection_id:     connection?.id ?? null,
    stats,
  };
}

// ─── Update Profile ────────────────────────────────────────────────────────────

export async function updateProfile(
  userId: string,
  data: {
    full_name?:       string;
    username?:        string;
    faculty?:         string;
    department?:      string;
    bio?:             string;
    avatar_url?:      string;
    study_interests?: string[];
    notification_prefs?: {
      opt_out_reminders:  boolean;
      quiet_hours_start:  string | null;
      quiet_hours_end:    string | null;
      reminder_frequency: 'daily' | 'every_2_days' | 'weekly';
    };
  },
) {
  const { notification_prefs, ...userFields } = data;

  // Username uniqueness check
  if (userFields.username) {
    const existing = await prisma.user.findUnique({
      where: { username: userFields.username },
      select: { id: true },
    });
    if (existing && existing.id !== userId) {
      throw new AppError(409, 'USERNAME_TAKEN', 'This username is already taken');
    }
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data:  userFields,
  });

  if (notification_prefs) {
    await prisma.notificationPref.upsert({
      where:  { user_id: userId },
      create: { user_id: userId, ...notification_prefs },
      update: notification_prefs,
    });
  }

  const { password_hash: _, google_id: __, ...safeUser } = updatedUser;
  return safeUser;
}

// ─── Upload Avatar ─────────────────────────────────────────────────────────────

export async function updateAvatar(
  userId:   string,
  buffer:   Buffer,
  mimeType: string,
): Promise<{ avatar_url: string }> {
  const { url } = await uploadAvatar(userId, buffer, mimeType);

  await prisma.user.update({
    where: { id: userId },
    data:  { avatar_url: url },
  });

  logger.info({ userId }, 'Avatar updated');

  return { avatar_url: url };
}

// ─── Peer Discovery ────────────────────────────────────────────────────────────

export async function discoverPeers(
  requestingUser: { id: string; institution_id: string; study_interests: string[] },
  filter: {
    faculty?:  string;
    interest?: string;
    page:      number;
    limit:     number;
    sort:      'best_match' | 'most_active' | 'recent';
  },
) {
  // Get IDs of already-connected users to exclude
  const connections = await prisma.connection.findMany({
    where: {
      OR: [
        { sender_id: requestingUser.id,   status: 'accepted' },
        { receiver_id: requestingUser.id, status: 'accepted' },
      ],
    },
    select: { sender_id: true, receiver_id: true },
  });

  const excludeIds = new Set<string>([requestingUser.id]);
  for (const c of connections) {
    excludeIds.add(c.sender_id);
    excludeIds.add(c.receiver_id);
  }

  const where: Record<string, unknown> = {
    institution_id: requestingUser.institution_id,
    role:           'student',
    id:             { notIn: Array.from(excludeIds) },
    ...(filter.faculty  && { faculty:    { equals: filter.faculty,  mode: 'insensitive' } }),
    ...(filter.interest && { study_interests: { has: filter.interest } }),
  };

  const orderBy: Record<string, unknown> =
    filter.sort === 'most_active' ? { last_active_at: 'desc' }
    : filter.sort === 'recent'    ? { created_at: 'desc' }
    : { xp_points: 'desc' }; // best_match approximation — sort by XP

  const skip = (filter.page - 1) * filter.limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take:    filter.limit,
      orderBy,
      select: {
        id:              true,
        full_name:       true,
        avatar_url:      true,
        faculty:         true,
        department:      true,
        bio:             true,
        study_interests: true,
        xp_points:       true,
        streak_count:    true,
        last_active_at:  true,
      },
    }),
    prisma.user.count({ where }),
  ]);

  // Add shared interest count + connection status for each result
  const pendingConnections = await prisma.connection.findMany({
    where: {
      OR: [
        { sender_id: requestingUser.id },
        { receiver_id: requestingUser.id },
      ],
      status: { in: ['pending', 'declined'] },
    },
  });

  const connectionStatusMap = new Map<string, string>();
  for (const c of pendingConnections) {
    const peerId = c.sender_id === requestingUser.id ? c.receiver_id : c.sender_id;
    connectionStatusMap.set(peerId, c.status);
  }

  type EnrichedUser = typeof users[number] & { shared_interests: number; connection_status: string | null };
  const enriched: EnrichedUser[] = users.map((u: typeof users[number]) => ({
    ...u,
    shared_interests: requestingUser.study_interests.filter((i) => (u.study_interests).includes(i)).length,
    connection_status: connectionStatusMap.get(u.id) ?? null,
  }));

  // For best_match, re-sort by shared interests
  if (filter.sort === 'best_match') {
    enriched.sort((a, b) => b.shared_interests - a.shared_interests);
  }

  return {
    users: enriched,
    pagination: { total, page: filter.page, limit: filter.limit, totalPages: Math.ceil(total / filter.limit), hasMore: filter.page * filter.limit < total },
  };
}

// ─── Connections ───────────────────────────────────────────────────────────────

export async function sendConnectionRequest(senderId: string, receiverId: string, institutionId: string) {
  if (senderId === receiverId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Cannot connect to yourself');
  }

  // Ensure receiver is in same institution
  const receiver = await prisma.user.findFirst({
    where: { id: receiverId, institution_id: institutionId },
  });

  if (!receiver) throw new AppError(404, 'NOT_FOUND', 'User not found');

  // Check for existing connections (both directions — declined rows can exist
  // in either or both, so evaluate every row for the pair)
  const existing = await prisma.connection.findMany({
    where: {
      OR: [
        { sender_id: senderId,   receiver_id: receiverId },
        { sender_id: receiverId, receiver_id: senderId },
      ],
    },
  });

  if (existing.some((c) => c.status === 'accepted')) {
    throw new AppError(409, 'CONFLICT', 'Already connected');
  }
  if (existing.some((c) => c.status === 'pending')) {
    throw new AppError(409, 'CONFLICT', 'Connection request already pending');
  }
  if (existing.some((c) => c.status === 'blocked')) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot connect with this user');
  }

  // Only declined rows remain. Clear them so @@unique([sender_id, receiver_id])
  // cannot reject the fresh request (previously fell through to create() and
  // 500'd with P2002 on a same-direction declined row).
  if (existing.length > 0) {
    await prisma.connection.deleteMany({
      where: { id: { in: existing.map((c) => c.id) } },
    });
  }

  const connection = await prisma.connection.create({
    data: { sender_id: senderId, receiver_id: receiverId, status: 'pending' },
    include: { sender: { select: { full_name: true } } },
  });

  await notificationService.create({
    user_id:    receiverId,
    type:       'social',
    title:      'New connection request',
    body:       `${connection.sender.full_name ?? 'Someone'} wants to connect with you`,
    action_url: '/connections',
  });

  return connection;
}

/**
 * List the requesting user's connections (mobile-additive; the send/respond
 * endpoints existed without any way to enumerate pending requests or accepted
 * peers). Declined/blocked rows are never exposed. `direction` tells the client
 * whether a pending row is actionable (only the receiver may accept/decline).
 */
export async function listConnections(
  userId:  string,
  status?: 'pending' | 'accepted',
) {
  const peerSelect = {
    id:         true,
    full_name:  true,
    avatar_url: true,
    faculty:    true,
    department: true,
  } as const;

  const rows = await prisma.connection.findMany({
    where: {
      OR:     [{ sender_id: userId }, { receiver_id: userId }],
      status: status ?? { in: ['pending', 'accepted'] },
    },
    orderBy: { updated_at: 'desc' },
    include: {
      sender:   { select: peerSelect },
      receiver: { select: peerSelect },
    },
  });

  return {
    connections: rows.map((c) => ({
      id:         c.id,
      status:     c.status,
      direction:  c.sender_id === userId ? ('outgoing' as const) : ('incoming' as const),
      created_at: c.created_at,
      updated_at: c.updated_at,
      peer:       c.sender_id === userId ? c.receiver : c.sender,
    })),
  };
}

export async function respondToConnection(
  connectionId: string,
  receiverId:   string,
  action:       'accept' | 'decline',
) {
  const connection = await prisma.connection.findFirst({
    where: { id: connectionId, receiver_id: receiverId, status: 'pending' },
  });

  if (!connection) throw new AppError(404, 'NOT_FOUND', 'Connection request not found');

  const updated = await prisma.connection.update({
    where: { id: connectionId },
    data:  { status: action === 'accept' ? 'accepted' : 'declined' },
    include: { receiver: { select: { full_name: true } } },
  });

  if (action === 'accept') {
    await notificationService.create({
      user_id:    connection.sender_id,
      type:       'social',
      title:      'Connection accepted!',
      body:       `${updated.receiver.full_name ?? 'Someone'} accepted your connection request`,
      action_url: `/profile/${receiverId}`,
    });
  }

  return updated;
}

// ─── Delete Account (NDPR right-to-delete) ───────────────────────────────────────

/**
 * Erase an account and everything attached to it, across all four stores.
 *
 * This used to ANONYMIZE: it overwrote the PII columns and set `deleted_at`,
 * leaving the row in place. That looked like a delete and was not one. Because the
 * row survived, every `onDelete: Cascade` in the schema — bookmarks, notifications,
 * schedules, badges, notification prefs, refresh tokens, push tokens, learning
 * resources and objectives, exam outcomes — never fired. Quiz sessions, their
 * answers and OTP requests stayed too, and three tables (`email_deliveries`,
 * `ai_usage_logs`, `mastery_attempts`) carry a `user_id` with NO Prisma relation at
 * all, so no cascade could ever have reached them. On the Mongo side only posts and
 * comments were touched, and only soft-deleted; direct messages, AI feedback,
 * generated questions, resource chunks, micro-lessons and study plans were left
 * whole and still keyed to the user.
 *
 * So: delete the row for real and let the cascades do their work, after clearing by
 * hand the relations that would otherwise block it. ORDER MATTERS — Postgres
 * refuses to delete a row that a non-cascading foreign key still points at.
 *
 * Ids that later steps need (rooms, schedules, objectives, avatar, email) are read
 * BEFORE the transaction, because after it they are gone.
 */
export async function deleteAccount(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { email: true, avatar_url: true, institution_id: true },
  });

  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

  const [createdRooms, schedules, objectives] = await Promise.all([
    prisma.studyRoom.findMany({ where: { created_by: userId }, select: { id: true } }),
    prisma.studySchedule.findMany({ where: { user_id: userId }, select: { id: true } }),
    prisma.learningObjective.findMany({ where: { user_id: userId }, select: { id: true } }),
  ]);

  const createdRoomIds = createdRooms.map((r) => r.id);

  await prisma.$transaction([
    // (a) Rows with a user_id but no declared relation — invisible to cascades.
    prisma.emailDelivery.deleteMany({ where: { user_id: userId } }),
    prisma.aIUsageLog.deleteMany({ where: { user_id: userId } }),
    prisma.masteryAttempt.deleteMany({ where: { user_id: userId } }),

    // (b) Relations without onDelete: Cascade — these would block the delete.
    //     Quiz sessions cascade to their answers; rooms cascade to participants.
    prisma.quizSession.deleteMany({ where: { user_id: userId } }),
    prisma.oTPRequest.deleteMany({ where: { user_id: userId } }),
    prisma.connection.deleteMany({
      where: { OR: [{ sender_id: userId }, { receiver_id: userId }] },
    }),
    prisma.studyRoomParticipant.deleteMany({ where: { user_id: userId } }),
    prisma.studyRoom.deleteMany({ where: { created_by: userId } }),

    // (c) The row itself. Everything else attached to it cascades from here.
    prisma.user.delete({ where: { id: userId } }),
  ]);

  // The remaining stores are outside the transaction and cannot join it, so each is
  // best-effort and logged: the account is already gone in Postgres, and throwing
  // here would report a failure for a deletion that did happen. The stores are
  // independent — one failing must not skip the others.
  try {
    await Promise.all([
      Post.deleteMany({ author_id: userId }),
      Comment.deleteMany({ author_id: userId }),
      // Likes the user left on OTHER people's content, so counts drop.
      Post.updateMany({ likes: userId }, { $pull: { likes: userId } }),
      Comment.updateMany({ likes: userId }, { $pull: { likes: userId } }),
      // Both directions: a DM is the sender's data and the recipient's alike.
      Message.deleteMany({ $or: [{ sender_id: userId }, { receiver_id: userId }] }),
      // Messages they wrote anywhere, plus every message in rooms they owned.
      RoomMessage.deleteMany({ sender_id: userId }),
      createdRoomIds.length > 0
        ? RoomMessage.deleteMany({ room_id: { $in: createdRoomIds } })
        : Promise.resolve(),
      AIFeedback.deleteMany({ user_id: userId }),
      AIQuestion.deleteMany({ user_id: userId }),
      ResourceChunk.deleteMany({ user_id: userId }),
      MicroLesson.deleteMany({ user_id: userId }),
      StudyPlan.deleteMany({ user_id: userId }),
    ]);
  } catch (err) {
    logger.error({ err, userId }, 'Deleted-account Mongo cleanup failed');
  }

  try {
    await Promise.all([
      delByPattern(REDIS_KEYS.AI_DAILY(userId, '*')),
      delByPattern(REDIS_KEYS.LAST_REMINDER(userId, '*')),
      redisDel(REDIS_KEYS.RE_ENGAGEMENT(userId), REDIS_KEYS.OTP_RATE(user.email)),
      // Keyed by schedule/objective id rather than user id, so they can only be
      // found via the ids captured above.
      ...schedules.map((s) => delByPattern(REDIS_KEYS.SCHEDULE_CHECKIN(s.id, '*'))),
      ...objectives.map((o) => delByPattern(REDIS_KEYS.MASTERY_ATTEMPTS(o.id, '*'))),
      // Their XP no longer counts toward either aggregate.
      delByPattern(REDIS_KEYS.LEADERBOARD(user.institution_id, '*')),
      redisDel(REDIS_KEYS.ANALYTICS_OVERVIEW(user.institution_id)),
    ]);
  } catch (err) {
    logger.error({ err, userId }, 'Deleted-account Redis cleanup failed');
  }

  // Nulling avatar_url only ever dropped the POINTER; the object stayed public in
  // the bucket, readable by anyone who had seen the URL.
  if (user.avatar_url) {
    try {
      await deleteFromS3(extractKeyFromUrl(user.avatar_url));
    } catch (err) {
      logger.error({ err, userId }, 'Deleted-account avatar removal failed');
    }
  }

  logger.info({ userId }, 'Account hard-deleted across Postgres, Mongo, Redis and S3');
}

export const userService = {
  getMyProfile,
  getDashboard,
  getPublicProfile,
  updateProfile,
  updateAvatar,
  discoverPeers,
  sendConnectionRequest,
  listConnections,
  respondToConnection,
  deleteAccount,
};
