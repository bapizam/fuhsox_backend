/**
 * socket-ref.ts
 *
 * A zero-dependency module that holds the global Socket.io Server reference.
 * Using a shared ref module instead of importing socket.server.ts directly
 * avoids circular dependencies while keeping the getIO/setIO pattern clean.
 *
 * Dependency graph (no cycles):
 *   socket.server.ts  →  socket-ref.ts  (calls setIO after init)
 *   notification.service.ts  →  socket-ref.ts  (calls getIO to emit)
 */

import type { Server } from 'socket.io';

let _io: Server | null = null;

/**
 * Store the Socket.io server instance after it is initialised.
 * Called once from initSocketServer() in socket.server.ts.
 */
export function setIO(io: Server): void {
  _io = io;
}

/**
 * Retrieve the Socket.io server instance.
 * Returns null before initSocketServer() has been called
 * (e.g., during startup or in test environments).
 */
export function getIO(): Server | null {
  return _io;
}
