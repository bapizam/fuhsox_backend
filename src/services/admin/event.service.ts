import prisma from '@config/database';
import { notificationService } from '@services/notification.service';
import { emailQueue } from '@jobs/queues';
import { AppError } from '@typings/models';
import logger from '@lib/logger';
import { env } from '@config/env';

// ─── Create Event ──────────────────────────────────────────────────────────────

export async function createEvent(params: {
  institutionId:  string;
  createdBy:      string;
  title:          string;
  description:    string;
  eventDate:      Date;
  location?:      string;
  targetAudience: 'all' | 'faculty' | 'department';
  targetValue?:   string;
  attachmentUrl?: string;
  coverImageUrl?: string;
  isUrgent:       boolean;
  scheduledFor?:  Date | null;
}) {
  const {
    institutionId, createdBy, title, description, eventDate,
    location, targetAudience, targetValue, attachmentUrl,
    coverImageUrl, isUrgent, scheduledFor,
  } = params;

  // If scheduledFor is in the future, keep as 'scheduled'; else create as 'draft'
  const status = scheduledFor && scheduledFor > new Date() ? 'scheduled' : 'draft';

  const event = await prisma.event.create({
    data: {
      institution_id:  institutionId,
      created_by:      createdBy,
      title,
      description,
      event_date:      eventDate,
      location:        location ?? null,
      target_audience: targetAudience,
      target_value:    targetValue ?? null,
      attachment_url:  attachmentUrl ?? null,
      cover_image_url: coverImageUrl ?? null,
      is_urgent:       isUrgent,
      status,
      scheduled_for:   scheduledFor ?? null,
    },
  });

  logger.info({ eventId: event.id, institutionId }, 'Event created');

  return event;
}

// ─── Publish Event ─────────────────────────────────────────────────────────────

export async function publishEvent(eventId: string, institutionId: string): Promise<void> {
  const event = await prisma.event.findFirst({
    where: { id: eventId, institution_id: institutionId },
  });

  if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found');
  if (event.status === 'published') throw new AppError(409, 'CONFLICT', 'Event is already published');
  if (event.status === 'cancelled') throw new AppError(400, 'VALIDATION_ERROR', 'Cannot publish a cancelled event');

  await prisma.event.update({
    where: { id: eventId },
    data:  { status: 'published', published_at: new Date() },
  });

  // Notify target audience in-app + email
  await notifyAudienceAboutEvent(event, institutionId);

  logger.info({ eventId }, 'Event published');
}

// ─── Notify Audience ──────────────────────────────────────────────────────────

async function notifyAudienceAboutEvent(
  event: {
    id: string; title: string; description: string; event_date: Date;
    location: string | null; target_audience: string; target_value: string | null;
    is_urgent: boolean;
  },
  institutionId: string,
): Promise<void> {
  const where: Record<string, unknown> = {
    institution_id: institutionId,
    role:           'student',
    ...(event.target_audience === 'faculty'    && event.target_value && { faculty:    event.target_value }),
    ...(event.target_audience === 'department' && event.target_value && { department: event.target_value }),
  };

  const users = await prisma.user.findMany({
    where,
    select: { id: true, email: true, full_name: true },
  });

  const institution = await prisma.institution.findUnique({
    where:  { id: institutionId },
    select: { name: true },
  });

  // Bulk in-app notifications
  await notificationService.createBulk(
    users.map((u: { id: string; email: string; full_name: string | null }) => ({
      user_id:    u.id,
      type:       'event' as const,
      title:      event.is_urgent ? `🚨 URGENT: ${event.title}` : `📅 ${event.title}`,
      body:       event.description.substring(0, 200),
      action_url: `/events/${event.id}`,
    })),
  );

  // Email notifications
  const emailJobs = users.map((u: { id: string; email: string; full_name: string | null }) => ({
    name: 'send',
    data: {
      type:        'event_notification' as const,
      to:          u.email,
      subject:     event.is_urgent ? `🚨 Urgent: ${event.title}` : `📅 Upcoming Event: ${event.title}`,
      template:    'event-notification' as const,
      data: {
        user_name:        u.full_name?.split(' ')[0] ?? 'Scholar',
        event_title:      event.title,
        event_date:       event.event_date.toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        event_location:   event.location ?? 'TBD',
        event_description: event.description,
        is_urgent:        event.is_urgent,
        cta_link:         `${env.FRONTEND_URL}/events/${event.id}`,
        institution_name: institution?.name ?? 'FuhsoX',
      },
    },
  }));

  await emailQueue.addBulk(emailJobs);

  logger.info({ eventId: event.id, recipientCount: users.length }, 'Event notifications sent');
}

// ─── List Events (Admin) ───────────────────────────────────────────────────────

export async function listEvents(
  institutionId: string,
  filter: {
    status?: 'draft' | 'scheduled' | 'published' | 'cancelled';
    page:    number;
    limit:   number;
  },
) {
  const skip = (filter.page - 1) * filter.limit;

  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where: {
        institution_id: institutionId,
        ...(filter.status && { status: filter.status }),
      },
      orderBy: { created_at: 'desc' },
      skip,
      take:    filter.limit,
    }),
    prisma.event.count({
      where: {
        institution_id: institutionId,
        ...(filter.status && { status: filter.status }),
      },
    }),
  ]);

  return {
    events,
    pagination: { total, page: filter.page, limit: filter.limit, totalPages: Math.ceil(total / filter.limit), hasMore: filter.page * filter.limit < total },
  };
}

// ─── Update Event ──────────────────────────────────────────────────────────────

export async function updateEvent(
  eventId:       string,
  institutionId: string,
  data: Partial<{
    title:          string;
    description:    string;
    event_date:     Date;
    location:       string;
    target_audience: 'all' | 'faculty' | 'department';
    target_value:   string;
    is_urgent:      boolean;
    scheduled_for:  Date | null;
  }>,
) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, institution_id: institutionId },
  });

  if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found');
  if (event.status === 'published' || event.status === 'cancelled') {
    throw new AppError(400, 'VALIDATION_ERROR', `Cannot edit a ${event.status} event`);
  }

  return prisma.event.update({ where: { id: eventId }, data });
}

// ─── Cancel Event ──────────────────────────────────────────────────────────────

export async function cancelEvent(eventId: string, institutionId: string) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, institution_id: institutionId },
  });

  if (!event) throw new AppError(404, 'NOT_FOUND', 'Event not found');

  return prisma.event.update({
    where: { id: eventId },
    data:  { status: 'cancelled' },
  });
}

// ─── Process Scheduled Events (called from cron) ──────────────────────────────

export async function processScheduledEvents(): Promise<number> {
  const now = new Date();

  const dueEvents = await prisma.event.findMany({
    where: {
      status:        'scheduled',
      scheduled_for: { lte: now },
    },
  });

  let published = 0;
  for (const event of dueEvents) {
    try {
      await publishEvent(event.id, event.institution_id);
      published++;
    } catch (err) {
      logger.error({ err, eventId: event.id }, 'Failed to auto-publish scheduled event');
    }
  }

  return published;
}

export const eventService = {
  createEvent,
  publishEvent,
  listEvents,
  updateEvent,
  cancelEvent,
  processScheduledEvents,
};
