import { Router } from 'express';
import authenticate from '@middleware/authenticate';
import scopeToInstitution from '@middleware/institutionScope';
import {
  createSession,
  submitAnswer,
  submitAnswers,
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
//   Practice path: grades one answer AND streams AI tutor feedback when wrong.
router.patch('/:id/answer', submitAnswer);

// PATCH  /api/v1/sessions/:id/answers  — submit many answers (plural, batch)
//   Exam path: one round trip for the whole paper, no feedback streaming.
//   Registered after the singular route; Express matches on the exact path so the
//   two never collide, but keeping them adjacent makes the pairing obvious.
router.patch('/:id/answers', submitAnswers);

// PATCH  /api/v1/sessions/:id/complete — finalize session → score + XP + badges
router.patch('/:id/complete', completeSession);

export default router;
