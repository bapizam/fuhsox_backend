import type { Server, Socket } from 'socket.io';
import prisma from '@config/database';
import { RoomMessage } from '../../mongo/schemas';
import logger from '@lib/logger';

// ─── Study-Room Chat Handler (M5) ─────────────────────────────────────────────
// Realtime chat inside study rooms, layered on the existing authed socket.
// Clients join/leave the socket.io room `room:{id}` on screen focus/blur (NOT
// on connect/disconnect); every event re-checks StudyRoomParticipant membership
// server-side — being in the institution room is not room membership.
//
// Client→server:  room:join { room_id }
//                 room:leave { room_id }
//                 room:message:send { room_id, body, temp_id? }
// Server→client:  room:message:new { id, room_id, sender_id, sender, body,
//                                    created_at, temp_id? }  (echoed to the
//                 whole room, sender included — reconcile by temp_id)
//                 room:error { message, room_id?, temp_id? }

interface RoomSocketData {
  userId:        string;
  institutionId: string;
}

function roomSocketData(socket: Socket): RoomSocketData {
  return socket.data as RoomSocketData;
}

async function isRoomParticipant(roomId: string, userId: string): Promise<boolean> {
  const participant = await prisma.studyRoomParticipant.findUnique({
    where: { room_id_user_id: { room_id: roomId, user_id: userId } },
    select: { id: true },
  });
  return participant !== null;
}

export function registerRoomHandler(io: Server, socket: Socket): void {
  // ── room:join ─────────────────────────────────────────────────────────────
  socket.on('room:join', async (payload: { room_id: string }) => {
    const { userId } = roomSocketData(socket);

    try {
      const roomId = payload.room_id?.trim();
      if (!roomId) {
        socket.emit('room:error', { message: 'room_id is required' });
        return;
      }

      if (!(await isRoomParticipant(roomId, userId))) {
        socket.emit('room:error', { message: 'Join the room before opening its chat', room_id: roomId });
        return;
      }

      void socket.join(`room:${roomId}`);
    } catch (err) {
      logger.error({ err, userId }, 'room:join error');
      socket.emit('room:error', { message: 'Failed to join room chat', room_id: payload.room_id });
    }
  });

  // ── room:leave ────────────────────────────────────────────────────────────
  // No membership check — leaving a socket.io room you never joined is a no-op.
  socket.on('room:leave', (payload: { room_id: string }) => {
    if (payload.room_id?.trim()) {
      void socket.leave(`room:${payload.room_id.trim()}`);
    }
  });

  // ── room:message:send ─────────────────────────────────────────────────────
  socket.on(
    'room:message:send',
    async (payload: { room_id: string; body: string; temp_id?: string }) => {
      const { userId, institutionId } = roomSocketData(socket);
      const roomId = payload.room_id?.trim();
      const tempId = payload.temp_id;

      try {
        if (!roomId || !payload.body?.trim()) {
          socket.emit('room:error', { message: 'room_id and body are required', temp_id: tempId });
          return;
        }

        if (payload.body.length > 2000) {
          socket.emit('room:error', {
            message: 'Message too long (max 2000 characters)',
            room_id: roomId,
            temp_id: tempId,
          });
          return;
        }

        // Membership is checked per emit — a user who left (or was removed via
        // room deletion) must not be able to keep posting on a stale socket.
        if (!(await isRoomParticipant(roomId, userId))) {
          socket.emit('room:error', {
            message: 'You are not a participant in this room',
            room_id: roomId,
            temp_id: tempId,
          });
          return;
        }

        const message = await RoomMessage.create({
          room_id:        roomId,
          institution_id: institutionId,
          sender_id:      userId,
          body:           payload.body.trim(),
        });

        const sender = await prisma.user.findUnique({
          where:  { id: userId },
          select: { id: true, full_name: true, avatar_url: true },
        });

        // The sender's own echo arrives via the room broadcast — make sure a
        // send emitted before room:join settled still gets its confirmation.
        const roomKey = `room:${roomId}`;
        if (!socket.rooms.has(roomKey)) void socket.join(roomKey);

        io.to(roomKey).emit('room:message:new', {
          id:         message._id.toString(),
          room_id:    roomId,
          sender_id:  userId,
          sender:     sender ?? { id: userId, full_name: null, avatar_url: null },
          body:       message.body,
          created_at: message.createdAt,
          ...(tempId ? { temp_id: tempId } : {}),
        });
      } catch (err) {
        logger.error({ err, userId, roomId }, 'room:message:send error');
        socket.emit('room:error', {
          message: 'Failed to send message',
          room_id: roomId,
          temp_id: tempId,
        });
      }
    },
  );
}
