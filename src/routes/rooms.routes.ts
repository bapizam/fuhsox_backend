import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  createRoom,
  getRooms,
  getRoomById,
  getRoomMessages,
  joinRoom,
  leaveRoom,
  deleteRoom,
} from '@controllers/rooms.controller';

const router = Router();

router.use(authenticate, scopeToInstitution);

// ─── Study Rooms ───────────────────────────────────────────────────────────────

// POST   /api/v1/rooms             — create a new room
router.post('/', createRoom);

// GET    /api/v1/rooms             — list accessible rooms
router.get('/', getRooms);

// GET    /api/v1/rooms/:id         — get room details (if authorized)
router.get('/:id', getRoomById);

// GET    /api/v1/rooms/:id/messages — paginated chat history (participants only)
router.get('/:id/messages', getRoomMessages);

// POST   /api/v1/rooms/:id/join    — join a room
router.post('/:id/join', joinRoom);

// POST   /api/v1/rooms/:id/leave   — leave a room
router.post('/:id/leave', leaveRoom);

// DELETE /api/v1/rooms/:id         — delete a room (creator/admin only)
router.delete('/:id', deleteRoom);

export default router;
