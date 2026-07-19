import type { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '@config/database';
import { RoomMessage } from '../../mongo/schemas';
import { ok } from '@utils/response';
import asyncHandler from '@middleware/asyncHandler';
import { AppError } from '@typings/models';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createRoomSchema = z.object({
  name:        z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  is_private:  z.boolean().default(false),
  passcode:    z.string().max(50).optional(),
});

const joinRoomSchema = z.object({
  passcode: z.string().optional(),
});

const roomMessagesQuerySchema = z.object({
  page:  z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(30),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

export const createRoom = asyncHandler(async (req: Request, res: Response) => {
  const data = createRoomSchema.parse(req.body);

  if (data.is_private && !data.passcode) {
    throw new AppError(400, 'BAD_REQUEST', 'Passcode is required for private rooms');
  }

  const room = await prisma.studyRoom.create({
    data: {
      ...data,
      institution_id: req.institutionId,
      created_by:     req.user.id,
      participants: {
        create: {
          user_id: req.user.id,
        },
      },
    },
    include: {
      _count: {
        select: { participants: true },
      },
    },
  });

  res.status(201).json(ok(room));
});

export const getRooms = asyncHandler(async (req: Request, res: Response) => {
  const rooms = await prisma.studyRoom.findMany({
    where: {
      institution_id: req.institutionId,
      OR: [
        { is_private: false },
        { participants: { some: { user_id: req.user.id } } },
      ],
    },
    include: {
      creator: {
        select: { id: true, full_name: true, avatar_url: true },
      },
      _count: {
        select: { participants: true },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  // Never ship private-room passcodes to every client that can see the room.
  const safeRooms = rooms.map(({ passcode: _, ...room }) => room);

  res.status(200).json(ok(safeRooms));
});

export const getRoomById = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const room = await prisma.studyRoom.findUnique({
    where: {
      id,
      institution_id: req.institutionId,
    },
    include: {
      creator: {
        select: { id: true, full_name: true, avatar_url: true },
      },
      participants: {
        include: {
          user: {
            select: { id: true, full_name: true, avatar_url: true },
          },
        },
      },
    },
  });

  if (!room) {
    throw new AppError(404, 'NOT_FOUND', 'Room not found');
  }

  // If private, ensure user is a participant or creator
  if (room.is_private && room.created_by !== req.user.id) {
    const isParticipant = room.participants.some(p => p.user_id === req.user.id);
    if (!isParticipant) {
      throw new AppError(403, 'FORBIDDEN', 'Unauthorized to view this private room');
    }
  }

  // Same passcode redaction as the directory listing.
  const { passcode: _, ...safeRoom } = room;

  res.status(200).json(ok(safeRoom));
});

export const joinRoom = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { passcode } = joinRoomSchema.parse(req.body);

  const room = await prisma.studyRoom.findUnique({
    where: {
      id,
      institution_id: req.institutionId,
    },
    include: {
      participants: {
        where: { user_id: req.user.id },
      },
    },
  });

  if (!room) {
    throw new AppError(404, 'NOT_FOUND', 'Room not found');
  }

  if (room.participants.length > 0) {
    throw new AppError(400, 'BAD_REQUEST', 'Already a participant');
  }

  if (room.is_private && room.passcode !== passcode) {
    throw new AppError(403, 'FORBIDDEN', 'Invalid passcode');
  }

  const participant = await prisma.studyRoomParticipant.create({
    data: {
      room_id: room.id,
      user_id: req.user.id,
    },
  });

  res.status(200).json(ok({ joined: true, participant }));
});

export const leaveRoom = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const participant = await prisma.studyRoomParticipant.findUnique({
    where: {
      room_id_user_id: {
        room_id: id,
        user_id: req.user.id,
      },
    },
  });

  if (!participant) {
    throw new AppError(404, 'NOT_FOUND', 'Not a participant in this room');
  }

  await prisma.studyRoomParticipant.delete({
    where: { id: participant.id },
  });

  res.status(200).json(ok({ left: true }));
});

// Paginated chat history (M5) — newest-first pages for an inverted list.
// Messages ship in the same shape as the `room:message:new` socket event
// (string id + `created_at` + joined `sender` card) so the client renders one
// message type for both sources.
export const getRoomMessages = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { page, limit } = roomMessagesQuerySchema.parse(req.query);

  const room = await prisma.studyRoom.findUnique({
    where:  { id, institution_id: req.institutionId },
    select: { id: true },
  });

  if (!room) {
    throw new AppError(404, 'NOT_FOUND', 'Room not found');
  }

  const participant = await prisma.studyRoomParticipant.findUnique({
    where: {
      room_id_user_id: {
        room_id: id,
        user_id: req.user.id,
      },
    },
    select: { id: true },
  });

  if (!participant) {
    throw new AppError(403, 'FORBIDDEN', 'Join the room to read its messages');
  }

  const skip = (page - 1) * limit;
  const [messages, total] = await Promise.all([
    RoomMessage.find({ room_id: id, is_deleted: false })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    RoomMessage.countDocuments({ room_id: id, is_deleted: false }),
  ]);

  const senderIds = [...new Set(messages.map((m) => m.sender_id))];
  const senders = await prisma.user.findMany({
    where:  { id: { in: senderIds } },
    select: { id: true, full_name: true, avatar_url: true },
  });
  const senderMap = new Map(senders.map((s) => [s.id, s]));

  res.status(200).json(ok({
    messages: messages.map((m) => ({
      id:         m._id.toString(),
      room_id:    m.room_id,
      sender_id:  m.sender_id,
      sender:     senderMap.get(m.sender_id) ?? null,
      body:       m.body,
      created_at: m.createdAt,
    })),
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore:    page * limit < total,
    },
  }));
});

export const deleteRoom = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  const room = await prisma.studyRoom.findUnique({
    where: {
      id,
      institution_id: req.institutionId,
    },
  });

  if (!room) {
    throw new AppError(404, 'NOT_FOUND', 'Room not found');
  }

  if (room.created_by !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    throw new AppError(403, 'FORBIDDEN', 'Unauthorized to delete this room');
  }

  await prisma.studyRoom.delete({
    where: { id: room.id },
  });

  res.status(200).json(ok({ deleted: true }));
});
