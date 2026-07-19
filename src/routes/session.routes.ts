import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  createSession,
  submitAnswer,
  completeSession,
  getMySessions,
  getSessionById,
} from '@controllers/controllers';

const router = Router();

router.use(authenticate, scopeToInstitution);

// POST   /api/v1/sessions              — create new quiz session
router.post('/', createSession);

// GET    /api/v1/sessions/me           — list my sessions (order matters: /me before /:id)
router.get('/me', getMySessions);

// GET    /api/v1/sessions/:id          — get full session detail with answers + AI feedback
router.get('/:id', getSessionById);

// PATCH  /api/v1/sessions/:id/answer   — submit a single answer (PATCH, singular)
router.patch('/:id/answer', submitAnswer);

// PATCH  /api/v1/sessions/:id/complete — finalize session → score + XP + badges
router.patch('/:id/complete', completeSession);

export default router;
