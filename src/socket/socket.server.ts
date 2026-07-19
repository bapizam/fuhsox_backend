import { Server, type Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import { env } from '@config/env';
import prisma from '@config/database';
import { Message } from '../../mongo/schemas';
import { registerRoomHandler } from './room.handler';
import { setIO } from '@lib/socket-ref';
import type { JWTPayload } from '@typings/models';
import logger from '@lib/logger';

// ─── Global IO Instance ────────────────────────────────────────────────────────
// The canonical reference is held in @lib/socket-ref to avoid circular imports.
// This local getter is kept for backward compatibility with any internal callers.

export { getIO } from '@lib/socket-ref';

// ─── Custom Socket Data ────────────────────────────────────────────────────────

/**
 * Per-connection auth context stamped by the handshake middleware. socket.io's
 * `socket.data` is `any` by default (the generic, not a global interface), so
 * reads go through the `socketData()` helper for real typing.
 */
interface SocketData {
  userId:        string;
  institutionId: string;
  role:          string;
}

function socketData(socket: Socket): SocketData {
  return socket.data as SocketData;
}

// ─── Initialize Socket.io Server ──────────────────────────────────────────────

export function initSocketServer(httpServer: HTTPServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin:      env.FRONTEND_URL,
      credentials: true,
    },
    transports:   ['websocket', 'polling'],
    pingTimeout:  30000,
    pingInterval: 10000,
  });

  // ─── Authentication Middleware ───────────────────────────────────────────────
  // Every socket connection must carry a valid JWT access token in
  // socket.handshake.auth.token.  Unauthenticated connections are refused here.

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth['token'] as string | undefined;

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JWTPayload;
      socket.data = {
        userId:        payload.sub,
        institutionId: payload.institution_id,
        role:          payload.role,
      } satisfies SocketData;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  // ─── Connection Handler ──────────────────────────────────────────────────────

  io.on('connection', (socket: Socket) => {
    const { userId, institutionId } = socketData(socket);

    logger.debug({ userId, socketId: socket.id }, 'Socket connected');

    // Personal room — used for targeted notifications and DM delivery
    // (join can return a Promise with async adapters — explicitly fire-and-forget)
    void socket.join(`user:${userId}`);

    // Institution room — used for institution-wide broadcasts
    void socket.join(`institution:${institutionId}`);

    // Non-blocking last_active_at update
    prisma.user
      .update({ where: { id: userId }, data: { last_active_at: new Date() } })
      .catch(() => { /* silent — not critical */ });

    // Register feature-specific event handlers
    // Note: AI quiz feedback is triggered automatically in session.service.ts
    // when a student answers incorrectly in practice mode — no manual socket event needed.
    registerMessageHandler(io, socket);
    registerRoomHandler(io, socket);

    socket.on('disconnect', (reason) => {
      logger.debug({ userId, socketId: socket.id, reason }, 'Socket disconnected');
    });

    socket.on('error', (err) => {
      logger.error({ err, userId }, 'Socket error');
    });

    socket.emit('connected', { userId, message: 'Real-time connection established' });
  });

  setIO(io);
  logger.info('✅ Socket.io server initialized');

  return io;
}

// ─── Message Handler ──────────────────────────────────────────────────────────
// Handles real-time DM sending and read-receipt events between connected users.

function registerMessageHandler(io: Server, socket: Socket): void {
  // ── message:send ──────────────────────────────────────────────────────────
  // Payload: { receiver_id: string; body: string }
  // The sender must have an accepted connection with the receiver.
  socket.on('message:send', async (payload: { receiver_id: string; body: string }) => {
    const { userId, institutionId } = socketData(socket);

    try {
      if (!payload.receiver_id?.trim() || !payload.body?.trim()) {
        socket.emit('message:error', { message: 'receiver_id and body are required' });
        return;
      }

      if (payload.body.length > 2000) {
        socket.emit('message:error', { message: 'Message too long (max 2000 characters)' });
        return;
      }

      // Guard: only accepted connections may DM each other
      const connection = await prisma.connection.findFirst({
        where: {
          OR: [
            { sender_id: userId, receiver_id: payload.receiver_id },
            { sender_id: payload.receiver_id, receiver_id: userId },
          ],
          status: 'accepted',
        },
      });

      if (!connection) {
        socket.emit('message:error', { message: 'Cannot message a user you are not connected to' });
        return;
      }

      // Persist to MongoDB
      const message = await Message.create({
        institution_id: institutionId,
        sender_id:      userId,
        receiver_id:    payload.receiver_id,
        body:           payload.body.trim(),
      });

      const outboundMessage = {
        id:          message._id.toString(),
        sender_id:   userId,
        receiver_id: payload.receiver_id,
        body:        message.body,
        created_at:  message.createdAt,
        read_at:     null,
      };

      // Push to receiver's personal room (delivers if online, silently dropped otherwise)
      io.to(`user:${payload.receiver_id}`).emit('message:new', outboundMessage);

      // Confirm delivery to sender
      socket.emit('message:sent', outboundMessage);

    } catch (err) {
      logger.error({ err, userId }, 'message:send error');
      socket.emit('message:error', { message: 'Failed to send message' });
    }
  });

  // ── message:read ──────────────────────────────────────────────────────────
  // Payload: { sender_id: string }
  // Marks all unread messages from sender_id → current user as read,
  // then notifies the sender via message:read_receipt.
  socket.on('message:read', async (payload: { sender_id: string }) => {
    const { userId } = socketData(socket);

    try {
      await Message.updateMany(
        { sender_id: payload.sender_id, receiver_id: userId, read_at: null },
        { $set: { read_at: new Date() } },
      );

      io.to(`user:${payload.sender_id}`).emit('message:read_receipt', {
        reader_id: userId,
      });
    } catch (err) {
      logger.error({ err, userId }, 'message:read error');
    }
  });
}

