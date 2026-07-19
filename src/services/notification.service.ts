import prisma from '@config/database';
import type { CreateNotificationInput, Notification } from '@typings/models';
import { getIO } from '@lib/socket-ref';
import { pushQueue } from '@jobs/queues';
import logger from '@lib/logger';

// Enqueue an Expo push for one recipient (M5 fan-out — the push worker resolves
// the user's device tokens). Best-effort: a Redis hiccup must never fail the
// notification write that already happened.
async function enqueuePush(
  input: CreateNotificationInput,
  notificationId?: string,
): Promise<void> {
  try {
    await pushQueue.add('send', {
      type:              'notification',
      user_id:           input.user_id,
      notification_type: input.type,
      title:             input.title,
      body:              input.body,
      action_url:        input.action_url,
      ...(notificationId ? { notification_id: notificationId } : {}),
    });
  } catch (err) {
    logger.warn({ err, userId: input.user_id }, 'Failed to enqueue push notification');
  }
}

// ─── Create & Deliver Notification ────────────────────────────────────────────

export async function createNotification(
  input: CreateNotificationInput,
): Promise<Notification> {
  const notification = await prisma.notification.create({
    data: {
      user_id:    input.user_id,
      type:       input.type,
      title:      input.title,
      body:       input.body,
      action_url: input.action_url,
    },
  });

  // Emit via Socket.io if the user is online
  try {
    const io = getIO();
    if (io) {
      io.to(`user:${input.user_id}`).emit('notification:new', {
        id:         notification.id,
        type:       notification.type,
        title:      notification.title,
        body:       notification.body,
        action_url: notification.action_url,
        is_read:    false,
        created_at: notification.created_at,
      });
    }
  } catch {
    // Socket not yet initialized (e.g. in tests) — ignore
  }

  await enqueuePush(input, notification.id);

  logger.debug({ userId: input.user_id, type: input.type }, 'Notification created');

  return notification;
}

// ─── Bulk Notifications ────────────────────────────────────────────────────────

export async function createBulkNotifications(
  inputs: CreateNotificationInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;

  const result = await prisma.notification.createMany({
    data: inputs.map((i) => ({
      user_id:    i.user_id,
      type:       i.type,
      title:      i.title,
      body:       i.body,
      action_url: i.action_url,
    })),
    skipDuplicates: true,
  });

  // Emit to all online users
  try {
    const io = getIO();
    if (io) {
      for (const input of inputs) {
        io.to(`user:${input.user_id}`).emit('notification:new', {
          type:  input.type,
          title: input.title,
          body:  input.body,
        });
      }
    }
  } catch { /* Socket not ready */ }

  // createMany returns no rows, so bulk pushes carry no notification_id — the
  // client tap falls back to invalidating the inbox instead of marking read.
  for (const input of inputs) {
    await enqueuePush(input);
  }

  return result.count;
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────

export async function getUserNotifications(
  userId: string,
  page: number = 1,
  limit: number = 20,
) {
  const skip = (page - 1) * limit;

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where:   { user_id: userId },
      orderBy: { created_at: 'desc' },
      skip,
      take:    limit,
    }),
    prisma.notification.count({ where: { user_id: userId } }),
    prisma.notification.count({ where: { user_id: userId, is_read: false } }),
  ]);

  return { notifications, total, unread_count: unreadCount, page, limit };
}

export async function markAsRead(notificationId: string, userId: string): Promise<Notification> {
  return prisma.notification.update({
    where: { id: notificationId, user_id: userId },
    data:  { is_read: true },
  });
}

export async function markAllAsRead(userId: string): Promise<{ updated_count: number }> {
  const result = await prisma.notification.updateMany({
    where: { user_id: userId, is_read: false },
    data:  { is_read: true },
  });
  return { updated_count: result.count };
}

export const notificationService = {
  create: createNotification,
  createBulk: createBulkNotifications,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
};
