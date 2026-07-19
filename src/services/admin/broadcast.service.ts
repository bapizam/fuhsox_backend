import prisma from '@config/database';
import { emailQueue } from '@jobs/queues';
import { EMAIL_BATCH_SIZE } from '@config/constants';
import logger from '@lib/logger';

// ─── Resolve Recipients ────────────────────────────────────────────────────────

async function resolveRecipients(
  institutionId:  string,
  recipientType:  'all' | 'faculty' | 'department',
  recipientValue?: string,
): Promise<{ id: string; email: string; full_name: string | null }[]> {
  const where: Record<string, unknown> = {
    institution_id: institutionId,
    role:           'student',
    ...(recipientType === 'faculty'    && recipientValue && { faculty:    recipientValue }),
    ...(recipientType === 'department' && recipientValue && { department: recipientValue }),
  };

  return prisma.user.findMany({
    where,
    select: { id: true, email: true, full_name: true },
  });
}

// ─── Send Broadcast ────────────────────────────────────────────────────────────

export async function sendBroadcast(params: {
  institutionId:  string;
  createdBy:      string;
  recipientType:  'all' | 'faculty' | 'department';
  recipientValue?: string;
  subject:        string;
  htmlBody:       string;
}): Promise<{ broadcast_id: string; recipient_count: number }> {
  const { institutionId, createdBy, recipientType, recipientValue, subject, htmlBody } = params;

  // Resolve who receives this
  const recipients = await resolveRecipients(institutionId, recipientType, recipientValue);

  if (recipients.length === 0) {
    throw new Error('No recipients found for the specified audience');
  }

  const institution = await prisma.institution.findUnique({
    where:  { id: institutionId },
    select: { name: true },
  });

  // Create broadcast record
  const broadcast = await prisma.broadcast.create({
    data: {
      institution_id:  institutionId,
      created_by:      createdBy,
      recipient_type:  recipientType,
      recipient_value: recipientValue ?? null,
      subject,
      html_body:       htmlBody,
      recipient_count: recipients.length,
      status:          'queued',
    },
  });

  // Create delivery records in batches
  for (let i = 0; i < recipients.length; i += EMAIL_BATCH_SIZE) {
    const batch = recipients.slice(i, i + EMAIL_BATCH_SIZE);

    // Bulk-create delivery records
    const deliveries = await prisma.emailDelivery.createManyAndReturn({
      data: batch.map((r) => ({
        broadcast_id: broadcast.id,
        user_id:      r.id,
        email:        r.email,
        status:       'queued' as const,
      })),
    });

    // Build a lookup map from email → recipient (safe index-independent pairing)
    const recipientByEmail = new Map(batch.map((r) => [r.email, r]));

    // Enqueue email jobs for each delivery
    const jobs = deliveries.map((delivery: { id: string; email: string }) => {
      const recipient = recipientByEmail.get(delivery.email);
      return {
        name: 'send',
        data: {
          type:        'broadcast' as const,
          to:          delivery.email,
          subject,
          template:    'broadcast' as const,
          delivery_id: delivery.id,
          data: {
            user_name:        recipient?.full_name?.split(' ')[0] ?? 'Scholar',
            html_body:        htmlBody,
            institution_name: institution?.name ?? 'FuhsoX',
          },
        },
      };
    });

    await emailQueue.addBulk(jobs);
  }

  // Mark broadcast as sending
  await prisma.broadcast.update({
    where: { id: broadcast.id },
    data:  { status: 'sending', sent_at: new Date() },
  });

  logger.info({ broadcastId: broadcast.id, recipientCount: recipients.length }, 'Broadcast enqueued');

  return { broadcast_id: broadcast.id, recipient_count: recipients.length };
}

// ─── Get Broadcast History ─────────────────────────────────────────────────────

export async function getBroadcastHistory(
  institutionId: string,
  page:  number = 1,
  limit: number = 20,
) {
  const skip = (page - 1) * limit;

  const [broadcasts, total] = await Promise.all([
    prisma.broadcast.findMany({
      where:   { institution_id: institutionId },
      orderBy: { created_at: 'desc' },
      skip,
      take:    limit,
      select: {
        id:              true,
        subject:         true,
        recipient_type:  true,
        recipient_value: true,
        recipient_count: true,
        status:          true,
        sent_at:         true,
        created_at:      true,
      },
    }),
    prisma.broadcast.count({ where: { institution_id: institutionId } }),
  ]);

  return {
    broadcasts,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit), hasMore: page * limit < total },
  };
}

// ─── Get Broadcast Detail with Deliveries ─────────────────────────────────────

export async function getBroadcastDetail(broadcastId: string, institutionId: string) {
  const broadcast = await prisma.broadcast.findFirst({
    where:   { id: broadcastId, institution_id: institutionId },
    include: {
      deliveries: {
        select: { id: true, email: true, status: true, sent_at: true, opened_at: true, failed_at: true },
        take:   100, // Prevent huge payload
      },
    },
  });

  if (!broadcast) return null;

  // Aggregate delivery stats
  const stats = await prisma.emailDelivery.groupBy({
    by:    ['status'],
    where: { broadcast_id: broadcastId },
    _count: { id: true },
  });

  const statMap: Record<string, number> = {};
  for (const s of stats) statMap[s.status] = s._count.id;

  return {
    ...broadcast,
    delivery_stats: {
      queued:    statMap['queued']    ?? 0,
      sent:      statMap['sent']      ?? 0,
      delivered: statMap['delivered'] ?? 0,
      opened:    statMap['opened']    ?? 0,
      failed:    statMap['failed']    ?? 0,
      bounced:   statMap['bounced']   ?? 0,
    },
  };
}

export const broadcastService = {
  sendBroadcast,
  getBroadcastHistory,
  getBroadcastDetail,
};
